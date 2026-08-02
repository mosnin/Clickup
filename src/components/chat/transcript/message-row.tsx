"use client";

// One message.
//
// The row has two shapes and the difference between them is the whole reason
// grouping exists: a **header row** carries an avatar, a name and a timestamp;
// a **continuation** carries none of that and hangs under the one above it,
// with the time appearing in the gutter only on hover. Ten consecutive
// messages from one person in one minute should read as one person talking,
// not as ten postcards.
//
// Which shape to draw is not decided here — `ChatRow.grouped` arrives already
// answered by the projector, which owns the ten-minute window, the
// author-equality rule and the reset-at-a-divider rule. A renderer that
// re-derived any of that would be a second opinion about what a conversation
// looks like.
//
// Three states this row has that a naive one does not:
//
//   • **pending** — written, not yet acknowledged. Always draws its own header
//     (the projector refuses to group it), so the send status has somewhere to
//     sit beside the timestamp.
//   • **highlighted** — jump-to-message landed here. A single 2s tint, keyed so
//     it re-fires when you jump to the same row twice, and reduced-motion safe
//     because it goes through the app's `MotionConfig`.
//   • **editing** — the body is replaced in place by a field. Not a dialog: the
//     surrounding conversation is most of the context for what you are about to
//     write, and a modal removes it at the moment it matters.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatMessage } from "@/lib/buzz/message-types";
import { parseImetaTags, stripMediaLines } from "@/lib/buzz/media";
import { KIND_HUDDLE_STARTED } from "@/lib/buzz/timeline";
import { BridgeBody } from "@/components/chat/bridge";
import { HuddleCard, useHuddleOrNull } from "@/components/chat/huddle";
import { cn } from "@/lib/utils";
import { motion } from "@/components/motion";
import { MessageMedia } from "@/components/chat/media";
import type { VideoReviewContext } from "@/components/chat/media/video-review";
import { MessageActionBar } from "./action-bar";
import { ActorAvatar } from "./avatar";
import { formatFullDateTime, formatTime } from "./date-labels";
import { MessageReactions } from "./reactions";
import { ThreadSummaryRow } from "./thread-summary-row";
import type { ThreadSummary } from "./thread-summary";

export type MessageRowProps = {
  message: ChatMessage;
  grouped: boolean;
  summary: ThreadSummary | null;
  /**
   * Present only when this message carries a video, which is what makes the
   * review launcher appear where — and only where — it means something.
   */
  review?: VideoReviewContext;
  canManage: boolean;
  canCopy: boolean;
  editing: boolean;
  /** Bumped by each jump so the same row can flash twice. */
  highlightToken: number;
  onToggleReaction: (emoji: string, remove: boolean) => void;
  onReply: () => void;
  onOpenThread: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (content: string) => void;
  onDelete: () => void;
  onCopyMessage: () => void;
  onCopyLink: () => void;
  /** C12 — absent when the room has no scope to make a task in. */
  onMakeTask?: () => void;
  /** C7 — absent when the room has no scope to file a report against. */
  onReport?: () => void;
  /**
   * "Why didn't I get notified about this?" — absent when nothing can answer.
   */
  onExplainNotification?: () => void;
  /**
   * The answer, when it has been asked for.
   *
   * A node rather than an event id, because the explainer needs the room's
   * scope and channel and this row has neither — the transcript owns both, so
   * it builds the block and this row decides where it sits. Off until asked
   * for: a transcript that annotates every message with why it did or did not
   * ring is a transcript nobody can read.
   */
  notifyExplainer?: ReactNode;
};

