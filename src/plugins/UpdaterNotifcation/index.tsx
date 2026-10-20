/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { relaunch } from "@utils/native";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { update } from "@utils/updater";
import { useState } from "@webpack/common";

import gitHash from "~git-hash";

const settings = definePluginSettings({
    repo: {
        type: OptionType.STRING,
        description: "Repository to watch (owner/name)",
        default: "phklie/Equicord"
    },
    branch: {
        type: OptionType.STRING,
        description: "Branch to watch",
        default: "main"
    },
    intervalMinutes: {
        type: OptionType.NUMBER,
        description: "Minutes between checks (minimum 5)",
        default: 10
    },
    checkOnStart: {
        type: OptionType.BOOLEAN,
        description: "Check for updates when Discord starts",
        default: true
    },
    githubToken: {
        type: OptionType.STRING,
        description: "Optional GitHub token (raises the API rate limit, used for all lookups)",
        default: ""
    },
    actions: {
        type: OptionType.COMPONENT,
        component: () => <SettingsActions />
    },
    lastSeenSha: {
        type: OptionType.STRING,
        description: "Last commit you were notified about",
        default: "",
        hidden: true
    }
});

interface CommitFile {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    previous_filename?: string;
    patch?: string;
}

interface CommitSummary {
    sha: string;
    title: string;
    author: string;
    date: string;
}

interface UpdateInfo {
    sha: string;
    title: string;
    body: string;
    author: string;
    date: string;
    url: string;
    extraCommits: number;
    commits: CommitSummary[];
    files: CommitFile[];
    note?: string;
}

const API = "https://api.github.com";
const STYLE_ID = "vc-commit-notifier-style";
const MAX_PATCH_LINES = 400;

interface RawResponse {
    status: number;
    text: string;
    remaining: string | null;
    reset: string | null;
}

class RateLimitError extends Error {
    constructor(public resetAt: number) {
        super(`GitHub API limit reached, resets at ${new Date(resetAt * 1000).toLocaleTimeString()}`);
    }
}

let blockedUntil = 0;

function getNative() {
    if (typeof VencordNative === "undefined") return undefined;
    return VencordNative.pluginHelpers?.CommitNotifier as PluginNative<typeof import("./native")> | undefined;
}

async function request(url: string, headers: Record<string, string> = {}): Promise<RawResponse> {
    const native = getNative();
    if (native) return native.request(url, headers);

    const res = await fetch(url, { headers });
    return {
        status: res.status,
        text: await res.text(),
        remaining: res.headers.get("x-ratelimit-remaining"),
        reset: res.headers.get("x-ratelimit-reset")
    };
}

async function gh<T>(path: string): Promise<T> {
    if (Date.now() / 1000 < blockedUntil) throw new RateLimitError(blockedUntil);

    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    const token = settings.store.githubToken.trim();
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await request(API + path, headers);

    if ((res.status === 403 || res.status === 429) && res.remaining === "0") {
        blockedUntil = Number(res.reset) || Math.floor(Date.now() / 1000) + 600;
        throw new RateLimitError(blockedUntil);
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`GitHub responded with ${res.status}`);

    return JSON.parse(res.text);
}

function toSummary(c: any): CommitSummary {
    const sha = (c.sha as string) ?? "";
    return {
        sha,
        title: c.commit?.message?.split("\n")[0]?.trim() || sha.slice(0, 7),
        author: c.commit?.author?.name ?? c.author?.login ?? "unknown",
        date: c.commit?.author?.date ?? ""
    };
}

function messageBody(message: string | undefined) {
    if (!message) return "";
    return message.split("\n").slice(1).join("\n").trim();
}

async function getLatestCommit() {
    const { repo, branch } = settings.store;
    const ref = encodeURIComponent(branch.trim() || "main");

    const commit = await gh<any>(`/repos/${repo}/commits/${ref}`);
    const sha = commit.sha as string;
    if (!sha) return null;

    return {
        ...toSummary(commit),
        body: messageBody(commit.commit?.message),
        url: (commit.html_url as string) ?? `https://github.com/${repo}/commit/${sha}`
    };
}

const detailsCache = new Map<string, UpdateInfo>();

