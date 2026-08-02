"use client";

// The thread pane — spec 01 §2.3.
//
// The head message, then its replies, in the auxiliary pane beside the room.
// Deliberately *beside*: the whole reason a thread exists is that its content
// does not belong in the channel's flow, and the whole reason a pane exists
// rather than a route is that the channel's flow is most of the context for
// what you are about to say. A thread that replaced the room would make you
// choose between the argument and what it is about.
//
// Where the geometry comes from: `AuxPane` (shell/surfaces.tsx) owns "column
// beside the room, or a sheet floating over it below 600px". That answer lives
// there so every pane that ever docks in that slot gives the same answer on a
// phone — the alternative is each pane inventing its own idea of what narrow
// means, which is how one of them ends up as a 40px sliver nobody can read.
//
// Replies are drawn by the same `MessageRow` the channel draws, through the
// same `buildTimelineRows`, so grouping, day dividers and the ten-minute window
// behave identically in both places. Spec §2.10 says exactly that, and the
// reason is not consistency for its own sake: a reader who has learned that a
// nameless row means "same person, still talking" must not have to learn a
// second rule four hundred pixels to the right.

import { useCallback, useMemo, useState } from "react";
import type { ChatMessage, ChatRow } from "@/lib/buzz/message-types";
import type { ChatScope } from "@/lib/buzz/channel-types";
import {
  buildTimelineRows,
  formatTimelineMessages,
  type ActorDirectory,
  type TimelineActor,
} from "@/lib/buzz/timeline";
import { useToast } from "@/components/toast";
import { NonMessageRow } from "./dividers";
import { MessageRow } from "./message-row";
import { useMessageActions, useSelfPubkey, useThreadFeed } from "./messages-data";
import { buildMessageLink } from "./message-link";
import {
  applyOptimisticReaction,
  selectDisplayReactions,
  type ReactionOverlay,
} from "./reaction-algebra";
import { canManageMessage, hasCopyActions, rowKey } from "./row-model";

export function ThreadPane({
  scope,
  channelId,
  rootId,
  actors,
}: {
  scope: ChatScope | null;
  channelId: string;
  rootId: string;
  actors?: ActorDirectory;
}) {
  const { toast } = useToast();
  const feed = useThreadFeed(scope, channelId, rootId);
  const actions = useMessageActions(scope, channelId);
  const selfPubkey = useSelfPubkey();

  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [overlays, setOverlays] = useState<Record<string, ReactionOverlay>>({});

  // Same merge the channel does: the window's names, with the caller's
  // winning where it has any.
  const directory = useMemo(() => {
    if (!feed.windowActors?.length) return actors;
    const merged = new Map(feed.windowActors.map((actor) => [actor.pubkey, actor]));
    if (actors) {
      const entries =
        actors instanceof Map
          ? actors.entries()
          : Object.entries(actors as Record<string, TimelineActor>);
      for (const [pubkey, actor] of entries) merged.set(pubkey, actor);
    }
    return merged;
  }, [feed.windowActors, actors]);

  const options = useMemo(
    () => ({
      ...(selfPubkey ? { selfPubkey } : {}),
      ...(directory ? { actors: directory } : {}),
    }),
    [selfPubkey, directory],
  );

  const messages = useMemo(() => {
    if (!feed.events) return undefined;
    const visible = feed.events.filter((event) => !event.id || !hidden.has(event.id));
    return formatTimelineMessages(visible, options);
  }, [feed.events, hidden, options]);

  const head = messages?.find((message) => message.id === rootId) ?? null;

  const replies = useMemo(
    () => (messages ?? []).filter((message) => message.id !== rootId),
    [messages, rootId],
  );

  // `historyExhausted: false`, deliberately, and it is not about paging: it is
  // what suppresses a day divider on the OLDEST loaded day. In a pane whose
  // replies almost always land on one day, forcing it draws "Today" directly
  // under the "3 replies" rule — two separators, one boundary, no information.
  // Genuine day *changes* inside a long thread still get one.
  const replyRows: ChatRow[] = useMemo(
    () => buildTimelineRows(replies, { historyExhausted: false }, options),
    [replies, options],
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
      toast("Message deleted", {
        action: { label: "Undo", onClick: restore },
        onExpire: () => {
          void actions.remove(message.id).catch(() => {
            restore();
            toast("Failed to delete message", { kind: "error" });
          });
        },
      });
    },
    [actions, toast],
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
          // No summary inside the pane: every reply here is already *in* the
          // thread being read, so a "2 replies" line under one of them offers
          // to open the pane you are standing in.
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
              toast("Couldn't edit the message", { kind: "error" });
            });
          }}
          onDelete={() => deleteMessage(drawn)}
          onCopyMessage={() => void copy(drawn.body, "Message copied to clipboard")}
          onCopyLink={() =>
            void copy(
              buildMessageLink({
                channelId,
                messageId: drawn.id,
                threadRootId: rootId,
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
      rootId,
      actions,
      toast,
      toggleReaction,
      deleteMessage,
      copy,
    ],
  );

  return (
    <div className="-mx-4">
      {feed.subscriptions}
      {feed.error ? (
        <p className="px-4 text-sm text-destructive">{feed.error}</p>
      ) : messages === undefined ? (
        <ThreadSkeleton />
      ) : !head ? (
        <p className="chat-quiet px-4 text-sm">
          {/* Not "something went wrong": the likeliest cause is that the root
              was deleted while the pane was open, and saying so tells the
              reader why the thread they were reading is gone. */}
          This thread is no longer available. Its first message may have been
          deleted.
        </p>
      ) : (
        <>
          {drawMessage(head, false)}
          <div className="mx-4 my-2 flex items-center gap-2">
            <span aria-hidden className="h-px flex-1 bg-[var(--chat-hairline)]" />
            <span className="text-[0.6875rem] text-[var(--chat-quiet)]">
              {replies.length === 0
                ? "No replies yet"
                : `${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
            </span>
            <span aria-hidden className="h-px flex-1 bg-[var(--chat-hairline)]" />
          </div>
          {replyRows.map((row) =>
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
    </div>
  );
}

function ThreadSkeleton() {
  return (
    <div aria-hidden data-testid="thread-skeleton" className="space-y-3 px-4 pt-1">
      {[80, 55, 68].map((width, index) => (
        <div key={index} className="flex gap-3">
          <div className="size-9 shrink-0 rounded-full bg-[var(--chat-hover)]" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-2.5 w-20 rounded-full bg-[var(--chat-hover)]" />
            <div
              className="h-3 rounded-full bg-[var(--chat-hover)]"
              style={{ width: `${width}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
