"use client";

// Frame-anchored comments: the review panel and the box you write them in.
//
// The distinctive feature, and the trick is genuinely small (§2.10): **a
// frame-anchored comment is an ordinary thread reply whose body begins
// `[MM:SS.d] `.** No new event kind, no dedicated field, no second table — which
// is why it works everywhere a reply works: it is searchable, it is editable, it
// notifies, an agent reading the log over MCP sees it, and a client that has
// never heard of video review renders it as a sentence that starts with a
// timecode. Every bit of that comes from *not* inventing a shape.
//
// The whole of the grammar lives in `src/lib/buzz/media.ts` and nothing here
// re-derives any of it. Two rules that this file only obeys:
//
//   • **Replies never re-stamp** — a reply inherits the moment of the comment it
//     answers, because "and also here" three minutes later is a different remark,
//     not the same one.
//   • **Focusing the composer pauses the video.** Writing about a frame while the
//     frame moves means writing about the wrong frame by the time you press
//     enter.

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import {
  alreadyStamped,
  formatCommentTimecode,
  nestOneLevel,
  parseTimecodedComment,
  stampComment,
} from "@/lib/buzz/media";

/** One comment, in the little shape this panel needs. */
export type VideoReviewComment = {
  id: string;
  author: string;
  /** The raw body, **including** the `[MM:SS] ` prefix. */
  body: string;
  /** Unix seconds. */
  createdAt: number;
  parentId?: string | null;
  mine?: boolean;
  pending?: boolean;
};

export type VideoReviewContext = {
  /** The video message's event id — the root every comment hangs off. */
  rootEventId: string;
  comments: VideoReviewComment[];
  /**
   * Post a comment. `parentEventId` is the comment being answered, or the video.
   *
   * Rejecting is meaningful: the composer restores the draft it cleared, which
   * is the only copy of the sentence in existence at that moment.
   */
  onSend?: (body: string, parentEventId: string) => Promise<unknown>;
  /** Why sending is off — shown instead of the box. */
  disabledReason?: string;
};

/**
 * The comments beside a video.
 *
 * Read-only when there are comments and no way to add one (§2.10): the review of
 * a video in a room you have left is still worth reading.
 */