async function getUpdateInfo(): Promise<UpdateInfo | null> {
    const latest = await getLatestCommit();
    if (!latest) return null;
    if (latest.sha === gitHash || latest.sha.startsWith(gitHash)) return null;

    const cached = detailsCache.get(latest.sha);
    if (cached && !cached.note) return cached;

    const { repo } = settings.store;
    let info: UpdateInfo = { ...latest, extraCommits: 0, commits: [toSummary(latest)], files: [] };

    try {
        try {
            const cmp = await gh<any>(`/repos/${repo}/compare/${gitHash}...${latest.sha}`);
            if (cmp.status === "behind" || cmp.status === "identical") return null;

            const commits: CommitSummary[] = (cmp.commits ?? []).map(toSummary).reverse();
            info = {
                ...info,
                extraCommits: Math.max(0, (cmp.total_commits ?? 1) - 1),
                commits: commits.length ? commits : info.commits,
                files: cmp.files ?? []
            };
        } catch (e) {
            if (e instanceof RateLimitError) throw e;
            const full = await gh<any>(`/repos/${repo}/commits/${latest.sha}`);
            info = { ...info, files: full.files ?? [] };
        }
    } catch (e) {
        info.note = e instanceof RateLimitError
            ? `File list unavailable. ${e.message}`
            : "File list unavailable right now";
    }

    detailsCache.set(latest.sha, info);
    return info;
}

/**
 * Preview = exactly the same window you get when a real update exists.
 * If there is a pending update we show that one. If you're already up to date,
 * we show the latest commit of the watched branch with its real details.
 */
async function getPreviewInfo(): Promise<{ info: UpdateInfo; isReal: boolean; } | null> {
    const real = await getUpdateInfo();
    if (real) return { info: real, isReal: true };

    const latest = await getLatestCommit();
    if (!latest) return null;

    const { repo } = settings.store;
    const info: UpdateInfo = { ...latest, extraCommits: 0, commits: [toSummary(latest)], files: [] };

    try {
        const full = await gh<any>(`/repos/${repo}/commits/${latest.sha}`);
        info.files = full.files ?? [];
    } catch (e: any) {
        info.note = e instanceof RateLimitError ? `File list unavailable. ${e.message}` : "File list unavailable right now";
    }

    return { info, isReal: false };
}

