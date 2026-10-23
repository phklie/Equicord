/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { QuestSpooferLogger } from "@plugins/questSpoofer/constants";
import {
    _resetProcessedQuestsForTesting,
    isAutoQuestListenerActive,
    resetProcessedQuestCache,
    runQuestSpoofer,
    startAutoQuestListener,
    stopAutoQuestListener,
} from "@plugins/questSpoofer/runner";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { showToast } from "@webpack/common";

export default definePlugin({
    name: "QuestSpoofer",
    description:
        "Spoofs Discord Quests for video, desktop play, and streaming.",
    authors: [Devs.phklie],

    toolboxActions: {
        async "Fetch & Spoof Quests"() {
            await runQuestSpoofer();
        },
        "Reset Auto Cache"() {
            resetProcessedQuestCache();
            showToast({ text: "Auto quest cache cleared.", variant: "success" });
        },
        "Toggle Auto-Spoof"() {
            if (isAutoQuestListenerActive()) {
                stopAutoQuestListener();
                return showToast(
                    { text: "Auto quest listener stopped.", variant: "critical" }
                );
            }

            startAutoQuestListener();
            showToast({ text: "Auto quest listener started.", variant: "success" });
        },
    },

    async start() {
        await runQuestSpoofer();
        startAutoQuestListener();
    },

    stop() {
        stopAutoQuestListener();
        QuestSpooferLogger.info("QuestSpoofer plugin stopped.");
        showToast({ text: "QuestSpoofer plugin stopped.", variant: "success" });
    },

    _resetProcessedQuestsForTesting() {
        _resetProcessedQuestsForTesting();
    },
});
