/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React, ReactDOM, useEffect, useRef, useState } from "@webpack/common";

import { ActionType, runAction, stopAction, useStatus } from "./actions";

const svgProps = {
    viewBox: "0 0 24 24",
    width: 18,
    height: 18,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
};

const Icons = {
    channel: () => (
        <svg {...svgProps}>
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
    ),
    allServers: () => (
        <svg {...svgProps}>
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
        </svg>
    ),
    leaveServers: () => (
        <svg {...svgProps}>
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
        </svg>
    ),
    friends: () => (
        <svg {...svgProps}>
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <line x1="17" y1="11" x2="23" y2="11" />
        </svg>
    ),
    nuke: () => (
        <svg {...svgProps}>
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
    ),
};

interface ItemDef {
    type: ActionType;
    title: string;
    sub: string;
    confirmText: string;
    confirmLabel: string;
    danger?: boolean;
}

const ITEMS: ItemDef[] = [
    {
        type: "channel",
        title: "Delete messages — this channel",
        sub: "Removes your messages from the current channel",
        confirmText: "This will delete all your messages in the current channel. This can't be undone.",
        confirmLabel: "Delete",
    },
    {
        type: "allServers",
        title: "Delete messages — all servers",
        sub: "Removes your messages in every server, you stay in them",
        confirmText: "This will delete your messages in every server you're in. You will stay in the servers. This can't be undone.",
        confirmLabel: "Delete",
    },
    {
        type: "leaveServers",
        title: "Leave all servers",
        sub: "Deletes your messages first, then leaves each server",
        confirmText: "This will delete your messages in every server, then leave them all. Servers you own are skipped when leaving. This can't be undone.",
        confirmLabel: "Leave all",
    },
    {
        type: "friends",
        title: "Remove all friends",
        sub: "Deletes your DM messages with them, then unfriends",
        confirmText: "This will delete your messages in your DMs with each friend, then remove them from your friends list. This can't be undone.",
        confirmLabel: "Remove all",
    },
    {
        type: "nuke",
        title: "Nuke everything",
        sub: "Channel + all servers (leave) + all friends, at once",
        confirmText: "This will delete your messages in this channel and every server, leave all servers, delete your DMs with friends and remove all of them. This can't be undone.",
        confirmLabel: "Nuke",
        danger: true,
    },
];

const NUKE_WORD = "NUKE";

export function MassCleanModal({ open, onClose }: { open: boolean; onClose: () => void; }) {
    const { running, status } = useStatus();
    const [mounted, setMounted] = useState(open);
    const [visible, setVisible] = useState(false);
    const [pending, setPending] = useState<ItemDef | null>(null);
    const [typed, setTyped] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    // mount / unmount with a smooth exit
    useEffect(() => {
        if (open) {
            setMounted(true);
            const id = requestAnimationFrame(() => setVisible(true));
            return () => cancelAnimationFrame(id);
        }
        setVisible(false);
        const t = setTimeout(() => {
            setMounted(false);
            setPending(null);
            setTyped("");
        }, 180);
        return () => clearTimeout(t);
    }, [open]);

    // Escape: back from confirm first, then close
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            if (pending) cancelConfirm();
            else onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, onClose, pending]);

    // focus the input for the nuke confirmation
    useEffect(() => {
        if (pending?.danger) {
            const t = setTimeout(() => inputRef.current?.focus(), 60);
            return () => clearTimeout(t);
        }
    }, [pending]);

    function askConfirm(item: ItemDef) {
        setTyped("");
        setPending(item);
    }

    function cancelConfirm() {
        setPending(null);
        setTyped("");
    }

    const canConfirm = !pending?.danger || typed.trim().toUpperCase() === NUKE_WORD;

    function doConfirm() {
        if (!pending || !canConfirm || running) return;
        const { type } = pending;
        cancelConfirm();
        runAction(type);
    }

    if (!mounted) return null;

    return ReactDOM.createPortal(
        <div
            className={`mc-backdrop${visible ? " mc-in" : ""}`}
            onMouseDown={e => e.target === e.currentTarget && onClose()}
        >
            <div className="mc-modal" role="dialog" aria-modal="true">
                <div className="mc-header">
                    <div>
                        <div className="mc-title">MassClean</div>
                        <div className="mc-subtitle">{pending ? "Confirm action" : "Pick an action"}</div>
                    </div>
                    <button className="mc-close" onClick={onClose} aria-label="Close">
                        <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>

                {pending ? (
                    <div className="mc-view mc-confirm" key="confirm">
                        <div className={`mc-confirm-card${pending.danger ? " mc-danger-card" : ""}`}>
                            <span className="mc-item-icon">{Icons[pending.type]()}</span>
                            <div className="mc-confirm-body">
                                <div className="mc-confirm-title">{pending.title}</div>
                                <div className="mc-confirm-text">{pending.confirmText}</div>
                            </div>
                        </div>

                        {pending.danger && (
                            <div className="mc-type-wrap">
                                <label className="mc-type-label">
                                    Type <b>{NUKE_WORD}</b> to continue
                                </label>
                                <input
                                    ref={inputRef}
                                    className="mc-input"
                                    value={typed}
                                    onChange={e => setTyped(e.currentTarget.value)}
                                    onKeyDown={e => e.key === "Enter" && doConfirm()}
                                    placeholder={NUKE_WORD}
                                    spellCheck={false}
                                    autoComplete="off"
                                />
                            </div>
                        )}

                        <div className="mc-confirm-actions">
                            <button className="mc-btn-ghost" onClick={cancelConfirm}>Cancel</button>
                            <button
                                className={`mc-btn-solid${pending.danger ? " mc-btn-danger" : ""}`}
                                disabled={!canConfirm || running}
                                onClick={doConfirm}
                            >
                                {pending.confirmLabel}
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="mc-view mc-list" key="list">
                        {ITEMS.map(item => (
                            <button
                                key={item.type}
                                className={`mc-item${item.danger ? " mc-danger" : ""}`}
                                disabled={running}
                                onClick={() => askConfirm(item)}
                            >
                                <span className="mc-item-icon">{Icons[item.type]()}</span>
                                <span className="mc-item-text">
                                    <span className="mc-item-title">{item.title}</span>
                                    <span className="mc-item-sub">{item.sub}</span>
                                </span>
                            </button>
                        ))}
                    </div>
                )}

                <div className="mc-footer">
                    <div className={`mc-status-dot${running ? " running" : ""}`} />
                    <span className="mc-status-text">{running ? status : "Idle"}</span>
                    {running && (
                        <button className="mc-stop-btn" onClick={stopAction}>Stop</button>
                    )}
                </div>
            </div>
        </div>,
        document.body
    );
}
