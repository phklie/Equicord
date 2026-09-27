/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { Devs } from "@utils/constants";
import { Forms, IconUtils, React, showToast, Toasts, UserStore } from "@webpack/common";

const OVERLAY_ID = "vcl-overlay";

const PASSWORD_TYPE_OPTIONS = [
    { label: "Numbers only", value: "numeric", default: false },
    { label: "Letters & numbers", value: "alnum", default: true },
];

const PIN_LENGTH_OPTIONS = [
    { label: "4 digits", value: "4", default: true },
    { label: "6 digits", value: "6", default: false },
    { label: "Custom", value: "custom", default: false },
];

function getPinLength(): number {
    const mode = settings.store.pinLength;
    if (mode === "4") return 4;
    if (mode === "6") return 6;
    const custom = Number(settings.store.pinLengthCustom);
    return custom > 0 ? Math.floor(custom) : 4;
}

// ─── Password field (masked, local state, commits on blur so typing/backspace always works) ─

function PasswordSettingComponent() {
    const [value, setValue] = React.useState(settings.store.password);

    const commit = () => { settings.store.password = value; };

    const isNumeric = settings.store.passwordType === "numeric";
    const requiredLen = getPinLength();
    const mismatch = isNumeric && value.length > 0 && value.length !== requiredLen;

    return (
        <>
            <input
                type="password"
                value={value}
                placeholder="Set an unlock password"
                autoComplete="new-password"
                spellCheck={false}
                onChange={e => {
                    let v = e.target.value;
                    if (isNumeric) {
                        v = v.replace(/[^0-9]/g, "");
                        if (v.length > requiredLen) v = v.slice(0, requiredLen);
                    }
                    setValue(v);
                }}
                onBlur={commit}
                onKeyDown={e => {
                    if (e.key === "Enter") { commit(); (e.target as HTMLInputElement).blur(); }
                }}
                style={{
                    width: "100%",
                    padding: "10px 12px",
                    borderRadius: "12px",
                    border: mismatch ? "1px solid rgb(242, 63, 66)" : "1px solid var(--input-border, #4e5058)",
                    background: "var(--input-background, #1e1f22)",
                    color: "var(--text-normal, #dbdee1)",
                    fontSize: "16px",
                    outline: "none",
                    boxSizing: "border-box",
                    transition: "border-color 0.15s ease, background 0.15s ease",
                }}
            />
            <Forms.FormText style={{ marginTop: "6px", opacity: mismatch ? 0.9 : 0.6, fontSize: "12px", color: mismatch ? "rgb(242, 63, 66)" : undefined }}>
                {isNumeric
                    ? mismatch
                        ? `Type ${requiredLen - value.length} more digit${requiredLen - value.length === 1 ? "" : "s"} to complete the PIN.`
                        : `Digits only, up to ${requiredLen} digits.`
                    : "Letters and numbers only."} Leave empty to disable the lock.
            </Forms.FormText>
        </>
    );
}

const settings = definePluginSettings({
    password: {
        type: OptionType.COMPONENT,
        description: "Unlock password",
        component: () => <PasswordSettingComponent />,
    },
    passwordType: {
        type: OptionType.SELECT,
        description: "Allowed password characters — also changes the lock screen style (numeric = PIN style)",
        options: PASSWORD_TYPE_OPTIONS,
        restartNeeded: false,
    },
    pinLength: {
        type: OptionType.SELECT,
        description: "PIN length (only used when password type is Numbers only)",
        options: PIN_LENGTH_OPTIONS,
        restartNeeded: false,
    },
    pinLengthCustom: {
        type: OptionType.NUMBER,
        description: "Custom PIN length (used when PIN length above is set to Custom)",
        default: 5,
        restartNeeded: false,
    },
    autoLockMinutes: {
        type: OptionType.NUMBER,
        description: "Auto-lock after N minutes of inactivity (0 = disabled)",
        default: 5,
        restartNeeded: false,
    },
    blurAmount: {
        type: OptionType.SLIDER,
        description: "Blur intensity",
        default: 18,
        markers: [0, 4, 8, 12, 16, 20, 24, 28, 32],
        restartNeeded: false,
    },
    shortcut: {
        type: OptionType.STRING,
        description: "Manual lock keyboard shortcut (e.g. Ctrl+L, Alt+K, Ctrl+Shift+P)",
        default: "Ctrl+L",
        restartNeeded: false,
    },
});

