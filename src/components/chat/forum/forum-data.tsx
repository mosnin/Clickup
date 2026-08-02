"use client";

// Where the forum gets its posts.
//
// The same two shapes `transcript/messages-data.tsx` explains at length, for the
// same two reasons, and reusing its boundary rather than declaring a second one:
//
//  1. **References are built by hand** with `makeFunctionReference` rather than
//     read off `api.buzz.forum`. The generated `api` object is a checked-in stub
//     that only knows the modules present when it was last generated, so
//     `api.buzz.*` does not typecheck until somebody runs `npx convex dev`.
//  2. **A query against a function that is not deployed throws during render**,
//     so every subscription sits inside `MessagesBoundary` and its failure
//     becomes a sentence on the page.
//
// Paging is one subscription per page, again for the reason that file gives:
// Convex pushes a query's whole result on any change, so a single query holding
// four pages of posts re-sends four pages when one comment lands, while a page
// per cursor leaves the older pages sitting still — and keeps every one of them
// live, so an edit to a post four pages back still arrives.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { ChatScope } from "@/lib/buzz/channel-types";
import type { TimelineActor, TimelineEvent } from "@/lib/buzz/timeline";
import { MessagesBoundary } from "@/components/chat/transcript/messages-data";
import type { ComposerMentionable } from "@/components/chat/composer";
import type { ForumSummary } from "./model";

type ScopeArgs = { scopeType: ChatScope["scopeType"]; scopeId: string };

/** One page of a forum's posts, plus what overlays them. */
export type ForumPostsWindow = {
  events: TimelineEvent[];
  summaries: ForumSummary[];
  actors?: TimelineActor[];
  nextCursor?: string;
};

/** One post and its comment subtree. */
export type ForumThreadWindow = {
  events: TimelineEvent[];
  actors?: TimelineActor[];
  nextCursor?: string;
};

/** `api.buzz.forum.posts`. */
export const forumPostsQuery = makeFunctionReference<
  "query",
  ScopeArgs & { channelId: string; cursor?: string; limit?: number },
  ForumPostsWindow
>("buzz/forum:posts");

/** `api.buzz.forum.post`. */
export const forumPostQuery = makeFunctionReference<
  "query",
  ScopeArgs & { channelId: string; postId: string; cursor?: string },
  ForumThreadWindow
>("buzz/forum:post");

/** `api.buzz.forum.createPost`. */
export const createForumPost = makeFunctionReference<
  "mutation",
  ScopeArgs & { channelId: string; title: string; body: string },
  { eventId: string; createdAt: number }
>("buzz/forum:createPost");

/**
 * `api.buzz.forum.comment`.
 *
 * Argument-compatible with `buzz/messages:post`, which is the point: the comment
 * box on a post is the room's composer with the function reference swapped, not
 * a second composer. See `MessageComposerProps.postRef`.
 */
export const commentOnForumPost = makeFunctionReference<
  "mutation",
  ScopeArgs & { channelId: string; body: string; parentId?: string; rootId?: string },
  { eventId: string; createdAt: number }
>("buzz/forum:comment");

// ---------------------------------------------------------------------------
// The post list
// ---------------------------------------------------------------------------

export type ForumFeed = {
  /** `undefined` while the first page is in flight — the skeleton state. */
  events: TimelineEvent[] | undefined;
  summaries: ForumSummary[];
  actors: TimelineActor[] | undefined;
  /** Pages that have actually resolved. "No posts yet" needs this, not `!hasMore`. */
  resolvedPages: number;
  hasMore: boolean;
  fetchingMore: boolean;
  fetchMore: () => void;
  error: string | null;
  /** Must be rendered by the caller — this is where the subscriptions live. */
  subscriptions: ReactNode;
};

export function useForumFeed(
  scope: ChatScope | null,
  channelId: string,
): ForumFeed {
  // `""` is the first page (no cursor). Cursors are appended, never replaced,
  // so a page that has loaded stays loaded.
  const [cursors, setCursors] = useState<string[]>([""]);
  const [pages, setPages] = useState<Record<string, ForumPostsWindow>>({});
  const [error, setError] = useState<string | null>(null);

  // A new room is a new forum. Keyed on the community too, because the same
  // channel id in two communities is two different rooms.
  const key = scope ? `${scope.scopeType}:${scope.scopeId}:${channelId}` : "none";
  const lastKey = useRef(key);
  if (lastKey.current !== key) {
    lastKey.current = key;
    // Render-phase reset: an effect would paint one frame of the previous
    // forum's cards under the new forum's header, which reads as the wrong
    // posts rather than as a load.
    setCursors([""]);
    setPages({});
    setError(null);
  }

  const onPage = useCallback((cursor: string, window: ForumPostsWindow) => {
    setPages((prev) => (prev[cursor] === window ? prev : { ...prev, [cursor]: window }));
  }, []);

  const resolved = cursors.filter((cursor) => pages[cursor] !== undefined);
  const tail = resolved.length > 0 ? pages[resolved[resolved.length - 1]] : undefined;
  const hasMore = Boolean(tail?.nextCursor);
  const fetchingMore = resolved.length < cursors.length;

  const fetchMore = useCallback(() => {
    setCursors((prev) => {
      const last = prev[prev.length - 1];
      const window = pages[last];
      // Only the tail page may extend the chain, and only once: without the
      // membership check a double click appends the same cursor twice and
      // mounts two identical subscriptions.
      if (!window?.nextCursor || prev.includes(window.nextCursor)) return prev;
      return [...prev, window.nextCursor];
    });
  }, [pages]);

  const events = useMemo(() => {
    if (resolved.length === 0) return undefined;
    // Left unsorted and undeduped: the projector sorts by (created_at, id) and
    // dedupes by id, and doing it twice would be two opinions about ordering.
    return cursors.flatMap((cursor) => pages[cursor]?.events ?? []);
  }, [cursors, pages, resolved.length]);

  const summaries = useMemo(() => {
    // Later pages win on a collision, which cannot normally happen (a post is on
    // one page) but does across a refetch — and the fresher roll-up is the one
    // that saw the comment that just landed.
    const byPost = new Map<string, ForumSummary>();
    for (const cursor of cursors) {
      for (const summary of pages[cursor]?.summaries ?? []) byPost.set(summary.postId, summary);
    }
    return [...byPost.values()];
  }, [cursors, pages]);

  const actors = useMemo(() => {
    const seen = new Map<string, TimelineActor>();
    for (const cursor of [...cursors].reverse()) {
      for (const actor of pages[cursor]?.actors ?? []) seen.set(actor.pubkey, actor);
    }
    return seen.size === 0 ? undefined : [...seen.values()];
  }, [cursors, pages]);

  const subscriptions = (
    <MessagesBoundary key={key} onError={setError}>
      {cursors.map((cursor) => (
        <ForumPageSubscription
          key={cursor}
          scope={scope}
          channelId={channelId}
          cursor={cursor}
          onResult={onPage}
          onOk={() => setError(null)}
        />
      ))}
    </MessagesBoundary>
  );

  return {
    events,
    summaries,
    actors,
    resolvedPages: resolved.length,
    hasMore,
    fetchingMore,
    fetchMore,
    error,
    subscriptions,
  };
}

