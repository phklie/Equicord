/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginInfo } from "@plugins/betterMicrophone.desktop/constants";
import { openMicrophoneSettingsModal } from "@plugins/betterMicrophone.desktop/modals";
import { MicrophonePatcher } from "@plugins/betterMicrophone.desktop/patchers";
import { initMicrophoneStore } from "@plugins/betterMicrophone.desktop/stores";
import { addSettingsPanelButton, Emitter, MicrophoneSettingsIcon, removeSettingsPanelButton } from "@plugins/philsPluginLibrary";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "BetterMicrophone",
    description: "This plugin allows you to further customize your microphone.",
    authors: [Devs.phklie],
    dependencies: ["PhilsPluginLibrary", "VoicePatcher"],
    requiresRestart: true,

    start(): void {
        initMicrophoneStore();
        this.microphonePatcher = new MicrophonePatcher().patch();
        addSettingsPanelButton({
            name: PluginInfo.PLUGIN_NAME,
            icon: MicrophoneSettingsIcon,
            tooltipText: "Microphone Settings",
            onClick: openMicrophoneSettingsModal
        });
    },

    stop(): void {
        this.microphonePatcher?.unpatch();
        Emitter.removeAllListeners(PluginInfo.PLUGIN_NAME);
        removeSettingsPanelButton(PluginInfo.PLUGIN_NAME);
    },

    toolboxActions: {
        "Open Microphone Settings": openMicrophoneSettingsModal
    },
});
