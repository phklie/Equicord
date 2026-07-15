/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from "@webpack/common";

import { runAction, stopAction, ActionType, useStatus } from "./actions";

interface ActionItemProps {
    icon: string;
    iconColor: string;
    title: string;
    sub: string;
    onClick: () => void;
}

function ActionItem({ icon, iconColor, title, sub, onClick }: ActionItemProps) {
    return (
        <div
            className="mc-item"
            onClick={onClick}
            role="button"
            tabIndex={0}
            onKeyDown={e => e.key === "Enter" && onClick()}
        >
            <div className={`mc-item-icon ${iconColor}`}>
                <i className={`ti ${icon}`} aria-hidden />
            </div>
            <div className="mc-item-text">
                <div className="mc-item-title">{title}</div>
                <div className="mc-item-sub">{sub}</div>
            </div>
        </div>
    );
}

const ITEMS: {
    type: ActionType;
    icon: string;
    iconColor: string;
    title: string;
    sub: string;
}[] = [
    {
        type: "channel",
        icon: "ti-message-x",
        iconColor: "blue",
        title: "Delete messages — this channel",
        sub: "Removes your messages from the current channel",
    },
    {
        type: "allServers",
        icon: "ti-server-off",
        iconColor: "orange",
        title: "Delete messages — all servers",
        sub: "Searches and removes your messages across every server",
    },
    {
        type: "friends",
        icon: "ti-user-minus",
        iconColor: "red",
        title: "Remove all friends",
        sub: "Unfriends everyone and clears DM relationships",
    },
    {
        type: "nuke",
        icon: "ti-skull",
        iconColor: "danger",
        title: "Nuke account data",
        sub: "Messages (all servers) + all friends removed at once",
    },
];

export function renderPopout(onClose: () => void) {
    const { running, status } = useStatus();

    function handle(type: ActionType) {
        onClose();
        runAction(type);
    }

    return (
        <div className="mc-popout">
            {ITEMS.map((item, i) => (
                <ActionItem
                    key={item.type}
                    icon={item.icon}
                    iconColor={item.iconColor}
                    title={item.title}
                    sub={item.sub}
                    onClick={() => handle(item.type)}
                />
            ))}

            {running && (
                <>
                    <div className="mc-separator" />
                    <div className="mc-status-bar">
                        <div className="mc-status-dot running" />
                        <span className="mc-status-text">{status}</span>
                        <button className="mc-stop-btn" onClick={stopAction}>Stop</button>
                    </div>
                </>
            )}
        </div>
    );
}