const CSS = /* css */ `
.cn-root {
    --cn-glow: #6aa4ff;
    --cn-glow-2: #a9c9ff;
    --cn-text: #f4f5f7;
    --cn-dim: #9b9fa9;
    --cn-faint: #6a6e78;
    --cn-line: rgba(255,255,255,.08);
    position: fixed;
    inset: 0;
    z-index: 100000;
    display: grid;
    place-items: center;
    font-family: "gg sans", "Noto Sans", system-ui, sans-serif;
    color: var(--cn-text);
    animation: cn-root-in .45s cubic-bezier(.2,.8,.2,1) both;
}
.cn-root.cn-closing { animation: cn-root-out .3s ease forwards; pointer-events: none; }

.cn-vignette {
    position: absolute;
    inset: 0;
    background: radial-gradient(ellipse at center, rgba(0,0,0,0) 28%, rgba(0,0,0,.4) 62%, rgba(0,0,0,.82) 100%);
    -webkit-backdrop-filter: blur(7px) saturate(.7);
    backdrop-filter: blur(7px) saturate(.7);
    -webkit-mask-image: radial-gradient(ellipse at center, transparent 22%, #000 78%);
    mask-image: radial-gradient(ellipse at center, transparent 22%, #000 78%);
}
.cn-vignette::after {
    content: "";
    position: absolute;
    inset: 0;
    box-shadow: inset 0 0 180px 40px rgba(0,0,0,.6);
}

.cn-card {
    position: relative;
    width: min(640px, calc(100vw - 32px));
    max-height: min(720px, calc(100vh - 48px));
    display: flex;
    flex-direction: column;
    border-radius: 20px;
    background: linear-gradient(180deg, rgba(30,31,36,.95), rgba(14,15,18,.97));
    -webkit-backdrop-filter: blur(24px);
    backdrop-filter: blur(24px);
    box-shadow:
        0 0 0 1px rgba(255,255,255,.08),
        0 30px 80px -10px rgba(0,0,0,.8),
        0 0 90px -22px rgba(106,164,255,.55),
        inset 0 1px 0 rgba(255,255,255,.06);
    overflow: hidden;
    animation: cn-card-in .55s cubic-bezier(.16,1,.3,1) both;
}
.cn-card::before {
    content: "";
    position: absolute;
    inset: 0 0 auto 0;
    height: 2px;
    z-index: 2;
    background: linear-gradient(90deg, transparent, #fff, var(--cn-glow), transparent);
    background-size: 200% 100%;
    animation: cn-shimmer 4s linear infinite;
}
.cn-card::after {
    content: "";
    position: absolute;
    top: -120px; left: 50%;
    width: 420px; height: 220px;
    transform: translateX(-50%);
    background: radial-gradient(closest-side, rgba(106,164,255,.22), transparent);
    pointer-events: none;
}

.cn-head { position: relative; z-index: 1; display: flex; gap: 14px; align-items: flex-start; padding: 22px 24px 14px; flex: none; }
.cn-badge {
    flex: none; width: 44px; height: 44px; border-radius: 14px;
    display: grid; place-items: center; position: relative;
    background: linear-gradient(145deg, #34363d, #14151a);
    box-shadow: 0 0 0 1px rgba(255,255,255,.12), 0 8px 24px -6px rgba(106,164,255,.55), inset 0 1px 0 rgba(255,255,255,.12);
}
.cn-badge svg { width: 22px; height: 22px; fill: #fff; }
.cn-badge.cn-pulse::after {
    content: ""; position: absolute; inset: -4px; border-radius: 18px;
    border: 2px solid var(--cn-glow);
    animation: cn-pulse 2.2s ease-out infinite;
}

.cn-titles { min-width: 0; flex: 1; }
.cn-kicker { font-size: 12px; color: var(--cn-dim); margin-bottom: 3px; letter-spacing: .02em; }
.cn-title { font-size: 19px; font-weight: 700; line-height: 1.3; overflow-wrap: anywhere; }
.cn-meta { display: flex; flex-wrap: wrap; gap: 6px 10px; margin-top: 8px; font-size: 12px; color: var(--cn-dim); align-items: center; }
.cn-chip {
    padding: 2px 9px; border-radius: 999px; background: rgba(255,255,255,.07);
    color: #e6e8ee; font-weight: 600; box-shadow: inset 0 0 0 1px rgba(255,255,255,.08);
}
.cn-chip.glow { background: rgba(106,164,255,.14); color: var(--cn-glow-2); box-shadow: inset 0 0 0 1px rgba(106,164,255,.35), 0 0 12px -3px rgba(106,164,255,.5); }
.cn-close {
    flex: none; width: 32px; height: 32px; border: 0; border-radius: 10px;
    background: transparent; color: var(--cn-dim); cursor: pointer; font-size: 18px; line-height: 1;
    transition: background .2s, color .2s, transform .2s;
}
.cn-close:hover { background: rgba(255,255,255,.09); color: #fff; transform: rotate(90deg); }

.cn-body {
    position: relative; z-index: 1; flex: 1; min-height: 80px; overflow-y: auto; padding: 0 14px 4px;
    scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.22) transparent;
}
.cn-body::-webkit-scrollbar { width: 6px; }
.cn-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,.22); border-radius: 6px; }

.cn-stats { display: flex; gap: 8px; padding: 2px 10px 10px; flex-wrap: wrap; }
.cn-stat {
    padding: 5px 11px; border-radius: 10px; font-size: 12px; color: var(--cn-dim);
    background: rgba(255,255,255,.04); box-shadow: inset 0 0 0 1px var(--cn-line);
}
.cn-stat b { color: #fff; font-weight: 700; margin-right: 4px; }

.cn-message {
    margin: 0 10px 10px; padding: 12px 14px; border-radius: 12px; font-size: 13px; line-height: 1.55;
    white-space: pre-wrap; overflow-wrap: anywhere; color: #d7d9df;
    background: rgba(255,255,255,.035); box-shadow: inset 0 0 0 1px var(--cn-line);
    border-left: 2px solid var(--cn-glow);
}

.cn-sectionlabel { padding: 8px 10px 6px; font-size: 12px; font-weight: 600; color: var(--cn-dim); display: flex; justify-content: space-between; text-transform: uppercase; letter-spacing: .06em; }

.cn-commit { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 10px; font-size: 13px; }
.cn-commit:hover { background: rgba(255,255,255,.04); }
.cn-commit .cn-sha { flex: none; font-family: "gg mono", ui-monospace, Consolas, monospace; font-size: 11px; color: var(--cn-glow-2); }
.cn-commit .cn-ct { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cn-commit .cn-ca { flex: none; font-size: 11px; color: var(--cn-faint); }

.cn-item { border-radius: 10px; }
.cn-item.open { background: rgba(255,255,255,.03); }
.cn-file {
    display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 10px; font-size: 13px; cursor: pointer;
    transition: background .2s, transform .2s;
    user-select: none;
}
.cn-file:hover { background: rgba(255,255,255,.05); transform: translateX(3px); }
.cn-chev { flex: none; width: 10px; color: var(--cn-faint); font-size: 10px; transition: transform .2s; }
.cn-item.open .cn-chev { transform: rotate(90deg); color: var(--cn-glow-2); }
.cn-tag {
    flex: none; width: 20px; height: 20px; border-radius: 6px; display: grid; place-items: center;
    font-size: 11px; font-weight: 800; font-family: ui-monospace, Consolas, monospace;
    background: rgba(255,255,255,.07); color: #cfd2da; box-shadow: inset 0 0 0 1px rgba(255,255,255,.1);
}
.cn-tag.added { background: #f4f5f7; color: #0b0c0e; box-shadow: 0 0 10px -2px rgba(255,255,255,.5); }
.cn-tag.removed { background: #1a1b1f; color: var(--cn-faint); text-decoration: line-through; }
.cn-tag.renamed, .cn-tag.copied { background: rgba(106,164,255,.16); color: var(--cn-glow-2); box-shadow: inset 0 0 0 1px rgba(106,164,255,.4); }
.cn-path {
    flex: 1; min-width: 0; direction: ltr; text-align: left; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; font-family: "gg mono", ui-monospace, Consolas, monospace;
}
.cn-path b { font-weight: 600; color: #fff; }
.cn-path span { color: var(--cn-dim); }
.cn-delta { flex: none; font-size: 11px; font-family: ui-monospace, Consolas, monospace; }
.cn-delta i { font-style: normal; color: #f4f5f7; margin-right: 6px; }
.cn-delta u { text-decoration: none; color: var(--cn-faint); }

.cn-patch {
    display: none; margin: 0 10px 10px; border-radius: 10px; overflow: auto; max-height: 280px;
    background: #0a0b0d; box-shadow: inset 0 0 0 1px var(--cn-line);
    font-family: "gg mono", ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.5;
    scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.22) transparent;
}
.cn-item.open .cn-patch { display: block; }
.cn-pl { padding: 0 12px; white-space: pre; direction: ltr; text-align: left; color: var(--cn-dim); min-width: max-content; }
.cn-pl.add { background: rgba(255,255,255,.09); color: #fff; }
.cn-pl.del { background: rgba(0,0,0,.55); color: var(--cn-faint); }
.cn-pl.hunk { background: rgba(106,164,255,.1); color: var(--cn-glow-2); }
.cn-pnote { padding: 10px 12px; font-size: 12px; color: var(--cn-faint); }

.cn-empty { padding: 26px 24px; text-align: center; color: var(--cn-dim); font-size: 14px; line-height: 1.6; }
.cn-empty small { display: block; margin-top: 6px; color: var(--cn-faint); font-size: 12px; }

.cn-status { position: relative; z-index: 1; flex: none; min-height: 18px; padding: 10px 24px 0; font-size: 12px; color: var(--cn-dim); transition: color .2s; }
.cn-status.err { color: #fff; }
.cn-status.err::before { content: "\\26A0  "; color: var(--cn-glow-2); }

.cn-actions { position: relative; z-index: 1; flex: none; display: flex; gap: 10px; padding: 12px 24px 22px; }
.cn-actions .cn-btn { min-width: 0; padding-inline: 8px; font-size: 13px; }
.cn-btn {
    flex: 1; height: 44px; border-radius: 12px; border: 0; font: inherit; font-size: 14px; font-weight: 700;
    cursor: pointer; position: relative; overflow: hidden;
    transition: transform .2s cubic-bezier(.2,.8,.2,1), box-shadow .25s, background .25s, opacity .2s;
}
.cn-btn:active { transform: scale(.97); }
.cn-btn:disabled { opacity: .45; cursor: not-allowed; transform: none; }
.cn-btn:focus-visible { outline: 2px solid var(--cn-glow); outline-offset: 2px; }

.cn-btn.ghost { background: rgba(255,255,255,.06); color: var(--cn-text); box-shadow: inset 0 0 0 1px rgba(255,255,255,.1); }
.cn-btn.ghost:hover:not(:disabled) { background: rgba(255,255,255,.11); transform: translateY(-1px); box-shadow: inset 0 0 0 1px rgba(106,164,255,.45), 0 0 16px -4px rgba(106,164,255,.5); }

.cn-btn.primary { background: linear-gradient(180deg, #ffffff, #cfd3db); color: #0b0c0e; box-shadow: 0 10px 28px -10px rgba(255,255,255,.35), 0 0 0 1px rgba(255,255,255,.4); }
.cn-btn.primary::after {
    content: ""; position: absolute; inset: 0;
    background: linear-gradient(110deg, transparent 30%, rgba(106,164,255,.45) 50%, transparent 70%);
    transform: translateX(-120%); transition: transform .7s ease;
}
.cn-btn.primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 14px 34px -8px rgba(106,164,255,.75), 0 0 0 1px rgba(255,255,255,.5); }
.cn-btn.primary:hover:not(:disabled)::after { transform: translateX(120%); }

.cn-spin::before {
    content: ""; display: inline-block; width: 12px; height: 12px; margin-right: 8px;
    border: 2px solid rgba(128,128,128,.4); border-top-color: currentColor; border-radius: 50%;
    vertical-align: -1px; animation: cn-rot .7s linear infinite;
}

/* settings panel buttons */
.cn-settings { display: flex; flex-wrap: wrap; gap: 10px; margin: 8px 0 16px; }
.cn-sbtn {
    height: 38px; padding: 0 16px; border-radius: 10px; border: 0; cursor: pointer; font: inherit; font-size: 14px; font-weight: 600;
    color: #f4f5f7; background: linear-gradient(180deg, #2b2d33, #1b1c20);
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.1), 0 6px 18px -8px rgba(106,164,255,.5);
    transition: transform .2s, box-shadow .25s, opacity .2s;
}
.cn-sbtn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: inset 0 0 0 1px rgba(106,164,255,.55), 0 8px 22px -6px rgba(106,164,255,.7); }
.cn-sbtn:disabled { opacity: .5; cursor: not-allowed; }
.cn-sbtn.main { background: linear-gradient(180deg, #ffffff, #cfd3db); color: #0b0c0e; }

@keyframes cn-root-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes cn-root-out { to { opacity: 0; } }
@keyframes cn-card-in { from { opacity: 0; transform: translateY(18px) scale(.94); } to { opacity: 1; transform: none; } }
@keyframes cn-shimmer { to { background-position: -200% 0; } }
@keyframes cn-pulse { 0% { opacity: .9; transform: scale(1); } 100% { opacity: 0; transform: scale(1.5); } }
@keyframes cn-rot { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
    .cn-root, .cn-card, .cn-card::before, .cn-badge::after, .cn-btn, .cn-file { animation: none !important; transition: none !important; }
}
`;

