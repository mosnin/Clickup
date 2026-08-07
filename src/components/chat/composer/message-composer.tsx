"use client";

// The composer.
//
// Four things happen in this box and they are all about not losing what
// somebody typed:
//
//  • **The draft.** Every change is written under a key that is the room (or
//    `thread:<headId>`), so walking away and coming back finds the sentence
//    where you left it. Debounced, and flushed on the way out — a draft that
//    only survives if you pause for 300ms before switching rooms is a draft
//    that does not survive.
//  • **The optimistic row.** The bubble appears the instant Enter is pressed,
//    carrying a local key the acknowledged event inherits, so it never blinks.
//  • **The failure.** A refused send puts the text *back in the box* and says
//    why. This is the part people notice: the alternative is a message that
//    disappeared into a network error, and there is no copy of it anywhere.
//  • **The keyboard.** On a phone the composer must sit above the keys, not
//    under them.
//
// It renders nothing of the transcript and knows nothing about it. What it
// sends up is three callbacks — one row appeared, one row landed, one row
// failed — which is the whole contract a transcript needs.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { Paperclip, Quote as QuoteGlyph, Send, Smile, AtSign } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AttachmentTray,
  dropZoneHandlers,
  pastedFiles,
} from "@/components/chat/media/attachment-tray";
import type { ComposerMedia } from "@/components/chat/media/composer-media";
import { useToast } from "@/components/toast";
import type { ChatScope } from "@/lib/buzz/channel-types";
import type { ChatMessage } from "@/lib/buzz/message-types";
import { channelDraftKey, threadDraftKey, type DraftInput } from "@/lib/buzz/drafts";
import { ComposerEditor, type ComposerEditorHandle } from "./composer-editor";
export type { ComposerEditorHandle } from "./composer-editor";
import type { ComposerMentionable } from "./extensions";
import { EmojiPicker } from "./emoji-picker";
import type { CustomEmoji } from "./emoji-data";
import {
  clearDraftNow,
  configureDraftStore,
  peekDraft,
  renameDraftNow,
  saveDraftNow,
} from "./draft-store";
import { useKeyboardInset } from "./keyboard-inset";
import {
  acknowledgedId,
  createOptimisticMessage,
  isLocalKey,
  mentionRefsFor,
  newLocalKey,
  postArgs,
  type ComposerAuthor,
  type PostArgs,
  type SendTarget,
} from "./optimistic";

/**
 * `api.buzz.messages.post`, named by hand.
 *
 * The generated `api` object is a checked-in stub that only knows the modules
 * present when it was last generated, so `api.buzz.messages` does not typecheck
 * until somebody runs `npx convex dev`. Same treatment as
 * `shell/channel-data.tsx`: name the function and its arguments here, and go
 * back to the generated reference when the stub is regenerated.
 */
export const postMessage = makeFunctionReference<"mutation", PostArgs, unknown>(
  "buzz/messages:post",
);

/** What a caller may hand this composer instead of `buzz/messages:post`. */
export type PostMutation = FunctionReference<"mutation", "public", PostArgs, unknown>;

/** How long typing pauses before the draft is written. */
const DRAFT_DEBOUNCE_MS = 300;

