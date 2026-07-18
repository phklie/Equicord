/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { findStoreLazy } from "@webpack";
import { Alerts, ChannelStore, GuildStore, Menu, PermissionStore, RestAPI, UserStore } from "@webpack/common";

interface VoiceState {
    userId: string;
    channelId?: string;
    oldChannelId?: string;
}

interface VoiceStateStore {
    getAllVoiceStates(): { [guildId: string]: { [userId: string]: VoiceState } };
    getVoiceStatesForChannel(channelId: string): { [userId: string]: VoiceState };
}

const VoiceStateStore: VoiceStateStore = findStoreLazy("VoiceStateStore");

interface BlacklistEntry {
    userId: string;
    channelId: string | null; // null = server-wide
    guildId: string;
}

let blacklist: BlacklistEntry[] = [];
let monitorInterval: NodeJS.Timeout | null = null;
const kickCache = new Set<string>();

const settings = definePluginSettings({
    muteUser: {
        type: OptionType.BOOLEAN,
        description: "Server Mute blacklisted users",
        default: true,
    },
    deafenUser: {
        type: OptionType.BOOLEAN,
        description: "Server Deafen blacklisted users",
        default: true,
    },
    disconnectUser: {
        type: OptionType.BOOLEAN,
        description: "Disconnect blacklisted users from channel",
        default: true,
    },
    monitorSpeed: {
        type: OptionType.SLIDER,
        description: "Monitor check interval (milliseconds)",
        default: 100,
        markers: [50, 100, 250, 500, 1000],
        stickToMarkers: true,
    },
});

function hasPerms(channelId: string): boolean {
    try {
        const MUTE = 1n << 22n;
        const DEAFEN = 1n << 23n;
        const MOVE = 1n << 24n;
        const channel = ChannelStore.getChannel(channelId);
        if (!channel) return false;
        return PermissionStore.can(MUTE | DEAFEN | MOVE, channel);
    } catch {
        return false;
    }
}

function kickUserWithSettings(guildId: string, userId: string, channelId: string) {
    const cacheKey = `${userId}-${channelId}`;
    if (kickCache.has(cacheKey)) return;

    // Check if user is blacklisted (channel-specific or server-wide)
    if (!isBlacklisted(userId, channelId, guildId)) return;

    kickCache.add(cacheKey);

    const actions: Promise<any>[] = [];

    if (settings.store.muteUser || settings.store.deafenUser) {
        const body: any = {};
        if (settings.store.muteUser) body.mute = true;
        if (settings.store.deafenUser) body.deaf = true;

        actions.push(
            RestAPI.patch({
                url: `/guilds/${guildId}/members/${userId}`,
                body: body
            }).catch(() => {})
        );
    }

    if (settings.store.disconnectUser) {
        setTimeout(() => {
            RestAPI.patch({
                url: `/guilds/${guildId}/members/${userId}`,
                body: { channel_id: null }
            }).catch(() => {});
        }, 100);
    }

    Promise.all(actions).then(() => {
        setTimeout(() => kickCache.delete(cacheKey), 1000);
    }).catch(() => {
        kickCache.delete(cacheKey);
    });

    console.log("[VCBlacklist] Actions applied to:", userId, channelId);
}

/**
 * Check if a user is blacklisted.
 * - If a server-wide entry exists (channelId === null) for the same guild → blacklisted everywhere.
 * - If a channel-specific entry exists for this exact channel → blacklisted.
 */
function isBlacklisted(userId: string, channelId: string, guildId?: string): boolean {
    return blacklist.some(e => {
        if (e.userId !== userId) return false;
        if (e.channelId === null) {
            // server-wide entry: match any channel in the same guild
            return guildId ? e.guildId === guildId : true;
        }
        return e.channelId === channelId;
    });
}

function isBlacklistedServerWide(userId: string, guildId: string): boolean {
    return blacklist.some(e => e.userId === userId && e.channelId === null && e.guildId === guildId);
}

function addBlacklist(userId: string, channelId: string, guildId: string, serverWide = false) {
    if (serverWide) {
        if (!isBlacklistedServerWide(userId, guildId)) {
            blacklist.push({ userId, channelId: null, guildId });
            console.log("[VCBlacklist] Added server-wide:", userId, guildId);
        }
    } else {
        if (!isBlacklisted(userId, channelId)) {
            blacklist.push({ userId, channelId, guildId });
            console.log("[VCBlacklist] Added channel-specific:", userId, channelId);
        }
    }
}

