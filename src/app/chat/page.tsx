import type { Metadata } from "next";
import { ChatHomeScreen } from "@/components/chat/shell/home-screen";

export const metadata: Metadata = { title: "Chat" };

// `/chat` — home. The shell around it is the layout's; this route is only the
// screen that sits in the content surface, which is why it is four lines.

export default function ChatHome() {
  return <ChatHomeScreen />;
}