// ─── State ────────────────────────────────────────────────────────────

let overlay: HTMLDivElement | null = null;
let domObserver: MutationObserver | null = null;
let keyGuard: ((e: KeyboardEvent) => void) | null = null;
let focusGuard: ((e: FocusEvent) => void) | null = null;
let inactiveTimer: ReturnType<typeof setTimeout> | null = null;
let shortcutListener: ((e: KeyboardEvent) => void) | null = null;
let loadLockListener: (() => void) | null = null;

const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "scroll", "touchstart"] as const;

// ─── Activity / auto-lock timer ────────────────────────────────────────

function onActivity() {
    if (overlay) return;
    if (inactiveTimer) clearTimeout(inactiveTimer);
    const mins = settings.store.autoLockMinutes;
    if (mins > 0) inactiveTimer = setTimeout(lock, mins * 60_000);
}

function bindActivity() {
    ACTIVITY_EVENTS.forEach(ev => document.addEventListener(ev, onActivity, { passive: true }));
    onActivity();
}

function unbindActivity() {
    ACTIVITY_EVENTS.forEach(ev => document.removeEventListener(ev, onActivity));
    if (inactiveTimer) { clearTimeout(inactiveTimer); inactiveTimer = null; }
}

// ─── Manual shortcut (configurable) ─────────────────────────────────────

function parseShortcut(raw: string) {
    const parts = (raw || "").split("+").map(p => p.trim()).filter(Boolean);
    let ctrl = false, alt = false, shift = false, key = "";
    for (const p of parts) {
        const low = p.toLowerCase();
        if (low === "ctrl" || low === "control") ctrl = true;
        else if (low === "alt") alt = true;
        else if (low === "shift") shift = true;
        else key = p;
    }
    return { ctrl, alt, shift, key: key.toLowerCase() };
}

function bindShortcut() {
    shortcutListener = (e: KeyboardEvent) => {
        if (overlay) return;
        const { ctrl, alt, shift, key } = parseShortcut(settings.store.shortcut);
        if (!key) return;
        if (e.ctrlKey === ctrl && e.altKey === alt && e.shiftKey === shift && e.key.toLowerCase() === key) {
            e.preventDefault();
            e.stopPropagation();
            lock();
        }
    };
    document.addEventListener("keydown", shortcutListener, true);
}

function unbindShortcut() {
    if (shortcutListener) {
        document.removeEventListener("keydown", shortcutListener, true);
        shortcutListener = null;
    }
}

// ─── Lock / unlock ──────────────────────────────────────────────────────

function lock() {
    if (!settings.store.password) {
        showToast("Set an unlock password in DiscordLock settings first", Toasts.Type.FAILURE);
        return;
    }
    if (settings.store.passwordType === "numeric" && settings.store.password.length !== getPinLength()) {
        showToast(`Your password must be exactly ${getPinLength()} digits — check DiscordLock settings`, Toasts.Type.FAILURE);
        return;
    }
    unbindActivity();
    if (!document.getElementById(OVERLAY_ID)) createOverlay();
    else bringOverlayToFront();
}

