"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Bot,
  CornerDownLeft,
  FileText,
  Home,
  Inbox,
  LayoutGrid,
  List,
  Plus,
  Search,
  Sparkles,
  SquareCheck,
  Users,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { parseQuickAdd } from "@/lib/quick-add";
import { setTheme } from "@/components/theme-toggle";
import { useToast } from "@/components/toast";
import { AnimatePresence, EASE, motion } from "@/components/motion";

// ⌘K command palette: jump to any list/doc/board/workspace/agent, search
// tasks by title, or create a task without leaving the keyboard. Mounted
// once in the dashboard layout; other components can open it by
// dispatching the "open-command-palette" window event.

type Item = {
  key: string;
  group: string;
  label: string;
  hint?: string;
  icon?: React.ComponentType<{ className?: string }>;
  run: () => void | Promise<void>;
};

export function CommandPalette() {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  // null = normal mode; a string = "new task" mode with that title,
  // where the input now filters lists to create the task in.
  const [createTitle, setCreateTitle] = useState<string | null>(null);
  // "New doc/whiteboard/list" flows: pick a space, then (lists only) a name.
  const [spacePick, setSpacePick] = useState<"doc" | "board" | "list" | null>(
    null,
  );
  const [listNameSpace, setListNameSpace] = useState<Id<"spaces"> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const tree = useQuery(api.sidebar.tree, open ? {} : "skip");
  const agents = useQuery(api.agents.listForCurrentUser, open ? {} : "skip");
  const taskHits = useQuery(
    api.tasks.quickSearch,
    open && createTitle === null && query.trim().length >= 2
      ? { text: query }
      : "skip",
  );
  const createTask = useMutation(api.tasks.create);
  const createDoc = useMutation(api.docs.create);
  const createWhiteboard = useMutation(api.whiteboards.create);
  const createList = useMutation(api.lists.create);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setCreateTitle(null);
    setSpacePick(null);
    setListNameSpace(null);
  }, []);

  // Global shortcuts: ⌘K / Ctrl+K toggles; "open-command-palette" event
  // (sidebar search button) opens.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery("");
        setCreateTitle(null);
      }
    }
    function onOpenEvent() {
      setOpen(true);
      setQuery("");
      setCreateTitle(null);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("open-command-palette", onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("open-command-palette", onOpenEvent);
    };
  }, []);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);
  useEffect(
    () => setHighlight(0),
    [query, open, createTitle, spacePick, listNameSpace],
  );

  // Every list in the tree, used both for navigation and for the
  // create-task list picker.
  const allLists = useMemo(() => {
    if (!tree) return [];
    const out: { id: Id<"lists">; name: string; place: string }[] = [];
    const spaces = [
      ...(tree.personal ? [{ space: tree.personal, place: "Personal" }] : []),
      ...tree.workspaces.flatMap((w) =>
        w.spaces.map((s) => ({ space: s, place: w.name })),
      ),
    ];
    for (const { space, place } of spaces) {
      for (const l of space.lists) {
        out.push({ id: l._id, name: l.name, place: `${place} · ${space.name}` });
      }
      for (const f of space.folders) {
        for (const l of f.lists) {
          out.push({
            id: l._id,
            name: l.name,
            place: `${place} · ${f.name}`,
          });
        }
      }
    }
    return out;
  }, [tree]);

  const allSpaces = useMemo(() => {
    if (!tree) return [];
    const out: { id: Id<"spaces">; name: string; place: string }[] = [];
    if (tree.personal)
      out.push({ id: tree.personal._id, name: tree.personal.name, place: "Personal" });
    for (const w of tree.workspaces)
      for (const sp of w.spaces)
        out.push({ id: sp._id, name: sp.name, place: w.name });
    return out;
  }, [tree]);

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const nav = (href: string) => () => {
      router.push(href);
      close();
    };

    // ── Create mode: the list picker. The title runs through the
    //    quick-add grammar ("tomorrow", "!high") so dates and priority
    //    typed in the title become real fields. ──
    if (createTitle !== null) {
      const parsed = parseQuickAdd(createTitle);
      const extras = parsed.matched.map((m) => m.label).join(" · ");
      const group = `New task: “${parsed.title || createTitle}”${extras ? ` · ${extras}` : ""}`;
      return allLists
        .filter((l) => !q || l.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((l) => ({
          key: `create-${l.id}`,
          group,
          label: l.name,
          hint: l.place,
          icon: List,
          run: async () => {
            const taskId = await createTask({
              listId: l.id,
              title: parsed.title || createTitle,
              dueDate: parsed.dueDate,
              priority: parsed.priority,
            });
            close();
            toast(`Task created in ${l.name}`);
            router.push(`/dashboard/l/${l.id}/t/${taskId}`);
          },
        }));
    }

    // ── Space picker for New doc / whiteboard / list ──
    if (spacePick !== null) {
      const label =
        spacePick === "doc"
          ? "New doc in…"
          : spacePick === "board"
            ? "New whiteboard in…"
            : "New list in…";
      return allSpaces
        .filter((sp) => !q || sp.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((sp) => ({
          key: `space-${sp.id}`,
          group: label,
          label: sp.name,
          hint: sp.place,
          icon: Home,
          run: async () => {
            if (spacePick === "doc") {
              const docId = await createDoc({
                parentType: "space",
                parentId: sp.id,
                title: "Untitled",
              });
              close();
              router.push(`/dashboard/d/${docId}`);
            } else if (spacePick === "board") {
              const wbId = await createWhiteboard({
                parentType: "space",
                parentId: sp.id,
                title: "Untitled board",
              });
              close();
              router.push(`/dashboard/wb/${wbId}`);
            } else {
              setSpacePick(null);
              setListNameSpace(sp.id);
              setQuery("");
            }
          },
        }));
    }

    // ── List-name step: no items; Enter creates. ──
    if (listNameSpace !== null) return [];

    // ── Normal mode ──
    const out: Item[] = [];
    const match = (label: string) => !q || label.toLowerCase().includes(q);

    const statics: Item[] = [
      { key: "home", group: "Go to", label: "Home", icon: Home, run: nav("/dashboard") },
      { key: "my-work", group: "Go to", label: "My work", icon: SquareCheck, run: nav("/dashboard/my-work") },
      { key: "inbox", group: "Go to", label: "Inbox", icon: Inbox, run: nav("/dashboard/inbox") },
      { key: "personal", group: "Go to", label: "Personal space", icon: Home, run: nav("/dashboard/personal") },
      { key: "agents", group: "Go to", label: "Agents", icon: Bot, run: nav("/dashboard/agents") },
      { key: "brain", group: "Go to", label: "Brain", icon: Sparkles, run: nav("/dashboard/brain") },
    ];
    out.push(...statics.filter((s) => match(s.label)));

    for (const w of tree?.workspaces ?? []) {
      if (!match(w.name)) continue;
      out.push({
        key: `ws-${w._id}`,
        group: "Workspaces",
        label: w.name,
        icon: Users,
        run: nav(`/dashboard/w/${w._id}`),
      });
    }

    for (const l of allLists) {
      if (!match(l.name)) continue;
      out.push({
        key: `list-${l.id}`,
        group: "Lists",
        label: l.name,
        hint: l.place,
        icon: List,
        run: nav(`/dashboard/l/${l.id}`),
      });
    }

    const spaces = [
      ...(tree?.personal ? [tree.personal] : []),
      ...(tree?.workspaces.flatMap((w) => w.spaces) ?? []),
    ];
    for (const s of spaces) {
      for (const d of s.docs) {
        if (!match(d.title)) continue;
        out.push({
          key: `doc-${d._id}`,
          group: "Docs",
          label: d.title,
          hint: s.name,
          icon: FileText,
          run: nav(`/dashboard/d/${d._id}`),
        });
      }
      for (const wb of s.whiteboards) {
        if (!match(wb.title)) continue;
        out.push({
          key: `wb-${wb._id}`,
          group: "Whiteboards",
          label: wb.title,
          hint: s.name,
          icon: LayoutGrid,
          run: nav(`/dashboard/wb/${wb._id}`),
        });
      }
    }

    const allAgents = agents
      ? [...agents.personal, ...agents.workspaces.flatMap((w) => w.agents)]
      : [];
    for (const a of allAgents) {
      if (!match(a.name)) continue;
      out.push({
        key: `agent-${a._id}`,
        group: "Agents",
        label: a.name,
        icon: Bot,
        run: nav(`/dashboard/agents/${a._id}`),
      });
    }

    for (const t of taskHits ?? []) {
      out.push({
        key: `task-${t.taskId}`,
        group: "Tasks",
        label: t.title,
        hint: t.listName,
        icon: SquareCheck,
        run: nav(`/dashboard/l/${t.listId}/t/${t.taskId}`),
      });
    }

    // Creation + theme actions, reachable by name.
    const actionItems: Item[] = [
      {
        key: "new-doc",
        group: "Actions",
        label: "New doc…",
        icon: FileText,
        run: () => {
          setSpacePick("doc");
          setQuery("");
        },
      },
      {
        key: "new-wb",
        group: "Actions",
        label: "New whiteboard…",
        icon: LayoutGrid,
        run: () => {
          setSpacePick("board");
          setQuery("");
        },
      },
      {
        key: "new-list",
        group: "Actions",
        label: "New list…",
        icon: List,
        run: () => {
          setSpacePick("list");
          setQuery("");
        },
      },
      {
        key: "theme-light",
        group: "Actions",
        label: "Theme: light",
        icon: Sparkles,
        run: () => {
          setTheme("light");
          close();
        },
      },
      {
        key: "theme-dark",
        group: "Actions",
        label: "Theme: dark",
        icon: Sparkles,
        run: () => {
          setTheme("dark");
          close();
        },
      },
      {
        key: "theme-system",
        group: "Actions",
        label: "Theme: follow system",
        icon: Sparkles,
        run: () => {
          setTheme("system");
          close();
        },
      },
    ];
    out.push(...actionItems.filter((a) => match(a.label)));

    // Quick-create is always reachable; with text typed it carries the text
    // through as the task title. When nothing strongly matches what was
    // typed, creating IS the primary intent, so it goes first and plain
    // Enter creates. (⌘Enter always creates, regardless of highlight.)
    const createItem: Item = {
      key: "new-task",
      group: "Actions",
      label: q ? `New task “${query.trim()}”` : "New task…",
      hint: q ? "⌘↵" : undefined,
      icon: Plus,
      run: () => {
        setCreateTitle(query.trim() || "");
        setQuery("");
      },
    };
    const strongMatch =
      !q || out.some((item) => item.label.toLowerCase().startsWith(q));
    if (strongMatch) out.push(createItem);
    else out.unshift(createItem);

    return out.slice(0, 24);
  }, [
    query,
    createTitle,
    spacePick,
    listNameSpace,
    tree,
    agents,
    taskHits,
    allLists,
    allSpaces,
    router,
    close,
    createTask,
    createDoc,
    createWhiteboard,
    toast,
  ]);

  function onInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Naming a new list: Enter creates it in the picked space.
      if (listNameSpace !== null) {
        const name = query.trim();
        if (!name) return;
        void (async () => {
          const listId = await createList({
            name,
            parentType: "space",
            parentId: listNameSpace,
          });
          close();
          router.push(`/dashboard/l/${listId}`);
        })();
        return;
      }
      // ⌘Enter / Ctrl+Enter: create a task from the typed text, always.
      if (
        (e.metaKey || e.ctrlKey) &&
        createTitle === null &&
        spacePick === null
      ) {
        setCreateTitle(query.trim() || "");
        setQuery("");
        return;
      }
      // In create mode with no title yet, Enter locks in the title.
      if (createTitle === "" && query.trim()) {
        setCreateTitle(query.trim());
        setQuery("");
        return;
      }
      items[highlight]?.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (listNameSpace !== null) {
        setListNameSpace(null);
        setSpacePick("list");
        setQuery("");
      } else if (spacePick !== null) {
        setSpacePick(null);
        setQuery("");
      } else if (createTitle !== null) {
        setCreateTitle(null);
        setQuery("");
      } else {
        close();
      }
    }
  }

  // Keep the highlighted row in view while arrowing.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-highlighted="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const awaitingTitle = createTitle === "";

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[65] bg-foreground/30 backdrop-blur-sm"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="mx-auto mt-[12vh] w-[min(560px,calc(100vw-2rem))] overflow-hidden rounded-2xl bento shadow-2xl"
            role="dialog"
            aria-label="Command palette"
          >
            <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
              {awaitingTitle || createTitle ? (
                <Plus className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
              ) : (
                <Search className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
              )}
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={onInputKeyDown}
                placeholder={
                  awaitingTitle
                    ? "Task title… try “ship the deck tomorrow !high”"
                    : createTitle
                      ? "Pick a list…"
                      : listNameSpace !== null
                        ? "List name, then Enter…"
                        : spacePick !== null
                          ? "Pick a space…"
                          : "Search or jump to…"
                }
                className="w-full bg-transparent text-sm focus:outline-none"
              />
              <kbd className="hidden flex-shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground sm:block">
                esc
              </kbd>
            </div>

            <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-2">
              {awaitingTitle ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  Type the task title and press{" "}
                  <CornerDownLeft className="inline h-3 w-3" />, you&apos;ll
                  pick the list next.
                </p>
              ) : items.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  Nothing matches.
                </p>
              ) : (
                items.map((item, i) => {
                  const prev = items[i - 1];
                  const showGroup = !prev || prev.group !== item.group;
                  const Icon = item.icon;
                  return (
                    <div key={item.key}>
                      {showGroup && (
                        <p className="px-3 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          {item.group}
                        </p>
                      )}
                      <button
                        type="button"
                        data-highlighted={i === highlight}
                        onClick={() => item.run()}
                        onMouseMove={() => setHighlight(i)}
                        className={cn(
                          "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm",
                          i === highlight && "bg-muted",
                        )}
                      >
                        {Icon ? (
                          <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                        ) : null}
                        <span className="min-w-0 flex-1 truncate">
                          {item.label}
                        </span>
                        {item.hint && (
                          <span className="flex-shrink-0 truncate text-xs text-muted-foreground">
                            {item.hint}
                          </span>
                        )}
                        {i === highlight && (
                          <CornerDownLeft className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                        )}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
