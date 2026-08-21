/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { definePluginSettings } from "@api/Settings";
import { managedStyleRootNode } from "@api/Styles";
import { Devs } from "@utils/constants";
import { createAndAppendStyle } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";

let style: HTMLStyleElement;

const settings = definePluginSettings({
    hideCamera: {
        type: OptionType.BOOLEAN,
        description: "Hide the Camera button in the voice call bar",
        default: false,
        onChange: setCss
    },
    hideScreenShare: {
        type: OptionType.BOOLEAN,
        description: "Hide the Screen Share button in the voice call bar",
        default: false,
        onChange: setCss
    },
    hideActivities: {
        type: OptionType.BOOLEAN,
        description: "Hide the Activities button in the voice call bar",
        default: false,
        onChange: setCss
    },
    hideSoundboard: {
        type: OptionType.BOOLEAN,
        description: "Hide the Soundboard button in the voice call bar",
        default: false,
        onChange: setCss
    },
});

function setCss() {
    const rules: string[] = [];

    if (settings.store.hideCamera) {
        rules.push(`[class*="actionButtons"] > :nth-child(1) { display: none !important; }`);
    }
    if (settings.store.hideScreenShare) {
        rules.push(`[class*="actionButtons"] > :nth-child(3) { display: none !important; }`);
    }
    if (settings.store.hideActivities) {
        rules.push(`[class*="actionButtons"] > :nth-child(5) { display: none !important; }`);
    }
    if (settings.store.hideSoundboard) {
        rules.push(`[class*="actionButtons"] > :nth-child(7) { display: none !important; }`);
    }

    style.textContent = rules.join("\n");
}

export default definePlugin({
    name: "VoicePanelButtons",
    description: "Lets you hide the Camera, Screen Share, Activities, and/or Soundboard buttons from the voice call control bar.",
    authors: [Devs.phklie],
    settings,

    start() {
        style = createAndAppendStyle("VcVoicePanelButtons", managedStyleRootNode);
        setCss();
    },

    stop() {
        style?.remove();
    },
});