function unlock() {
    domObserver?.disconnect();
    domObserver = null;

    if (keyGuard) { document.removeEventListener("keydown", keyGuard, true); keyGuard = null; }
    if (focusGuard) { document.removeEventListener("focusin", focusGuard, true); focusGuard = null; }
    if (overlay && (overlay as any)._pinKeydown) {
        document.removeEventListener("keydown", (overlay as any)._pinKeydown, true);
    }

    if (overlay) {
        overlay.style.transition = "opacity 0.28s ease";
        overlay.style.opacity = "0";
        setTimeout(() => {
            overlay?.remove();
            overlay = null;
        }, 300);
    }

    bindActivity();
}

// ─── Helpers ──────────────────────────────────────────────────────────

function getUserAssets() {
    const user = UserStore.getCurrentUser();
    if (!user) return { avatarUrl: "", username: "User" };
    const avatarUrl = IconUtils.getUserAvatarURL(user, false, 128);
    return { avatarUrl, username: user.globalName || user.username || "User" };
}

function escapeHtml(text: string) {
    return text.replace(/[&<>"']/g, char => {
        switch (char) {
            case "&": return "&amp;";
            case "<": return "&lt;";
            case ">": return "&gt;";
            case "\"": return "&quot;";
            default: return "&#39;";
        }
    });
}

function focusInput() {
    const input = overlay?.querySelector<HTMLInputElement>("#vcl-input");
    if (!input) return;
    requestAnimationFrame(() => input.focus());
}

function bringOverlayToFront() {
    if (!overlay) return;
    if (overlay.parentElement !== document.body || document.body.lastElementChild !== overlay) {
        document.body.appendChild(overlay);
    }
    if (settings.store.passwordType !== "numeric") focusInput();
}

// ─── Styles (gray / transparent black) ─────────────────────────────────

