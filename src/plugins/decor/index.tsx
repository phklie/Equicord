/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated, FieryFlames and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui/styles.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { get } from "@api/DataStore";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { FluxDispatcher, showToast, Toasts, UserStore } from "@webpack/common";

import { CDN_URL, RAW_SKU_ID, setBaseUrl, SKU_ID } from "./lib/constants";
import { useAuthorizationStore } from "./lib/stores/AuthorizationStore";
import { useCurrentUserDecorationsStore } from "./lib/stores/CurrentUserDecorationsStore";
import { useUserDecorAvatarDecoration, useUsersDecorationsStore } from "./lib/stores/UsersDecorationsStore";
import { settings } from "./settings";
import { setAvatarDecorationModalPreview, setDecorationGridDecoration, setDecorationGridItem } from "./ui/components";
import DecorSection, { DecorSectionProps } from "./ui/components/DecorSection";

export interface AvatarDecoration {
    asset: string;
    skuId: string;
}

let intervalId: any;
let lastModified = "";

const DATABASE_URL = "https://raw.githubusercontent.com/ryanlosing/pfp/main/decorations.json";

async function fetchDecorations(noCache = false) {
    const modified = await fetch(DATABASE_URL, { method: "HEAD", cache: "no-cache" })
        .then(res => res.headers.get("last-modified"))
        .catch(() => null);

    if (!noCache && modified && modified === lastModified) return;
    if (modified) lastModified = modified;

    const init = {} as RequestInit;
    if (noCache) init.cache = "no-cache";

    await fetch(DATABASE_URL, init)
        .then(res => res.ok && res.json())
        .then(remote => {
            if (remote?.decorations) {
                for (const userId of Object.keys(remote.decorations)) {
                    useUsersDecorationsStore.getState().fetch(userId);
                }
            }
        })
        .catch(() => null);
}

export default definePlugin({
    name: "Decor",
    description: "Create and use your own custom avatar decorations, or pick your favorite from the presets.",
    tags: ["Appearance", "Customisation"],
    required: true,
    authors: [Devs.FieryFlames],
    patches: [
        {
            find: "getAvatarDecorationURL:",
            replacement: {
                match: /(?<=function \i\((\i)\){)(?=.{0,20}let{avatarDecoration)/,
                replace: "const vcDecorDecoration=$self.getDecorAvatarDecorationURL($1);if(vcDecorDecoration)return vcDecorDecoration;"
            }
        },
        {
            find: "DefaultCustomizationSections",
            replacement: {
                match: /(?<=#{intl::USER_SETTINGS_AVATAR_DECORATION}\)},"decoration"\),)/,
                replace: "$self.DecorSection(),"
            }
        },
        {
            find: "80,onlyAnimateOnHoverOrFocus:!",
            replacement: [
                {
                    match: /(?=function (\i)\(\i\){let{children.{20,200}isSelected:\i,\.\.\.\i\}=\i)/,
                    replace: "$self.DecorationGridItem=$1;",
                },
                {
                    match: /(?<==)\i=>{let{user:\i,avatarDecoration/,
                    replace: "$self.DecorationGridDecoration=$&",
                },
                {
                    match: /(?<=\i\.PURCHASE)(?=,)(?<=avatarDecoration:(\i).+?)/,
                    replace: "||$1.skuId===$self.SKU_ID"
                }
            ]
        },
        {
            find: "isAvatarDecorationAnimating:",
            group: true,
            replacement: [
                {
                    match: /(?<=\.avatarDecoration,guildId:\i\}\)\),)(?<=user:(\i).+?)/,
                    replace: "vcDecorAvatarDecoration=$self.useUserDecorAvatarDecoration($1),"
                },
                {
                    match: /(?<={avatarDecoration:).{1,20}?(?=,)(?<=avatarDecorationOverride:(\i).+?)/,
                    replace: "$1??vcDecorAvatarDecoration??($&)"
                },
                {
                    match: /(?<=size:\i}\),\[)/,
                    replace: "vcDecorAvatarDecoration,"
                }
            ]
        },
        {
            find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
            replacement: [
                {
                    match: /(?<=\i\)\({avatarDecoration:)\i(?=,)(?<=currentUser:(\i).+?)/,
                    replace: "$self.useUserDecorAvatarDecoration($1)??$&"
                }
            ]
        },
        ...[
            "#{intl::COLLECTIBLES_NAMEPLATE_PREVIEW_A11Y}", // Nameplate preview
            "#{intl::COLLECTIBLES_PROFILE_PREVIEW_A11Y}", // Avatar preview
        ].map(find => ({
            find,
            replacement: {
                match: /(?<=userValue:)((\i(?:\.author)?)\?\.avatarDecoration)/,
                replace: "$self.useUserDecorAvatarDecoration($2)??$1"
            }
        })),
        {
            find: "#{intl::PREMIUM_UPSELL_PROFILE_AVATAR_DECO_INLINE_UPSELL_DESCRIPTION}",
            replacement: [
                {
                    match: /(?<==)function\(\i\){let{user:\i,guildId:\i,avatarDecoration:/,
                    replace: "$self.AvatarDecorationModalPreview=$&"
                }
            ]
        },
        // 2026-03-wysiwyg-user-profile-editing
        {
            find: '("UserProfileModalV2EditingPanel")',
            replacement: [
                {
                    match: /"inline"===.{0,100}#{intl::Zenogr::raw}\)/,
                    replace: "$self.ExperimentDecorSection(),$&"
                }
            ]
        }
    ],
    settings,

    flux: {
        CONNECTION_OPEN: () => {
            useUsersDecorationsStore.getState().fetch(UserStore.getCurrentUser().id);
        },
        USER_PROFILE_MODAL_OPEN: data => {
            useUsersDecorationsStore.getState().fetch(data.userId);
        },
    },

    set DecorationGridItem(e: any) {
        setDecorationGridItem(e);
    },

    set DecorationGridDecoration(e: any) {
        setDecorationGridDecoration(e);
    },

    set AvatarDecorationModalPreview(e: any) {
        setAvatarDecorationModalPreview(e);
    },

    SKU_ID,
    RAW_SKU_ID,

    useUserDecorAvatarDecoration,

    async start() {
        await fetchDecorations();
        clearInterval(intervalId);
        intervalId = setInterval(() => fetchDecorations(), 1000 * 60 * 5);
    },

    stop() {
        clearInterval(intervalId);
    },

    getDecorAvatarDecorationURL({ avatarDecoration, canAnimate }: { avatarDecoration: AvatarDecoration | null; canAnimate?: boolean; }) {
        if (avatarDecoration?.skuId === SKU_ID) {
            const parts = avatarDecoration.asset.split("_");
            if (avatarDecoration.asset.startsWith("a_") && !canAnimate) parts.shift();
            return `${CDN_URL}/${parts.join("_")}.png`;
        } else if (avatarDecoration?.skuId === RAW_SKU_ID) {
            return avatarDecoration.asset;
        }
    },

    DecorSection: ErrorBoundary.wrap(DecorSection, { noop: true }),

    toolboxActions: {
        "Refresh Decorations": async () => {
            await fetchDecorations(true);
            showToast("Decor: Decorations refreshed!", Toasts.Type.SUCCESS);
        }
    }
});