export function MessageRow({
  message,
  grouped,
  summary,
  review,
  canManage,
  canCopy,
  editing,
  highlightToken,
  onToggleReaction,
  onReply,
  onOpenThread,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onDelete,
  onCopyMessage,
  onCopyLink,
  onMakeTask,
  onReport,
  onExplainNotification,
  notifyExplainer,
}: MessageRowProps) {
  const canAct = !message.pending && !message.failed;

  // A 48100 is an announcement that a call exists, and the card is drawn from
  // the *folded* snapshot rather than from the announcement — the difference
  // between "somebody started a huddle an hour ago" and "there is a call
  // happening, with these three people in it, join it". Outside a room there is
  // no session to fold (a surface that lists events with no call machinery), so
  // the row falls back to its own text rather than throwing.
  const huddle = useHuddleOrNull();
  const asHuddle = message.kind === KIND_HUDDLE_STARTED && huddle !== null;

  // The attachments, and the body with their markdown lines taken back off.
  //
  // §2.7 requires both halves — the `imeta` tag and a matching line in the body
  // — so that a client which only understands text still sees a link where the
  // picture was. This surface understands both, so it draws the picture and does
  // not also print its URL underneath. Read from `message.tags`, which is the
  // *overlaid* set: an edited message shows the edit's attachments, and this
  // renderer does not have to know that.
  const media = useMemo(() => parseImetaTags(message.tags), [message.tags]);
  const visibleBody = useMemo(
    () => (media.length === 0 ? message.body : stripMediaLines(message.body, media)),
    [message.body, media],
  );

  return (
    <article
      // Focusable, and that is what makes the toolbar reachable on a phone:
      // there is no hover on a touch device, so tapping the row focuses it and
      // `group-focus-within` reveals the bar. It buys the keyboard the same
      // affordance — a transcript whose only actions were hover-revealed had
      // none at all without a pointer.
      tabIndex={0}
      // `group/message` is what the action bar's reveal hangs off, and it is
      // namespaced because a message can contain groups of its own.
      className={cn(
        "group/message relative px-5 outline-none transition-colors",
        grouped ? "py-0.5" : "pt-3",
        "hover:bg-[var(--chat-hover)] focus-within:bg-[var(--chat-hover)]",
        // A ring only for the keyboard: a visible outline on every tap would
        // leave the phone permanently drawing a box around the last thing
        // touched.
        "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--chat-hairline)]",
        message.pending && "opacity-60",
      )}
      data-message-id={message.id}
      data-render-key={message.renderKey}
      data-grouped={grouped ? "true" : "false"}
      data-mine={message.mine ? "true" : "false"}
      data-pending={message.pending ? "true" : "false"}
      aria-label={`${message.author}: ${message.body}`}
    >
      {message.highlighted ? (
        <motion.span
          // Keyed on the token so jumping to the same row twice flashes twice;
          // an `animate` on a stable key would run once and never again.
          key={highlightToken}
          aria-hidden
          initial={{ opacity: 0.4 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 2, ease: "easeOut" }}
          className="pointer-events-none absolute inset-0 bg-[var(--chat-accent)]"
        />
      ) : null}

      <div className="flex gap-3">
        <div className="w-9 shrink-0">
          {grouped ? (
            // The gutter is not empty — it holds the time, revealed on hover.
            // Reserving the width is what keeps a continuation's text aligned
            // with the header row's above it.
            <span className="mt-1 block text-right text-[0.625rem] tabular-nums text-[var(--chat-quiet)] opacity-0 transition-opacity group-hover/message:opacity-100">
              {formatTime(message.createdAt)}
            </span>
          ) : (
            <ActorAvatar
              label={message.author}
              pubkey={message.pubkey}
              avatarUrl={message.authorAvatarUrl}
              isAgent={message.isAgent}
            />
          )}
        </div>

        <div className="min-w-0 flex-1">
          {!grouped ? (
            <header className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-semibold">{message.author}</span>
              {message.isAgent ? (
                <span
                  // Text, not a bot glyph: "agent" is unambiguous at 10px and
                  // the house rule spends icons on affordances, not labels.
                  className="rounded-full bg-[var(--chat-hover)] px-1.5 text-[0.625rem] font-medium uppercase tracking-wide text-[var(--chat-quiet)]"
                  title={message.ownerLabel ? `Runs for ${message.ownerLabel}` : undefined}
                >
                  agent
                </span>
              ) : null}
              {message.role ? (
                <span className="text-[0.625rem] uppercase tracking-wide text-[var(--chat-quiet)]">
                  {message.role}
                </span>
              ) : null}
              <time
                dateTime={new Date(message.createdAt * 1000).toISOString()}
                title={formatFullDateTime(message.createdAt)}
                className="text-[0.6875rem] tabular-nums text-[var(--chat-quiet)]"
              >
                {formatTime(message.createdAt)}
              </time>
              {message.pending ? (
                <span className="text-[0.6875rem] text-[var(--chat-quiet)]">Sending…</span>
              ) : null}
              {message.failed ? (
                <span className="text-[0.6875rem] font-medium text-destructive">
                  Not sent
                </span>
              ) : null}
            </header>
          ) : null}

          {editing ? (
            // Seeded with the *visible* body: the media lines are metadata this
            // surface already draws as pictures, and putting them in the box
            // would invite somebody to edit a URL by hand.
            <EditField
              initial={visibleBody}
              allowEmpty={media.length > 0}
              onCancel={onCancelEdit}
              onSubmit={onSubmitEdit}
            />
          ) : asHuddle ? (
            <HuddleCard eventId={message.id} className="mt-0.5 max-w-md" />
          ) : (
            <>
              {visibleBody || media.length === 0 ? (
                <p className="whitespace-pre-wrap break-words text-[0.9375rem] leading-relaxed">
                  <MessageBody body={visibleBody} />
                  {message.edited ? (
                    <span
                      title="This message has been edited"
                      className="ml-1 align-baseline text-[0.6875rem] text-[var(--chat-quiet)]"
                    >
                      (edited)
                    </span>
                  ) : null}
                </p>
              ) : null}
              <MessageMedia tags={message.tags} review={review} />
            </>
          )}

          <MessageReactions
            reactions={message.reactions}
            onToggle={onToggleReaction}
            disabled={!canAct}
          />

          {summary ? (
            <ThreadSummaryRow summary={summary} onOpen={onOpenThread} />
          ) : null}

          {notifyExplainer ? (
            <div className="soft-field mt-1.5 max-w-prose px-3 py-2">
              {notifyExplainer}
            </div>
          ) : null}
        </div>
      </div>

      {editing ? null : (
        <MessageActionBar
          message={message}
          canManage={canManage && canAct}
          canCopy={canCopy}
          canReact={canAct}
          canReply={canAct}
          {...(onMakeTask && canAct ? { onMakeTask } : {})}
          {...(onReport && canAct ? { onReport } : {})}
          {...(onExplainNotification && canAct
            ? { onExplainNotification, notifyExplained: notifyExplainer !== null && notifyExplainer !== undefined }
            : {})}
          onToggleReaction={onToggleReaction}
          onReply={onReply}
          onEdit={onStartEdit}
          onDelete={onDelete}
          onCopyMessage={onCopyMessage}
          onCopyLink={onCopyLink}
        />
      )}
    </article>
  );
}