function injectStyles(blur: number) {
    document.getElementById("vcl-styles")?.remove();

    const fa = document.createElement("link");
    fa.id = "vcl-fa";
    fa.rel = "stylesheet";
    fa.href = "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css";
    if (!document.getElementById("vcl-fa")) document.head.appendChild(fa);

    const st = document.createElement("style");
    st.id = "vcl-styles";
    st.textContent = `
        #vcl-overlay {
            position:                fixed;
            inset:                   0;
            z-index:                 2147483647;
            pointer-events:          auto;
            isolation:               isolate;
            display:                 flex;
            flex-direction:          column;
            align-items:             center;
            justify-content:         center;
            background:              rgba(20,20,22,0.55);
            backdrop-filter:         blur(${blur}px) brightness(0.4) saturate(0.15) grayscale(0.3);
            -webkit-backdrop-filter: blur(${blur}px) brightness(0.4) saturate(0.15) grayscale(0.3);
            overflow:                hidden;
            cursor:                  default;
        }

        #vcl-avatar {
            width:               72px;
            height:              72px;
            border-radius:       50%;
            background-size:     cover;
            background-position: center;
            background-color:    rgba(120,120,120,0.15);
            border:              1.5px solid rgba(180,180,180,0.2);
            margin-bottom:       18px;
            box-shadow:          0 8px 32px rgba(0,0,0,0.55);
            animation:           vcl-up 0.42s cubic-bezier(0.22,1,0.36,1) both;
        }

        #vcl-username {
            font-family:    'gg sans','Noto Sans',system-ui,sans-serif;
            font-size:      18px;
            font-weight:    600;
            letter-spacing: -0.3px;
            color:          rgba(230,230,232,0.92);
            margin:         0 0 6px;
            animation:      vcl-up 0.42s cubic-bezier(0.22,1,0.36,1) 0.05s both;
        }

        #vcl-sub {
            font-family: 'gg sans','Noto Sans',system-ui,sans-serif;
            font-size:   13px;
            color:       rgba(160,160,165,0.55);
            margin:      0 0 30px;
            animation:   vcl-up 0.42s cubic-bezier(0.22,1,0.36,1) 0.09s both;
        }

        /* ── text (alnum) mode ── */

        #vcl-input-wrap {
            position:  relative;
            width:     280px;
            animation: vcl-up 0.42s cubic-bezier(0.22,1,0.36,1) 0.13s both;
        }

        #vcl-input-wrap > i.vcl-icon-lock {
            position:       absolute;
            left:           15px;
            top:            50%;
            transform:      translateY(-50%);
            font-size:      11.5px;
            color:          rgba(180,180,185,0.3);
            pointer-events: none;
            transition:     color 0.2s;
        }
        #vcl-input-wrap:focus-within > i.vcl-icon-lock { color: rgba(200,200,205,0.55); }

        #vcl-input {
            width:          100%;
            padding:        13px 44px 13px 40px;
            background:     rgba(90,90,95,0.18);
            border:         1px solid rgba(170,170,175,0.16);
            border-radius:  14px;
            color:          rgba(230,230,232,0.9);
            font-size:      14px;
            font-family:    'gg sans','Noto Sans',system-ui,sans-serif;
            letter-spacing: 1px;
            outline:        none;
            box-sizing:     border-box;
            caret-color:    rgba(220,220,225,0.7);
            transition:     border-color 0.2s, background 0.2s, box-shadow 0.2s;
        }
        #vcl-input::placeholder { color: rgba(180,180,185,0.28); letter-spacing: 0; }
        #vcl-input:focus {
            background:   rgba(100,100,105,0.24);
            border-color: rgba(190,190,195,0.32);
            box-shadow:   0 0 0 3px rgba(180,180,185,0.06), 0 8px 28px rgba(0,0,0,0.4);
        }
        #vcl-input.vcl-err {
            border-color: rgba(255,110,110,0.5);
            box-shadow:   0 0 0 3px rgba(255,90,90,0.08);
            animation:    vcl-shake 0.34s ease;
        }

        #vcl-submit {
            position:      absolute;
            right:         10px;
            top:           50%;
            transform:     translateY(-50%);
            background:    none;
            border:        none;
            color:         rgba(190,190,195,0.3);
            font-size:     12px;
            cursor:        pointer;
            padding:       6px 8px;
            border-radius: 8px;
            transition:    color 0.18s, background 0.18s;
            line-height:   1;
        }
        #vcl-submit:hover { color: rgba(230,230,232,0.75); background: rgba(180,180,185,0.1); }

        /* ── pin (numeric / mobile) mode ── */

        #vcl-pin-dots {
            display:    flex;
            gap:        16px;
            margin-bottom: 34px;
            animation:  vcl-up 0.42s cubic-bezier(0.22,1,0.36,1) 0.13s both;
        }
        .vcl-dot {
            width:         13px;
            height:        13px;
            border-radius: 50%;
            border:        1.5px solid rgba(200,200,205,0.4);
            background:    transparent;
            transition:    background 0.15s, transform 0.15s;
        }
        .vcl-dot.vcl-filled {
            background: rgba(225,225,228,0.85);
            transform:  scale(1.05);
        }
        #vcl-pin-dots.vcl-err { animation: vcl-shake 0.34s ease; }
        #vcl-pin-dots.vcl-err .vcl-dot { border-color: rgba(255,110,110,0.6); }
        #vcl-pin-dots.vcl-err .vcl-dot.vcl-filled { background: rgba(255,120,120,0.85); }

        #vcl-keypad {
            display:               grid;
            grid-template-columns: repeat(3, 68px);
            gap:                   16px;
            animation:             vcl-up 0.42s cubic-bezier(0.22,1,0.36,1) 0.17s both;
        }
        .vcl-key {
            width:          68px;
            height:         68px;
            border-radius:  50%;
            border:         1px solid rgba(170,170,175,0.14);
            background:     rgba(90,90,95,0.16);
            color:          rgba(230,230,232,0.88);
            font-size:      22px;
            font-family:    'gg sans','Noto Sans',system-ui,sans-serif;
            font-weight:    500;
            cursor:         pointer;
            display:        flex;
            align-items:    center;
            justify-content: center;
            transition:     background 0.15s, transform 0.1s, border-color 0.15s;
            -webkit-tap-highlight-color: transparent;
        }
        .vcl-key:hover  { background: rgba(120,120,125,0.22); border-color: rgba(190,190,195,0.24); }
        .vcl-key:active { transform: scale(0.93); background: rgba(140,140,145,0.28); }
        .vcl-key-back  { font-size: 17px; }
        .vcl-key-clear { font-size: 16px; font-weight: 700; color: rgba(230,230,232,0.55); }

        /* ── shared ── */

        #vcl-error {
            display:     none;
            width:       280px;
            margin-top:  10px;
            font-family: 'gg sans','Noto Sans',system-ui,sans-serif;
            font-size:   12.5px;
            color:       rgba(255,130,130,0.9);
            align-items: center;
            justify-content: center;
            gap:         6px;
        }
        #vcl-error.vcl-show { display: flex; }

        @keyframes vcl-up {
            from { opacity: 0; transform: translateY(12px); }
            to   { opacity: 1; transform: translateY(0);    }
        }
        @keyframes vcl-shake {
            0%,100% { transform: translateX(0);   }
            20%,60% { transform: translateX(-6px); }
            40%,80% { transform: translateX(6px);  }
        }
    `;
    document.head.appendChild(st);
}