const ICON_UPDATE =
    '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 8.5 6h-2.2A7 7 0 1 1 12 5c1.6 0 3 .5 4.2 1.4L13 9.6h8V1.6l-2.8 2.8A8.9 8.9 0 0 0 12 3z"/></svg>';
const ICON_OK =
    '<svg viewBox="0 0 24 24"><path d="M9.2 16.6 4.9 12.3l-1.4 1.4 5.7 5.7L20.5 8.1l-1.4-1.4z"/></svg>';

const STATUS_LETTER: Record<string, string> = {
    added: "A",
    removed: "D",
    modified: "M",
    changed: "M",
    renamed: "R",
    copied: "C"
};

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
}

function timeAgo(iso: string) {
    if (!iso) return "";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}

function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = h("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.append(style);
}

let root: HTMLElement | null = null;
let currentInfo: UpdateInfo | null = null;
let pendingInfo: UpdateInfo | null = null;
let previewMode = false;
let busy = false;

function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && root) {
        e.preventDefault();
        e.stopPropagation();
        closeModal();
        return;
    }

    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        e.stopPropagation();
        void showPreview();
    }
}

function closeModal(markSeen = true) {
    if (!root) return;
    if (markSeen && !previewMode && currentInfo) settings.store.lastSeenSha = currentInfo.sha;
    const el = root;
    root = null;
    previewMode = false;
    el.classList.add("cn-closing");
    setTimeout(() => el.remove(), 300);
}