/**
 * The body.
 *
 * C12 moved this one level up: `BridgeBody` renders the same `@[Name](id)`
 * mentions through the same shared parser, and additionally draws
 * `#[Label](kind:id)` references as live chips. The rendering contract is
 * unchanged — React nodes, never `dangerouslySetInnerHTML`, because bodies are
 * written by agents that may have read a hostile document and a renderer with
 * no HTML path has no sanitizer to keep correct.
 */
function MessageBody({ body }: { body: string }) {
  return <BridgeBody body={body} />;
}

/**
 * Editing, in place.
 *
 * Enter saves and Shift+Enter breaks a line, matching the composer — the
 * muscle memory being edited with is the muscle memory that wrote the message.
 * Escape cancels, and it stops the event: the thread pane and the shell drawer
 * both listen for Escape, and an edit abandoned by closing the pane it was in
 * is a lost paragraph.
 */
function EditField({
  initial,
  allowEmpty = false,
  onCancel,
  onSubmit,
}: {
  initial: string;
  /**
   * A message whose whole content is a picture may legitimately have no words,
   * so clearing the caption of one is a save rather than a cancel.
   */
  allowEmpty?: boolean;
  onCancel: () => void;
  onSubmit: (content: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Caret at the end rather than selecting everything: the common edit is a
    // typo near where you stopped typing, and a select-all means one keystroke
    // destroys the message you meant to fix.
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const commit = () => {
    const next = value.trim();
    if (next === initial.trim() || (!next && !allowEmpty)) {
      onCancel();
      return;
    }
    onSubmit(next);
  };

  return (
    <div className="mt-1">
      <textarea
        ref={ref}
        rows={Math.min(8, value.split("\n").length + 1)}
        value={value}
        aria-label="Edit message"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            commit();
          }
        }}
        className="soft-field w-full resize-none px-2 py-1.5 text-[0.9375rem] outline-none"
      />
      <div className="mt-1 flex items-center gap-2 text-[0.6875rem] text-[var(--chat-quiet)]">
        <button
          type="button"
          onClick={commit}
          className="rounded-full bg-[var(--chat-accent)] px-2.5 py-1 font-medium text-[var(--chat-accent-fg)]"
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full px-2.5 py-1 font-medium hover:bg-[var(--chat-hover)]"
        >
          Cancel
        </button>
        <span>Enter to save · Escape to cancel</span>
      </div>
    </div>
  );
}