// ─── Overlay: text (alnum) mode ────────────────────────────────────────

function createTextModeOverlay(avatarUrl: string, username: string) {
    overlay!.innerHTML = `
        <div id="vcl-avatar" style="background-image:url('${escapeHtml(avatarUrl)}')"></div>
        <p id="vcl-username">${escapeHtml(username)}</p>
        <p id="vcl-sub">Enter password to unlock</p>

        <div id="vcl-input-wrap">
            <i class="fa-solid fa-lock vcl-icon-lock"></i>
            <input id="vcl-input" type="password" placeholder="Password" autocomplete="off" spellcheck="false" />
            <button id="vcl-submit"><i class="fa-solid fa-arrow-right"></i></button>
        </div>

        <div id="vcl-error">
            <i class="fa-solid fa-circle-exclamation"></i>
            <span id="vcl-error-msg"></span>
        </div>
    `;

    const input = overlay!.querySelector<HTMLInputElement>("#vcl-input")!;
    const submitBtn = overlay!.querySelector<HTMLButtonElement>("#vcl-submit")!;
    const errorBox = overlay!.querySelector<HTMLDivElement>("#vcl-error")!;
    const errorMsg = overlay!.querySelector<HTMLSpanElement>("#vcl-error-msg")!;

    let attempts = 0;
    let lockUntil = 0;

    function showError(msg: string) {
        input.classList.add("vcl-err");
        errorMsg.textContent = msg;
        errorBox.classList.add("vcl-show");
        setTimeout(() => {
            input.classList.remove("vcl-err");
            errorBox.classList.remove("vcl-show");
            input.value = "";
            input.focus();
        }, 2800);
    }

    function tryUnlock() {
        const now = Date.now();
        if (now < lockUntil) {
            showError(`Too many attempts — wait ${Math.ceil((lockUntil - now) / 1000)}s`);
            return;
        }
        if (input.value === settings.store.password) { unlock(); return; }

        attempts++;
        if (attempts >= 5) {
            lockUntil = Date.now() + 15_000;
            attempts = 0;
            showError("Too many attempts — locked for 15s");
        } else {
            showError(`Wrong password (${attempts} / 5)`);
        }
    }

    submitBtn.addEventListener("click", tryUnlock);
    input.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); tryUnlock(); }
        e.stopPropagation();
    });

    setTimeout(() => requestAnimationFrame(() => input.focus()), 140);
}

// ─── Overlay: pin (numeric / mobile) mode ──────────────────────────────