function setStatus(message: string, isError = false) {
    const el = document.getElementById("cn-status");
    if (!el) return;
    el.textContent = message;
    el.classList.toggle("err", isError);
}

function buildPatch(file: CommitFile) {
    const box = h("div", "cn-patch");

    if (!file.patch) {
        box.append(h("div", "cn-pnote", "No diff available for this file (binary, renamed without changes, or too large)."));
        return box;
    }

    const lines = file.patch.split("\n");
    const shown = lines.slice(0, MAX_PATCH_LINES);

    for (const line of shown) {
        const kind = line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
        box.append(h("div", "cn-pl" + (kind ? " " + kind : ""), line || " "));
    }

    if (lines.length > shown.length) {
        box.append(h("div", "cn-pnote", `\u2026 ${lines.length - shown.length} more lines (open the commit on GitHub to see everything)`));
    }

    return box;
}

function buildFileRow(file: CommitFile, index: number) {
    const item = h("div", "cn-item");
    item.style.animation = `cn-card-in .5s ${Math.min(index, 14) * 35}ms cubic-bezier(.16,1,.3,1) both`;

    const row = h("div", "cn-file");
    row.title = file.previous_filename ? `${file.previous_filename} \u2192 ${file.filename}` : file.filename;

    const path = h("span", "cn-path");
    const slash = file.filename.lastIndexOf("/");
    if (slash >= 0) {
        path.append(h("span", "", file.filename.slice(0, slash + 1)), h("b", "", file.filename.slice(slash + 1)));
    } else {
        path.append(h("b", "", file.filename));
    }

    const delta = h("span", "cn-delta");
    delta.append(h("i", "", `+${file.additions}`), h("u", "", `\u2212${file.deletions}`));

    const tag = h("span", `cn-tag ${file.status}`, STATUS_LETTER[file.status] ?? "M");
    tag.title = file.status;

    row.append(h("span", "cn-chev", "\u25B6"), tag, path, delta);

    let patch: HTMLElement | null = null;
    row.onclick = () => {
        if (!patch) {
            patch = buildPatch(file);
            item.append(patch);
        }
        item.classList.toggle("open");
    };

    item.append(row);
    return item;
}

