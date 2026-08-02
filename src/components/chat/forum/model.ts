// What a forum post is, to the surfaces that draw one.
//
// Pure — no React, no Convex, no DOM — because every rule here is a rule about
// ordering or truncation, and those are exactly the rules that break silently:
// a sort with no tie-break shuffles cards under the reader's cursor whenever two
// posts share a second, and a preview that counts UTF-16 units cuts an emoji in
// half. Both pass a rendering test and neither passes a unit test, which is why
// they live here rather than inside a component.
//
// The kind numbers are **restated** rather than imported from
// `convex/buzz/forum.ts`, for the reason `src/lib/buzz/timeline.ts` gives about
// its own copies: that module reaches `_nostr.ts` and therefore `@noble/curves`,
// a signing library the browser has no use for and should not download to draw a
// card. The duplication is the hazard the codebase warns about, so
// `tests/buzz-forum.test.ts` pins every constant below against the server's copy
// and fails if the two ever drift.

import type { ChatMessage } from "@/lib/buzz/message-types";

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/** A top-level forum post. */
export const KIND_FORUM_POST = 45001;
/** A comment on one. */
export const KIND_FORUM_COMMENT = 45003;

/**
 * The content set for the **post list**: posts only.
 *
 * Comments are excluded on purpose rather than by accident of the query — a
 * comment that appeared as a card in the list would be a reply to a discussion,
 * presented as a discussion.
 */
export const FORUM_LIST_KINDS: ReadonlySet<number> = new Set([KIND_FORUM_POST]);

/** The content set for one post's page: the post and everything under it. */
export const FORUM_THREAD_KINDS: ReadonlySet<number> = new Set([
  KIND_FORUM_POST,
  KIND_FORUM_COMMENT,
]);

// ---------------------------------------------------------------------------
// Titles and previews
// ---------------------------------------------------------------------------

/** The tag a post's title rides in. `convex/buzz/forum.ts` writes it. */
export const SUBJECT_TAG = "subject";

/**
 * The title on a post, or the empty string.
 *
 * First tag wins, matching the server: an author who can append a second subject
 * tag must not be able to choose which one a reader believes.
 */
export function titleFromTags(tags: readonly string[][]): string {
  for (const tag of tags) {
    if (tag[0] === SUBJECT_TAG && typeof tag[1] === "string") return tag[1];
  }
  return "";
}

/**
 * How long a title may be. The server's cap, restated and pinned by a test.
 *
 * Enforced in the field as `maxLength` rather than by truncating on submit,
 * because truncation loses words somebody typed and does it silently — a field
 * that stops accepting characters says so while they are still looking at it.
 */
export const MAX_TITLE_CHARS = 200;

/** §5.5: a card's body preview is 200 characters and then an ellipsis. */
export const PREVIEW_CHARS = 200;

/**
 * The first 200 **characters** of a body, with an ellipsis when there is more.
 *
 * Code points, not UTF-16 units — `slice(0, 200)` on a body that reaches the cut
 * inside an emoji or an accented character emits half a surrogate pair, which
 * renders as a replacement glyph on the one card that happened to be that long.
 * The ellipsis is a single character rather than three dots so the count is what
 * it says it is.
 *
 * Newlines collapse: a preview is one paragraph of a card, and a body whose first
 * two hundred characters are blank lines would otherwise draw an empty card.
 */
