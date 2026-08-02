"use client";

// The transcript.
//
// Everything a room is made of below the header and above the composer: the
// virtualized list, the rows, the actions on a row, and the four states the
// surface can be in. It owns the state that has to be *shared* across rows —
// which message is being edited, which reactions are guessed, which message the
// reader jumped to — and nothing else; a row that held its own edit state would
// let two rows be edited at once.
//
// Three decisions worth defending:
//
//   • **The projection is the whole read path.** `projectTimeline` folds signed
//     events into rows: edits applied, deletions removed, reactions counted,
//     grouping decided, dividers placed. This component never inspects a tag.
//     There is exactly one answer to "what does this room say", and a second
//     one assembled here would disagree about edits within a week.
//   • **Deleting is a toast, not a dialog.** House rule, and it is the better
//     interaction anyway: `window.confirm` asks you to predict whether you will
//     regret something, an undo lets you find out. The mutation runs when the
//     undo window closes, so a delete you take back never reached the server.
//   • **Nothing is invented when the backend is missing.** If
//     `buzz/messages:list` is not deployed, the boundary in `messages-data`
//     turns the throw into a sentence and this renders that sentence. A
//     transcript showing plausible history would be believed.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { ChatMessage, ChatRow } from "@/lib/buzz/message-types";
import type { ChatScope } from "@/lib/buzz/channel-types";
import { parseImetaTags } from "@/lib/buzz/media";
import { buildVideoReviews } from "@/components/chat/media/review-context";
// C12. The transcript owns the reference subscription for every row it draws —
// one query for the window rather than one per chip.
import { MessageToTask, TranscriptBridge } from "@/components/chat/bridge";
import { ReportMessageDialog } from "@/components/chat/moderation";
import { NotifyExplainer } from "@/components/chat/notifications";
import {
  formatTimelineMessages,
  projectTimeline,
  type ActorDirectory,
  type TimelineActor,
  type TimelineEvent,
} from "@/lib/buzz/timeline";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import { NonMessageRow } from "./dividers";
import { MessageRow } from "./message-row";
import {
  useMessageActions,
  useMessageFeed,
  useSelfPubkey,
} from "./messages-data";
import { buildMessageLink, MESSAGE_PARAM } from "./message-link";
import {
  applyOptimisticReaction,
  selectDisplayReactions,
  type ReactionOverlay,
} from "./reaction-algebra";
import {
  canManageMessage,
  countMessageRows,
  estimateRowHeight,
  hasCopyActions,
  historyExhausted as isHistoryExhausted,
  keyForMessageId,
  needsAnotherPage,
  rowKey,
  selectTranscriptSurface,
} from "./row-model";
import { buildThreadSummaries } from "./thread-summary";
import { VirtualList, type VirtualListHandle } from "./virtual-list";

/** How long a jumped-to row stays marked. Matches the tint's own duration. */
const HIGHLIGHT_MS = 2200;

export type ChannelTranscriptProps = {
  scope: ChatScope | null;
  channelId: string;
  /** Drawn in the empty state, so a blank room still says which room it is. */
  channelLabel: string;
  /** From read state (C5). Absent until then — the divider simply is not drawn. */
  firstUnreadId?: string;
  unreadCount?: number;
  /** Opens the thread pane. The room owns that pane, not the transcript. */
  onOpenThread?: (rootId: string) => void;
  /** Extra display names for pubkeys, merged over whatever the window carries. */
  actors?: ActorDirectory;
  /**
   * Rows the composer has written but the server has not acknowledged.
   *
   * `TimelineEvent` rather than `ChatMessage`, and that is the whole reason the
   * seam is one prop: an optimistic event travels the *same* projection as an
   * acknowledged one, so it groups, lands under the right day divider and
   * carries its own reactions without a single special case in this file. The
   * alternative — a list of finished messages spliced in after the fold — needs
   * grouping and ordering re-derived at the splice point, which is a second
   * opinion about both.
   */
  pendingEvents?: readonly TimelineEvent[];
};

