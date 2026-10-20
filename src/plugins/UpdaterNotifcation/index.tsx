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
        description: "Optional GitHub token (only used for the changed files lookup)",
        default: ""
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
}

interface UpdateInfo {
    sha: string;
    title: string;
    author: string;
    date: string;
    url: string;
    extraCommits: number;
    files: CommitFile[];
    note?: string;
}

const API = "https://api.github.com";
const STYLE_ID = "vc-commit-notifier-style";

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

async function getLatestCommit() {
    const { repo, branch } = settings.store;
    const ref = encodeURIComponent(branch.trim() || "main");

    const res = await request(`${API}/repos/${repo}/commits/${ref}`, { Accept: "application/vnd.github+json" });
    if (res.status !== 200) throw new Error(`GitHub responded with ${res.status}`);

    const commit = JSON.parse(res.text);
    const sha = commit.sha as string;
    if (!sha) return null;

    return {
        sha,
        title: commit.commit?.message?.split("\n")[0]?.trim() || sha.slice(0, 7),
        author: commit.commit?.author?.name ?? commit.author?.login ?? "unknown",
        date: commit.commit?.author?.date ?? "",
        url: commit.html_url ?? `https://github.com/${repo}/commit/${sha}`
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
    let info: UpdateInfo = { ...latest, extraCommits: 0, files: [] };

    try {
        try {
            const cmp = await gh<any>(`/repos/${repo}/compare/${gitHash}...${latest.sha}`);
            if (cmp.status === "behind" || cmp.status === "identical") return null;
            info = {
                ...info,
                extraCommits: Math.max(0, (cmp.total_commits ?? 1) - 1),
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

const CSS = /* css */ `
.cn-root {
    --cn-accent: #8b7cff;
    --cn-accent-2: #ff7ad9;
    --cn-add: #4ade80;
    --cn-del: #fb7185;
    --cn-mod: #fbbf24;
    --cn-ren: #60a5fa;
    --cn-text: #f1f0ff;
    --cn-dim: #a09fc0;
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
    background: radial-gradient(ellipse at center, rgba(0,0,0,0) 28%, rgba(0,0,0,.35) 62%, rgba(0,0,0,.78) 100%);
    -webkit-backdrop-filter: blur(7px) saturate(.85);
    backdrop-filter: blur(7px) saturate(.85);
    -webkit-mask-image: radial-gradient(ellipse at center, transparent 22%, #000 78%);
    mask-image: radial-gradient(ellipse at center, transparent 22%, #000 78%);
}
.cn-vignette::after {
    content: "";
    position: absolute;
    inset: 0;
    box-shadow: inset 0 0 180px 40px rgba(0,0,0,.55);
}

.cn-card {
    position: relative;
    width: min(560px, calc(100vw - 32px));
    max-height: min(640px, calc(100vh - 48px));
    display: flex;
    flex-direction: column;
    border-radius: 22px;
    background: linear-gradient(180deg, rgba(36,34,56,.92), rgba(22,21,36,.94));
    -webkit-backdrop-filter: blur(24px);
    backdrop-filter: blur(24px);
    box-shadow: 0 0 0 1px rgba(255,255,255,.07), 0 30px 80px -10px rgba(0,0,0,.7), 0 0 90px -20px rgba(139,124,255,.45);
    overflow: hidden;
    animation: cn-card-in .55s cubic-bezier(.16,1,.3,1) both;
}
.cn-card::before {
    content: "";
    position: absolute;
    inset: 0 0 auto 0;
    height: 2px;
    background: linear-gradient(90deg, transparent, var(--cn-accent), var(--cn-accent-2), transparent);
    background-size: 200% 100%;
    animation: cn-shimmer 4s linear infinite;
}

.cn-head { display: flex; gap: 14px; align-items: flex-start; padding: 22px 24px 14px; }
.cn-badge {
    flex: none; width: 44px; height: 44px; border-radius: 14px;
    display: grid; place-items: center; position: relative;
    background: linear-gradient(135deg, var(--cn-accent), var(--cn-accent-2));
    box-shadow: 0 8px 24px -6px rgba(139,124,255,.7);
}
.cn-badge svg { width: 22px; height: 22px; fill: #fff; }
.cn-badge.cn-pulse::after {
    content: ""; position: absolute; inset: -4px; border-radius: 18px;
    border: 2px solid var(--cn-accent);
    animation: cn-pulse 2.2s ease-out infinite;
}
.cn-badge.cn-ok { background: linear-gradient(135deg, #34d399, #22d3ee); box-shadow: 0 8px 24px -6px rgba(52,211,153,.6); }

.cn-titles { min-width: 0; flex: 1; }
.cn-kicker { font-size: 12px; color: var(--cn-dim); margin-bottom: 3px; }
.cn-title { font-size: 19px; font-weight: 700; line-height: 1.3; overflow-wrap: anywhere; }
.cn-meta { display: flex; flex-wrap: wrap; gap: 6px 10px; margin-top: 8px; font-size: 12px; color: var(--cn-dim); }
.cn-chip { padding: 2px 9px; border-radius: 999px; background: rgba(139,124,255,.14); color: #c9c2ff; font-weight: 600; }
.cn-close {
    flex: none; width: 32px; height: 32px; border: 0; border-radius: 10px;
    background: transparent; color: var(--cn-dim); cursor: pointer; font-size: 18px; line-height: 1;
    transition: background .2s, color .2s, transform .2s;
}
.cn-close:hover { background: rgba(255,255,255,.08); color: #fff; transform: rotate(90deg); }

.cn-sectionlabel { padding: 4px 24px 8px; font-size: 12px; font-weight: 600; color: var(--cn-dim); display: flex; justify-content: space-between; }

.cn-files {
    margin: 0 14px; padding: 0 10px 4px; overflow-y: auto; min-height: 60px;
    scrollbar-width: thin; scrollbar-color: rgba(139,124,255,.4) transparent;
}
.cn-files::-webkit-scrollbar { width: 6px; }
.cn-files::-webkit-scrollbar-thumb { background: rgba(139,124,255,.4); border-radius: 6px; }

.cn-file {
    display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 10px; font-size: 13px;
    transition: background .2s, transform .2s;
}
.cn-file:hover { background: rgba(255,255,255,.05); transform: translateX(3px); }
.cn-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; }
.cn-dot.added { background: var(--cn-add); box-shadow: 0 0 8px var(--cn-add); }
.cn-dot.removed { background: var(--cn-del); box-shadow: 0 0 8px var(--cn-del); }
.cn-dot.modified, .cn-dot.changed { background: var(--cn-mod); box-shadow: 0 0 8px var(--cn-mod); }
.cn-dot.renamed { background: var(--cn-ren); box-shadow: 0 0 8px var(--cn-ren); }
.cn-path {
    flex: 1; min-width: 0; direction: ltr; text-align: left; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; font-family: "gg mono", ui-monospace, Consolas, monospace;
}
.cn-path b { font-weight: 600; color: #fff; }
.cn-path span { color: var(--cn-dim); }
.cn-delta { flex: none; font-size: 11px; font-family: ui-monospace, Consolas, monospace; }
.cn-delta i { font-style: normal; color: var(--cn-add); margin-right: 6px; }
.cn-delta u { text-decoration: none; color: var(--cn-del); }

.cn-empty { padding: 26px 24px; text-align: center; color: var(--cn-dim); font-size: 14px; }

.cn-status { min-height: 18px; padding: 10px 24px 0; font-size: 12px; color: var(--cn-dim); transition: color .2s; }
.cn-status.err { color: var(--cn-del); }

.cn-actions { display: flex; gap: 10px; padding: 12px 24px 22px; }
.cn-actions .cn-btn { min-width: 0; padding-inline: 8px; font-size: 12px; }
.cn-btn {
    flex: 1; height: 44px; border-radius: 12px; border: 0; font: inherit; font-size: 14px; font-weight: 700;
    cursor: pointer; position: relative; overflow: hidden;
    transition: transform .2s cubic-bezier(.2,.8,.2,1), box-shadow .25s, background .25s, opacity .2s;
}
.cn-btn:active { transform: scale(.97); }
.cn-btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }
.cn-btn:focus-visible { outline: 2px solid var(--cn-accent-2); outline-offset: 2px; }

.cn-btn.ghost { background: rgba(255,255,255,.06); color: var(--cn-text); box-shadow: inset 0 0 0 1px rgba(255,255,255,.1); }
.cn-btn.ghost:hover:not(:disabled) { background: rgba(255,255,255,.11); transform: translateY(-1px); }

.cn-btn.primary { background: linear-gradient(135deg, var(--cn-accent), var(--cn-accent-2)); color: #fff; box-shadow: 0 10px 28px -8px rgba(139,124,255,.8); }
.cn-btn.primary::after {
    content: ""; position: absolute; inset: 0;
    background: linear-gradient(110deg, transparent 30%, rgba(255,255,255,.35) 50%, transparent 70%);
    transform: translateX(-120%); transition: transform .7s ease;
}
.cn-btn.primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 14px 34px -8px rgba(255,122,217,.7); }
.cn-btn.primary:hover:not(:disabled)::after { transform: translateX(120%); }

.cn-spin::before {
    content: ""; display: inline-block; width: 12px; height: 12px; margin-right: 8px;
    border: 2px solid rgba(255,255,255,.35); border-top-color: #fff; border-radius: 50%;
    vertical-align: -1px; animation: cn-rot .7s linear infinite;
}

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

function buildCard(info: UpdateInfo | null, statusMessage = "", isError = false, preview = false) {
    const card = h("div", "cn-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");

    const head = h("div", "cn-head");
    const badge = h("div", "cn-badge " + (info ? "cn-pulse" : "cn-ok"));
    badge.innerHTML = info ? ICON_UPDATE : ICON_OK;

    const titles = h("div", "cn-titles");
    titles.append(
        h("div", "cn-kicker", preview ? "Theme preview" : info ? "New update available" : "Updates"),
        h("div", "cn-title", info ? info.title : "You're up to date")
    );

    if (info) {
        const meta = h("div", "cn-meta");
        meta.append(h("span", "cn-chip", info.sha.slice(0, 7)), h("span", "", info.author));
        const when = timeAgo(info.date);
        if (when) meta.append(h("span", "", when));
        if (info.extraCommits > 0) {
            meta.append(h("span", "cn-chip", `+${info.extraCommits} more commit${info.extraCommits > 1 ? "s" : ""}`));
        }
        titles.append(meta);
    }

    const closeBtn = h("button", "cn-close", "\u2715");
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.onclick = () => closeModal();
    head.append(badge, titles, closeBtn);
    card.append(head);

    if (info) {
        const label = h("div", "cn-sectionlabel");
        label.append(h("span", "", "Changed files"), h("span", "", String(info.files.length)));
        card.append(label);

        const list = h("div", "cn-files");
        if (!info.files.length) list.append(h("div", "cn-empty", "No files to show"));

        info.files.forEach((file, i) => {
            const row = h("div", "cn-file");
            row.style.animation = `cn-card-in .5s ${Math.min(i, 14) * 35}ms cubic-bezier(.16,1,.3,1) both`;
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

            row.append(h("span", `cn-dot ${file.status}`), path, delta);
            list.append(row);
        });
        card.append(list);
    }

    const status = h("div", "cn-status" + (isError ? " err" : ""), statusMessage || info?.note || "");
    status.id = "cn-status";
    card.append(status);

    const actions = h("div", "cn-actions");
    const previewBtn = h("button", "cn-btn ghost", "Preview theme");
    const checkBtn = h("button", "cn-btn ghost", preview ? "Close preview" : "Check for update");
    const updateBtn = h("button", "cn-btn primary", preview ? "Preview only" : "Update Now");
    updateBtn.disabled = preview || !info;
    previewBtn.onclick = () => void showPreview();
    checkBtn.onclick = () => preview ? closeModal(false) : runCheck(true);
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
    card.querySelector<HTMLElement>(".cn-btn.primary")?.focus();
}

async function showPreview() {
    try {
        const latest = await getLatestCommit();
        if (!latest) {
            showModal(null, "Couldn't load the latest commit for preview", true, true);
            return;
        }

        const info: UpdateInfo = { ...latest, extraCommits: 0, files: [] };
        showModal(info, "Preview only — update is disabled", false, true);
    } catch (e: any) {
        showModal(null, `Preview failed: ${e?.message ?? e}`, true, true);
    }
}

async function runCheck(manual: boolean) {
    if (busy) return;
    busy = true;

    const btn = root?.querySelector<HTMLButtonElement>(".cn-btn.ghost");
    if (btn) {
        btn.disabled = true;
        btn.classList.add("cn-spin");
    }
    setStatus("Checking...");

    try {
        const info = await getUpdateInfo();
        if (info) {
            if (manual || settings.store.lastSeenSha !== info.sha) showModal(info);
        } else if (manual) {
            showModal(null);
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
        const b = root?.querySelector<HTMLButtonElement>(".cn-btn.ghost");
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

let timer: ReturnType<typeof setInterval> | undefined;
let startTimeout: ReturnType<typeof setTimeout> | undefined;

export default definePlugin({
    name: "CommitNotifier",
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
