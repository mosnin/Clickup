"use client";

// One post, and the discussion under it.
//
// A sub-route of its channel rather than a screen of its own (§5.2): the room is
// most of the context for what a post means, and the rail stays where it was, so
// opening a post is a move within a place rather than a departure from it.
//
// **Everything a post can have done to it comes from the message paths.** The
// row is `MessageRow`, the same one the transcript draws — so the hover toolbar,
// the emoji picker, the more-menu, edit-in-place and the undo-able delete are
// not re-decided here; the writes are `useMessageActions`, which addresses
// `buzz/messages:{react,unreact,edit,remove}`; and the projection is
// `formatTimelineMessages`, which folds the edits and the reaction pills. What
// this file owns is the *arrangement* — a titled article with a comment list
// beneath it, which is genuinely not a side pane and should not pretend to be.
//
// The one thing above the row is the title, because a title is the one thing a
// message has no room for.

import { useCallback, useMemo, useReducer, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { ChatMessage, ChatRow } from "@/lib/buzz/message-types";
import {
  buildTimelineRows,
  formatTimelineMessages,
  type TimelineActor,
  type TimelineEvent,
} from "@/lib/buzz/timeline";
import { useToast } from "@/components/toast";
import { MessageRow } from "@/components/chat/transcript/message-row";
import { NonMessageRow } from "@/components/chat/transcript/dividers";
import { buildMessageLink } from "@/components/chat/transcript/message-link";
import {
  MyPubkeyProvider,
  useMessageActions,
  useSelfPubkey,
} from "@/components/chat/transcript/messages-data";
import {
  applyOptimisticReaction,
  selectDisplayReactions,
  type ReactionOverlay,
} from "@/components/chat/transcript/reaction-algebra";
import {
  canManageMessage,
  hasCopyActions,
  rowKey,
} from "@/components/chat/transcript/row-model";
import { useChannel, useChannels } from "@/components/chat/shell/channel-data";
import { useChatShell } from "@/components/chat/shell/chat-shell";
import { ContentSurface } from "@/components/chat/shell/surfaces";
import {
  RoomComposer,
  applyPending,
  type PendingChange,
} from "@/components/chat/shell/room-composer";
import { commentOnForumPost, useForumThread } from "./forum-data";
import { FORUM_THREAD_KINDS, KIND_FORUM_COMMENT, titleFromTags } from "./model";

export function ForumPostScreen({
  channelId,
  postId,
}: {
  channelId: string;
  postId: string;
}) {
  const { channels, error } = useChannels();
  const channel = useChannel(channelId);
  const { scope } = useChatShell();

  if (channels === undefined && !error) {
    return (
      <ContentSurface>
        <div className="h-13 shrink-0 px-5" />
        <div className="min-h-0 flex-1" />
      </ContentSurface>
    );
  }

  if (!channel || channel.kind !== "forum") {
    return (
      <ContentSurface>
        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          <div className="max-w-sm">
            <h1 className="text-lg font-semibold">Post not found</h1>
            <p className="chat-quiet mt-2 text-sm">
              {/* Two causes, one sentence, because the reader cannot act on the
                  difference: the room is in another community, or it is not a
                  forum and has no posts to open. */}
              This post&apos;s room is not a forum in this community. Pick a
              community from the rail, or open the room from the sidebar.
            </p>
          </div>
        </div>
      </ContentSurface>
    );
  }

  return (
    <MyPubkeyProvider>
      <PostBody scope={scope} channel={channel} channelId={channelId} postId={postId} />
    </MyPubkeyProvider>
  );
}

function PostBody({
  scope,
  channel,
  channelId,
  postId,
}: {
  scope: ReturnType<typeof useChatShell>["scope"];
  channel: NonNullable<ReturnType<typeof useChannel>>;
  channelId: string;
  postId: string;
}) {
  const { toast } = useToast();
  const feed = useForumThread(scope, channelId, postId);
  const actions = useMessageActions(scope, channelId);
  const selfPubkey = useSelfPubkey();

  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [overlays, setOverlays] = useState<Record<string, ReactionOverlay>>({});
  const [pending, dispatchPending] = useReducer(
    (list: readonly TimelineEvent[], change: PendingChange) => applyPending(list, change),
    [] as readonly TimelineEvent[],
  );

  const actorMap = useMemo(
    () => new Map((feed.actors ?? []).map((actor) => [actor.pubkey, actor])),
    [feed.actors],
  );

  const messages = useMemo(() => {
    if (!feed.events) return undefined;
    const visible = [...feed.events, ...pending].filter(
      (event) => !event.id || !hidden.has(event.id),
    );
    return formatTimelineMessages(visible, {
      ...(selfPubkey ? { selfPubkey } : {}),
      actors: actorMap as ReadonlyMap<string, TimelineActor>,
      // The forum's own content set. A chat message that somehow carried this
      // post's id would not draw a row here, and a post would not draw one in
      // the transcript — the two surfaces are disjoint by construction, not by
      // a filter either of them could forget.
      contentKinds: FORUM_THREAD_KINDS,
    });
  }, [feed.events, pending, hidden, selfPubkey, actorMap]);

  const head = messages?.find((message) => message.id === postId) ?? null;
  const comments = useMemo(
    () => (messages ?? []).filter((message) => message.id !== postId),
    [messages, postId],
  );

  // `historyExhausted: false` for the same reason the thread pane passes it: it
  // suppresses a day divider on the OLDEST loaded day, and in a discussion that
  // mostly happens on one day, forcing one draws "Today" directly above the
  // "N comments" rule — two separators for one boundary and no information.
  const commentRows: ChatRow[] = useMemo(
    () => buildTimelineRows(comments, { historyExhausted: false }, {}),
    [comments],
  );

  const toggleReaction = useCallback(
    async (message: ChatMessage, emoji: string, remove: boolean) => {
      const source = message.reactions;
      setOverlays((prev) => ({
        ...prev,
        [message.id]: { source, value: applyOptimisticReaction(source, emoji, remove) },
      }));
      try {
        if (remove) await actions.unreact(message.id, emoji);
        else await actions.react(message.id, emoji);
      } catch (error) {
        setOverlays((prev) => {
          const next = { ...prev };
          delete next[message.id];
          return next;
        });
        toast(
          error instanceof Error ? error.message : "Failed to update the reaction.",
          { kind: "error" },
        );
      }
    },
    [actions, toast],
  );

  const deleteMessage = useCallback(
    (message: ChatMessage) => {
      const restore = () =>
        setHidden((prev) => {
          const next = new Set(prev);
          next.delete(message.id);
          return next;
        });
      setHidden((prev) => new Set(prev).add(message.id));
      // The house rule: the row goes away now and the mutation runs when the
      // undo window closes. Deleting a post somebody spent an hour on is exactly
      // the action that needs the window.
      toast(message.id === postId ? "Post deleted" : "Comment deleted", {
        action: { label: "Undo", onClick: restore },
        onExpire: () => {
          void actions.remove(message.id).catch(() => {
            restore();
            toast("Failed to delete", { kind: "error" });
          });
        },
      });
    },
    [actions, toast, postId],
  );

  const copy = useCallback(
    async (text: string, confirmation: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast(confirmation);
      } catch {
        toast("Couldn't reach the clipboard", { kind: "error" });
      }
    },
    [toast],
  );

  const drawMessage = useCallback(
    (message: ChatMessage, grouped: boolean) => {
      const overlay = overlays[message.id];
      const reactions = selectDisplayReactions(overlay, message.reactions);
      const drawn =
        reactions === message.reactions
          ? message
          : { ...message, reactions: [...reactions] };
      return (
        <MessageRow
          message={drawn}
          grouped={grouped}
          // No summary: every comment here is already in the discussion being
          // read, so a "2 replies" line would offer to open the page you are on.
          summary={null}
          canManage={canManageMessage(drawn)}
          canCopy={hasCopyActions(drawn)}
          editing={editingId === drawn.id}
          highlightToken={0}
          onToggleReaction={(emoji, remove) => void toggleReaction(drawn, emoji, remove)}
          onReply={() => setEditingId(null)}
          onOpenThread={() => {}}
          onStartEdit={() => setEditingId(drawn.id)}
          onCancelEdit={() => setEditingId(null)}
          onSubmitEdit={(content) => {
            setEditingId(null);
            void actions.edit(drawn.id, content).catch(() => {
              toast("Couldn't edit", { kind: "error" });
            });
          }}
          onDelete={() => deleteMessage(drawn)}
          onCopyMessage={() => void copy(drawn.body, "Copied to clipboard")}
          onCopyLink={() =>
            void copy(
              buildMessageLink({
                channelId,
                messageId: drawn.id,
                threadRootId: postId,
                origin: typeof window === "undefined" ? undefined : window.location.origin,
              }),
              "Link copied to clipboard",
            )
          }
        />
      );
    },
    [
      overlays,
      editingId,
      channelId,
      postId,
      actions,
      toast,
      toggleReaction,
      deleteMessage,
      copy,
    ],
  );

  const title = head ? titleFromTags(head.tags) : "";

  return (
    <ContentSurface>
      <header className="flex h-13 shrink-0 items-center gap-2 px-5">
        <Link
          href={`/chat/c/${encodeURIComponent(channelId)}`}
          aria-label={`Back to #${channel.name}`}
          className="chat-icon-button tap-target"
        >
          <ArrowLeft aria-hidden className="size-4" />
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-[0.9375rem] font-semibold">
          {title || (head ? "Untitled post" : "Post")}
        </h1>
        <span className="chat-quiet shrink-0 text-xs">#{channel.name}</span>
      </header>

      <div className="chat-scroll min-h-0 flex-1">
        {feed.error ? (
          <p className="px-5 text-sm text-destructive">{feed.error}</p>
        ) : messages === undefined ? (
          <PostSkeleton />
        ) : !head ? (
          <p className="chat-quiet px-5 text-sm">
            {/* The likeliest cause, said plainly: a deleted post's content stops
                being served at all, so the page it was on has nothing to draw. */}
            This post is no longer available. It may have been deleted.
          </p>
        ) : (
          <>
            {title ? (
              <h2 className="title-rule mx-5 pb-2 pt-3 text-lg font-bold leading-snug">
                {title}
              </h2>
            ) : null}
            {drawMessage(head, false)}
            <div className="mx-5 my-2 flex items-center gap-2">
              <span aria-hidden className="h-px flex-1 bg-[var(--chat-hairline)]" />
              <span className="text-[0.6875rem] text-[var(--chat-quiet)]">
                {comments.length === 0
                  ? "No comments yet"
                  : `${comments.length} ${comments.length === 1 ? "comment" : "comments"}`}
              </span>
              <span aria-hidden className="h-px flex-1 bg-[var(--chat-hairline)]" />
            </div>
            {commentRows.map((row) =>
              row.type === "message" ? (
                <div key={rowKey(row)}>{drawMessage(row.message, row.grouped)}</div>
              ) : (
                <div key={rowKey(row)}>
                  <NonMessageRow row={row} />
                </div>
              ),
            )}
          </>
        )}
        {feed.subscriptions}
      </div>

      <div className="shrink-0 px-5 pb-4 pt-1">
        <RoomComposer
          scope={scope}
          channel={channel}
          channelLabel="this post"
          parentId={postId}
          rootId={postId}
          // The one thing that differs from the room's composer: where the text
          // goes, and what the pending row says it is. Everything else — the
          // draft that survives leaving the page, the optimistic row, putting a
          // refused comment back in the box — is the same component.
          postRef={commentOnForumPost}
          postKind={KIND_FORUM_COMMENT}
          onPending={dispatchPending}
        />
      </div>
    </ContentSurface>
  );
}

function PostSkeleton() {
  return (
    <div aria-hidden data-testid="post-skeleton" className="space-y-3 px-5 pt-3">
      <div className="h-4 w-2/3 rounded-full bg-[var(--chat-hover)]" />
      <div className="h-3 w-24 rounded-full bg-[var(--chat-hover)]" />
      <div className="h-3 w-full rounded-full bg-[var(--chat-hover)]" />
      <div className="h-3 w-5/6 rounded-full bg-[var(--chat-hover)]" />
    </div>
  );
}