function createPinModeOverlay(avatarUrl: string, username: string) {
    const targetLen = getPinLength();

    overlay!.innerHTML = `
        <div id="vcl-avatar" style="background-image:url('${escapeHtml(avatarUrl)}')"></div>
        <p id="vcl-username">${escapeHtml(username)}</p>
        <p id="vcl-sub">Enter passcode to unlock</p>

        <div id="vcl-pin-dots"></div>

        <div id="vcl-error">
            <i class="fa-solid fa-circle-exclamation"></i>
            <span id="vcl-error-msg"></span>
        </div>

        <div id="vcl-keypad">
            <button class="vcl-key" data-d="1">1</button>
            <button class="vcl-key" data-d="2">2</button>
            <button class="vcl-key" data-d="3">3</button>
            <button class="vcl-key" data-d="4">4</button>
            <button class="vcl-key" data-d="5">5</button>
            <button class="vcl-key" data-d="6">6</button>
            <button class="vcl-key" data-d="7">7</button>
            <button class="vcl-key" data-d="8">8</button>
            <button class="vcl-key" data-d="9">9</button>
            <button class="vcl-key vcl-key-clear" id="vcl-key-clear">C</button>
            <button class="vcl-key" data-d="0">0</button>
            <button class="vcl-key vcl-key-back" id="vcl-key-back"><i class="fa-solid fa-delete-left"></i></button>
        </div>
    `;

    const dotsWrap = overlay!.querySelector<HTMLDivElement>("#vcl-pin-dots")!;
    const errorBox = overlay!.querySelector<HTMLDivElement>("#vcl-error")!;
    const errorMsg = overlay!.querySelector<HTMLSpanElement>("#vcl-error-msg")!;
    const backBtn = overlay!.querySelector<HTMLButtonElement>("#vcl-key-back")!;
    const clearBtn = overlay!.querySelector<HTMLButtonElement>("#vcl-key-clear")!;

    for (let i = 0; i < targetLen; i++) {
        const dot = document.createElement("div");
        dot.className = "vcl-dot";
        dotsWrap.appendChild(dot);
    }

    let buffer = "";
    let attempts = 0;
    let lockUntil = 0;
    let busy = false;

    function renderDots() {
        const dots = dotsWrap.querySelectorAll<HTMLDivElement>(".vcl-dot");
        dots.forEach((d, i) => d.classList.toggle("vcl-filled", i < buffer.length));
    }

    function showError(msg: string) {
        busy = true;
        errorMsg.textContent = msg;
        errorBox.classList.add("vcl-show");
        dotsWrap.classList.add("vcl-err");
        setTimeout(() => {
            errorBox.classList.remove("vcl-show");
            dotsWrap.classList.remove("vcl-err");
            buffer = "";
            renderDots();
            busy = false;
        }, 900);
    }

    function submitIfReady() {
        if (buffer.length < targetLen) return;

        const now = Date.now();
        if (now < lockUntil) {
            showError(`Too many attempts — wait ${Math.ceil((lockUntil - now) / 1000)}s`);
            return;
        }

        if (buffer === settings.store.password) { unlock(); return; }

        attempts++;
        if (attempts >= 5) {
            lockUntil = Date.now() + 15_000;
            attempts = 0;
            showError("Too many attempts — locked for 15s");
        } else {
            showError("Wrong passcode");
        }
    }

    function pressDigit(d: string) {
        if (busy || Date.now() < lockUntil) return;
        if (buffer.length >= targetLen) return;
        buffer += d;
        renderDots();
        if (buffer.length === targetLen) setTimeout(submitIfReady, 120);
    }

    function pressBackspace() {
        if (busy) return;
        buffer = buffer.slice(0, -1);
        renderDots();
    }

    function pressClear() {
        if (busy) return;
        buffer = "";
        renderDots();
    }

    overlay!.querySelectorAll<HTMLButtonElement>(".vcl-key[data-d]").forEach(btn => {
        btn.addEventListener("click", () => pressDigit(btn.dataset.d!));
    });
    backBtn.addEventListener("click", pressBackspace);
    clearBtn.addEventListener("click", pressClear);

    (overlay as any)._pinKeydown = (e: KeyboardEvent) => {
        if (/^[0-9]$/.test(e.key)) { e.preventDefault(); pressDigit(e.key); }
        else if (e.key === "Backspace") { e.preventDefault(); pressBackspace(); }
        else if (e.key === "Escape" || e.key.toLowerCase() === "c") { e.preventDefault(); pressClear(); }
    };
    document.addEventListener("keydown", (overlay as any)._pinKeydown, true);
}

