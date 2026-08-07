"use client";

// "3 replies · Maya, Priya · 2 hours ago" — spec 01 §2.3.
//
// One line, and it is the only thing standing between a channel and the failure
// mode threading exists to prevent: either every reply is inline and the room
// is unreadable, or replies are hidden and nobody knows a conversation
// happened.
//
// The facepile reads **oldest-first**, so the most recent replier sits
// rightmost — next to the count that just changed. The stats pass walks
// newest-first (that is how it takes the three most *recent* participants) and
// reverses on the way out; getting that backwards puts the person who started
// the thread beside the number that moves.

import type { ThreadSummary } from "./thread-summary";
import { replyCountLabel } from "./thread-summary";
import { ActorAvatar } from "./avatar";
import { formatThreadSummaryLastReplyTime } from "./date-labels";

export function ThreadSummaryRow({
  summary,
  onOpen,
}: {
  summary: ThreadSummary;
  onOpen: () => void;
}) {
  if (summary.replyCount <= 0) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-thread-summary=""
      className="tap-target mt-1.5 flex items-center gap-2 rounded-full py-0.5 pr-2 text-left transition-colors hover:bg-[var(--chat-hover)]"
    >
      <span className="flex -space-x-1.5">
        {summary.participants.map((participant) => (
          <ActorAvatar
            key={participant.pubkey}
            label={participant.label}
            pubkey={participant.pubkey}
            isAgent={participant.isAgent}
            size={20}
            className="ring-2 ring-background"
          />
        ))}
      </span>
      <span className="text-xs font-semibold">
        {replyCountLabel(summary.replyCount)}
      </span>
      {summary.lastReplyAt > 0 ? (
        <span className="text-tiny text-[var(--chat-quiet)]">
          {formatThreadSummaryLastReplyTime(summary.lastReplyAt)}
        </span>
      ) : null}
    </button>
  );
}