function buildCard(info: UpdateInfo | null, statusMessage = "", isError = false, preview = false) {
    const card = h("div", "cn-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");

    const head = h("div", "cn-head");
    const badge = h("div", "cn-badge " + (info ? "cn-pulse" : ""));
    badge.innerHTML = info ? ICON_UPDATE : ICON_OK;

    const titles = h("div", "cn-titles");
    titles.append(
        h("div", "cn-kicker", info ? "New update available" : "Updates"),
        h("div", "cn-title", info ? info.title : "You're up to date")
    );

    if (info) {
        const meta = h("div", "cn-meta");
        meta.append(h("span", "cn-chip glow", info.sha.slice(0, 7)), h("span", "", info.author));
        const when = timeAgo(info.date);
        if (when) meta.append(h("span", "", when));
        if (info.extraCommits > 0) {
            meta.append(h("span", "cn-chip", `+${info.extraCommits} more commit${info.extraCommits > 1 ? "s" : ""}`));
        }
        if (preview) meta.append(h("span", "cn-chip", "Preview"));
        titles.append(meta);
    }

    const closeBtn = h("button", "cn-close", "\u2715");
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.onclick = () => closeModal();
    head.append(badge, titles, closeBtn);
    card.append(head);

    const body = h("div", "cn-body");

    if (info) {
        const adds = info.files.reduce((n, f) => n + (f.additions || 0), 0);
        const dels = info.files.reduce((n, f) => n + (f.deletions || 0), 0);

        const stats = h("div", "cn-stats");
        for (const [value, label] of [
            [String(info.files.length), "files changed"],
            [`+${adds}`, "additions"],
            [`\u2212${dels}`, "deletions"],
            [String(info.commits.length), info.commits.length === 1 ? "commit" : "commits"]
        ]) {
            const stat = h("span", "cn-stat");
            stat.append(h("b", "", value), label);
            stats.append(stat);
        }
        body.append(stats);

        if (info.body) body.append(h("div", "cn-message", info.body));

        if (info.commits.length > 1) {
            const label = h("div", "cn-sectionlabel");
            label.append(h("span", "", "Commits"), h("span", "", String(info.commits.length)));
            body.append(label);

            for (const c of info.commits) {
                const row = h("div", "cn-commit");
                row.title = c.title;
                row.append(
                    h("span", "cn-sha", c.sha.slice(0, 7)),
                    h("span", "cn-ct", c.title),
                    h("span", "cn-ca", [c.author, timeAgo(c.date)].filter(Boolean).join(" \u00B7 "))
                );
                body.append(row);
            }
        }

        const label = h("div", "cn-sectionlabel");
        label.append(h("span", "", "Changed files"), h("span", "", String(info.files.length)));
        body.append(label);

        if (!info.files.length) body.append(h("div", "cn-empty", "No files to show"));
        info.files.forEach((file, i) => body.append(buildFileRow(file, i)));
    } else {
        const empty = h("div", "cn-empty", "You're running the latest version.");
        empty.append(h("small", "", `Current build: ${String(gitHash).slice(0, 7)}`));
        body.append(empty);
    }

    card.append(body);

    const status = h("div", "cn-status" + (isError ? " err" : ""), statusMessage || info?.note || "");
    status.id = "cn-status";
    card.append(status);

    const actions = h("div", "cn-actions");
    const previewBtn = h("button", "cn-btn ghost", "Preview");
    const checkBtn = h("button", "cn-btn ghost", "Check for updates");
    const updateBtn = h("button", "cn-btn primary", "Update Now");
    checkBtn.id = "cn-check";
    updateBtn.disabled = preview || !info;
    previewBtn.onclick = () => void showPreview();
    checkBtn.onclick = () => void runCheck(true);
    updateBtn.onclick = () => applyUpdate(updateBtn, checkBtn);
    actions.append(previewBtn, checkBtn, updateBtn);
    card.append(actions);

    return card;
}