// ─── Overlay ──────────────────────────────────────────────────────────

function createOverlay() {
    injectStyles(settings.store.blurAmount ?? 18);

    const { avatarUrl, username } = getUserAssets();

    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    document.body.appendChild(overlay);

    if (settings.store.passwordType === "numeric") {
        createPinModeOverlay(avatarUrl, username);
    } else {
        createTextModeOverlay(avatarUrl, username);
    }

    // Block devtools shortcuts while locked (cosmetic deterrent only, not real security)
    keyGuard = (e: KeyboardEvent) => {
        const input = overlay?.querySelector<HTMLInputElement>("#vcl-input");
        if (input && e.target === input) return;
        const blocked =
            e.key === "F12" ||
            (e.ctrlKey && e.shiftKey && ["I", "J", "C", "K"].includes(e.key)) ||
            (e.ctrlKey && e.key === "U");
        if (blocked) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    document.addEventListener("keydown", keyGuard, true);

    focusGuard = (e: FocusEvent) => {
        if (!overlay || overlay.contains(e.target as Node)) return;
        e.stopImmediatePropagation();
        if (settings.store.passwordType !== "numeric") focusInput();
    };
    document.addEventListener("focusin", focusGuard, true);

    overlay.addEventListener("contextmenu", e => {
        const input = overlay?.querySelector<HTMLInputElement>("#vcl-input");
        if (e.target !== input) e.preventDefault();
    });
    overlay.addEventListener("mousedown", e => {
        if (e.target === overlay && settings.store.passwordType !== "numeric") {
            e.preventDefault();
            focusInput();
        }
    });

    domObserver = new MutationObserver(() => {
        if (!document.getElementById(OVERLAY_ID) && overlay) {
            document.body.appendChild(overlay);
            bringOverlayToFront();
            return;
        }
        bringOverlayToFront();
    });
    domObserver.observe(document.body, { childList: true });
}

// ─── Plugin ───────────────────────────────────────────────────────────

export default definePlugin({
    name: "DiscordLock",
    description: "Locks Discord with a password after inactivity or via a custom shortcut, with adjustable blur and lock style.",
    tags: ["Privacy", "Utility"],
    authors: [Devs.phklie],
    settings,

    start() {
        bindActivity();
        bindShortcut();

        if (settings.store.password) {
            if (document.readyState === "complete") {
                lock();
            } else {
                loadLockListener = () => lock();
                window.addEventListener("load", loadLockListener, { once: true });
            }
        }
    },

    stop() {
        unbindActivity();
        unbindShortcut();

        if (loadLockListener) {
            window.removeEventListener("load", loadLockListener);
            loadLockListener = null;
        }

        domObserver?.disconnect();
        domObserver = null;

        if (keyGuard) { document.removeEventListener("keydown", keyGuard, true); keyGuard = null; }
        if (focusGuard) { document.removeEventListener("focusin", focusGuard, true); focusGuard = null; }
        if (overlay && (overlay as any)._pinKeydown) {
            document.removeEventListener("keydown", (overlay as any)._pinKeydown, true);
        }

        overlay?.remove();
        overlay = null;

        document.getElementById("vcl-styles")?.remove();
        document.getElementById("vcl-fa")?.remove();
    },
});