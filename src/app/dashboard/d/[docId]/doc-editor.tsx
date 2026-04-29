"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useAction } from "convex/react";
import { useEditor, EditorContent, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  ArrowLeft,
  Bold,
  Code,
  Heading1,
  Heading2,
  Italic,
  List,
  ListOrdered,
  Quote,
  Sparkles,
  Strikethrough,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { PresenceStack } from "@/components/dashboard/presence-stack";
import { usePresence } from "@/lib/use-presence";
import { cn } from "@/lib/utils";

const SAVE_DEBOUNCE_MS = 800;

export function DocEditor({ docId }: { docId: string }) {
  const id = docId as Id<"docs">;
  const doc = useQuery(api.docs.get, { docId: id });
  const updateContent = useMutation(api.docs.updateContent);
  const rename = useMutation(api.docs.rename);
  const remove = useMutation(api.docs.remove);
  const viewers = usePresence({ focusType: "doc", focusId: id });

  const [title, setTitle] = useState("");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tiptap is initialized once, with the doc's content. We hand the
  // editor an empty doc until the query resolves, then push the real
  // content via setContent below.
  const editor = useEditor({
    extensions: [StarterKit],
    content: undefined,
    editorProps: {
      attributes: {
        class:
          "prose prose-sm sm:prose max-w-none min-h-[60vh] focus:outline-none",
      },
    },
    immediatelyRender: false,
    onUpdate({ editor }) {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      const json = editor.getJSON();
      saveTimerRef.current = setTimeout(() => {
        updateContent({ docId: id, content: json }).then(() => {
          setSavedAt(Date.now());
        });
      }, SAVE_DEBOUNCE_MS);
    },
  });

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // Initial content + title sync. Only run when the doc id changes or
  // when the editor mounts to avoid clobbering local edits.
  const initialized = useRef(false);
  useEffect(() => {
    if (!editor || !doc || initialized.current) return;
    editor.commands.setContent((doc.content as JSONContent) ?? "");
    setTitle(doc.title);
    initialized.current = true;
  }, [editor, doc]);

  if (doc === undefined) return <DocSkeleton />;
  if (doc === null) {
    return (
      <div className="rounded-3xl border border-border bg-muted/30 p-10 text-center">
        <p className="text-sm text-muted-foreground">
          This doc doesn&apos;t exist or you don&apos;t have access.
        </p>
        <Link
          href="/dashboard"
          className="mt-3 inline-block text-sm font-medium text-brand-600 hover:underline"
        >
          Back to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Dashboard
        </Link>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <PresenceStack viewers={viewers} size={6} />
          {savedAt && <span>Saved {timeAgo(savedAt)}</span>}
          <button
            type="button"
            onClick={() => {
              if (window.confirm("Delete this doc?")) {
                remove({ docId: id }).then(() => {
                  window.history.back();
                });
              }
            }}
            className="rounded-full px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Delete
          </button>
        </div>
      </div>

      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        onBlur={() => {
          if (title.trim() && title !== doc.title) {
            rename({ docId: id, title: title.trim() });
          } else if (!title.trim()) {
            setTitle(doc.title);
          }
        }}
        placeholder="Untitled"
        className="w-full bg-transparent text-3xl font-semibold tracking-tight focus:outline-none sm:text-4xl"
      />

      <Toolbar editor={editor} />
      <div className="rounded-3xl border border-border bg-background p-6">
        <EditorContent editor={editor} />
      </div>
      <AiWriterRow editor={editor} />
    </div>
  );
}

function AiWriterRow({
  editor,
}: {
  editor: ReturnType<typeof useEditor>;
}) {
  const writerContinue = useAction(api.ai.writerContinue);
  const [pending, setPending] = useState(false);

  if (!editor) return null;

  async function continueWithAi() {
    if (!editor || pending) return;
    setPending(true);
    try {
      const context = editor.getText().slice(-3000);
      const text = await writerContinue({
        prompt:
          "Continue the document with the next paragraph. Stay on topic.",
        context,
      });
      if (text.trim()) {
        editor.commands.focus("end");
        editor.commands.insertContent("\n\n" + text.trim());
      }
    } finally {
      setPending(false);
    }
  }

  async function summarize() {
    if (!editor || pending) return;
    setPending(true);
    try {
      const context = editor.getText().slice(0, 6000);
      const text = await writerContinue({
        prompt:
          "Summarize this document in 3 bullet points. Output the bullets as a markdown list.",
        context,
      });
      if (text.trim()) {
        editor.commands.focus("end");
        editor.commands.insertContent("\n\n## Summary\n\n" + text.trim());
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={continueWithAi}
        disabled={pending}
      >
        <Sparkles className="h-3.5 w-3.5" />
        {pending ? "Writing…" : "Continue with AI"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={summarize}
        disabled={pending}
      >
        Summarize
      </Button>
    </div>
  );
}

function Toolbar({ editor }: { editor: ReturnType<typeof useEditor> }) {
  if (!editor) return null;

  const buttons: {
    label: string;
    Icon: typeof Bold;
    isActive: () => boolean;
    onClick: () => void;
  }[] = [
    {
      label: "Bold",
      Icon: Bold,
      isActive: () => editor.isActive("bold"),
      onClick: () => editor.chain().focus().toggleBold().run(),
    },
    {
      label: "Italic",
      Icon: Italic,
      isActive: () => editor.isActive("italic"),
      onClick: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      label: "Strike",
      Icon: Strikethrough,
      isActive: () => editor.isActive("strike"),
      onClick: () => editor.chain().focus().toggleStrike().run(),
    },
    {
      label: "Code",
      Icon: Code,
      isActive: () => editor.isActive("code"),
      onClick: () => editor.chain().focus().toggleCode().run(),
    },
    {
      label: "H1",
      Icon: Heading1,
      isActive: () => editor.isActive("heading", { level: 1 }),
      onClick: () =>
        editor.chain().focus().toggleHeading({ level: 1 }).run(),
    },
    {
      label: "H2",
      Icon: Heading2,
      isActive: () => editor.isActive("heading", { level: 2 }),
      onClick: () =>
        editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      label: "Bullet list",
      Icon: List,
      isActive: () => editor.isActive("bulletList"),
      onClick: () => editor.chain().focus().toggleBulletList().run(),
    },
    {
      label: "Ordered list",
      Icon: ListOrdered,
      isActive: () => editor.isActive("orderedList"),
      onClick: () => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      label: "Quote",
      Icon: Quote,
      isActive: () => editor.isActive("blockquote"),
      onClick: () => editor.chain().focus().toggleBlockquote().run(),
    },
  ];

  return (
    <nav
      aria-label="Formatting"
      className="flex flex-wrap gap-1 rounded-full border border-border bg-background p-1"
    >
      {buttons.map((b) => (
        <button
          key={b.label}
          type="button"
          aria-label={b.label}
          aria-pressed={b.isActive()}
          onClick={b.onClick}
          className={cn(
            "inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground",
            b.isActive() && "bg-muted text-foreground",
          )}
        >
          <b.Icon className="h-4 w-4" />
        </button>
      ))}
    </nav>
  );
}

function DocSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-8 w-1/3 animate-pulse rounded-full bg-muted" />
      <div className="h-12 w-2/3 animate-pulse rounded-full bg-muted" />
      <div className="h-9 w-full animate-pulse rounded-full bg-muted" />
      <div className="h-64 w-full animate-pulse rounded-3xl bg-muted/40" />
    </div>
  );
}

function timeAgo(ts: number): string {
  const sec = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}