export function VideoReviewPanel({
  context,
  currentTime,
  duration,
  onSeek,
  onAuthoringFocus,
}: {
  context: VideoReviewContext;
  currentTime: number;
  duration: number;
  onSeek: (seconds: number) => void;
  onAuthoringFocus?: () => void;
}) {
  const [replyTo, setReplyTo] = useState<VideoReviewComment | null>(null);
  const threads = useMemo(
    () => nestOneLevel(context.comments, context.rootEventId),
    [context.comments, context.rootEventId],
  );

  // A reply target that has gone away — deleted, or the panel reloaded — must
  // not leave the composer permanently in "replying to" mode with nothing to
  // reply to.
  useEffect(() => {
    if (replyTo && !context.comments.some((comment) => comment.id === replyTo.id)) {
      setReplyTo(null);
    }
  }, [context.comments, replyTo]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="chat-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {threads.length === 0 ? (
          <p className="chat-quiet px-1 py-6 text-center text-xs">
            No comments yet. Play to a moment and say what you see.
          </p>
        ) : (
          <ul className="space-y-3">
            {threads.map(({ comment, replies }) => (
              <li key={comment.id}>
                <CommentCard
                  comment={comment}
                  duration={duration}
                  onSeek={onSeek}
                  onReply={() => setReplyTo(comment)}
                  replyTo={comment.author}
                  canReply={Boolean(context.onSend)}
                />
                {replies.length > 0 ? (
                  <ul className="mt-2 space-y-2 border-l border-[var(--chat-hairline)] pl-3">
                    {replies.map((reply) => (
                      <li key={reply.id}>
                        <CommentCard
                          comment={reply}
                          duration={duration}
                          onSeek={onSeek}
                          onReply={() => setReplyTo(comment)}
                          replyTo={comment.author}
                          canReply={Boolean(context.onSend)}
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {context.onSend ? (
        <CommentComposer
          context={context}
          currentTime={currentTime}
          duration={duration}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          onFocus={onAuthoringFocus}
        />
      ) : (
        <p className="chat-quiet border-t border-[var(--chat-hairline)] px-3 py-3 text-xs">
          {context.disabledReason ?? "You cannot comment here."}
        </p>
      )}
    </div>
  );
}

function CommentCard({
  comment,
  duration,
  onSeek,
  onReply,
  replyTo,
  canReply,
}: {
  comment: VideoReviewComment;
  duration: number;
  onSeek: (seconds: number) => void;
  onReply: () => void;
  /** Whose thread this is — the reply button lands there, not on this card. */
  replyTo: string;
  canReply: boolean;
}) {
  const parsed = parseTimecodedComment(comment.body);
  const seekable = parsed.seconds !== null && (duration <= 0 || parsed.seconds <= duration);

  return (
    <div className={cn("rounded-lg px-2 py-1.5", comment.pending && "opacity-60")}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        {parsed.timecode ? (
          <button
            type="button"
            disabled={!seekable}
            onClick={() => parsed.seconds !== null && onSeek(parsed.seconds)}
            aria-label={`Seek to ${parsed.timecode}`}
            className="rounded-full bg-[var(--chat-accent)] px-1.5 py-0.5 font-mono text-[0.625rem] text-[var(--chat-accent-fg)] disabled:opacity-40"
          >
            {parsed.timecode}
          </button>
        ) : null}
        <span className="text-xs font-semibold">{comment.author}</span>
        <span className="chat-quiet text-[0.625rem]">
          {comment.pending ? "now" : timeAgo(comment.createdAt * 1000)}
        </span>
      </div>
      <p className="mt-0.5 whitespace-pre-wrap break-words text-[0.8125rem] leading-snug">
        {parsed.text}
      </p>
      {canReply ? (
        <button
          type="button"
          // Named after the *thread's* author rather than this card's: a reply
          // to a reply is filed under the top-level comment (replies nest one
          // level), so the label has to say where it will actually land.
          aria-label={`Reply to ${replyTo}`}
          onClick={onReply}
          className="chat-quiet mt-0.5 text-[0.625rem] underline underline-offset-2"
        >
          Reply
        </button>
      ) : null}
    </div>
  );
}

/**
 * The box, with the one control that makes this a review tool.
 *
 * "Comment at current frame" defaults **on**, because the reason somebody is
 * typing in this box is the frame they are looking at — and it is a checkbox
 * rather than a mode because the un-anchored comment ("looks good, ship it") is
 * a real thing people say about a video as a whole.
 *
 * When replying, the checkbox is replaced by the person being answered: a reply
 * inherits its parent's moment and there is nothing to decide.
 */
function CommentComposer({
  context,
  currentTime,
  duration,
  replyTo,
  onCancelReply,
  onFocus,
}: {
  context: VideoReviewContext;
  currentTime: number;
  duration: number;
  replyTo: VideoReviewComment | null;
  onCancelReply: () => void;
  onFocus?: () => void;
}) {
  const [value, setValue] = useState("");
  const [stamp, setStamp] = useState(true);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);

  const bounded = Math.min(Math.max(0, currentTime), duration > 0 ? duration : currentTime);
  const willStamp = stamp && !replyTo && !alreadyStamped(value.trim());

  const submit = async () => {
    const text = value.trim();
    if (!text || sending || !context.onSend) return;
    const body = willStamp ? stampComment(bounded, text) : text;
    const parentEventId = replyTo ? replyTo.id : context.rootEventId;

    setSending(true);
    setFailure(null);
    // Cleared optimistically, and put back on refusal — the box holds the only
    // copy of the sentence for as long as the send takes.
    setValue("");
    try {
      await context.onSend(body, parentEventId);
      onCancelReply();
    } catch (error) {
      setValue(text);
      setFailure(error instanceof Error && error.message ? error.message : "Not sent.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="border-t border-[var(--chat-hairline)] p-3">
      {failure ? (
        <p role="alert" className="mb-1.5 text-[0.6875rem] text-destructive">
          Not sent — {failure}
        </p>
      ) : null}

      <div className="mb-1.5 flex items-center justify-between gap-2 text-[0.6875rem]">
        {replyTo ? (
          <>
            <span className="chat-quiet truncate">Replying to {replyTo.author}</span>
            <button
              type="button"
              onClick={onCancelReply}
              className="shrink-0 underline underline-offset-2"
            >
              Cancel
            </button>
          </>
        ) : (
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={stamp}
              onChange={(event) => setStamp(event.target.checked)}
              className="size-3.5"
            />
            <span>Comment at current frame</span>
            <span
              data-testid="timecode-chip"
              className={cn(
                "rounded-full px-1.5 py-0.5 font-mono text-[0.625rem]",
                willStamp
                  ? "bg-[var(--chat-accent)] text-[var(--chat-accent-fg)]"
                  : "bg-[var(--chat-hover)] text-[var(--chat-quiet)]",
              )}
            >
              {formatCommentTimecode(bounded)}
            </span>
          </label>
        )}
      </div>

      <textarea
        ref={boxRef}
        rows={2}
        value={value}
        disabled={sending}
        aria-label="Comment on this video"
        placeholder={replyTo ? `Reply to ${replyTo.author}` : "Say what you see"}
        // §2.10: focusing the box pauses playback, because the frame you are
        // writing about must not move while you write about it.
        onFocusCapture={onFocus}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        className="soft-field w-full resize-none px-2 py-1.5 text-[0.8125rem] outline-none"
      />

      <div className="mt-1.5 flex items-center justify-end">
        <button
          type="button"
          disabled={sending || value.trim() === ""}
          onClick={() => void submit()}
          className="rounded-full bg-[var(--chat-accent)] px-3 py-1 text-xs font-medium text-[var(--chat-accent-fg)] disabled:opacity-40"
        >
          Comment
        </button>
      </div>
    </div>
  );
}