function removeBlacklist(userId: string, channelId: string | null, guildId: string) {
    blacklist = blacklist.filter(e => {
        if (e.userId !== userId || e.guildId !== guildId) return true;
        if (channelId === null) return e.channelId !== null; // remove server-wide entry
        return e.channelId !== channelId; // remove channel-specific entry
    });
    // Clear cache entries for this user
    for (const key of kickCache) {
        if (key.startsWith(`${userId}-`)) kickCache.delete(key);
    }
    console.log("[VCBlacklist] Removed:", userId, channelId ?? "server-wide");
}

function getUserChannelId(userId: string): string | null {
    try {
        const states = VoiceStateStore.getAllVoiceStates();
        for (const users of Object.values(states)) {
            if (users[userId]) return users[userId].channelId ?? null;
        }
    } catch {}
    return null;
}

function getUserGuildId(userId: string): string | null {
    try {
        const states = VoiceStateStore.getAllVoiceStates();
        for (const [guildId, users] of Object.entries(states)) {
            if (users[userId]) return guildId;
        }
    } catch {}
    return null;
}

function monitorBlacklist() {
    try {
        if (blacklist.length === 0) return;

        const allStates = VoiceStateStore.getAllVoiceStates();

        for (const entry of [...blacklist]) {
            const { userId, channelId, guildId } = entry;

            for (const [stateGuildId, users] of Object.entries(allStates)) {
                const userState = users[userId];
                if (!userState?.channelId) continue;

                if (channelId === null) {
                    // Server-wide: block in any channel within the same guild
                    if (stateGuildId !== guildId) continue;
                    const ch = ChannelStore.getChannel(userState.channelId);
                    if (ch && hasPerms(userState.channelId)) {
                        kickUserWithSettings(guildId, userId, userState.channelId);
                    }
                } else {
                    // Channel-specific: only block in that exact channel
                    if (userState.channelId === channelId) {
                        const ch = ChannelStore.getChannel(channelId);
                        if (ch && hasPerms(channelId)) {
                            kickUserWithSettings(ch.guild_id, userId, channelId);
                        }
                    }
                }
            }
        }
    } catch {}
}

function startMonitoring() {
    if (monitorInterval) return;
    const interval = settings.store.monitorSpeed;
    monitorInterval = setInterval(monitorBlacklist, interval);
    console.log(`[VCBlacklist] Monitoring started (${interval}ms)`);
}

function stopMonitoring() {
    if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
        console.log("[VCBlacklist] Monitoring stopped");
    }
}

// ─── Context Menus ───────────────────────────────────────────────────────────

const UserContext: NavContextMenuPatchCallback = (children, { user }) => {
    if (!user || user.id === UserStore.getCurrentUser().id) return;

    const channelId = getUserChannelId(user.id);
    if (!channelId) return;

    const voiceChannel = ChannelStore.getChannel(channelId);
    if (!voiceChannel || voiceChannel.type !== 2) return;

    if (!hasPerms(channelId)) return;

    const guildId = voiceChannel.guild_id;

    const blacklistedChannel = blacklist.some(e => e.userId === user.id && e.channelId === channelId);
    const blacklistedServerWide = isBlacklistedServerWide(user.id, guildId);

    children.splice(-1, 0, (
        <Menu.MenuGroup>
            
            <Menu.MenuItem
                id="vc-blacklist-channel"
                label={blacklistedChannel
                    ? `Remove from Voice Blacklist`
                    : `Voice Blacklist`}
                color={blacklistedChannel ? "danger" : undefined}
                action={() => {
                    if (blacklistedChannel) {
                        Alerts.show({
                            title: "Remove from Voice Blacklist",
                            body: `Are you sure you want to remove ${user.username} from the blacklist for #${voiceChannel.name}?`,
                            confirmText: "Remove",
                            cancelText: "Cancel",
                            confirmColor: "red",
                            onConfirm: () => removeBlacklist(user.id, channelId, guildId)
                        });
                    } else {
                        addBlacklist(user.id, channelId, guildId, false);
                        kickUserWithSettings(guildId, user.id, channelId);
                    }
                }}
            />

            
            <Menu.MenuItem
                id="vc-blacklist-server"
                label={blacklistedServerWide
                    ? "Remove from Server Blacklist"
                    : "Server Blacklist"}
                color="danger"
                action={() => {
                    if (blacklistedServerWide) {
                        Alerts.show({
                            title: "Remove from Server-Wide Blacklist",
                            body: `Are you sure you want to remove ${user.username} from the server blacklist?`,
                            confirmText: "Remove",
                            cancelText: "Cancel",
                            confirmColor: "red",
                            onConfirm: () => removeBlacklist(user.id, null, guildId)
                        });
                    } else {
                        addBlacklist(user.id, channelId, guildId, true);
                        kickUserWithSettings(guildId, user.id, channelId);
                    }
                }}
            />
        </Menu.MenuGroup>
    ));
};

