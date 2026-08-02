"use client";

// Which messages can be reviewed, and what the conversation about each one is.
//
// §2.10's context assembly, over our projection instead of Buzz's. Two rules
// carry the whole thing:
//
//   • **A review exists only where there is a video** — `hasVideoAttachment` —
//     so the launcher does not appear on messages where it would open an empty
//     dialog.
//   • **A comment on a comment is a comment on the video** (`commentsByRoot`
//     walks every ancestor), because the panel shows one conversation about one
//     clip and an answer that only appeared under its parent would vanish from
//     it the moment somebody replied.
//
// Built from the messages the transcript already folded rather than from a
// second query: the replies are in the channel window whether or not the
// transcript draws them as rows, and a query per video would be one round trip
// per screenshot in a busy room.

import type { ChatMessage } from "@/lib/buzz/message-types";
import { commentsByRoot, hasVideoAttachment } from "@/lib/buzz/media";
import type { VideoReviewComment, VideoReviewContext } from "./video-review";

export function buildVideoReviews(
  messages: readonly ChatMessage[],
  options: {
    /** Absent on a read-only surface; the panel then renders without a box. */
    onSend?: (body: string, parentEventId: string) => Promise<unknown>;
    disabledReason?: string;
  } = {},
): Map<string, VideoReviewContext> {
  const withVideo = messages.filter((message) => hasVideoAttachment(message.tags));
  if (withVideo.length === 0) return new Map();

  const nodes: (VideoReviewComment & { id: string })[] = messages.map((message) => ({
    id: message.id,
    author: message.author,
    body: message.body,
    createdAt: message.createdAt,
    ...(message.parentId ? { parentId: message.parentId } : {}),
    ...(message.mine ? { mine: true } : {}),
    ...(message.pending ? { pending: true } : {}),
  }));
  const byRoot = commentsByRoot(nodes);

  const out = new Map<string, VideoReviewContext>();
  for (const message of withVideo) {
    // A pending video has no event id yet, so a comment filed under it would be
    // filed under a local key the server has never heard of.
    if (message.pending) continue;
    out.set(message.id, {
      rootEventId: message.id,
      comments: byRoot.get(message.id) ?? [],
      ...(options.onSend ? { onSend: options.onSend } : {}),
      ...(options.disabledReason ? { disabledReason: options.disabledReason } : {}),
    });
  }
  return out;
}
