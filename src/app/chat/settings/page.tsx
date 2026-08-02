import type { Metadata } from "next";
import { ChatSettingsScreen } from "@/components/chat/shell/settings-screen";

export const metadata: Metadata = { title: "Settings · Chat" };

// `/chat/settings`.
//
// The route the notification panel and the presence control were built for and
// had nowhere to land. It is a page rather than a sheet over the room for the
// same reason the moderation queue is: the Chat shell already owns the chrome,
// so a screen inside it keeps the rail, the community and the way back, and a
// modal would have had to reproduce all three.

export default function ChatSettings() {
  return <ChatSettingsScreen />;
}
