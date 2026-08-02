// Where a search hit goes — spec 01 §6.3.
//
// Pure, and separate from the surface that renders the results, because "which
// place does this event live in" is a rule and not a rendering decision. Buzz
// keeps it in `app/navigation/resolveSearchHitDestination.ts` for the same
// reason: the ⌘K dialog, the in-channel find bar and any future surface that
// shows a hit must all land in the same place, and three copies of a branch on
// `kind` is three chances to disagree about where a forum comment opens.
//
// The href is built by `buildMessageLink` and by nothing else. That is the whole
// point of having it: a hit is a message, and there is already exactly one
// answer to "what is the URL of a message". A second URL builder here would work
// perfectly until the day the deep-link parameter is renamed, at which point
// every search result in the product would quietly stop landing anywhere.

import { buildMessageLink } from "../transcript/message-link";

/**
 * The two kinds of thing a hit can be.
 *
 * `forum-post` is Buzz's classification and it is kept, even though both branches
 * currently produce the same href: the forum surface does not exist yet, and a
 * link to a route that 404s is worse than a link that lands you in the room at
 * the post. Keeping the classification means the day the forum route lands, one
 * line changes — rather than somebody having to rediscover that 45001 and 45003
 * were ever different from a message.
 */
export type SearchHitDestination = {
  kind: "message" | "forum-post";
  channelId: string;
  messageId: string;
  threadRootId?: string;
  /** An in-app path. Relative, so it works in a router push and in an anchor. */
  href: string;
};

/** 45001 — a forum post. Its own id is the post id. */
export const KIND_FORUM_POST = 45001;
/** 45003 — a comment on a forum post; its thread root is the post. */
export const KIND_FORUM_COMMENT = 45003;

/** The fields a destination is derived from — anything hit-shaped will do. */
export type RoutableHit = {
  eventId: string;
  kind: number;
  channelId?: string | null;
  threadRootId?: string | null;
};

/**
 * Resolve a hit to somewhere to go, or to `null`.
 *
 * `null` for a hit with no channel is §6.3's first line and it is not a defensive
 * crumb: kind 0 profiles and every other global kind are genuinely unnavigable as
 * *messages*, and a result row that cannot be opened should not be rendered as
 * one. The caller filters on this rather than rendering a dead row.
 */
export function resolveSearchHitDestination(hit: RoutableHit): SearchHitDestination | null {
  if (!hit.channelId) return null;
  if (!hit.eventId) return null;

  const isForum = hit.kind === KIND_FORUM_POST || hit.kind === KIND_FORUM_COMMENT;
  // A forum *post* is its own root; a comment names the post it is under. Either
  // way the thread the link carries is the post, which is what lets the room
  // open the right pane instead of guessing.
  const threadRootId =
    hit.kind === KIND_FORUM_POST ? hit.eventId : (hit.threadRootId ?? undefined);

  return {
    kind: isForum ? "forum-post" : "message",
    channelId: hit.channelId,
    messageId: hit.eventId,
    ...(threadRootId ? { threadRootId } : {}),
    href: buildMessageLink({
      channelId: hit.channelId,
      messageId: hit.eventId,
      ...(threadRootId ? { threadRootId } : {}),
    }),
  };
}
