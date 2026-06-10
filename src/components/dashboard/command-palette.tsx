"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { useUser } from "@clerk/nextjs";
import {
  CheckSquare,
  FileText,
  Inbox,
  LayoutGrid,
  List as ListIcon,
  Search,
  Sparkles,
  User,
  Wand2,
  X,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useToast } from "@/components/dashboard/toast";
import { cn } from "@/lib/utils";

// The command palette is the central piece of Pace's "speed" promise.
// Mounted in the dashboard layout. Exposes an open() through context so
// any component can pop it (the sidebar slot, the keyboard shortcut
// layer, programmatic triggers).
//
// Two modes: "search" (default — find any task/list/doc/person) and
// "commands" (a small fixed set: jump-to inbox, brain, etc.). Either
// is reachable from the same input.

type CommandPaletteContextValue = {
  open: () => void;
  close: () => void;
};

const CommandPaletteContext = createContext<CommandPaletteContextValue>({
  open: () => {},
  close: () => {},
});

export function useCommandPalette() {
  return useContext(CommandPaletteContext);
}

export function CommandPaletteProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const value = useMemo(
    () => ({ open: () => setOpen(true), close: () => setOpen(false) }),
    [],
  );

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      <CommandPalette open={open} onClose={() => setOpen(false)} />
    </CommandPaletteContext.Provider>
  );
}

type Hit =
  | { kind: "list"; id: Id<"lists">; name: string }
  | { kind: "task"; id: Id<"tasks">; title: string; listId: Id<"lists"> }
  | { kind: "doc"; id: Id<"docs">; title: string }
  | { kind: "whiteboard"; id: Id<"whiteboards">; title: string }
  | { kind: "person"; clerkId: string; name: string; email: string };

type CommandItem = {
  kind: "command";
  id: string;
  label: string;
  href: string;
  icon: typeof Inbox;
};

type QuickItem = { kind: "quick"; query: string };

const FALLBACK_COMMANDS: CommandItem[] = [
  { kind: "command", id: "home", label: "Go to Home", href: "/dashboard", icon: ListIcon },
  { kind: "command", id: "personal", label: "Go to Personal space", href: "/dashboard/personal", icon: ListIcon },
  { kind: "command", id: "inbox", label: "Go to Inbox", href: "/dashboard/inbox", icon: Inbox },
  { kind: "command", id: "brain", label: "Open Brain (AI search)", href: "/dashboard/brain", icon: Sparkles },
];

// Look at the current pathname to decide the scope for Quick Task. Any
// /dashboard/w/<id>/... route scopes to that workspace; everything else
// scopes to the user's personal space (lists under their personal space
// + assignment limited to themselves).
function workspaceIdFromPath(pathname: string | null): Id<"workspaces"> | null {
  if (!pathname) return null;
  const m = pathname.match(/^\/dashboard\/w\/([^/]+)/);
  return m ? (m[1] as Id<"workspaces">) : null;
}

function listIdFromPath(pathname: string | null): Id<"lists"> | null {
  if (!pathname) return null;
  const m = pathname.match(/^\/dashboard\/l\/([^/]+)/);
  return m ? (m[1] as Id<"lists">) : null;
}

