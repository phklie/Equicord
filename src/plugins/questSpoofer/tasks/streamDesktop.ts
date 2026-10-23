/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FluxDispatcher, showToast } from "@webpack/common";

import { ApplicationStreamingStore, QuestSpooferLogger } from "../constants";

/**
 * Spoofs the STREAM_ON_DESKTOP quest by faking an active stream and
 * listening for quest heartbeat progress.
 */
export function spoofStreamDesktopQuest(
    quest: any,
    appId: string,
    appName: string,
    pid: number,
    secondsNeeded: number,
) {
    if (!IS_DISCORD_DESKTOP) {
        QuestSpooferLogger.error("Not in desktop environment.");
        return showToast({
            text: "❌ Use the desktop app to spoof this quest.",
            variant: "critical"
        });
    }

    const backup = ApplicationStreamingStore.getStreamerActiveStreamMetadata;
    ApplicationStreamingStore.getStreamerActiveStreamMetadata = () => ({
        id: appId,
        pid,
        sourceName: null,
    });

    QuestSpooferLogger.log(`Simulating stream for ${appName} (pid ${pid})`);

    const listener = (data: any) => {
        const progress =
            quest.config.configVersion === 1
                ? data.userStatus.streamProgressSeconds
                : Math.floor(data.userStatus.progress.STREAM_ON_DESKTOP.value);

        QuestSpooferLogger.debug(
            `Stream heartbeat: ${progress}/${secondsNeeded}s`,
        );

        if (progress >= secondsNeeded) {
            FluxDispatcher.unsubscribe(
                "QUESTS_SEND_HEARTBEAT_SUCCESS",
                listener,
            );
            ApplicationStreamingStore.getStreamerActiveStreamMetadata = backup;
            showToast({
                text: "✅ Streaming quest completed!",
                variant: "success"
            });
            QuestSpooferLogger.info("Stream quest spoofed successfully.");
        }
    };

    FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", listener);
    showToast({
        text: `📡 Spoofing stream for ${appName}`,
        variant: "default"
    });
}
