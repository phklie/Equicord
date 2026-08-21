import definePlugin from "@utils/types";
import { UserStore } from "@webpack/common";
import { showNotification } from "@api/Notifications";
import { Devs } from "@utils/constants";

export default definePlugin({
    name: "FriendRequestNotifier",
    description: "Sends a notification when someone sends you a friend request",
    authors: [Devs.phklie],

    flux: {
        RELATIONSHIP_ADD(data: { relationship: { id: string; type: number; user?: any } }) {
            const { relationship } = data;
            if (relationship.type !== 3) return;

            const user = relationship.user ?? UserStore.getUser(relationship.id);
            if (!user) return;

            const avatarUrl = user.avatar
                ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
                : `https://cdn.discordapp.com/embed/avatars/${(Number(user.discriminator) || 0) % 5}.png`;

            const displayName = user.globalName || user.username;

            showNotification({
                title: "New Friend Request",
                body: `${displayName} (@${user.username}) sent you a friend request`,
                icon: avatarUrl,
                permanent: false,
            });
        }
    }
});