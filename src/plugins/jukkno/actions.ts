/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sleep } from "@utils/misc";
import { ChannelStore, GuildStore, RelationshipStore, RestAPI, SelectedChannelStore, useEffect, UserStore , useState } from "@webpack/common";

import { settings } from ".";

// ─── State (module-level so all components share it) ─────────────────────────

export type ActionType = "channel" | "allServers" | "leaveServers" | "friends" | "nuke";

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

// Runs a request and retries on rate limits (429). Returns the response or null on failure.
async function request(fn: () => Promise<any>, retries = 6): Promise<any | null> {
    for (let i = 0; i < retries; i++) {
        if (_stop) return null;
        try {
            return await fn();
        } catch (e: any) {
            if (e?.status === 429) {
                await sleep((e.body?.retry_after ?? 1) * 1000 + 250);
                continue;
            }
            return null;
        }
    }
    return null;
}

async function delMsg(channelId: string, messageId: string): Promise<boolean> {
    const res = await request(() => RestAPI.del({ url: `/channels/${channelId}/messages/${messageId}` }));
    return res !== null;
}

async function deleteInChannel(channelId: string, authorId: string, label = ""): Promise<number> {
    let deleted = 0;
    let beforeId: string | undefined;
    const prefix = label ? `${label} — ` : "";

    while (!_stop) {
        const res = await request(() => RestAPI.get({
            url: `/channels/${channelId}/messages`,
            query: { limit: 100, ...(beforeId ? { before: beforeId } : {}) },
        }));

        const msgs: any[] = res?.body ?? [];
        if (!msgs.length) break;

        for (const msg of msgs) {
            if (_stop) return deleted;
            if (msg.author?.id !== authorId) continue;
            if (await delMsg(channelId, msg.id)) {
                deleted++;
                setState(true, `${prefix}deleted ${deleted} messages`);
                await sleep(settings.store.deleteDelay);
            }
        }

        beforeId = msgs[msgs.length - 1].id;
        await sleep(350);
    }

    return deleted;
}

// Search can answer 202 while Discord is still indexing the server — wait and retry.
async function searchGuild(guildId: string, authorId: string, offset: number): Promise<any | null> {
    for (let attempt = 0; attempt < 8 && !_stop; attempt++) {
        try {
            const res = await RestAPI.get({
                url: `/guilds/${guildId}/messages/search`,
                query: { author_id: authorId, offset, sort_by: "timestamp", sort_order: "desc" },
            });
            if (res.status === 202) {
                await sleep((res.body?.retry_after ?? 2) * 1000 + 250);
                continue;
            }
            return res.body;
        } catch (e: any) {
            if (e?.status === 429) {
                await sleep((e.body?.retry_after ?? 1) * 1000 + 250);
                continue;
            }
            return null;
        }
    }
    return null;
}

async function deleteInGuild(guildId: string, authorId: string, label: string): Promise<number> {
    let deleted = 0;
    let failed = 0; // messages that can't be deleted, we skip over them with the offset
    let stale = 0; // search index lag (already deleted messages still showing)
    const seen = new Set<string>();

    while (!_stop) {
        const body = await searchGuild(guildId, authorId, failed);
        const groups: any[][] = body?.messages ?? [];
        if (!groups.length) break;

        const mine = groups.flat().filter(m => m.author?.id === authorId && !seen.has(m.id));

        if (!mine.length) {
            if (++stale > 3) break;
            await sleep(1500);
            continue;
        }
        stale = 0;

        for (const msg of mine) {
            if (_stop) return deleted;
            seen.add(msg.id);
            if (await delMsg(msg.channel_id, msg.id)) {
                deleted++;
                setState(true, `${label} — deleted ${deleted}`);
                await sleep(settings.store.deleteDelay);
            } else {
                failed++;
            }
        }

        await sleep(500);
    }

    return deleted;
}

async function leaveGuild(guildId: string): Promise<boolean> {
    const res = await request(() => RestAPI.del({
        url: `/users/@me/guilds/${guildId}`,
        body: { lurking: false },
    }));
    return res !== null;
}

// Deletes my messages in every server (and optionally leaves it afterwards).
async function cleanGuilds(meId: string, leave: boolean): Promise<void> {
    const guilds = Object.values(GuildStore.getGuilds() ?? {}) as any[];

    for (let i = 0; i < guilds.length && !_stop; i++) {
        const g = guilds[i];
        const label = `Server ${i + 1}/${guilds.length}`;

        await deleteInGuild(g.id, meId, label);
        if (_stop) break;

        if (leave) {
            if (g.ownerId === meId) {
                setState(true, `${label} — you own it, skipped leaving`);
            } else {
                setState(true, `${label} — leaving`);
                await leaveGuild(g.id);
            }
            await sleep(800);
        }
    }
}

// Deletes my messages in the DM with each friend, then removes the friend.
async function cleanFriends(meId: string): Promise<void> {
    const ids: string[] = [...(RelationshipStore.getFriendIDs() ?? [])];

    for (let i = 0; i < ids.length && !_stop; i++) {
        const label = `Friend ${i + 1}/${ids.length}`;

        const dmId = ChannelStore.getDMFromUserId(ids[i]);
        if (dmId) await deleteInChannel(dmId, meId, label);
        if (_stop) break;

        setState(true, `${label} — removing`);
        await request(() => RestAPI.del({ url: `/users/@me/relationships/${ids[i]}` }));
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
                await deleteInChannel(channelId, me.id, "Channel");
            }
        }

        if (type === "allServers") {
            await cleanGuilds(me.id, false);
        }

        if (type === "leaveServers" || type === "nuke") {
            await cleanGuilds(me.id, true);
        }

        if (type === "friends" || type === "nuke") {
            await cleanFriends(me.id);
        }

        setState(false, _stop ? "Stopped" : "Done");
    } catch (err) {
        console.error("[MassClean]", err);
        setState(false, "Error — check console");
    }
}