function showModal(info: UpdateInfo | null, statusMessage = "", isError = false, preview = false) {
    injectStyle();
    currentInfo = info;
    previewMode = preview;

    if (!root) {
        root = h("div", "cn-root");
        const vignette = h("div", "cn-vignette");
        vignette.onclick = () => closeModal();
        root.append(vignette);
        document.body.append(root);
    } else {
        root.querySelector(".cn-card")?.remove();
    }

    const card = buildCard(info, statusMessage, isError, preview);
    if (root.dataset.shown) card.style.animation = "none";
    root.dataset.shown = "1";
    root.append(card);
    card.querySelector<HTMLElement>(".cn-btn.primary:not(:disabled)")?.focus();
}

/** Opens the window on demand (from settings) without hitting the network. */
function openWindow() {
    if (pendingInfo) showModal(pendingInfo);
    else showModal(null, "Press \u201CCheck for updates\u201D to look for a new commit");
}

async function showPreview() {
    if (busy) return;
    busy = true;
    setStatus("Loading preview...");

    try {
        const result = await getPreviewInfo();
        if (!result) {
            showModal(null, "Couldn't load the latest commit for preview", true);
            return;
        }

        if (result.isReal) {
            pendingInfo = result.info;
            showModal(result.info);
        } else {
            showModal(result.info, result.info.note ?? "Preview only \u2014 you're already on the latest commit, so Update Now is disabled", false, true);
        }
    } catch (e: any) {
        console.error("[CommitNotifier]", e);
        showModal(null, `Preview failed: ${e?.message ?? e}`, true);
    } finally {
        busy = false;
    }
}