const ChannelContext: NavContextMenuPatchCallback = (children, { channel }) => {
    if (!channel || channel.type !== 2 || !channel.guild_id) return;
    if (!hasPerms(channel.id)) return;

    // Show channel-specific entries AND server-wide entries for this guild
    const list = blacklist.filter(e =>
        (e.channelId === channel.id || (e.channelId === null && e.guildId === channel.guild_id))
    );
    if (list.length === 0) return;

    const items = list.map(entry => {
        const user = UserStore.getUser(entry.userId);
        const name = user?.username || entry.userId;
        const scope = "";

        return (
            <Menu.MenuItem
                key={`${entry.userId}-${entry.channelId ?? "sw"}`}
                id={`bl-${entry.userId}-${entry.channelId ?? "sw"}`}
                label={`${name}${scope}`}
                color="danger"
                action={() => {
                    Alerts.show({
                        title: "Remove from Blacklist",
                        body: `Are you sure you want to remove ${name} from the blacklist${entry.channelId === null ? " server" : ""}?`,
                        confirmText: "Remove",
                        cancelText: "Cancel",
                        confirmColor: "red",
                        onConfirm: () => removeBlacklist(entry.userId, entry.channelId, entry.guildId)
                    });
                }}
            />
        );
    });

    items.push(<Menu.MenuSeparator key="sep" />);
    items.push(
        <Menu.MenuItem
            key="rm-all"
            id="rm-all"
            label="Remove All"
            color="danger"
            action={() => {
                Alerts.show({
                    title: "Remove All Users",
                    body: `Are you sure you want to remove all ${list.length} users from the blacklist?`,
                    confirmText: "Remove All",
                    cancelText: "Cancel",
                    confirmColor: "red",
                    onConfirm: () => list.forEach(e => removeBlacklist(e.userId, e.channelId, e.guildId))
                });
            }}
        />
    );

    children.splice(-1, 0, (
        <Menu.MenuGroup>
            <Menu.MenuItem id="vc-bl-list" label="Voice Blacklist">
                {items}
            </Menu.MenuItem>
        </Menu.MenuGroup>
    ));
};

// ─── Plugin ──────────────────────────────────────────────────────────────────

export default definePlugin({
    name: "VoiceChannelBlacklist",
    description: "Block users from voice channels with customizable actions (supports server-wide blacklist)",
    authors: [Devs.phklie],
    settings,

    start() {
        console.log("[VCBlacklist] Plugin started");
        startMonitoring();
    },

    stop() {
        console.log("[VCBlacklist] Plugin stopped");
        stopMonitoring();
        blacklist = [];
        kickCache.clear();
    },

    contextMenus: {
        "user-context": UserContext,
        "channel-context": ChannelContext
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[] }) {
            if (!voiceStates) return;

            for (const { userId, channelId } of voiceStates) {
                if (!channelId || userId === UserStore.getCurrentUser()?.id) continue;

                const channel = ChannelStore.getChannel(channelId);
                if (!channel || !hasPerms(channelId)) continue;

                if (isBlacklisted(userId, channelId, channel.guild_id)) {
                    kickUserWithSettings(channel.guild_id, userId, channelId);
                }
            }
        },

        CHANNEL_DELETE({ channel }: { channel: { id: string; type: number } }) {
            if (channel?.type === 2 && channel?.id) {
                blacklist = blacklist.filter(e => e.channelId !== channel.id);
                console.log("[VCBlacklist] Channel deleted, cleaned blacklist");
            }
        }
    }
});