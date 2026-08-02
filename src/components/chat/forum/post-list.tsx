"use client";

// The forum, as a list of things to read.
//
// Three bands, and only the middle one scrolls: the composer, the sort control,
// the cards. The composer is at the *top* rather than pinned to the bottom
// because a forum is not a conversation you are standing in — you arrive to
// read, and occasionally to start something, and a box pinned under the fold is
// a box that says the room's job is replying.
//
// Sorting is applied here, over the cards that have loaded, and that is stated
// plainly rather than hidden: the server pages by creation time (an index can
// order by that; it cannot order by "most recently replied to", which is a
// number derived from other rows), and `sortForumCards` orders what is on the
// page. The order is total — every comparator ends at the event id — so the same
// set of cards always lands in the same order, whichever subscription delivered
// them first.

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ChatChannelSummary, ChatScope } from "@/lib/buzz/channel-types";
import {
  formatTimelineMessages,
  type TimelineActor,
} from "@/lib/buzz/timeline";
import { useSelfPubkey } from "@/components/chat/transcript/messages-data";
import { cn } from "@/lib/utils";
import { useForumFeed, useForumMentionables, useCreatePost } from "./forum-data";
import {
  buildForumCards,
  forumPostHref,
  FORUM_LIST_KINDS,
  FORUM_SORTS,
  sortForumCards,
  type ForumSort,
} from "./model";
import { PostCard } from "./post-card";
import { PostComposer, type PostComposerProps } from "./post-composer";

export function ForumPostList({
  scope,
  channel,
  onComposerReady,
}: {
  scope: ChatScope | null;
  channel: ChatChannelSummary;
  /** Forwarded to the post composer's body editor. See `PostComposerProps`. */
  onComposerReady?: PostComposerProps["onEditorReady"];
}) {
  const router = useRouter();
  const feed = useForumFeed(scope, channel.channelId);
  const mentionables = useForumMentionables(scope, channel.channelId);
  const selfPubkey = useSelfPubkey();
  const createPost = useCreatePost(scope, channel.channelId);
  const [sort, setSort] = useState<ForumSort>("latest");

  const actorMap = useMemo(
    () => new Map((feed.actors ?? []).map((actor) => [actor.pubkey, actor])),
    [feed.actors],
  );

  const cards = useMemo(() => {
    if (!feed.events) return undefined;
    // The same projector the transcript uses, told which kinds draw a row here.
    // That is what makes an edited post show its new text, a deleted one vanish
    // and its reactions fold — none of it written twice — and what keeps a chat
    // message out of the post list even though both live in this room.
    const messages = formatTimelineMessages(feed.events, {
      ...(selfPubkey ? { selfPubkey } : {}),
      actors: actorMap as ReadonlyMap<string, TimelineActor>,
      contentKinds: FORUM_LIST_KINDS,
    });
    return sortForumCards(buildForumCards(messages, feed.summaries), sort);
  }, [feed.events, feed.summaries, actorMap, selfPubkey, sort]);

  const onCreated = useCallback(
    (postId: string) => {
      // Straight into the post that was just written. A composer that clears
      // itself and leaves you at the top of a list is a composer that makes you
      // hunt for the thing you just made.
      if (postId) router.push(forumPostHref(channel.channelId, postId));
    },
    [router, channel.channelId],
  );

  const composerOff = channel.archivedAt !== undefined
    ? "This forum is archived."
    : !channel.joined
      ? "Join this forum to create posts."
      : !scope
        ? "Connecting…"
        : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {feed.subscriptions}

      <div className="shrink-0 px-5 pb-3">
        <PostComposer
          mentionables={mentionables}
          disabledReason={composerOff}
          onSubmit={createPost}
          onCreated={onCreated}
          {...(onComposerReady ? { onEditorReady: onComposerReady } : {})}
        />
      </div>

      <div className="shrink-0 px-5 pb-2">
        <div className="segmented inline-flex" role="tablist" aria-label="Sort posts">
          {FORUM_SORTS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={sort === option.id}
              onClick={() => setSort(option.id)}
              className={cn(
                "tap-target rounded-full px-3 py-1 text-xs font-medium",
                sort === option.id && "segmented-on",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="chat-scroll min-h-0 flex-1 px-5 pb-5">
        {feed.error ? (
          <p className="text-sm text-destructive">{feed.error}</p>
        ) : cards === undefined ? (
          <PostListSkeleton />
        ) : cards.length === 0 ? (
          <div className="max-w-sm py-6">
            <p className="text-sm font-medium">No posts yet</p>
            <p className="chat-quiet mt-1 text-sm">
              Start a discussion by creating the first post. A post has a title
              and stays findable; a chat message does not.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {cards.map((card) => (
              <PostCard
                key={card.message.renderKey}
                card={card}
                channelId={channel.channelId}
                actors={actorMap}
              />
            ))}
            {feed.hasMore ? (
              <button
                type="button"
                onClick={feed.fetchMore}
                disabled={feed.fetchingMore}
                className="chat-quiet w-full rounded-full py-2 text-xs font-medium hover:bg-[var(--chat-hover)]"
              >
                {feed.fetchingMore ? "Loading…" : "Older posts"}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

/** §5.5: three cards. Content-shaped, so the list does not jump when it lands. */
function PostListSkeleton() {
  return (
    <div aria-hidden data-testid="forum-skeleton" className="space-y-2">
      {[70, 55, 62].map((width, index) => (
        <div key={index} className="bento rounded-2xl px-4 py-3.5">
          <div
            className="h-3.5 rounded-full bg-[var(--chat-hover)]"
            style={{ width: `${width}%` }}
          />
          <div className="mt-2 h-2.5 w-28 rounded-full bg-[var(--chat-hover)]" />
          <div className="mt-2.5 h-2.5 w-full rounded-full bg-[var(--chat-hover)]" />
        </div>
      ))}
    </div>
  );
}
