/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { QuestSpooferLogger } from "@plugins/questSpoofer/constants";
import { postVideoProgress } from "@plugins/questSpoofer/helpers";
import { showToast } from "@webpack/common";

/**
 * Spoofs video watch quests by incrementally posting progress timestamps until completion.
 */
export async function spoofVideoQuest(
    quest: any,
    secondsNeeded: number,
    secondsDone: number,
) {
    const enrolledAt =
        quest.user_status?.enrolled_at ??
        quest.user_status?.enrolledAt ??
        quest.userStatus?.enrolledAt;

    if (!enrolledAt) {
        QuestSpooferLogger.warn(
            "Missing enrollment timestamp for video quest; cannot spoof.",
        );
        showToast({
            text: "Could not spoof video quest: missing enrollment info.",
            variant: "critical"
        });
        return;
    }

    const enrolledAtMs = new Date(enrolledAt).getTime();
    const speed = 7;
    const interval = 1;

    await (async function spoof() {
        QuestSpooferLogger.info("Started video spoofing...");
        while (true) {
            const maxAllowed =
                Math.floor((Date.now() - enrolledAtMs) / 1000) + 10;
            const diff = maxAllowed - secondsDone;
            const timestamp = secondsDone + speed;

            if (diff >= speed) {
                const postTime = Math.min(
                    secondsNeeded,
                    timestamp + Math.random(),
                );
                const res = await postVideoProgress(quest.id, postTime);

                QuestSpooferLogger.log(
                    `POST /video-progress: +${speed}s → ${postTime}s`,
                );

                if (res.body.completed_at) {
                    QuestSpooferLogger.info("Video quest marked as completed.");
                    break;
                }

                secondsDone = Math.min(secondsNeeded, timestamp);
            }

            if (timestamp >= secondsNeeded) break;
            await new Promise(r => setTimeout(r, interval * 1000));
        }

        await postVideoProgress(quest.id, secondsNeeded);
        showToast({
            text: "✅ Video quest completed!",
            variant: "success"
        });
        QuestSpooferLogger.info("Sent final video-progress to finish quest.");
    })();

    showToast({
        text: `▶️ Spoofing video quest: ${quest.config.messages.questName}`,
        variant: "default"
    });
}
