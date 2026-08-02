import type { Metadata } from "next";
import { ChannelScreen } from "@/components/chat/shell/channel-screen";

export const metadata: Metadata = { title: "Chat" };

// `/chat/c/<id>` — one room.
//
// The id is in the path rather than a query parameter, so a room is a place
// with a URL somebody can send. Everything that decides what the room looks
// like — the sidebar's active row, the top strip's location line, the read
// marker — reads it back through `activeChannelId(pathname)`, so there is one
// mapping from URL to selection and nothing to keep in sync.

export default async function ChannelPage({
  params,
}: {
  params: Promise<{ channelId: string }>;
}) {
  const { channelId } = await params;
  return <ChannelScreen channelId={channelId} />;
}
