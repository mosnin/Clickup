"use client";

// The editing surface itself.
//
// Deliberately thin: it owns the Tiptap instance and nothing else. Drafts,
// sending, failure and the toolbar all live in `message-composer.tsx`, because
// a component that both edits text and talks to the server is a component whose
// send logic can only be tested by typing.
//
// What it does own is the two keyboard facts that are properties of the
// surface rather than of the feature: Enter/Shift-Enter (in `extensions.ts`,
// guarded on the suggestion menu) and paste.

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import {
  buildComposerExtensions,
  type ComposerMentionable,
  type MenuFlag,
} from "./extensions";

export type ComposerEditorHandle = {
  focus: () => void;
  /** The markdown this composer would send. */
  markdown: () => string;
  setMarkdown: (markdown: string) => void;
  clear: () => void;
  /** Insert literal characters at the caret — emoji, a shortcode, anything. */
  insertText: (text: string) => void;
  /** Drop text in as a markdown blockquote and put the caret after it. */
  quote: (text: string) => void;
  toggleBlockquote: () => void;
  isEmpty: () => boolean;
};

function markdownOf(editor: Editor | null): string {
  if (!editor) return "";
  const storage = editor.storage as { markdown?: { getMarkdown(): string } };
  return storage.markdown?.getMarkdown() ?? "";
}

export const ComposerEditor = forwardRef<
  ComposerEditorHandle,
  {
    placeholder: string;
    ariaLabel: string;
    mentionables: ComposerMentionable[];
    onChange: (markdown: string) => void;
    /** Return true when the send was accepted, so Enter can stop there. */
    onSend: () => boolean;
    /**
     * Fired once the Tiptap instance exists.
     *
     * `useEditor` returns null on the first render (`immediatelyRender: false`,
     * because this renders on the server too), so the imperative handle is
     * inert for one pass. A caller that restores a draft on mount would restore
     * it into nothing; this is how it learns to try again.
     */
    onReady?: () => void;
    disabled?: boolean;
  }
