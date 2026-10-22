/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { del } from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Flex } from "@components/Flex";
import { Heart } from "@components/Heart";
import { PencilIcon } from "@components/Icons";
import { Margins } from "@components/margins";
import { Notice } from "@components/Notice";
import { Devs, EquicordDevs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { openInviteModal } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { User } from "@vencord/discord-types";
import { extractAndLoadChunksLazy } from "@webpack";
import { FluxDispatcher, IconUtils, Menu, openModal, showToast, UserStore } from "@webpack/common";

import { SetAvatarModal } from "./AvatarModal";

const cl = classNameFactory("vc-userpfp-");
const DONO_URL = "https://ko-fi.com/coolesding";
const INVITE_LINK = "userpfp-1129784704267210844";
const USERPFP_IMG_URL = "https://raw.githubusercontent.com/UserPFP/img";
const CUSTOM_DB_URL = "https://ryanlosing.github.io/pfp/users.json";

export const requireSettingsModal = extractAndLoadChunksLazy(['type:"USER_SETTINGS_MODAL_OPEN"']);
export const KEY_DATASTORE = "vencord-custom-avatars";
export const data = { avatars: {} as Record<string, string> };

const settings = definePluginSettings({
    overrideServerAvatars: {
        type: OptionType.BOOLEAN,
        description: "Override server avatars with custom avatars or the default user avatar if no custom avatar is set.",
        default: true
    },
    preferNitro: {
        description: "Which avatar to use if both default animated (Nitro) pfp and UserPFP avatars are present",
        type: OptionType.SELECT,
        options: [
            { label: "UserPFP", value: false },
            { label: "Nitro", value: true, default: true },
        ],
    },
    databaseSource: {
        description: "URL to load database",
        type: OptionType.STRING,
        default: CUSTOM_DB_URL,
        hidden: true,
        isValid: (value => {
            if (!value) {
                value = CUSTOM_DB_URL;
                return false;
            }
            return true;
        })
    },
});

let timeoutId: any;
let blockedUntil = 0;
let backoffMs = 0;
let lastManualRefresh = 0;

const REFRESH_INTERVAL = 1000 * 60 * 30; // 30 minutes
const MANUAL_COOLDOWN = 1000 * 30; // 30 seconds

async function fetchAvatars() {
    // Back off if the server told us to slow down
    if (Date.now() < blockedUntil) return;

    let newAvatars: Record<string, string>;

    try {
        // "no-cache" = conditional request (ETag). Unchanged file => 304, no download
        const res = await fetch(settings.store.databaseSource, { cache: "no-cache" });

        if (res.status === 429 || res.status === 403) {
            backoffMs = Math.min((backoffMs || 5 * 60 * 1000) * 2, 60 * 60 * 1000);
            blockedUntil = Date.now() + backoffMs;
            return;
        }

        if (!res.ok) return;
        backoffMs = 0;

        const remote = await res.json();
        newAvatars = { ...(remote?.avatars ?? {}) };
    } catch {
        // Keep the current data if the request fails
        return;
    }

    // Skip the UI refresh if nothing changed
    if (JSON.stringify(newAvatars) === JSON.stringify(data.avatars)) return;

    // Remote is the single source of truth: anything removed there is removed here
    data.avatars = newAvatars;

    // Refresh all cached users so avatars update immediately
    const allCachedUsers = UserStore.getUsers();
    for (const userId of Object.keys(allCachedUsers)) {
        const user = UserStore.getUser(userId);
        if (user) FluxDispatcher.dispatch({ type: "USER_UPDATE", user });
    }
}

function scheduleNext() {
    clearTimeout(timeoutId);
    // Random 0-60s jitter so requests never line up exactly
    const delay = REFRESH_INTERVAL + Math.random() * 60_000;
    timeoutId = setTimeout(async () => {
        await fetchAvatars();
        scheduleNext();
    }, delay);
}

export default definePlugin({
    name: "UserPFP",
    description: "Allows you to set local static or animated avatars for yourself and other users",
    tags: ["Appearance", "Customisation", "Servers"],
    authors: [EquicordDevs.nexpid, Devs.thororen, EquicordDevs.soapphia, EquicordDevs.sketchmyname],
    settings,
    data,
    settingsAboutComponent: () => (
        <>
            <Notice.Info className={Margins.bottom8}>
                Using the set avatar feature is local only meaning only you see it change.
            </Notice.Info>
            <Notice.Info className={Margins.bottom8}>
                Avatar database and images provided .
            </Notice.Info>
            <Flex className={cl("settings")}>
                <Button
                    variant="link"
                    className={cl("settings-button")}
                    onClick={() => openInviteModal(INVITE_LINK)}
                >
                    Join UserPFP Server
                </Button>
                <Button
                    variant="secondary"
                    className={cl("settings-button")}
                    onClick={() => VencordNative.native.openExternal(DONO_URL)}
                >
                    Support UserPFP here <Heart className={cl("settings-heart")} />
                </Button>
            </Flex>
        </>
    ),
    patches: [
        {
            find: "getUserAvatarURL:",
            replacement: [
                {
                    match: /(getUserAvatarURL:)(\i),/,
                    replace: "$1$self.getAvatarHook($2),"
                },
                {
                    match: /(getGuildMemberAvatarURLSimple:)(\i),/,
                    replace: "$1$self.getAvatarServerHook($2),",
                    predicate: () => settings.store.overrideServerAvatars
                }
            ]
        }
    ],
    contextMenus: {
        "user-context": (children, { user }) => {
            if (!user?.id) return;

            children.push(
                <Menu.MenuSeparator />,
                <Menu.MenuItem
                    label="Set Avatar"
                    id="set-avatar"
                    icon={PencilIcon}
                    leadingAccessory={{ type: "icon", icon: PencilIcon }}
                    action={async () => {
                        await requireSettingsModal();
                        openModal(modalProps => <SetAvatarModal userId={user.id} modalProps={modalProps} />);
                    }}
                />
            );
        }
    },
    getAvatarHook: (original: any) => (user: User, animated: boolean, size: number) => {
        if (settings.store.preferNitro && user.avatar?.startsWith("a_")) return original(user, animated, size);
        if (!data.avatars[user.id]) return original(user, animated, size);

        const avatarUrl = data.avatars[user.id];

        if (avatarUrl.startsWith("data:")) return avatarUrl;

        try {
            const res = new URL(avatarUrl);
            if (avatarUrl.startsWith(USERPFP_IMG_URL)) {
                res.searchParams.set("animated", animated ? "true" : "false");
                if (!animated) {
                    res.pathname = res.pathname.replaceAll(/\.gifv?/g, ".png");
                }
            }
            return res.toString();
        } catch {
            return original(user, animated, size);
        }
    },
    getAvatarServerHook: (original: any) => (config: any) => {
        const { userId, avatar, size, canAnimate } = config;
        const { avatars } = data;

        if (avatars[userId]) {
            const customUrl = avatars[userId];
            if (customUrl.startsWith("data:")) return customUrl;

            try {
                const res = new URL(customUrl);
                if (size) res.searchParams.set("size", size.toString());
                return res.toString();
            } catch {
                return customUrl;
            }
        }

        if (avatar) {
            const user = UserStore.getUser(userId);
            if (user?.avatar) {
                return IconUtils.getUserAvatarURL(user, canAnimate, size);
            }
        }

        return original(config);
    },

    async start() {
        // Wipe the old local cache once so only the remote database is used
        await del(KEY_DATASTORE).catch(() => null);

        await fetchAvatars();
        scheduleNext();
    },

    stop() {
        clearTimeout(timeoutId);
    },

    toolboxActions: {
        "Refresh Avatars": async () => {
            if (Date.now() - lastManualRefresh < MANUAL_COOLDOWN) {
                showToast({ text: "UserPFP: Please wait a bit before refreshing again", variant: "critical" });
                return;
            }
            lastManualRefresh = Date.now();

            await fetchAvatars();
            showToast({ text: "UserPFP: Avatars refreshed!", variant: "success" });
        }
    }
});