export type MessageComposerProps = {
  scope: ChatScope;
  channelId: string;
  /** What the placeholder says: `#flight-path`, or a person's name in a DM. */
  channelLabel: string;
  /** Set on a thread composer. The draft moves under `thread:<rootId>`. */
  parentId?: string;
  rootId?: string;
  author: ComposerAuthor;
  mentionables: ComposerMentionable[];
  /**
   * Where the text goes. `buzz/messages:post` unless the surface says otherwise.
   *
   * The forum's comment box is this composer with this one thing changed, and
   * the argument shape is deliberately identical (`buzz/forum:comment` takes
   * exactly `PostArgs`) so nothing else has to differ. Everything a composer is
   * actually *for* — the draft that survives walking away, the optimistic row,
   * putting a refused message back in the box — is the same problem wherever the
   * text is going, and a second composer would have solved three of the four.
   *
   * Only the kind of thing being said changes, and the server decides that from
   * which door the text came through, not from a number a client sent.
   */
  postRef?: PostMutation;
  /** What the optimistic row claims to be. See `SendTarget.kind`. */
  postKind?: number;
  customEmoji?: CustomEmoji[];
  /** A message the reader chose to quote. Seeded into the box once, then released. */
  quote?: { author: string; body: string } | null;
  onQuoteConsumed?: () => void;
  /** The row to draw immediately. Keyed on `renderKey`. */
  onOptimistic?: (message: ChatMessage) => void;
  /** The same row landed; `eventId` is what it is called from now on. */
  onAcknowledged?: (localKey: string, eventId: string) => void;
  onFailed?: (localKey: string, reason: string) => void;
  /**
   * The composer's imperative handle, once it exists.
   *
   * For the things a transcript legitimately drives from outside: focusing the
   * box when somebody presses `r` on a message, or dropping text into it. Not a
   * second way to send — sending stays here, with the draft and the failure
   * handling that belong to it.
   */
  onEditorReady?: (handle: ComposerEditorHandle) => void;
  /**
   * Somebody is writing.
   *
   * Called on every keystroke and throttled by whoever supplies it — the
   * announcement rides Ably and is never a database write, so the throttle
   * belongs with the transport rather than here (`presence/use-typing.ts`).
   * Absent by default: a composer nobody wired an indicator to is silent, not
   * broken.
   */
  onTyping?: () => void;
  /**
   * Files, if this surface can carry them.
   *
   * Optional and absent by default, so a composer that has no business holding
   * an attachment — a forum comment box, a surface in a room somebody has only
   * read access to — is unchanged. When present it brings its own send, because
   * a message with attachments goes through `buzz/media:post` rather than
   * `buzz/messages:post`: the same core, one more set of preconditions.
   */
  media?: ComposerMedia;
  disabled?: boolean;
  /** Why sending is off — shown instead of the box. A disabled control that
   *  does not say why is a control people click twice and then reload. */
  disabledReason?: string;
  autoFocus?: boolean;
};