>(function ComposerEditor(
  { placeholder, ariaLabel, mentionables, onChange, onSend, onReady, disabled = false },
  ref,
) {
  // Refs, not closures: the extension list is built once and would otherwise
  // pin the first render's mentionables and the first render's send handler
  // forever — a composer that sends into the room you were in when it mounted.
  const mentionsRef = useRef(mentionables);
  mentionsRef.current = mentionables;
  const sendRef = useRef(onSend);
  sendRef.current = onSend;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const menuFlag = useRef<MenuFlag>({ open: false });

  const extensions = useMemo(
    () =>
      buildComposerExtensions({
        placeholder,
        mentionables: () => mentionsRef.current,
        onSend: () => sendRef.current(),
        menuFlag: menuFlag.current,
      }),
    // Built once. The placeholder is captured, which is right: it names the
    // room, and changing rooms remounts this component by key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const editor = useEditor({
    extensions,
    content: "",
    editable: !disabled,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        // Styled here rather than as a `.chat-composer-prose` rule in
        // globals.css: that stylesheet is shared with a concurrent build and
        // takes append-only edits, and a composer whose looks live in two files
        // is a composer that gets restyled by accident. Descendant variants
        // because the editor draws real elements (a `<blockquote>` is a
        // blockquote), so the alternative would be a node view per mark.
        class: [
          "min-h-8 text-sm leading-6 outline-none",
          "[&_p]:my-0",
          "[&_p+p]:mt-1.5",
          "[&_blockquote]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:opacity-80",
          "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5",
          "[&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5",
          "[&_code]:rounded [&_code]:bg-[var(--chat-hover)] [&_code]:px-1 [&_code]:text-[0.85em]",
          "[&_pre]:my-1 [&_pre]:rounded-lg [&_pre]:bg-[var(--chat-hover)] [&_pre]:p-2 [&_pre]:text-xs",
          "[&_a]:underline [&_a]:underline-offset-2",
          "[&_.chat-mention]:rounded [&_.chat-mention]:bg-[var(--chat-active)] [&_.chat-mention]:px-1 [&_.chat-mention]:font-medium",
          // The placeholder, which Tiptap renders as a data attribute on the
          // empty first paragraph and leaves entirely to CSS.
          "[&_p.is-editor-empty:first-child]:before:pointer-events-none",
          // Absolute, not floated.
          //
          // The float+zero-height trick keeps the placeholder out of layout, but
          // a zero-height box cannot also be `overflow-hidden` — that clips the
          // text to nothing rather than to an ellipsis, which is how the first
          // attempt at this fix made the placeholder vanish outright. Taking it
          // out of flow entirely gets the same "does not move the caret" result
          // and leaves it a real box that can truncate.
          "[&_p.is-editor-empty:first-child]:relative",
          "[&_p.is-editor-empty:first-child]:before:absolute",
          "[&_p.is-editor-empty:first-child]:before:inset-x-0",
          "[&_p.is-editor-empty:first-child]:before:top-0",
          "[&_p.is-editor-empty:first-child]:before:text-muted-foreground",
          "[&_p.is-editor-empty:first-child]:before:opacity-60",
          "[&_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]",
          // One line, truncated — never wrapped.
          //
          // The placeholder floats with zero height so it does not push the
          // caret down, which means the box is one line tall while the text is
          // free to wrap to two. At 390px "Message #flight-path" does exactly
          // that, and the second line is clipped by the box it does not
          // contribute height to: the reader sees "Message #flight-" and a
          // sliver. Truncating is the honest failure — an ellipsis says there
          // is more, where a clipped descender says the app is broken.
          // One line, truncated — never wrapped. At 390px "Message #flight-path"
          // wraps to two lines inside a box one line tall, and the reader sees
          // a clipped descender, which reads as broken rather than as elided.
          "[&_p.is-editor-empty:first-child]:before:overflow-hidden",
          "[&_p.is-editor-empty:first-child]:before:whitespace-nowrap",
          "[&_p.is-editor-empty:first-child]:before:text-ellipsis",
        ].join(" "),
        "aria-label": ariaLabel,
        role: "textbox",
        "aria-multiline": "true",
      },
      /**
       * Paste, without smuggling markup.
       *
       * A clipboard carrying `text/html` came from something with opinions
       * about markup — a browser, a document editor, another chat client — and
       * those opinions are exactly what must not reach a message body. The
       * body is markdown; there is no HTML in it, so there is nothing to
       * sanitise later and nothing that could survive to a renderer. We take
       * the plain-text flavour and insert it as characters.
       *
       * A clipboard with only text takes the normal path, where tiptap-markdown
       * reads it as markdown — which is not a leniency, it is the same format
       * this composer stores.
       */
      handlePaste(view, event) {
        const clipboard = event.clipboardData;
        if (!clipboard) return false;
        if (!clipboard.getData("text/html")) return false;
        event.preventDefault();
        const text = clipboard.getData("text/plain") ?? "";
        if (text) view.dispatch(view.state.tr.insertText(text).scrollIntoView());
        return true;
      },
    },
    onUpdate: ({ editor: ed }) => changeRef.current(markdownOf(ed)),
  });

  useImperativeHandle(
    ref,
    (): ComposerEditorHandle => ({
      focus: () => editor?.commands.focus("end"),
      markdown: () => markdownOf(editor ?? null),
      setMarkdown: (markdown) => {
        // `false` for emitUpdate: restoring a draft is not an edit, and
        // emitting one would immediately write the draft back over itself with
        // a fresh `updatedAt` on every room switch.
        editor?.commands.setContent(markdown, false);
      },
      clear: () => editor?.commands.clearContent(false),
      insertText: (text) => editor?.chain().focus().insertContent(text).run(),
      quote: (text) => {
        if (!editor) return;
        // A blockquote of plain lines, which is all quoting is here: there is
        // no quote-with-attribution message primitive, so a quote is text the
        // sender is choosing to include. Anything richer would be a shape the
        // recipient's renderer has never heard of.
        const lines = text.split("\n").filter((line) => line.trim() !== "");
        editor
          .chain()
          .focus()
          .insertContent([
            {
              type: "blockquote",
              content: lines.map((line) => ({
                type: "paragraph",
                content: [{ type: "text", text: line }],
              })),
            },
            { type: "paragraph" },
          ])
          .run();
      },
      toggleBlockquote: () => editor?.chain().focus().toggleBlockquote().run(),
      isEmpty: () => markdownOf(editor ?? null).trim() === "",
    }),
    [editor],
  );

  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  useEffect(() => {
    if (editor) readyRef.current?.();
  }, [editor]);

  if (!editor) {
    // Reserve the row rather than collapsing: the composer is pinned to the
    // bottom of the room and a zero-height first paint moves the transcript.
    return <div className="min-h-8" />;
  }

  return <EditorContent editor={editor} />;
});
