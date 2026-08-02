// The summary row — spec 01 §2.3.
//
// One line under a message that has replies: three faces, a count, and when it
// last moved. It is the only thing standing between a channel and the failure
// mode threads exist to prevent — either every reply is inline and the room is
// unreadable, or replies are hidden and nobody knows a conversation happened.
//
// Two rules from the spec are load-bearing and neither is obvious:
//
//   • **Walk newest-first, display oldest-first.** The stats pass takes the
//     three most *recent* repliers, then the render reverses them, so a facepile
//     reads left-to-right in the order people arrived and the most recent
//     replier is rightmost — next to the count that just changed.
//   • **Cap the ancestor climb.** A reply chain is built from ids the client did
//     not create, and a cycle in it is an infinite loop inside a render. The cap
//     is `messages.length + 1`: strictly more hops than any acyclic chain can
//     need, so it never truncates a legitimate thread and always terminates.

import type { ChatMessage } from "@/lib/buzz/message-types";

export const MAX_SUMMARY_PARTICIPANTS = 3;

export type SummaryParticipant = {
  pubkey: string;
  label: string;
  isAgent: boolean;
};

export type ThreadSummary = {
  replyCount: number;
  /** 0 when nothing has replied — callers render null rather than "0 replies". */
  lastReplyAt: number;
  /** Oldest-first, ready to draw. At most `MAX_SUMMARY_PARTICIPANTS`. */
  participants: SummaryParticipant[];
};

type MutableStats = {
  replyCount: number;
  lastReplyAt: number;
  /** Newest-first while accumulating; reversed on the way out. */
  participants: SummaryParticipant[];
  seen: Set<string>;
};

/**
 * Descendant stats for every message that has any, keyed by message id.
 *
 * Counts the whole subtree, not just direct children: "4 replies" on a root
 * that has one reply with three replies of its own is the honest number, and
 * the one a reader is deciding whether to open the pane on.
 */
export function buildThreadSummaries(
  messages: readonly ChatMessage[],
): Map<string, ThreadSummary> {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const stats = new Map<string, MutableStats>();

  // Newest-first, with the event id as the tie-break — bursty threads
  // routinely share a timestamp, and without the tie-break the three faces
  // shown are whichever order the array happened to arrive in.
  const ordered = [...messages].sort(
    (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
  const hopCap = messages.length + 1;

  for (const message of ordered) {
    let cursor = message.parentId ? byId.get(message.parentId) : undefined;
    let hops = 0;
    while (cursor && hops < hopCap) {
      hops += 1;
      let entry = stats.get(cursor.id);
      if (!entry) {
        entry = { replyCount: 0, lastReplyAt: 0, participants: [], seen: new Set() };
        stats.set(cursor.id, entry);
      }
      entry.replyCount += 1;
      if (message.createdAt > entry.lastReplyAt) entry.lastReplyAt = message.createdAt;
      if (
        entry.participants.length < MAX_SUMMARY_PARTICIPANTS &&
        !entry.seen.has(message.pubkey)
      ) {
        entry.seen.add(message.pubkey);
        entry.participants.push({
          pubkey: message.pubkey,
          label: message.author,
          isAgent: message.isAgent,
        });
      }
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
  }

  const out = new Map<string, ThreadSummary>();
  for (const [id, entry] of stats) {
    out.set(id, {
      replyCount: entry.replyCount,
      lastReplyAt: entry.lastReplyAt,
      participants: [...entry.participants].reverse(),
    });
  }
  return out;
}

/**
 * Fold a locally-computed summary together with one the server sent.
 *
 * `max` on both numbers rather than "server wins": the local walk sees replies
 * that arrived this second and the server's roll-up sees replies that fell out
 * of the loaded window, and each is right about the half the other cannot see.
 * Taking the larger of the two can overcount only if something is wrong
 * upstream; taking either one alone undercounts routinely.
 */
export function mergeThreadSummaries(
  local: ThreadSummary | null | undefined,
  remote: ThreadSummary | null | undefined,
): ThreadSummary | null {
  if (!local) return remote ?? null;
  if (!remote) return local;
  const participants: SummaryParticipant[] = [];
  const seen = new Set<string>();
  // Remote first, then local: the server's list is the more complete one, and
  // the slice keeps the last three so the newest replier stays rightmost.
  for (const p of [...remote.participants, ...local.participants]) {
    if (seen.has(p.pubkey)) continue;
    seen.add(p.pubkey);
    participants.push(p);
  }
  return {
    replyCount: Math.max(local.replyCount, remote.replyCount),
    lastReplyAt: Math.max(local.lastReplyAt, remote.lastReplyAt),
    participants: participants.slice(-MAX_SUMMARY_PARTICIPANTS),
  };
}

/** `"3 replies"` / `"1 reply"`. */
export function replyCountLabel(count: number): string {
  return `${count} ${count === 1 ? "reply" : "replies"}`;
}

/** Two initials, the identity mark a facepile is made of. */
export function initials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