export function MessageComposer({
  scope,
  channelId,
  channelLabel,
  parentId,
  rootId,
  author,
  mentionables,
  postRef = postMessage,
  postKind,
  customEmoji = [],
  quote,
  onQuoteConsumed,
  onOptimistic,
  onAcknowledged,
  onFailed,
  onEditorReady,
  onTyping,
  media,
  disabled = false,
  disabledReason,
  autoFocus = false,
}: MessageComposerProps) {
  const post = useMutation(postRef);
  const { toast } = useToast();
  const editorRef = useRef<ComposerEditorHandle | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [ready, setReady] = useState(0);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<{ reason: string; body: string } | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [empty, setEmpty] = useState(true);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const keyboardInset = useKeyboardInset();

  // A thread composer's draft belongs to the thread, not to the room: two
  // half-written replies in the same channel must not overwrite each other.
  const draftKey = rootId ? threadDraftKey(rootId) : channelDraftKey(channelId);

  const target: SendTarget = useMemo(
    () => ({
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      channelId,
      ...(parentId ? { parentId } : {}),
      ...(rootId ? { rootId } : {}),
      ...(postKind !== undefined ? { kind: postKind } : {}),
    }),
    [scope.scopeType, scope.scopeId, channelId, parentId, rootId, postKind],
  );

  // ── Drafts ───────────────────────────────────────────────────────────────

  const pending = useRef<{ key: string; input: DraftInput } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushDraft = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const queued = pending.current;
    pending.current = null;
    // The key travels with the text. Flushing through a closure over "the
    // current key" is how a draft ends up filed under the room you switched to.
    if (queued) saveDraftNow(queued.key, queued.input);
  }, []);

  const mentionablesRef = useRef(mentionables);
  mentionablesRef.current = mentionables;

  // A ref for the same reason `mentionables` gets one: a caller that builds the
  // callback inline hands a new identity every render, and keying `onChange` on
  // it would rebuild the editor's change handler on each keystroke.
  const typingRef = useRef(onTyping);
  typingRef.current = onTyping;

  const onChange = useCallback(
    (markdown: string) => {
      setEmpty(markdown.trim() === "");
      typingRef.current?.();
      pending.current = {
        key: draftKey,
        input: {
          content: markdown,
          channelId,
          // The caret is restored at the end rather than where it was. A
          // ProseMirror position and an offset into the serialized markdown are
          // different coordinate spaces, and a number carried from one into the
          // other is a caret that lands mid-token. The end is where it almost
          // always was anyway.
          selectionStart: markdown.length,
          selectionEnd: markdown.length,
          mentionRefs: mentionRefsFor(markdown, mentionablesRef.current),
        },
      };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flushDraft, DRAFT_DEBOUNCE_MS);
    },
    [draftKey, channelId, flushDraft],
  );

  // Point the store at this community and this person. Idempotent, and it runs
  // the one-time v1 migration on the way in. Done here rather than left to the
  // shell because a composer whose store was never configured writes drafts
  // that only exist until the tab is closed — which looks exactly like working.
  useEffect(() => {
    configureDraftStore({ scopeType: scope.scopeType, scopeId: scope.scopeId }, author.pubkey);
    // The fields, not the object: a parent that builds `scope` inline would
    // otherwise re-configure the store on every render.
  }, [scope.scopeType, scope.scopeId, author.pubkey]);

  // Flush when the key changes and when the composer goes away. Both are the
  // same event from the draft's point of view: the text stops being watched.
  useEffect(() => flushDraft, [flushDraft, draftKey]);

  // The thread head was optimistic when this reply was started, and has just
  // become a real event. The draft follows it in ONE operation: composed from a
  // save and a clear it would be two flushes, and a crash between them loses
  // the reply entirely.
  //
  // Declared above the restore below, because order matters — the rename has to
  // land before anything reads the new key. The pending text is already on disk
  // by now: React runs every cleanup (including the flush above) before it runs
  // any effect from the same commit.
  const previousRoot = useRef(rootId);
  useEffect(() => {
    const from = previousRoot.current;
    previousRoot.current = rootId;
    if (!from || !rootId || from === rootId) return;
    // Only when the old head was a pending row. Any other change of `rootId` is
    // a different thread, and moving a draft into it would be a reply landing
    // in a conversation it was not written for.
    if (!isLocalKey(from)) return;
    // A "collision" keeps both records rather than picking a winner; the
    // orphan is what the drafts panel (§2.5) exists to surface.
    renameDraftNow(threadDraftKey(from), threadDraftKey(rootId));
  }, [rootId]);

  // Restore. Runs when the room (or thread) changes, and once the editor
  // exists — `useEditor` returns null on the first render, and a restore that
  // fired before it mounted would silently do nothing.
  //
  // Read imperatively rather than subscribed. A composer that re-applied the
  // stored draft whenever the store changed would re-apply its OWN writes, and
  // `setContent` puts the caret back at the end of the document — so the box
  // would fight the person typing in it. The draft is read at the two moments
  // it means something: arriving in a room, and coming back from a failure.
  useEffect(() => {
    const handle = editorRef.current;
    if (!handle) return;
    handle.setMarkdown(peekDraft(draftKey)?.content ?? "");
    setEmpty(handle.isEmpty());
    setFailure(null);
  }, [draftKey, ready]);

  // ── Quoting ──────────────────────────────────────────────────────────────

  // §2.4: there is no quote-with-attribution primitive. Quoting is markdown
  // blockquote formatting, which is why what lands in the box is text the
  // sender can edit or delete like anything else they typed.
  const consumedQuote = useRef<unknown>(null);
  const consumedRef = useRef(onQuoteConsumed);
  consumedRef.current = onQuoteConsumed;
  useEffect(() => {
    // `ready` and not just the handle: the handle exists one render before the
    // Tiptap instance does, and its methods are inert until then. A quote
    // consumed against the inert handle is a quote that never appears.
    if (!quote || !ready || !editorRef.current) return;
    // Guarded on the object identity, not on a boolean: the same message can
    // be quoted twice, and a parent that re-renders must not insert it twice.
    if (consumedQuote.current === quote) return;
    consumedQuote.current = quote;
    editorRef.current.quote(`${quote.author}: ${quote.body}`);
    setEmpty(false);
    consumedRef.current?.();
  }, [quote, ready]);

  useEffect(() => {
    if (autoFocus && ready) editorRef.current?.focus();
  }, [autoFocus, ready]);

  // ── Sending ──────────────────────────────────────────────────────────────

  const send = useCallback(
    (override?: string): boolean => {
      if (disabled || sending) return false;
      const handle = editorRef.current;
      const body = (override ?? handle?.markdown() ?? "").trim();
      // A picture on its own is a message. An empty box with nothing attached is
      // not, and an attachment that has not landed is one this send would drop.
      const withMedia = Boolean(media?.hasAttachments);
      if (!body && !withMedia) return false;
      if (withMedia && media?.busy) return false;

      const localKey = newLocalKey();
      onOptimistic?.(
        createOptimisticMessage({
          localKey,
          body,
          author,
          target,
          now: Date.now(),
        }),
      );

      // Clear optimistically, but hold on to what was cleared. The composer is
      // empty for the ~200ms a send takes, and if the send is refused this is
      // the only copy of the sentence in existence.
      handle?.clear();
      setEmpty(true);
      setFailure(null);
      pending.current = null;
      clearDraftNow(draftKey);
      setSending(true);

      const outgoing = postArgs(target, body);
      void (withMedia && media ? media.send(outgoing) : post(outgoing))
        .then((result) => {
          setSending(false);
          // Only on success: a refused send leaves the tray alone, so pressing
          // Retry re-sends the files rather than a message that has lost them.
          if (withMedia) media?.clear();
          // No id back is not a failure — the mutation may answer with nothing
          // at all. The transcript reconciles on the local key either way.
          onAcknowledged?.(localKey, acknowledgedId(result) ?? localKey);
        })
        .catch((error: unknown) => {
          setSending(false);
          const reason =
            error instanceof Error && error.message
              ? error.message
              : "The message could not be sent.";
          // Put it back: in the box, and in the draft store, so it also
          // survives navigating away from the failure.
          editorRef.current?.setMarkdown(body);
          setEmpty(false);
          saveDraftNow(draftKey, {
            content: body,
            channelId,
            selectionStart: body.length,
            selectionEnd: body.length,
            mentionRefs: mentionRefsFor(body, mentionablesRef.current),
          });
          setFailure({ reason, body });
          onFailed?.(localKey, reason);
          toast(reason, { kind: "error" });
        });

      return true;
    },
    [
      disabled,
      sending,
      author,
      target,
      draftKey,
      channelId,
      post,
      media,
      onOptimistic,
      onAcknowledged,
      onFailed,
      toast,
    ],
  );

  const sendRef = useRef(send);
  sendRef.current = send;

  // A picture with no caption is sendable; an upload still going up is not.
  const sendBlocked =
    sending || (empty && !media?.hasAttachments) || Boolean(media?.hasAttachments && media.busy);

  if (disabled) {
    return (
      <div className="shrink-0 px-5 pb-4 pt-1">
        <p className="chat-quiet soft-field px-3 py-2.5 text-sm">
          {disabledReason ?? "You cannot send messages here."}
        </p>
      </div>
    );
  }

  return (
    <div
      data-chat-composer=""
      // The keyboard's overlap, paid as padding. The box stays pinned to the
      // bottom of the window and its contents rise above the keys; the
      // transcript above gives up the same pixels.
      style={{ paddingBottom: keyboardInset ? keyboardInset + 16 : undefined }}
      className="shrink-0 px-3 pb-4 pt-1 sm:px-5"
      // Drop is on the whole composer rather than on the text box: the box is
      // one line tall and a target that small is a target people miss.
      {...(media
        ? dropZoneHandlers({
            onFiles: media.add,
            depth: dragDepth,
            setActive: setDragging,
          })
        : {})}
    >
      {failure ? (
        <div
          role="alert"
          className="mb-1.5 flex items-center gap-2 rounded-lg bg-[var(--chat-hover)] px-3 py-2 text-xs"
        >
          <span className="min-w-0 flex-1 truncate">Not sent — {failure.reason}</span>
          <button
            type="button"
            onClick={() => sendRef.current(failure.body)}
            className="shrink-0 rounded-full px-2 py-1 font-medium underline underline-offset-2"
          >
            Retry
          </button>
        </div>
      ) : null}

      {media ? <AttachmentTray slots={media.slots} onRemove={media.remove} /> : null}

      <div
        className={cn(
          "soft-field flex items-end gap-1 p-1.5",
          dragging && "ring-2 ring-[var(--chat-accent)]",
        )}
        onPaste={
          media
            ? (event) => {
                // Screenshots arrive on the clipboard and nowhere else. Only
                // preventDefault when there really are files, or pasting text
                // would stop working.
                const files = pastedFiles(event);
                if (files.length === 0) return;
                event.preventDefault();
                media.add(files);
              }
            : undefined
        }
      >
        <div className="chat-scroll max-h-40 min-w-0 flex-1 px-1.5 py-1">
          <ComposerEditor
            ref={editorRef}
            // Bumped rather than flagged: the editor materializes one render
            // after mount, and the draft restore has to run again on that pass.
            onReady={() => {
              setReady((n) => n + 1);
              if (editorRef.current) onEditorReady?.(editorRef.current);
            }}
            placeholder={`Message ${channelLabel}`}
            ariaLabel={`Message ${channelLabel}`}
            mentionables={mentionables}
            onChange={onChange}
            onSend={() => sendRef.current()}
          />
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {media ? (
            <>
              <input
                ref={fileRef}
                type="file"
                multiple
                // No accept filter, deliberately (§2.6): the deny-list lives on
                // the server, and a picker that hides a file type answers "why
                // can't I attach this" with silence.
                className="sr-only"
                aria-label="Choose files to attach"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  if (files.length > 0) media.add(files);
                  // Cleared so picking the same file twice fires again.
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                aria-label="Attach a file"
                onClick={() => fileRef.current?.click()}
                className="chat-icon-button tap-target"
              >
                <Paperclip aria-hidden className="size-4" />
              </button>
            </>
          ) : null}

          <button
            type="button"
            aria-label="Mention someone"
            onClick={() => editorRef.current?.insertText("@")}
            className="chat-icon-button tap-target"
          >
            <AtSign aria-hidden className="size-4" />
          </button>

          <div className="relative">
            <button
              type="button"
              aria-label="Emoji"
              aria-expanded={emojiOpen}
              onClick={() => setEmojiOpen((open) => !open)}
              className="chat-icon-button tap-target"
            >
              <Smile aria-hidden className="size-4" />
            </button>
            {emojiOpen ? (
              <>
                {/* Click-away. A button rather than a document listener so it
                    cannot outlive the picker. */}
                <button
                  type="button"
                  aria-label="Close emoji picker"
                  onClick={() => setEmojiOpen(false)}
                  className="fixed inset-0 z-40 cursor-default"
                />
                <div className="absolute bottom-full right-0 z-50 mb-2">
                  <EmojiPicker
                    customEmoji={customEmoji}
                    onSelect={(token) => {
                      editorRef.current?.insertText(token);
                      setEmojiOpen(false);
                    }}
                  />
                </div>
              </>
            ) : null}
          </div>

          <button
            type="button"
            aria-label="Quote"
            onClick={() => editorRef.current?.toggleBlockquote()}
            className="chat-icon-button tap-target"
          >
            <QuoteGlyph aria-hidden className="size-4" />
          </button>

          <button
            type="button"
            aria-label="Send message"
            disabled={sendBlocked}
            onClick={() => sendRef.current()}
            className={cn(
              "tap-target flex size-8 items-center justify-center rounded-full transition-opacity",
              "bg-[var(--chat-accent)] text-[var(--chat-accent-fg)]",
              sendBlocked ? "opacity-40" : "opacity-100",
            )}
          >
            <Send aria-hidden className="size-4" />
          </button>
        </div>
      </div>

      <p className="chat-quiet mt-1.5 hidden text-tiny sm:block">
        Enter to send · Shift + Enter for a new line
      </p>
    </div>
  );
}
