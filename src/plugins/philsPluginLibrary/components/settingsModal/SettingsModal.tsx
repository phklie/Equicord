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

import { Flex } from "@components/Flex";
import { ContributorAuthorSummary } from "@plugins/philsPluginLibrary/components/ContributorAuthorSummary";
import { Author, Contributor } from "@plugins/philsPluginLibrary/types";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal } from "@webpack/common";
import React, { JSX } from "react";

export interface SettingsModalProps extends RenderModalProps {
    title?: string;
    size?: string;
    children?: React.ReactNode;
    onDone?: () => void;
    footerContent?: JSX.Element;
    closeButtonName?: string;
    author?: Author,
    contributors?: Contributor[];
    /** Width of the modal's content area (any CSS length, e.g. "50em"). The modal itself becomes this + 48px padding. */
    contentWidth?: string;
}

const LEGACY_SIZE_MAP: Record<string, string> = {
    small: "sm",
    medium: "md",
    large: "lg",
    dynamic: "md"
};

export const SettingsModal = (props: SettingsModalProps) => {
    const { size, title, children, onClose, onDone, footerContent, closeButtonName, author, contributors, contentWidth } = props;

    // unique class per width so stacked modals (e.g. screenshare -> audio) don't affect each other
    const widthClass = contentWidth ? `vc-sm-w-${contentWidth.replace(/[^a-z0-9]/gi, "_")}` : undefined;

    const hasContributors = !!author || (contributors && contributors.length > 0);

    return (
        <Modal
            transitionState={props.transitionState}
            onClose={onClose}
            title={title ?? ""}
            size={size ? LEGACY_SIZE_MAP[size] ?? size : "md"}
            actions={[
                {
                    text: closeButtonName ?? "Done",
                    variant: "primary",
                    onClick: () => (onDone ?? onClose)()
                }
            ]}
            actionBarInput={(hasContributors || footerContent) && (
                <Flex style={{ width: "100%", alignItems: "center", gap: "1em" }}>
                    {hasContributors && (
                        <ContributorAuthorSummary
                            author={author}
                            contributors={contributors} />
                    )}
                    {footerContent}
                </Flex>
            )}
        >
            {/* width/minWidth/boxSizing keep the content inside the modal body so no horizontal scrollbar appears */}
            {contentWidth && (
                <style>{`[data-mana-component="modal"]:has(.${widthClass}) { width: calc(${contentWidth} + 48px) !important; max-width: 95vw !important; }`}</style>
            )}
            <div className={widthClass} style={{
                display: "flex",
                flexDirection: "column",
                gap: "1em",
                marginBottom: "1em",
                width: "100%",
                minWidth: 0,
                boxSizing: "border-box"
            }}>
                {children}
            </div>
        </Modal>
    );
};
