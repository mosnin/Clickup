"use client";

import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Bold, Code, Italic, Link2, Strikethrough } from "lucide-react";
import { cn } from "@/lib/utils";

// The formatting bar that appears over a selection.
//
// Hand-rolled rather than @tiptap/extension-bubble-menu because that pulls in
// tippy.js for positioning, and the suggestion menus already position
// themselves off the editor's own coordinates. One positioning approach for
// every popup in this editor, one fewer dependency, and the bar matches the
// slash menu's surface instead of tippy's.

type Placement = { left: number; top: number } | null;

export function SelectionToolbar({ editor }: { editor: Editor }) {
  const [at, setAt] = useState<Placement>(null);
  // Marks change without the selection moving (pressing bold), so the bar
  // needs its own reason to redraw.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    function sync() {
      const { state, view } = editor;
      const { from, to, empty } = state.selection;
      if (empty || !editor.isEditable || !view.hasFocus()) {
        setAt(null);
        return;
      }
      // Code blocks are verbatim by definition — offering bold inside one
      // would produce markdown that means nothing.
      if (editor.isActive("codeBlock")) {
        setAt(null);
        return;
      }
      const start = view.coordsAtPos(from);
      const end = view.coordsAtPos(to);
      const left = (start.left + end.left) / 2;
      setAt({
        left: Math.min(Math.max(left, 96), window.innerWidth - 96),
        top: Math.min(start.top, end.top),
      });
      setTick((t) => t + 1);
    }

    editor.on("selectionUpdate", sync);
    editor.on("transaction", sync);
    editor.on("blur", sync);
    editor.on("focus", sync);
    return () => {
      editor.off("selectionUpdate", sync);
      editor.off("transaction", sync);
      editor.off("blur", sync);
      editor.off("focus", sync);
    };
  }, [editor]);

  if (!at) return null;

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      data-tick={tick}
      style={{ left: at.left, top: at.top }}
      className="fixed z-[60] -translate-x-1/2 -translate-y-[calc(100%+8px)] flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-lg"
    >
      <MarkButton
        editor={editor}
        mark="bold"
        label="Bold"
        icon={Bold}
        onClick={() => editor.chain().focus().toggleBold().run()}
      />
      <MarkButton
        editor={editor}
        mark="italic"
        label="Italic"
        icon={Italic}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <MarkButton
        editor={editor}
        mark="strike"
        label="Strikethrough"
        icon={Strikethrough}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      />
      <MarkButton
        editor={editor}
        mark="code"
        label="Inline code"
        icon={Code}
        onClick={() => editor.chain().focus().toggleCode().run()}
      />
      <MarkButton
        editor={editor}
        mark="link"
        label="Link"
        icon={Link2}
        onClick={() => {
          if (editor.isActive("link")) {
            editor.chain().focus().unsetLink().run();
            return;
          }
          // No modal asking for a URL — this is a markdown editor, so it
          // writes the syntax and leaves the caret where the URL goes.
          const { from, to } = editor.state.selection;
          const text = editor.state.doc.textBetween(from, to);
          editor
            .chain()
            .focus()
            .insertContent(`[${text || "text"}](https://)`)
            .run();
        }}
      />
    </div>
  );
}

function MarkButton({
  editor,
  mark,
  label,
  icon: Icon,
  onClick,
}: {
  editor: Editor;
  mark: string;
  label: string;
  icon: typeof Bold;
  onClick: () => void;
}) {
  const active = editor.isActive(mark);
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      // Mouse-down, not click: a click would blur the editor and collapse
      // the selection before the command ran.
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
      className={cn(
        "tap-target inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}