export function ChannelTranscript({
  scope,
  channelId,
  channelLabel,
  firstUnreadId,
  unreadCount,
  onOpenThread,
  actors,
  pendingEvents,
}: ChannelTranscriptProps) {
  const { toast } = useToast();
  const feed = useMessageFeed(scope, channelId);
  const actions = useMessageActions(scope, channelId);
  const selfPubkey = useSelfPubkey();
  const listRef = useRef<VirtualListHandle | null>(null);

  // Locally hidden while an undo is offered. Filtered out of the *events*
  // rather than out of the rows, so the projector still decides whether the
  // day divider above a deleted message still has anything under it.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [overlays, setOverlays] = useState<Record<string, ReactionOverlay>>({});
  const [jump, setJump] = useState<{ id: string; token: number } | null>(null);
  // C12: which message is being turned into a task. One at a time, at the
  // transcript level rather than inside a row — the picker outlives the hover
  // that opened it, and a popup owned by a virtualized row is a popup that
  // vanishes when the row scrolls out.
  const [taskFrom, setTaskFrom] = useState<string | null>(null);
  // C7: the message being reported, and the message whose delivery is being
  // explained. Both live here rather than in a row for the reason above — a
  // dialog or a disclosure owned by a virtualized row is one that disappears
  // when the row scrolls out from under it.
  const [reportFrom, setReportFrom] = useState<string | null>(null);
  const [explainFor, setExplainFor] = useState<string | null>(null);

  // --- projection ---------------------------------------------------------
  const events = useMemo(() => {
    if (!feed.events) return undefined;
    const loaded =
      hidden.size === 0
        ? feed.events
        : feed.events.filter((event) => !event.id || !hidden.has(event.id));
    // Pending rows go in with the rest and are ordered by the projector, not
    // appended to the end here: a message written while somebody else's older
    // message is still in flight belongs where its timestamp puts it.
    return pendingEvents?.length ? [...loaded, ...pendingEvents] : loaded;
  }, [feed.events, hidden, pendingEvents]);

  const directory = useMergedActors(feed.windowActors, actors);

  const timelineOptions = useMemo(
    () => ({
      ...(selfPubkey ? { selfPubkey } : {}),
      ...(directory ? { actors: directory } : {}),
      ...(jump ? { highlightedId: jump.id } : {}),
    }),
    [selfPubkey, directory, jump],
  );

  const exhausted = isHistoryExhausted({
    resolvedPages: feed.resolvedPages,
    hasMore: feed.hasMore,
  });

  const rowOptions = useMemo(
    () => ({
      ...(firstUnreadId ? { firstUnreadId } : {}),
      ...(unreadCount !== undefined ? { unreadCount } : {}),
      historyExhausted: exhausted,
    }),
    [firstUnreadId, unreadCount, exhausted],
  );

  const rows: ChatRow[] = useMemo(
    () => (events ? projectTimeline(events, timelineOptions, rowOptions) : []),
    [events, timelineOptions, rowOptions],
  );

  // Summaries need the messages the *channel* does not draw — the replies —
  // so this is a second fold rather than a read of `rows`. Same inputs, same
  // function, so the two can never disagree about what a message says.
  const summaries = useMemo(
    () =>
      events
        ? buildThreadSummaries(formatTimelineMessages(events, timelineOptions))
        : new Map(),
    [events, timelineOptions],
  );

  // Frame-anchored video comments (04-huddle-media §2.10).
  //
  // Assembled from the same fold the summaries use, for the same reason: the
  // comments on a video are its thread replies, and the channel window carries
  // them whether or not the transcript draws them as rows. A `review` exists
  // only for messages that actually have a video, so the launcher never appears
  // where it would open an empty dialog.
  const reviews = useMemo(
    () =>
      events
        ? buildVideoReviews(formatTimelineMessages(events, timelineOptions), {
            onSend: (body, parentEventId) => actions.reply(parentEventId, body),
          })
        : new Map(),
    [events, timelineOptions, actions],
  );

  const keys = useMemo(() => rows.map(rowKey), [rows]);
  const estimate = useCallback((index: number) => estimateRowHeight(rows[index]), [rows]);

  // --- paging -------------------------------------------------------------
  // Counts visible top-level ROWS, not events: fifty events in a busy room can
  // be forty-eight replies and reactions, and paging on the event count stops
  // fetching while the screen is still half empty.
  useEffect(() => {
    if (feed.fetchingOlder) return;
    if (
      needsAnotherPage({
        visibleRowCount: countMessageRows(rows),
        hasMore: feed.hasMore,
      })
    ) {
      feed.fetchOlder();
    }
  }, [rows, feed]);

  // --- jump-to-message ----------------------------------------------------
  const search = useSearchParams();
  const deepLinkId = search?.get(MESSAGE_PARAM) ?? null;
  const consumedDeepLink = useRef<string | null>(null);

  const jumpTo = useCallback((messageId: string) => {
    setJump((previous) => ({ id: messageId, token: (previous?.token ?? 0) + 1 }));
  }, []);

  useEffect(() => {
    if (!deepLinkId || consumedDeepLink.current === deepLinkId) return;
    // Only once the row is actually in the projection: firing against a list
    // the DOM has not committed scrolls to a row that is not there and fails
    // silently, which reads as a broken link.
    if (!keyForMessageId(rows, deepLinkId)) return;
    consumedDeepLink.current = deepLinkId;
    jumpTo(deepLinkId);
  }, [deepLinkId, rows, jumpTo]);

  useEffect(() => {
    if (!jump) return;
    const key = keyForMessageId(rows, jump.id);
    if (key) listRef.current?.scrollToKey(key);
    const timer = setTimeout(() => setJump(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
    // Deliberately keyed on the jump token alone: re-running whenever `rows`
    // changes would re-scroll the reader every time a message arrived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.token]);

  // --- actions ------------------------------------------------------------
  const toggleReaction = useCallback(
    async (message: ChatMessage, emoji: string, remove: boolean) => {
      const source = message.reactions;
      setOverlays((prev) => ({
        ...prev,
        [message.id]: {
          source,
          value: applyOptimisticReaction(source, emoji, remove),
        },
      }));
      try {
        if (remove) await actions.unreact(message.id, emoji);
        else await actions.react(message.id, emoji);
      } catch (error) {
        // A rejected toggle drops the guess rather than leaving it: a pill that
        // stays lit after the server said no is a lie the reader will act on.
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

  const submitEdit = useCallback(
    async (message: ChatMessage, content: string) => {
      setEditingId(null);
      try {
        // An edit replaces the message's media tags, so a message with
        // attachments has to say which ones it keeps or the edit deletes them
        // (`convex/buzz/media.ts`). All of them, here: this box edits words.
        // Removing an attachment is the tray's job, not the caption's.
        const attached = parseImetaTags(message.tags);
        await actions.edit(
          message.id,
          content,
          attached.length > 0 ? attached.map((entry) => entry.url) : undefined,
        );
        toast("Message edited");
      } catch (error) {
        toast(
          error instanceof Error ? error.message : "Couldn't edit the message",
          { kind: "error" },
        );
      }
    },
    [actions, toast],
  );

  const deleteMessage = useCallback(
    (message: ChatMessage) => {
      // Hidden first, deleted later. The row leaves immediately so the gesture
      // feels done, and the mutation only runs once the undo window closes —
      // which is why there is no confirmation dialog to dismiss.
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
          void actions.remove(message.id).catch((error: unknown) => {
            restore();
            toast(
              error instanceof Error
                ? `Failed to delete message: ${error.message}`
                : "Failed to delete message",
              { kind: "error" },
            );
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
        // A clipboard write can be refused (no permission, no secure context,
        // no clipboard at all). Saying so beats a success toast for something
        // that did not happen.
        toast("Couldn't reach the clipboard", { kind: "error" });
      }
    },
    [toast],
  );

  // --- render -------------------------------------------------------------
  const surface = selectTranscriptSurface({
    rowCount: rows.length,
    isLoading: feed.events === undefined && !feed.error,
    error: feed.error,
  });

  const render = useCallback(
    (index: number) => {
      const row = rows[index];
      if (row.type !== "message") return <NonMessageRow row={row} />;
      const overlay = overlays[row.message.id];
      const reactions = selectDisplayReactions(overlay, row.message.reactions);
      const message =
        reactions === row.message.reactions
          ? row.message
          : { ...row.message, reactions: [...reactions] };
      const rootId = message.rootId ?? message.id;
      return (
        <MessageRow
          message={message}
          grouped={row.grouped}
          summary={summaries.get(message.id) ?? null}
          review={reviews.get(message.id)}
          canManage={canManageMessage(message)}
          canCopy={hasCopyActions(message)}
          editing={editingId === message.id}
          highlightToken={jump?.token ?? 0}
          onToggleReaction={(emoji, remove) => void toggleReaction(message, emoji, remove)}
          onReply={() => onOpenThread?.(rootId)}
          onOpenThread={() => onOpenThread?.(rootId)}
          onStartEdit={() => setEditingId(message.id)}
          onCancelEdit={() => setEditingId(null)}
          onSubmitEdit={(content) => void submitEdit(message, content)}
          onDelete={() => deleteMessage(message)}
          onCopyMessage={() => void copy(message.body, "Message copied to clipboard")}
          onCopyLink={() =>
            void copy(
              buildMessageLink({
                channelId,
                messageId: message.id,
                ...(message.rootId ? { threadRootId: message.rootId } : {}),
                origin:
                  typeof window === "undefined" ? undefined : window.location.origin,
              }),
              "Link copied to clipboard",
            )
          }
          onMakeTask={() => setTaskFrom(message.id)}
          {...(scope ? { onReport: () => setReportFrom(message.id) } : {})}
          {...(scope
            ? {
                onExplainNotification: () =>
                  setExplainFor((current) =>
                    current === message.id ? null : message.id,
                  ),
                notifyExplainer:
                  explainFor === message.id ? (
                    <NotifyExplainer
                      scope={scope}
                      channelId={channelId}
                      eventId={message.id}
                    />
                  ) : null,
              }
            : {})}
        />
      );
    },
    [
      rows,
      overlays,
      summaries,
      reviews,
      editingId,
      jump?.token,
      scope,
      channelId,
      explainFor,
      onOpenThread,
      toggleReaction,
      submitEdit,
      deleteMessage,
      copy,
    ],
  );

  // Every Work object named anywhere in the loaded window, in one place.
  // Collected from the *events* rather than from the rows so a message that is
  // only drawn as a thread reply still contributes its references — and so the
  // list shrinks as the reader scrolls, which is what keeps the subscription
  // proportional to what is on screen.
  const bodies = useMemo(
    () => (events ?? []).map((event) => event.content ?? ""),
    [events],
  );

  return (
    <TranscriptBridge scope={scope} bodies={bodies}>
      {feed.subscriptions}
      {surface === "error" ? (
        <TranscriptNotice
          title="Messages aren't loading"
          // The reason, verbatim. "Could not find public function
          // buzz/messages:list" tells whoever is looking exactly what is
          // missing; "something went wrong" tells them to file a ticket.
          body={feed.error ?? "The message log could not be read."}
          tone="error"
        />
      ) : surface === "skeleton" ? (
        <TranscriptSkeleton />
      ) : surface === "empty" ? (
        <TranscriptNotice
          testId="message-empty"
          title="No messages yet"
          body={`Send the first message to start the thread in ${channelLabel}.`}
        />
      ) : (
        <VirtualList
          keys={keys}
          estimate={estimate}
          render={render}
          handleRef={listRef}
          onNearTop={feed.hasMore ? feed.fetchOlder : undefined}
          label={`Messages in ${channelLabel}`}
          className="pb-2"
          leading={
            <OlderHistoryChip
              fetching={feed.fetchingOlder}
              hasMore={feed.hasMore}
              exhausted={exhausted}
              onFetch={feed.fetchOlder}
            />
          }
        />
      )}

      {taskFrom ? (
        <div className="absolute bottom-4 right-4 z-30 rounded-xl bg-background p-1 shadow-lg ring-1 ring-[var(--chat-hairline)]">
          <MessageToTask
            scope={scope}
            channelId={channelId}
            eventId={taskFrom}
            onDone={() => setTaskFrom(null)}
          />
          <button
            type="button"
            className="tap-target w-full rounded px-2 py-1 text-left text-xs text-[var(--chat-quiet)] hover:bg-[var(--chat-hover)]"
            onClick={() => setTaskFrom(null)}
          >
            Cancel
          </button>
        </div>
      ) : null}

      {/* The report dialog. Mounted only while a message is chosen, and it
          closes by clearing that choice — the categories, the note and the
          "you have already reported this" answer all live inside it. */}
      {scope && reportFrom ? (
        <ReportMessageDialog
          scope={scope}
          open
          onOpenChange={(next) => {
            if (!next) setReportFrom(null);
          }}
          target={reportFrom}
        />
      ) : null}
    </TranscriptBridge>
  );
}

/**
 * The top of the list.
 *
 * Three states rather than one spinner: fetching says so, more-to-come offers
 * a button (a scroll gesture is not available to every reader, and a keyboard
 * user has no other way to ask), and a proven beginning says the room starts
 * here. That last one is why `historyExhausted` is distinct from `!hasMore` —
 * an unloaded window also reports "no more", and claiming a channel's start on
 * that basis is a lie about a room you have not read.
 */
function OlderHistoryChip({
  fetching,
  hasMore,
  exhausted,
  onFetch,
}: {
  fetching: boolean;
  hasMore: boolean;
  exhausted: boolean;
  onFetch: () => void;
}) {
  if (fetching) {
    return (
      <div
        data-testid="message-timeline-fetching-older"
        className="flex justify-center py-2 text-[0.6875rem] text-[var(--chat-quiet)]"
      >
        Loading earlier messages…
      </div>
    );
  }
  if (hasMore) {
    return (
      <div className="flex justify-center py-2">
        <button
          type="button"
          onClick={onFetch}
          className="tap-target rounded-full bg-[var(--chat-hover)] px-3 py-1 text-[0.6875rem] font-medium hover:bg-[var(--chat-active)]"
        >
          Load earlier messages
        </button>
      </div>
    );
  }
  if (exhausted) {
    return (
      <div className="px-5 pb-2 pt-4 text-[0.6875rem] text-[var(--chat-quiet)]">
        This is the beginning of the room.
      </div>
    );
  }
  return null;
}

function TranscriptNotice({
  title,
  body,
  tone,
  testId,
}: {
  title: string;
  body: string;
  tone?: "error";
  testId?: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-8 py-10">
      <div className="max-w-sm text-center" data-testid={testId}>
        <p className={cn("text-sm font-semibold", tone === "error" && "text-destructive")}>
          {title}
        </p>
        <p className="chat-quiet mt-1.5 break-words text-sm">{body}</p>
      </div>
    </div>
  );
}

/**
 * Content-shaped, not a grey block.
 *
 * The point of a skeleton is that the layout does not move when the content
 * lands, so it draws the transcript's own geometry: an avatar column, a short
 * name line, a body of one or two lines, and the same alternation of grouped
 * and header rows a real room has.
 */
function TranscriptSkeleton() {
  const widths = [72, 45, 88, 60, 52, 80, 38, 66];
  return (
    <div
      aria-hidden
      data-testid="message-skeleton"
      className="min-h-0 flex-1 space-y-3 px-5 pt-4"
    >
      {widths.map((width, index) => (
        <div key={index} className="flex gap-3">
          <div
            className={cn(
              "size-9 shrink-0 rounded-full bg-[var(--chat-hover)]",
              index % 3 === 1 && "invisible",
            )}
          />
          <div className="min-w-0 flex-1 space-y-1.5">
            {index % 3 !== 1 ? (
              <div className="h-2.5 w-24 rounded-full bg-[var(--chat-hover)]" />
            ) : null}
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

/**
 * The display-name directory.
 *
 * Merged from two sources with the caller's winning, because the caller knows
 * things the window cannot: the room's member list resolves a pubkey to the
 * name that room uses for it. Absent both, the projector falls back to a
 * truncated pubkey — which is ugly and *true*, and much better than a
 * confidently wrong name.
 */
function useMergedActors(
  fromWindow: readonly TimelineActor[] | undefined,
  fromCaller: ActorDirectory | undefined,
): ActorDirectory | undefined {
  return useMemo(() => {
    if (!fromWindow?.length) return fromCaller;
    const merged = new Map<string, TimelineActor>();
    for (const actor of fromWindow) merged.set(actor.pubkey, actor);
    if (fromCaller) {
      const entries =
        fromCaller instanceof Map
          ? fromCaller.entries()
          : Object.entries(fromCaller as Record<string, TimelineActor>);
      for (const [pubkey, actor] of entries) merged.set(pubkey, actor);
    }
    return merged;
  }, [fromWindow, fromCaller]);
}
