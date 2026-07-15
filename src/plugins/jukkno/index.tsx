/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { HeaderBarButton } from "@api/HeaderBar";
import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Popout, useRef, useState } from "@webpack/common";

import { renderPopout } from "./menu";
import { runAction, stopAction, useStatus } from "./actions";

// ─── Settings ────────────────────────────────────────────────────────────────

export const settings = definePluginSettings({
    deleteDelay: {
        type: OptionType.NUMBER,
        description: "Delay between each delete request (ms) — max 200",
        default: 150,
        max: 200,
    },
    searchLimit: {
        type: OptionType.NUMBER,
        description: "Messages to fetch per search batch — max 200",
        default: 25,
        max: 200,
    },
});

// ─── Icon ────────────────────────────────────────────────────────────────────

function Icon(props: React.SVGProps<SVGSVGElement>) {
    return (
        <svg
            viewBox="0 0 24 24"
            width={20}
            height={20}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            {...props}
        >
            {/* trash body */}
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14H6L5 6" />
            <path d="M10 11v6M14 11v6" />
            {/* lid */}
            <path d="M9 6V4h6v2" />
            {/* x slash */}
            <line x1="9" y1="9" x2="15" y2="21" strokeWidth={1.4} />
            <line x1="15" y1="9" x2="9" y2="21" strokeWidth={1.4} />
        </svg>
    );
}

// ─── Channel delete bar (Start / Stop above chat input) ───────────────────────

function ChannelDeleteBar() {
    const { running, status } = useStatus();

    return (
        <div className="mc-channel-bar">
            <span className="mc-channel-bar-label">Delete my messages in this channel:</span>
            <button
                className="mc-start-btn"
                disabled={running}
                onClick={() => runAction("channel")}
            >
                Start
            </button>
            <button
                className="mc-stop-btn"
                disabled={!running}
                onClick={stopAction}
                style={{ opacity: running ? 1 : 0.4, cursor: running ? "pointer" : "not-allowed" }}
            >
                Stop
            </button>
            <div className="mc-status-bar" style={{ marginTop: 0, flex: 1 }}>
                <div className={`mc-status-dot${running ? " running" : ""}`} />
                <span className="mc-status-text">{running ? status : "Idle"}</span>
            </div>
        </div>
    );
}

// ─── Header bar popout button ─────────────────────────────────────────────────

function MassCleanButton() {
    const buttonRef = useRef(null);
    const [show, setShow] = useState(false);

    return (
        <Popout
            position="bottom"
            align="right"
            spacing={8}
            animation={Popout.Animation.NONE}
            shouldShow={show}
            onRequestClose={() => setShow(false)}
            targetElementRef={buttonRef}
            renderPopout={() => renderPopout(() => setShow(false))}
        >
            {(_, { isShown }) => (
                <HeaderBarButton
                    ref={buttonRef}
                    className="mc-btn"
                    onClick={() => setShow(v => !v)}
                    tooltip={isShown ? null : "MassClean"}
                    icon={Icon}
                    selected={isShown}
                />
            )}
        </Popout>
    );
}

// ─── Plugin definition ────────────────────────────────────────────────────────

export default definePlugin({
    name: "jukkno",
    description: "Absolutely jukkno",
    authors: [EquicordDevs.ee],
    dependencies: ["HeaderBarAPI"],
    settings,

    headerBarButton: {
        icon: Icon,
        render: MassCleanButton,
        priority: 1336,
    },

    // Exposed for other plugins that may hook toolboxActions
    toolboxActions: {
        "Delete channel messages": () => runAction("channel"),
        "Delete all server messages": () => runAction("allServers"),
        "Remove all friends": () => runAction("friends"),
        "Nuke account data": () => runAction("nuke"),
        "Stop current action": stopAction,
    },
});