export function previewOf(body: string): string {
  const flat = body.replace(/\s+/gu, " ").trim();
  const chars = [...flat];
  if (chars.length <= PREVIEW_CHARS) return flat;
  return `${chars.slice(0, PREVIEW_CHARS).join("").trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** The server's roll-up of a post's comments. Mirrors `ForumThreadSummary`. */
export type ForumSummary = {
  postId: string;
  replyCount: number;
  lastReplyAt: number;
  participants: string[];
  capped: boolean;
};

/**
 * One card.
 *
 * The `message` is an ordinary projected `ChatMessage` — the same object the
 * transcript draws — so `body` is already the edited text, `reactions` are
 * already folded, and `mine` already means what it means everywhere else. What a
 * card adds is the three things a message has no room for: its title, the
 * preview of its body, and how the discussion under it has gone.
 */
export type ForumCard = {
  message: ChatMessage;
  title: string;
  preview: string;
  summary: ForumSummary | null;
};

export function buildForumCards(
  messages: readonly ChatMessage[],
  summaries: readonly ForumSummary[],
): ForumCard[] {
  const byPost = new Map(summaries.map((summary) => [summary.postId, summary]));
  return messages.map((message) => ({
    message,
    title: titleFromTags(message.tags),
    preview: previewOf(message.body),
    summary: byPost.get(message.id) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * The three orders, and there are three because they answer three questions:
 * what is new, what is alive, and what mattered.
 */
export type ForumSort = "latest" | "active" | "top";

export const FORUM_SORTS: readonly { id: ForumSort; label: string }[] = [
  { id: "latest", label: "Latest" },
  { id: "active", label: "Active" },
  { id: "top", label: "Most replies" },
];

export function isForumSort(value: string | null | undefined): value is ForumSort {
  return value === "latest" || value === "active" || value === "top";
}

/**
 * When a post last moved: its newest comment, or its own creation.
 *
 * Falling back to `createdAt` rather than 0 is what makes "Active" a *complete*
 * order instead of a partition — otherwise every post nobody has replied to
 * sorts below every post that has one reply, however old, and a forum that has
 * just been started reads as empty.
 */
export function lastActivityOf(card: ForumCard): number {
  return Math.max(card.summary?.lastReplyAt ?? 0, card.message.createdAt);
}

/**
 * The comparator for one sort.
 *
 * **Every branch ends at the event id**, and that is the load-bearing part.
 * `createdAt` is Nostr seconds, so two posts written in the same second are
 * routine; a reply count ties constantly (most posts have none). Without a total
 * order the same two cards land in different positions depending on whether
 * history or the live subscription delivered first, which the reader sees as a
 * list that reshuffles itself while they are looking at it.
 *
 * Ties on the id are broken **ascending** while everything above it is
 * descending, which looks inconsistent and is not: it is the same rule the
 * message log uses (`byRelayOrder`), so a post and a message that share a second
 * order the same way on both surfaces.
 */
export function compareForumCards(sort: ForumSort): (a: ForumCard, b: ForumCard) => number {
  return (a, b) => {
    if (sort === "active") {
      const delta = lastActivityOf(b) - lastActivityOf(a);
      if (delta !== 0) return delta;
    } else if (sort === "top") {
      const delta = (b.summary?.replyCount ?? 0) - (a.summary?.replyCount ?? 0);
      if (delta !== 0) return delta;
    }
    // "Latest" is only this, and the other two fall through to it: within equal
    // activity or an equal reply count, newer first is the answer a reader
    // expects and the one that needs no explanation.
    if (b.message.createdAt !== a.message.createdAt) {
      return b.message.createdAt - a.message.createdAt;
    }
    return a.message.id < b.message.id ? -1 : a.message.id > b.message.id ? 1 : 0;
  };
}

/** Sorted, without mutating the input — the caller's array is React state. */
export function sortForumCards(
  cards: readonly ForumCard[],
  sort: ForumSort,
): ForumCard[] {
  return [...cards].sort(compareForumCards(sort));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Where one post lives.
 *
 * A sub-route of its channel, not a screen of its own (§5.2) — the room is most
 * of the context for what a post means, and a URL that dropped it would make a
 * shared link land somewhere with no way back.
 */
export function forumPostHref(channelId: string, postId: string): string {
  return `/chat/c/${encodeURIComponent(channelId)}/p/${encodeURIComponent(postId)}`;
}

/** `"3 replies"` / `"1 reply"` / `"60+ replies"` when the server's scan capped. */
export function replyCountLabel(summary: ForumSummary): string {
  const count = summary.capped ? `${summary.replyCount}+` : String(summary.replyCount);
  return `${count} ${summary.replyCount === 1 && !summary.capped ? "reply" : "replies"}`;
}
