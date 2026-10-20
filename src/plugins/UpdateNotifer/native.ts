/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

const ALLOWED = ["https://github.com/", "https://api.github.com/"];

export async function request(_: IpcMainInvokeEvent, url: string, headers: Record<string, string> = {}) {
    if (!ALLOWED.some(prefix => url.startsWith(prefix))) throw new Error("Blocked URL");

    const res = await fetch(url, { headers });
    return {
        status: res.status,
        text: await res.text(),
        remaining: res.headers.get("x-ratelimit-remaining"),
        reset: res.headers.get("x-ratelimit-reset")
    };
}
