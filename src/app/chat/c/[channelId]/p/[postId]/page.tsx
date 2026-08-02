import type { Metadata } from "next";
import { ForumPostScreen } from "@/components/chat/forum";

export const metadata: Metadata = { title: "Chat" };

// `/chat/c/<id>/p/<postId>` — one forum post.
//
// A **sub-route of its channel**, which is 03-workflows-projects §5.2 and is the
// whole shape of the thing: a post belongs to a room, the rail keeps drawing that
// room as the active one, and the back arrow goes somewhere real. A top-level
// `/chat/p/<id>` would have been shorter and would have made a shared link land
// on a page with no context and no way up.
//
// Both ids are in the path rather than in a query parameter for the same reason
// the room's own id is: a post is a place, and a place has a URL somebody can
// send to the person it is about.

export default async function ForumPostPage({
  params,
}: {
  params: Promise<{ channelId: string; postId: string }>;
}) {
  const { channelId, postId } = await params;
  return <ForumPostScreen channelId={channelId} postId={postId} />;
}
