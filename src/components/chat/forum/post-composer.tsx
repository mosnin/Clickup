"use client";

// Starting a discussion.
//
// The one composer in Chat that is not the message composer, and the reason is
// the title: a post has a name, a message does not, and a name is not a longer
// first line — it is what the post is *called* in a list somebody scrolls a
// month later. Two fields, in the order they are thought of.
//
// Everything below the title is the ordinary body editor (`ComposerEditor`), so
// mentions, markdown, the emoji token grammar and Enter/Shift-Enter behave the
// way they do everywhere else. What is deliberately *not* reused is
// `MessageComposer`'s draft, optimistic-row and retry machinery: those exist
// because a chat message is written in a second and lost in a second, and a
// post is written deliberately with the box open in front of you. What replaces
// them is the rule below — **a refused post puts the text back**, both fields,
// and says why.
//
// Collapsed behind a placeholder button until it is wanted (§5.4). A permanently
// open two-field form at the top of a list of posts is a form that pushes the
// posts off the screen to ask a question nobody asked.

import { useCallback, useRef, useState } from "react";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import {
  ComposerEditor,
  type ComposerEditorHandle,
} from "@/components/chat/composer/composer-editor";
import type { ComposerMentionable } from "@/components/chat/composer";
import { MAX_TITLE_CHARS } from "./model";

export type PostComposerProps = {
  mentionables: ComposerMentionable[];
  /** Off, with a reason: archived room, not a member, no signing identity yet. */
  disabledReason?: string | null;
  /** Resolves with the new post's event id. Rejects with a sentence to show. */
  onSubmit: (title: string, body: string) => Promise<string>;
  /** Called with the new post's id, so the list can open it. */
  onCreated?: (postId: string) => void;
  /**
   * The body editor's imperative handle, once it exists.
   *
   * The same seam `MessageComposer` exposes and for the same reason: focusing
   * the box or putting text into it from outside. `useEditor` returns null on
   * the first render, so this is how a caller learns the handle is live.
   */
  onEditorReady?: (handle: ComposerEditorHandle) => void;
};

export function PostComposer({
  mentionables,
  disabledReason,
  onSubmit,
  onCreated,
  onEditorReady,
}: PostComposerProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [sending, setSending] = useState(false);
  const [bodyEmpty, setBodyEmpty] = useState(true);
  const editorRef = useRef<ComposerEditorHandle | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setTitle("");
    setBodyEmpty(true);
    editorRef.current?.clear();
  }, []);

  const submit = useCallback(async () => {
    if (sending) return;
    const trimmed = title.trim();
    const body = editorRef.current?.markdown()?.trim() ?? "";
    // Refused here as well as on the server, because the two refusals do
    // different jobs: the server's keeps a titleless post out of the log, and
    // this one keeps somebody from pressing Post and waiting for a round trip to
    // be told the obvious.
    if (!trimmed) {
      toast("A post needs a title", { kind: "error" });
      return;
    }
    setSending(true);
    try {
      const postId = await onSubmit(trimmed, body);
      close();
      onCreated?.(postId);
    } catch (error) {
      // The text stays exactly where it was. A post is minutes of writing, and
      // the failure mode this guards against is the one where the only copy of
      // it was in a box that has just been cleared.
      toast(
        error instanceof Error && error.message
          ? error.message
          : "The post could not be created.",
        { kind: "error" },
      );
    } finally {
      setSending(false);
    }
  }, [sending, title, onSubmit, onCreated, close, toast]);

  if (disabledReason) {
    return (
      <p className="chat-quiet soft-field px-3 py-2.5 text-sm" data-forum-composer="off">
        {disabledReason}
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-forum-composer="collapsed"
        className={cn(
          "soft-field w-full px-3 py-2.5 text-left text-sm",
          "chat-quiet transition-colors hover:bg-[var(--chat-hover)]",
        )}
      >
        Start a new post…
      </button>
    );
  }

  return (
    <div data-forum-composer="open" className="soft-field p-2">
      <input
        // Autofocus: the button that opened this was pressed to type a title.
        autoFocus
        value={title}
        maxLength={MAX_TITLE_CHARS}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            event.preventDefault();
            close();
          }
        }}
        aria-label="Post title"
        placeholder="Title"
        className="w-full bg-transparent px-1.5 py-1 text-compact font-semibold outline-none"
      />
      <div
        className="chat-scroll max-h-64 min-h-16 px-1.5 py-1"
        // Cmd/Ctrl+Enter posts. The editor's own `Enter` handler declines (see
        // `onSend` below) and so does its `Mod-Enter`, so both events reach this
        // handler — which is why the shortcut lives here rather than being a
        // second opinion inside the extension list.
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      >
        <ComposerEditor
          ref={editorRef}
          placeholder="Write the post…"
          ariaLabel="Post body"
          mentionables={mentionables}
          onReady={() => {
            if (editorRef.current) onEditorReady?.(editorRef.current);
          }}
          onChange={(markdown) => setBodyEmpty(markdown.trim() === "")}
          // Enter inserts a newline in a post body rather than sending: a post is
          // paragraphs, and a box where Enter posts is a box that posts a
          // paragraph. The button is the only way to send.
          onSend={() => false}
        />
      </div>
      <div className="flex items-center justify-end gap-2 px-1.5 pb-0.5 pt-1">
        <button
          type="button"
          onClick={close}
          className="rounded-full px-3 py-1.5 text-xs font-medium hover:bg-[var(--chat-hover)]"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={sending || title.trim() === "" || bodyEmpty}
          onClick={() => void submit()}
          className={cn(
            "rounded-full px-3 py-1.5 text-xs font-medium transition-opacity",
            "bg-[var(--chat-accent)] text-[var(--chat-accent-fg)]",
            sending || title.trim() === "" || bodyEmpty ? "opacity-40" : "opacity-100",
          )}
        >
          {sending ? "Posting…" : "Post"}
        </button>
      </div>
    </div>
  );
}