function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useUser();
  const { showUndo } = useToast();
  const quickTask = useAction(api.ai.quickTask);
  const removeTask = useMutation(api.tasks.remove);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [quickPending, setQuickPending] = useState(false);

  const hits = useQuery(
    api.search.palette,
    open && query.trim().length > 0 ? { q: query, limit: 12 } : "skip",
  );

  const workspaceId = workspaceIdFromPath(pathname);
  const currentListId = listIdFromPath(pathname);

  const runQuickTask = useCallback(
    async (sentence: string) => {
      const trimmed = sentence.trim();
      if (!trimmed || quickPending) return;
      const meSubject = user?.id;
      if (!meSubject) return;
      setQuickPending(true);
      try {
        const result = await quickTask({
          prompt: trimmed,
          scopeType: workspaceId ? "workspace" : "user",
          scopeId: workspaceId ?? meSubject,
          currentListId: currentListId ?? undefined,
        });
        if (result.ok) {
          onClose();
          router.push(`/dashboard/l/${result.listId}/t/${result.taskId}`);
          showUndo({
            label: result.explanation
              ? `Added “${result.title}” — ${result.explanation}`
              : `Added “${result.title}”`,
            onUndo: () => removeTask({ taskId: result.taskId }),
          });
        } else {
          alert(result.error);
        }
      } finally {
        setQuickPending(false);
      }
    },
    [
      quickPending,
      user,
      workspaceId,
      currentListId,
      quickTask,
      onClose,
      router,
      showUndo,
      removeTask,
    ],
  );

  // Reset state on open/close.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(0);
      return;
    }
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Close on Esc; arrow-key + Enter navigation lives below.
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

  const items: (Hit | CommandItem | QuickItem)[] = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return FALLBACK_COMMANDS;
    const search = hits ?? [];
    // Show "Create task" once the query has enough signal to be useful
    // (3+ chars). It pins to the bottom so it doesn't push real matches
    // off the visible list.
    if (trimmed.length >= 3) {
      return [...search, { kind: "quick", query: trimmed } as QuickItem];
    }
    return search;
  }, [hits, query]);

  // Clamp the active index when the result set shrinks.
  useEffect(() => {
    if (activeIndex >= items.length) setActiveIndex(0);
  }, [items.length, activeIndex]);

  const navigate = useCallback(
    (item: Hit | CommandItem | QuickItem) => {
      if (item.kind === "quick") {
        runQuickTask(item.query);
        return;
      }
      const href = hrefForItem(item);
      if (!href) return;
      router.push(href);
      onClose();
    },
    [router, onClose, runQuickTask],
  );

  function onKeyDownInput(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(items.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = items[activeIndex];
      if (target) navigate(target);
    }
  }

  if (!open) return null;

  const loading = query.trim().length > 0 && hits === undefined;
  const empty =
    !loading && query.trim().length > 0 && (hits?.length ?? 0) === 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[10vh]"
    >
      <div
        aria-hidden
        onClick={onClose}
        className="absolute inset-0 bg-foreground/40 backdrop-blur-sm"
      />
      <div className="relative w-full max-w-xl overflow-hidden rounded-3xl border border-border bg-background shadow-2xl">
        <label className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Search className="h-4 w-4 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.currentTarget.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDownInput}
            placeholder="Search tasks, lists, docs, people…"
            className="flex-1 bg-transparent text-sm placeholder-muted-foreground focus:outline-none"
          />
          <kbd className="hidden rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline">
            ESC
          </kbd>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground sm:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </label>

        <div className="max-h-[50vh] overflow-y-auto">
          {loading && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              Searching…
            </p>
          )}
          {empty && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              No matches. Try a different word — or open{" "}
              <Link
                href="/dashboard/brain"
                onClick={onClose}
                className="font-medium text-brand-700 hover:underline"
              >
                Brain
              </Link>{" "}
              for an AI answer.
            </p>
          )}
          {!loading && items.length > 0 && (
            <ul ref={listRef} className="p-1">
              {items.map((item, i) => (
                <li key={keyForItem(item)}>
                  <button
                    type="button"
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => navigate(item)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left text-sm",
                      i === activeIndex
                        ? "bg-muted text-foreground"
                        : "text-foreground hover:bg-muted",
                    )}
                  >
                    <ItemIcon item={item} />
                    <ItemLabel
                      item={item}
                      pending={item.kind === "quick" && quickPending}
                    />
                    <span className="ml-auto text-xs text-muted-foreground">
                      {kindLabel(item)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border bg-muted/40 px-4 py-2 text-[11px] text-muted-foreground">
          <span>
            <kbd className="rounded border border-border bg-background px-1 font-mono">
              ↑
            </kbd>{" "}
            <kbd className="rounded border border-border bg-background px-1 font-mono">
              ↓
            </kbd>{" "}
            move ·{" "}
            <kbd className="rounded border border-border bg-background px-1 font-mono">
              ↵
            </kbd>{" "}
            select
          </span>
          <span>
            <kbd className="rounded border border-border bg-background px-1 font-mono">
              ?
            </kbd>{" "}
            shortcuts
          </span>
        </div>
      </div>
    </div>
  );
}

function ItemIcon({ item }: { item: Hit | CommandItem | QuickItem }) {
  if (item.kind === "quick") return <Wand2 className="h-4 w-4 text-accent-600" aria-hidden />;
  if (item.kind === "command") {
    const Icon = item.icon;
    return <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />;
  }
  if (item.kind === "list") return <ListIcon className="h-4 w-4 text-muted-foreground" aria-hidden />;
  if (item.kind === "task") return <CheckSquare className="h-4 w-4 text-muted-foreground" aria-hidden />;
  if (item.kind === "doc") return <FileText className="h-4 w-4 text-muted-foreground" aria-hidden />;
  if (item.kind === "whiteboard") return <LayoutGrid className="h-4 w-4 text-muted-foreground" aria-hidden />;
  return <User className="h-4 w-4 text-muted-foreground" aria-hidden />;
}

function ItemLabel({
  item,
  pending,
}: {
  item: Hit | CommandItem | QuickItem;
  pending: boolean;
}) {
  if (item.kind === "quick") {
    return (
      <span className="truncate">
        {pending ? "Creating…" : "Create task:"}{" "}
        <span className="font-medium text-foreground">{item.query}</span>
      </span>
    );
  }
  if (item.kind === "command") return <span className="truncate">{item.label}</span>;
  if (item.kind === "list") return <span className="truncate">{item.name}</span>;
  if (item.kind === "task") return <span className="truncate">{item.title}</span>;
  if (item.kind === "doc") return <span className="truncate">{item.title}</span>;
  if (item.kind === "whiteboard") return <span className="truncate">{item.title}</span>;
  return (
    <span className="truncate">
      {item.name}{" "}
      <span className="text-muted-foreground">— {item.email}</span>
    </span>
  );
}

function kindLabel(item: Hit | CommandItem | QuickItem): string {
  if (item.kind === "quick") return "AI";
  return item.kind === "command" ? "command" : item.kind;
}

function keyForItem(item: Hit | CommandItem | QuickItem): string {
  if (item.kind === "quick") return "quick";
  if (item.kind === "command") return `cmd:${item.id}`;
  if (item.kind === "person") return `person:${item.clerkId}`;
  return `${item.kind}:${item.id}`;
}

function hrefForItem(item: Hit | CommandItem): string | null {
  if (item.kind === "command") return item.href;
  if (item.kind === "list") return `/dashboard/l/${item.id}`;
  if (item.kind === "task") return `/dashboard/l/${item.listId}/t/${item.id}`;
  if (item.kind === "doc") return `/dashboard/d/${item.id}`;
  if (item.kind === "whiteboard") return `/dashboard/wb/${item.id}`;
  return null; // people: no profile route yet
}
