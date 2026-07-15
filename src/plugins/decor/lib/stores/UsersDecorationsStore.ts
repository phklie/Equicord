/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { AvatarDecoration } from "@plugins/decor";
import { SKU_ID, RAW_SKU_ID } from "@plugins/decor/lib/constants";
import { proxyLazy } from "@utils/lazy";
import { User } from "@vencord/discord-types";
import { useEffect, useState, zustandCreate } from "@webpack/common";

const DECORATIONS_URL = "https://raw.githubusercontent.com/ryanlosing/pfp/main/decorations.json";

let remoteDecorations: Record<string, string> = {};

fetch(DECORATIONS_URL)
    .then(res => res.ok && res.json())
    .then(data => { if (data?.decorations) remoteDecorations = data.decorations; })
    .catch(() => null);

export const useUsersDecorationsStore = proxyLazy(() => zustandCreate((set: any, get: any) => ({
    usersDecorations: new Map<string, string | null>(),
    fetch(userId: string) {
        const decoration = remoteDecorations[userId] ?? null;
        const { usersDecorations } = get();
        const newMap = new Map(usersDecorations);
        newMap.set(userId, decoration);
        set({ usersDecorations: newMap });
    },
    fetchMany(userIds: string[]) {
        const { usersDecorations } = get();
        const newMap = new Map(usersDecorations);
        for (const userId of userIds) {
            newMap.set(userId, remoteDecorations[userId] ?? null);
        }
        set({ usersDecorations: newMap });
    },
    getAsset(userId: string) {
        return get().usersDecorations.get(userId);
    },
    get(userId: string) {
        return get().usersDecorations.get(userId);
    },
    has(userId: string) {
        return get().usersDecorations.has(userId);
    },
    set(userId: string, decoration: string | null) {
        const { usersDecorations } = get();
        const newMap = new Map(usersDecorations);
        newMap.set(userId, decoration);
        set({ usersDecorations: newMap });
    },
    bulkFetch: async () => { }
})));

export function useUserDecorAvatarDecoration(user?: User): AvatarDecoration | null | undefined {
    const [decoration, setDecoration] = useState<string | null>(
        user ? remoteDecorations[user.id] ?? null : null
    );

    useEffect(() => {
        if (!user) return;
        const asset = remoteDecorations[user.id] ?? null;
        setDecoration(asset);
    }, [user?.id]);

    return decoration ? { asset: decoration, skuId: RAW_SKU_ID } : null;
}