async function runCheck(manual: boolean) {
    if (busy) return;
    busy = true;

    const btn = document.getElementById("cn-check") as HTMLButtonElement | null;
    if (btn) {
        btn.disabled = true;
        btn.classList.add("cn-spin");
    }
    setStatus("Checking...");

    try {
        const info = await getUpdateInfo();
        pendingInfo = info;
        if (info) {
            if (manual || settings.store.lastSeenSha !== info.sha) showModal(info);
        } else if (manual) {
            showModal(null, "Checked just now \u2014 no new commits");
        }
    } catch (e: any) {
        console.error("[CommitNotifier]", e);
        if (manual) {
            const msg = `Check failed: ${e?.message ?? e}`;
            if (root) setStatus(msg, true);
            else showModal(null, msg, true);
        }
    } finally {
        busy = false;
        const b = document.getElementById("cn-check") as HTMLButtonElement | null;
        if (b) {
            b.disabled = false;
            b.classList.remove("cn-spin");
        }
    }
}

async function applyUpdate(updateBtn: HTMLButtonElement, checkBtn: HTMLButtonElement) {
    if (typeof IS_UPDATER_DISABLED !== "undefined" && IS_UPDATER_DISABLED) {
        setStatus("The updater is disabled in this build", true);
        return;
    }

    updateBtn.disabled = checkBtn.disabled = true;
    updateBtn.classList.add("cn-spin");
    updateBtn.textContent = "Updating...";
    setStatus("Pulling changes and rebuilding...");

    try {
        const ok = await update();
        if (!ok) throw new Error("Update could not be applied");

        if (currentInfo) settings.store.lastSeenSha = currentInfo.sha;
        setStatus("Updated, restarting...");
        setTimeout(() => relaunch(), 900);
    } catch (e: any) {
        console.error("[CommitNotifier]", e);
        updateBtn.classList.remove("cn-spin");
        updateBtn.textContent = "Update Now";
        updateBtn.disabled = checkBtn.disabled = false;
        setStatus(`Update failed: ${e?.message ?? e}`, true);
    }
}

function SettingsActions() {
    injectStyle();
    const [checking, setChecking] = useState(false);

    return (
        <div className="cn-settings">
            <button className="cn-sbtn main" onClick={() => openWindow()}>
                Open update window
            </button>
            <button
                className="cn-sbtn"
                disabled={checking}
                onClick={async () => {
                    setChecking(true);
                    try {
                        await runCheck(true);
                    } finally {
                        setChecking(false);
                    }
                }}
            >
                {checking ? "Checking..." : "Check for updates"}
            </button>
            <button className="cn-sbtn" onClick={() => void showPreview()}>
                Preview
            </button>
        </div>
    );
}

let timer: ReturnType<typeof setInterval> | undefined;
let startTimeout: ReturnType<typeof setTimeout> | undefined;

export default definePlugin({
    name: "UpdateNotifier",
    description: "Notifies you when the watched repository has a new commit and lets you update from a popup",
    authors: [Devs.phklie],
    required: true,
    settings,

    start() {
        injectStyle();
        document.addEventListener("keydown", onKey, true);

        if (settings.store.checkOnStart) {
            startTimeout = setTimeout(() => runCheck(false), 5000);
        }

        const minutes = Math.max(5, Number(settings.store.intervalMinutes) || 10);
        timer = setInterval(() => runCheck(false), minutes * 60_000);
    },

    stop() {
        document.removeEventListener("keydown", onKey, true);
        clearInterval(timer);
        clearTimeout(startTimeout);
        closeModal(false);
        document.getElementById(STYLE_ID)?.remove();
    }
});
