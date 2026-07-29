import { Suspense } from "react";
import type { Metadata } from "next";
import { ChatView } from "./chat-view";

export const metadata: Metadata = { title: "Chat" };

export default function ChatPage() {
  // Suspense because ChatView reads the channel out of the URL, and
  // useSearchParams opts a route into client rendering without it.
  return (
    <Suspense fallback={null}>
      <ChatView />
    </Suspense>
  );
}
