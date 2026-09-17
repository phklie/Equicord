import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { Message } from "@vencord/discord-types";
import { findByPropsLazy } from "@webpack";
import { UserStore } from "@webpack/common";
import { Devs } from "@utils/constants";

import { resolveGiftType } from "./giftCode";
import { settings } from "./settings";
import type { ClaimRequest, WebhookResult } from "./types";
import { sendClaimWebhook } from "./webhook";

const GIFT_LINK_REGEX = /(?:discord\.gift\/|discord\.com\/gifts?\/)([a-zA-Z0-9]{16,24})/;

const logger = new Logger("NitroSniper");
const GiftActions = findByPropsLazy("redeemGiftCode");

let startTime = 0;
let claiming = false;
const claimQueue: ClaimRequest[] = [];
const seenCodes = new Set<string>();

function resetState() {
    startTime = Date.now();
    claimQueue.length = 0;
    seenCodes.clear();
    claiming = false;
}

function toError(error: unknown) {
    return error instanceof Error ? error : new Error(String(error));
}

function isOwnMessage(message: Message) {
    return message.author?.id === UserStore.getCurrentUser()?.id;
}

function shouldSkipMessage(message: Message) {
    return settings.store.ignoreOwnGiftLinks && isOwnMessage(message);
}

function extractGiftCode(content: string) {
    return content.match(GIFT_LINK_REGEX)?.[1] ?? null;
}

function createClaimRequest(message: Message): ClaimRequest | null {
    const code = message.content ? extractGiftCode(message.content) : null;
    if (!code) return null;

    if (seenCodes.has(code)) return null;
    seenCodes.add(code);

    const authorId = message.author?.id;
    const authorAvatar = message.author?.avatar;

    return {
        code,
        authorId,
        authorName: message.author?.globalName ?? message.author?.username,
        authorUsername: message.author?.username,
        authorAvatarUrl: authorId && authorAvatar
            ? `https://cdn.discordapp.com/avatars/${authorId}/${authorAvatar}.png?size=128`
            : undefined,
        channelId: message.channel_id,
        guildId: message.guild_id,
        messageId: message.id
    };
}

function notifyClaim(result: WebhookResult, request: ClaimRequest, giftType: string | null) {
    void sendClaimWebhook(
        settings.store.webhookUrl,
        result,
        request,
        giftType
    ).catch(webhookError => {
        logger.error("Failed to send NitroSniper webhook notification", webhookError);
    });
}

function continueQueue() {
    claiming = false;
    processQueue();
}

function redeem(request: ClaimRequest) {
    const wantWebhook = settings.store.webhookUrl.trim().length > 0;
    const giftType = wantWebhook ? resolveGiftType(request.code) : Promise.resolve(null);

    GiftActions.redeemGiftCode({
        code: request.code,
        onRedeemed: () => {
            logger.log(`Successfully redeemed code: ${request.code}`);
            if (wantWebhook) void giftType.then(type => notifyClaim("claimed", request, type));
            continueQueue();
        },
        onError: (error: unknown) => {
            logger.error(`Failed to redeem code: ${request.code}`, toError(error));
            if (wantWebhook) void giftType.then(type => notifyClaim("failed", request, type));
            continueQueue();
        }
    });
}

function processQueue() {
    if (claiming) return;

    const request = claimQueue.shift();
    if (!request) return;

    claiming = true;
    redeem(request);
}

export default definePlugin({
    name: "NitroSniper",
    description: "Automatically redeems Nitro gift links sent in chat",
    authors: [Devs.phklie],
    tags: ["Chat", "Utility"],
    searchTerms: ["nitro", "gift", "redeem", "snipe"],
    settings,

    start() {
        resetState();
    },

    flux: {
        MESSAGE_CREATE({ message }: { message: Message; }) {
            if (!message.content) return;
            if (message.timestamp && new Date(message.timestamp).getTime() < startTime) return;
            if (shouldSkipMessage(message)) return;

            const request = createClaimRequest(message);
            if (!request) return;

            if (!claiming) {
                claiming = true;
                redeem(request);
            } else {
                claimQueue.push(request);
            }
        }
    }
});