/** One page, rendering nothing. Split out so the boundary wraps only the throw. */
function ForumPageSubscription({
  scope,
  channelId,
  cursor,
  onResult,
  onOk,
}: {
  scope: ChatScope | null;
  channelId: string;
  cursor: string;
  onResult: (cursor: string, window: ForumPostsWindow) => void;
  onOk: () => void;
}) {
  const result = useQuery(
    forumPostsQuery,
    scope
      ? {
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          channelId,
          ...(cursor ? { cursor } : {}),
        }
      : "skip",
  );
  const last = useRef<ForumPostsWindow | undefined>(undefined);
  useEffect(() => {
    if (result === undefined || last.current === result) return;
    last.current = result;
    onResult(cursor, result);
    onOk();
  }, [result, cursor, onResult, onOk]);
  return null;
}

// ---------------------------------------------------------------------------
// One post
// ---------------------------------------------------------------------------

export function useForumThread(
  scope: ChatScope | null,
  channelId: string,
  postId: string | null,
): {
  events: TimelineEvent[] | undefined;
  actors: TimelineActor[] | undefined;
  error: string | null;
  subscriptions: ReactNode;
} {
  const [window, setWindow] = useState<ForumThreadWindow | undefined>();
  const [error, setError] = useState<string | null>(null);
  const key = `${channelId}:${postId ?? "none"}`;
  const lastKey = useRef(key);
  if (lastKey.current !== key) {
    lastKey.current = key;
    setWindow(undefined);
    setError(null);
  }

  const subscriptions = (
    <MessagesBoundary key={key} onError={setError}>
      <ForumThreadSubscription
        scope={scope}
        channelId={channelId}
        postId={postId}
        onResult={setWindow}
        onOk={() => setError(null)}
      />
    </MessagesBoundary>
  );

  return { events: window?.events, actors: window?.actors, error, subscriptions };
}

function ForumThreadSubscription({
  scope,
  channelId,
  postId,
  onResult,
  onOk,
}: {
  scope: ChatScope | null;
  channelId: string;
  postId: string | null;
  onResult: (window: ForumThreadWindow) => void;
  onOk: () => void;
}) {
  const result = useQuery(
    forumPostQuery,
    scope && postId
      ? { scopeType: scope.scopeType, scopeId: scope.scopeId, channelId, postId }
      : "skip",
  );
  const last = useRef<ForumThreadWindow | undefined>(undefined);
  useEffect(() => {
    if (result === undefined || last.current === result) return;
    last.current = result;
    onResult(result);
    onOk();
  }, [result, onResult, onOk]);
  return null;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * `api.buzz.channels.members` — who can be mentioned in a post.
 *
 * The same query `shell/room-composer.tsx` runs for the room's composer, asked
 * again here because the post composer is not that component and cannot be: a
 * post has a title. Naming it rather than threading a `mentionables` prop down
 * through the channel screen keeps the forum's data needs inside the forum.
 */
const membersQuery = makeFunctionReference<
  "query",
  ScopeArgs & { channelId: string },
  { actorId: string; actorType: "user" | "agent"; name: string; isSelf: boolean }[] | null
>("buzz/channels:members");

/** Who a post may mention. Empty while the query is in flight — never a guess. */
export function useForumMentionables(
  scope: ChatScope | null,
  channelId: string,
): ComposerMentionable[] {
  const members = useQuery(
    membersQuery,
    scope ? { scopeType: scope.scopeType, scopeId: scope.scopeId, channelId } : "skip",
  );
  return useMemo(
    () =>
      (members ?? []).map((member) => ({
        id: member.actorId,
        name: member.name,
        kind: member.actorType,
      })),
    [members],
  );
}

/** Start a discussion. Returns the new post's event id. */
export function useCreatePost(
  scope: ChatScope | null,
  channelId: string,
): (title: string, body: string) => Promise<string> {
  const create = useMutation(createForumPost);
  return useCallback(
    async (title, body) => {
      if (!scope) throw new Error("No community selected");
      const result = await create({
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        channelId,
        title,
        body,
      });
      return result?.eventId ?? "";
    },
    [create, scope, channelId],
  );
}
