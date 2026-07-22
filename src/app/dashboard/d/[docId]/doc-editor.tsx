"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "convex/react";
import { useAction } from "convex/react";
import { useEditor, EditorContent, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Code,
  FileText,
  FolderTree,
  Heading1,
  Heading2,
  Italic,
  List,
  ListOrdered,
  Plus,
  Quote,
  Sparkles,
  Strikethrough,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import { useToast } from "@/components/toast";
import { AnimatePresence, motion } from "@/components/motion";

const SAVE_DEBOUNCE_MS = 800;
// Mirrors convex/docs.ts MAX_DOC_DEPTH — kept in sync manually since that
// file can't be imported client-side (it pulls in server-only builders).
const MAX_DOC_DEPTH = 3;

export function DocEditor({ docId }: { docId: string }) {
  const id = docId as Id<"docs">;
  const doc = useQuery(api.docs.get, { docId: id });
  const breadcrumbs = useQuery(api.docs.breadcrumbs, { docId: id });
  const children = useQuery(api.docs.children, { docId: id });
  const scopeDocs = useQuery(
    api.docs.listForParent,
    doc ? { parentType: doc.parentType, parentId: doc.parentId } : "skip",
  );
  const updateContent = useMutation(api.docs.updateContent);
  const rename = useMutation(api.docs.rename);
  const remove = useMutation(api.docs.remove);
  const createDoc = useMutation(api.docs.create);
  const moveDoc = useMutation(api.docs.move);
  const router = useRouter();
  const { toast } = useToast();

  const [title, setTitle] = useState("");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [addingSubpage, setAddingSubpage] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const moveTriggerRef = useRef<HTMLButtonElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentDepth = breadcrumbs?.length ?? 0;
  const atMaxDepth = currentDepth >= MAX_DOC_DEPTH;

  async function addSubpage() {
    if (!doc || addingSubpage) return;
    setAddingSubpage(true);
    try {
      const newId = await createDoc({
        parentType: doc.parentType,
        parentId: doc.parentId,
        parentDocId: id,
        title: "Untitled",
      });
      router.push(`/dashboard/d/${newId}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't add subpage", {
        kind: "error",
      });
    } finally {
      setAddingSubpage(false);
    }
  }

  async function moveTo(parentDocId: Id<"docs"> | null) {
    try {
      await moveDoc({ docId: id, parentDocId });
      setMoveOpen(false);
      toast("Moved");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't move doc", {
        kind: "error",
      });
    }
  }

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
      <div className="rounded-2xl border border-border bg-muted/30 p-10 text-center">
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
      <PageHeader
        icon={FileText}
        title={doc.title || "Untitled"}
        context={
          breadcrumbs && breadcrumbs.length > 0 ? (
            <nav
              aria-label="Breadcrumb"
              className="flex min-w-0 items-center gap-1.5 truncate"
            >
              {breadcrumbs.map((crumb) => (
                <span key={crumb._id} className="flex items-center gap-1.5">
                  <Link
                    href={`/dashboard/d/${crumb._id}`}
                    className="hover:text-foreground hover:underline"
                  >
                    {crumb.title}
                  </Link>
                  <span aria-hidden>/</span>
                </span>
              ))}
            </nav>
          ) : undefined
        }
        actions={
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {savedAt && <span>Saved {timeAgo(savedAt)}</span>}
            <button
              ref={moveTriggerRef}
              type="button"
              onClick={() => setMoveOpen((o) => !o)}
              className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <FolderTree className="h-3.5 w-3.5" /> Move
            </button>
            <button
              type="button"
              onClick={() => {
                router.push("/dashboard");
                toast("Doc deleted", {
                  action: {
                    label: "Undo",
                    onClick: () => router.push(`/dashboard/d/${id}`),
                  },
                  onExpire: () => remove({ docId: id }),
                });
              }}
              className="rounded-full px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Delete
            </button>
            <MoveMenu
              open={moveOpen}
              anchorRef={moveTriggerRef}
              onClose={() => setMoveOpen(false)}
              doc={doc}
              scopeDocs={scopeDocs}
              onMove={moveTo}
            />
          </div>
        }
      />

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

      <div className="flex flex-wrap items-center gap-2">
        {children?.map((child) => (
          <Link
            key={child._id}
            href={`/dashboard/d/${child._id}`}
            className="inline-flex items-center rounded-full border border-border px-3 py-1 text-xs font-medium text-foreground/80 hover:bg-muted"
          >
            {child.title}
          </Link>
        ))}
        <button
          type="button"
          onClick={addSubpage}
          disabled={addingSubpage || atMaxDepth}
          title={atMaxDepth ? "Maximum nesting depth reached" : undefined}
          className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <Plus className="h-3 w-3" /> Subpage
        </button>
      </div>

      <Toolbar editor={editor} />
      <div className="panel rounded-xl p-6">
        <EditorContent editor={editor} />
      </div>
      <AiWriterRow editor={editor} />
    </div>
  );
}

// ── Move menu ───────────────────────────────────────────────────────────
//
// Portals to <body> and anchors to the trigger's live bounding rect —
// mirrors the portal-popover pattern used elsewhere in the dashboard so
// the popover escapes any clipping/scroll region the doc page sits in.

function docDepthWithin(all: Doc<"docs">[], docId: Id<"docs">): number {
  const byId = new Map(all.map((d) => [d._id, d]));
  let depth = 0;
  let current = byId.get(docId);
  let hops = 0;
  while (current?.parentDocId && hops < 10) {
    const parent = byId.get(current.parentDocId);
    if (!parent) break;
    depth++;
    current = parent;
    hops++;
  }
  return depth;
}

function isDescendantWithin(
  all: Doc<"docs">[],
  candidateId: Id<"docs">,
  ancestorId: Id<"docs">,
): boolean {
  const byId = new Map(all.map((d) => [d._id, d]));
  let current = byId.get(candidateId);
  let hops = 0;
  while (current?.parentDocId && hops < 10) {
    if (current.parentDocId === ancestorId) return true;
    current = byId.get(current.parentDocId);
    hops++;
  }
  return false;
}

function MoveMenu({
  open,
  anchorRef,
  onClose,
  doc,
  scopeDocs,
  onMove,
}: {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  doc: Doc<"docs">;
  scopeDocs: Doc<"docs">[] | undefined;
  onMove: (parentDocId: Id<"docs"> | null) => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!open) return;
    function update() {
      setRect(anchorRef.current?.getBoundingClientRect() ?? null);
    }
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  const candidates = (scopeDocs ?? []).filter(
    (d) =>
      d._id !== doc._id &&
      !isDescendantWithin(scopeDocs ?? [], d._id, doc._id) &&
      docDepthWithin(scopeDocs ?? [], d._id) < MAX_DOC_DEPTH,
  );

  return createPortal(
    <AnimatePresence>
      {open && rect && (
        <>
          <div
            aria-hidden
            className="fixed inset-0 z-[60]"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            style={{ top: rect.bottom + 6, left: rect.left }}
            className="fixed z-[61] max-h-72 w-64 overflow-auto rounded-xl border border-border bg-background p-1 shadow-lg"
          >
            <button
              type="button"
              onClick={() => onMove(null)}
              disabled={!doc.parentDocId}
              className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-foreground/90 hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
            >
              Top level
            </button>
            {candidates.length > 0 && (
              <div className="my-1 h-px bg-border" />
            )}
            {candidates.map((c) => (
              <button
                key={c._id}
                type="button"
                onClick={() => onMove(c._id)}
                disabled={c._id === doc.parentDocId}
                className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-foreground/90 hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
              >
                <span className="truncate">{c.title}</span>
              </button>
            ))}
            {candidates.length === 0 && (
              <p className="px-2.5 py-1.5 text-xs text-muted-foreground">
                No other pages in this scope.
              </p>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
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
      className="sticky top-2 z-10 flex flex-wrap gap-1 rounded-full border border-border bg-background/80 p-1 backdrop-blur"
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
      <div className="-mx-4 flex min-h-[52px] items-center gap-2.5 border-b border-border py-2 sm:-mx-6 sm:px-6">
        <div className="h-4 w-4 animate-pulse rounded-full bg-muted" />
        <div className="h-4 w-32 animate-pulse rounded-full bg-muted" />
      </div>
      <div className="h-12 w-2/3 animate-pulse rounded-full bg-muted" />
      <div className="h-9 w-full animate-pulse rounded-full bg-muted" />
      <div className="h-64 w-full animate-pulse rounded-xl bg-muted/40" />
    </div>
  );
}

