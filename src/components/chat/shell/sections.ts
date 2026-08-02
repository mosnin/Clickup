// How a flat list of channels becomes the sidebar, and how a row is marked.
//
// Pure on purpose. These are the rules that decide what somebody sees in the
// only navigation the application has — which room is listed, in what order,
// and whether it is shouting at them. Rules that live inside a component are
// rules nobody can test and nobody can read without also reading JSX.
//
// Deliberately absent: Starred and user-made sections. Buzz has both, and the
// channel contract (src/lib/buzz/channel-types.ts) carries no star flag and no
// section assignment — so building them here would mean inventing client-side
// state for something that has to be per-person and per-community on the
// server. An empty Starred section that can never fill is worse than none.

import type { ChatChannelSummary } from "@/lib/buzz/channel-types";

export type ChatSectionId = "channels" | "forums" | "dms";

export type ChatSection = {
  id: ChatSectionId;
  label: string;
  /** What the section's `+` does, in words. Null when it has no quick action. */
  action: string | null;
  channels: ChatChannelSummary[];
};

/**
 * Rooms first by recency, then by name.
 *
 * Recency because the room you were last talking in is the room you are most
 * likely to want; name as the tiebreak because a list of never-used rooms
 * ordered by their creation accident is a list nobody can scan. A room with no
 * activity sorts below every room that has some, rather than to the top with
 * a zero timestamp.
 */
function byActivityThenName(
  a: ChatChannelSummary,
  b: ChatChannelSummary,
): number {
  const at = a.lastActivityAt ?? 0;
  const bt = b.lastActivityAt ?? 0;
  if (at !== bt) return bt - at;
  return title(a).localeCompare(title(b));
}

/** What a room is called on screen. A DM's name is derived, so it can be empty. */
export function title(channel: ChatChannelSummary): string {
  return channel.displayName.trim() || channel.name;
}

/**
 * The sidebar, grouped.
 *
 * Archived rooms and rooms you are not in are dropped: the sidebar answers
 * "where do I talk", the channel browser answers "what exists". Forums appear
 * only when there are forums — an always-present empty section for a feature a
 * community does not use is furniture.
 */
export function sidebarSections(
  channels: readonly ChatChannelSummary[],
): ChatSection[] {
  const live = channels.filter((c) => c.joined && c.archivedAt === undefined);

  const rooms = live.filter((c) => c.kind === "channel").sort(byActivityThenName);
  const forums = live.filter((c) => c.kind === "forum").sort(byActivityThenName);
  const dms = live
    .filter((c) => c.kind === "dm" || c.kind === "group_dm")
    .sort(byActivityThenName);

  const sections: ChatSection[] = [
    { id: "channels", label: "Channels", action: "Browse channels", channels: rooms },
  ];
  if (forums.length > 0) {
    sections.push({ id: "forums", label: "Forums", action: null, channels: forums });
  }
  sections.push({
    id: "dms",
    label: "Direct messages",
    action: "New message",
    channels: dms,
  });
  return sections;
}

export type UnreadMark =
  | { kind: "none" }
  | { kind: "dot" }
  | { kind: "count"; count: number; label: string };

/** Counts stop being useful long before they stop being renderable. */
const COUNT_CAP = 99;

/**
 * How a row's unread state is drawn.
 *
 * Two marks, and the difference is the whole point: a count is something
 * addressed to you and expected back, a dot is only news. Collapsing them into
 * one number loses the only distinction the badge exists to make, and a room
 * that shouts about everything gets muted and then missed.
 *
 * A direct message counts as addressed to you whether or not it named you —
 * that is what makes it direct.
 *
 * Never drawn on the row you are standing on. You are reading it; a badge
 * telling you so is a to-do the app just did for you.
 */
export function unreadMark(
  channel: ChatChannelSummary,
  isActive: boolean,
): UnreadMark {
  if (isActive) return { kind: "none" };
  const direct = channel.kind === "dm" || channel.kind === "group_dm";
  const count = direct ? Math.max(channel.mentions, channel.unread) : channel.mentions;
  if (count > 0) {
    return {
      kind: "count",
      count,
      label: count > COUNT_CAP ? `${COUNT_CAP}+` : String(count),
    };
  }
  if (channel.unread > 0) return { kind: "dot" };
  return { kind: "none" };
}

/**
 * The mark on a community tile, summed over its rooms.
 *
 * Nothing is drawn from a community whose channels have not loaded. A
 * fabricated badge is worse than no badge: it teaches people that the badge
 * means nothing, and after that a real one does not get read either. So the
 * caller passes `null` for "not observed yet" and gets `none` back, rather
 * than an empty array quietly meaning "all read".
 */
export function communityMark(
  channels: readonly ChatChannelSummary[] | null | undefined,
): UnreadMark {
  if (!channels) return { kind: "none" };
  let mentions = 0;
  let unread = 0;
  for (const c of channels) {
    if (!c.joined || c.archivedAt !== undefined) continue;
    mentions += c.mentions;
    unread += c.unread;
  }
  if (mentions > 0) {
    return {
      kind: "count",
      count: mentions,
      label: mentions > COUNT_CAP ? `${COUNT_CAP}+` : String(mentions),
    };
  }
  if (unread > 0) return { kind: "dot" };
  return { kind: "none" };
}

/**
 * Whether there is unread above or below what the sidebar is showing.
 *
 * The pill this drives is the answer to "the sidebar has forty rooms and the
 * one shouting at me is off screen". Offsets are measured by the caller
 * (the DOM knows where rows are; this decides what that means), so the rule
 * itself stays testable without a layout engine.
 *
 * A row is "out of view" only when it is fully out — a half-visible row is a
 * row you can already see is there, and pointing at it is noise.
 */
export function unreadOverflow(
  rows: readonly { top: number; bottom: number; count: number }[],
  view: { top: number; bottom: number },
): { above: number; below: number } {
  let above = 0;
  let below = 0;
  for (const row of rows) {
    if (row.count <= 0) continue;
    if (row.bottom <= view.top) above += row.count;
    else if (row.top >= view.bottom) below += row.count;
  }
  return { above, below };
}

/** "3 new messages" / "1 new message". The pill's whole label. */
export function unreadCountLabel(count: number): string {
  return `${count} new message${count === 1 ? "" : "s"}`;
}

/** Two letters for a community with no icon. Never more — it is a 36px tile. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
