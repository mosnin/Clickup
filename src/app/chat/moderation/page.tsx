import type { Metadata } from "next";
import { ModerationScreen } from "@/components/chat/moderation/moderation-screen";

export const metadata: Metadata = { title: "Moderation · Chat" };

// `/chat/moderation`.
//
// Buzz puts the queue inside Settings rather than at a route of its own, and
// the reason is sound: it is not somewhere you go, it is somewhere you are sent
// when something needs deciding. We have no Chat settings surface yet, so a
// route is the honest adaptation rather than a disagreement — when Settings
// arrives, this screen moves into it and the route can redirect.
//
// The gate is the Convex functions, not this page. A non-moderator who reaches
// the URL sees the refusal the server gives, which is the same one an API
// caller gets: the client guard would be UX, and UX is not a boundary.

export default function ChatModeration() {
  return <ModerationScreen />;
}
