/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sleep } from "@utils/misc";
import { GuildStore, RelationshipStore, RestAPI, SelectedChannelStore, UserStore } from "@webpack/common";
import { useState, useEffect } from "@webpack/common";

import { settings } from ".";

// ─── State (module-level so all components share it) ─────────────────────────

export type ActionType = "channel" | "allServers" | "friends" | "nuke";

let _running = false;
let _status = "Idle";
let _stop = false;
const listeners = new Set<() => void>();

function notify() { listeners.forEach(fn => fn()); }

function setState(running: boolean, status: string) {
    _running = running;
    _status = status;
    notify();
}

export function useStatus() {
    const [, tick] = useState(0);
    useEffect(() => {
        const fn = () => tick(n => n + 1);
        listeners.add(fn);
        return () => { listeners.delete(fn); };
    }, []);
    return { running: _running, status: _status };
}

export function stopAction() {
    _stop = true;
    setState(_running, "Stopping...");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function delMsg(channelId: string, messageId: string): Promise<void> {
    try {
        await RestAPI.del({ url: `/channels/${channelId}/messages/${messageId}` });
    } catch (e: any) {
        if (e?.status === 429) {
            await sleep((e.body?.retry_after ?? 1) * 1000 + 250);
            await delMsg(channelId, messageId);
        }
    }
}

async function deleteInChannel(channelId: string, authorId: string): Promise<number> {
    let deleted = 0;
    let beforeId: string | undefined;

    while (!_stop) {
        const res = await RestAPI.get({
            url: `/channels/${channelId}/messages`,
            query: { limit: 100, ...(beforeId ? { before: beforeId } : {}) },
        }).catch(() => null);

        const msgs: any[] = res?.body ?? [];
        if (!msgs.length) break;

        for (const msg of msgs) {
            if (_stop) return deleted;
            if (msg.author.id !== authorId) continue;
            await delMsg(channelId, msg.id);
            deleted++;
            setState(true, `Deleted ${deleted} messages`);
            await sleep(settings.store.deleteDelay);
        }

        beforeId = msgs[msgs.length - 1].id;
        await sleep(350);
    }

    return deleted;
}

async function deleteInGuild(guildId: string, authorId: string, idx: number, total: number): Promise<number> {
    let deleted = 0;
    let offset = 0;

    while (!_stop) {
        const res = await RestAPI.get({
            url: `/guilds/${guildId}/messages/search`,
            query: { author_id: authorId, offset, limit: settings.store.searchLimit },
        }).catch(() => null);

        const batches: any[][] = res?.body?.messages ?? [];
        if (!batches.length) break;

        for (const batch of batches) {
            for (const msg of batch) {
                if (_stop) return deleted;
                if (msg.author.id !== authorId) continue;
                await delMsg(msg.channel_id, msg.id);
                deleted++;
                setState(true, `Server ${idx}/${total} — deleted ${deleted}`);
                await sleep(settings.store.deleteDelay);
            }
        }

        if (batches.flat().length < settings.store.searchLimit) break;
        offset += settings.store.searchLimit;
        await sleep(500);
    }

    return deleted;
}

async function removeAllFriends(): Promise<void> {
    const ids = Object.keys(RelationshipStore.getFriendIDs() ?? {});
    for (let i = 0; i < ids.length && !_stop; i++) {
        setState(true, `Removing friends ${i + 1}/${ids.length}`);
        try { await RestAPI.del({ url: `/users/@me/relationships/${ids[i]}` }); } catch (_) {}
        await sleep(800);
    }
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export async function runAction(type: ActionType) {
    if (_running) return;
    _stop = false;
    setState(true, "Starting...");

    const me = UserStore.getCurrentUser();
    if (!me) { setState(false, "Idle"); return; }

    try {
        if (type === "channel" || type === "nuke") {
            const channelId = SelectedChannelStore.getChannelId();
            if (channelId) {
                setState(true, "Deleting in channel...");
                await deleteInChannel(channelId, me.id);
            }
        }

        if (type === "allServers" || type === "nuke") {
            const guilds = Object.keys(GuildStore.getGuilds());
            for (let i = 0; i < guilds.length && !_stop; i++) {
                await deleteInGuild(guilds[i], me.id, i + 1, guilds.length);
            }
        }

        if (type === "friends" || type === "nuke") {
            await removeAllFriends();
        }

        setState(false, _stop ? "Stopped" : "Done");
    } catch (err) {
        console.error("[MassClean]", err);
        setState(false, "Error — check console");
    }
}