"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import { Settings, X } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { ViewTabs, type ViewKey, isViewKey } from "./view-tabs";
import { ListView } from "./views/list-view";
import { BoardView } from "./views/board-view";
import { CalendarView } from "./views/calendar-view";
import { GanttView } from "./views/gantt-view";

// Quick filters, persisted in the URL (?f=mine,active,blocked&pri=high) so
// a filtered view is shareable and survives reload. Applied in one place
// here so all four views (List/Board/Calendar/Gantt) stay consistent.
type Flag = "mine" | "unassigned" | "active" | "blocked" | "approval";

const FLAGS: { key: Flag; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "mine", label: "Mine" },
  { key: "unassigned", label: "Unassigned" },
  { key: "blocked", label: "Blocked" },
  { key: "approval", label: "Needs approval" },
];

const PRIORITIES = ["urgent", "high", "normal", "low"] as const;

export function ListPage({
  listId,
  initialView,
}: {
  listId: string;
  initialView?: string;
}) {
  const id = listId as Id<"lists">;
  const list = useQuery(api.lists.get, { listId: id });
  const tasks = useQuery(api.tasks.listForList, { listId: id });
  const statuses = useQuery(api.listStatuses.listForList, { listId: id });
  const fields = useQuery(api.customFields.listForList, { listId: id });
  const { user } = useUser();
  const searchParams = useSearchParams();

  const view: ViewKey = isViewKey(initialView) ? initialView : "list";

  const activeFlags = useMemo(
    () => new Set((searchParams.get("f") ?? "").split(",").filter(Boolean)),
    [searchParams],
  );
  const priorityFilter = searchParams.get("pri") ?? "";

  if (
    list === undefined ||
    tasks === undefined ||
    statuses === undefined ||
    fields === undefined
  ) {
    return <PageSkeleton />;
  }

  if (list === null) {
    return (
      <div className="rounded-2xl border border-border bg-muted/30 p-10 text-center">
        <p className="text-sm text-muted-foreground">
          This list doesn&apos;t exist or you don&apos;t have access to it.
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

  const allTop = tasks
    .filter((t) => !t.parentTaskId)
    .sort((a, b) => a.position - b.position);

  const doneStatusIds = new Set(
    statuses
      .filter((s) => s.category === "complete" || s.category === "closed")
      .map((s) => s._id),
  );
  const topLevelTasks = applyFilters(
    allTop,
    activeFlags,
    priorityFilter,
    doneStatusIds,
    user?.id,
  );
  const filtered = topLevelTasks.length !== allTop.length;

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            {list.name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {filtered
              ? `${topLevelTasks.length} of ${allTop.length} task${allTop.length === 1 ? "" : "s"}`
              : `${allTop.length} task${allTop.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <Link
          href={`/dashboard/l/${list._id}/settings`}
          className="inline-flex h-9 items-center gap-1 rounded-full border border-border bg-background px-3 text-sm hover:bg-muted"
        >
          <Settings className="h-4 w-4" /> Settings
        </Link>
      </header>

      <ViewTabs listId={list._id} active={view} />

      <FilterBar activeFlags={activeFlags} priority={priorityFilter} />

      {view === "list" && (
        <ListView
          listId={list._id}
          tasks={topLevelTasks}
          statuses={statuses}
          fields={fields}
        />
      )}
      {view === "board" && (
        <BoardView
          listId={list._id}
          tasks={topLevelTasks}
          statuses={statuses}
        />
      )}
      {view === "calendar" && (
        <CalendarView listId={list._id} tasks={topLevelTasks} />
      )}
      {view === "gantt" && (
        <GanttView listId={list._id} tasks={topLevelTasks} statuses={statuses} />
      )}
    </div>
  );
}

function applyFilters(
  tasks: Doc<"tasks">[],
  flags: Set<string>,
  priority: string,
  doneStatusIds: Set<Id<"listStatuses">>,
  myId: string | undefined,
): Doc<"tasks">[] {
  return tasks.filter((t) => {
    if (flags.has("active") && doneStatusIds.has(t.statusId)) return false;
    if (flags.has("mine") && (!myId || !t.assigneeClerkIds.includes(myId)))
      return false;
    if (flags.has("unassigned") && t.assigneeClerkIds.length > 0) return false;
    if (flags.has("blocked") && (t.blockedByTaskIds ?? []).length === 0)
      return false;
    if (flags.has("approval") && !(t.requiresApproval && !t.approvedAt))
      return false;
    if (priority && t.priority !== priority) return false;
    return true;
  });
}

// URL-driven filter chips. Toggling rewrites ?f= and ?pri= (via replace, so
// filtering doesn't spam history) — the whole state lives in the link.
function FilterBar({
  activeFlags,
  priority,
}: {
  activeFlags: Set<string>;
  priority: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function commit(next: URLSearchParams) {
    const qs = next.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  }
  function toggleFlag(key: Flag) {
    const next = new URLSearchParams(searchParams.toString());
    const set = new Set(activeFlags);
    if (set.has(key)) set.delete(key);
    else set.add(key);
    if (set.size) next.set("f", [...set].join(","));
    else next.delete("f");
    commit(next);
  }
  function setPriority(p: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (p) next.set("pri", p);
    else next.delete("pri");
    commit(next);
  }
  function clearAll() {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("f");
    next.delete("pri");
    commit(next);
  }

  const any = activeFlags.size > 0 || !!priority;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {FLAGS.map((f) => {
        const on = activeFlags.has(f.key);
        return (
          <button
            key={f.key}
            type="button"
            onClick={() => toggleFlag(f.key)}
            aria-pressed={on}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              on
                ? "border-transparent bg-foreground text-background"
                : "border-border bg-background text-muted-foreground hover:text-foreground",
            )}
          >
            {f.label}
          </button>
        );
      })}
      <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
      {PRIORITIES.map((p) => {
        const on = priority === p;
        return (
          <button
            key={p}
            type="button"
            onClick={() => setPriority(on ? "" : p)}
            aria-pressed={on}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium capitalize transition-colors",
              on
                ? "border-transparent bg-foreground text-background"
                : "border-border bg-background text-muted-foreground hover:text-foreground",
            )}
          >
            {p}
          </button>
        );
      })}
      {any && (
        <button
          type="button"
          onClick={clearAll}
          className="tap-target inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <X className="h-3 w-3" /> Clear
        </button>
      )}
    </div>
  );
}

// Shaped like the loaded page: title, view tabs, then a table with header
// and rows — so the layout doesn't jump when data lands.
function PageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-8 w-1/3 animate-pulse rounded-full bg-muted" />
      <div className="flex gap-1 rounded-full border border-border p-1">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-7 w-20 animate-pulse rounded-full bg-muted/60"
          />
        ))}
      </div>
      <div className="overflow-hidden rounded-2xl border border-border">
        <div className="h-9 animate-pulse bg-muted/50" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="flex items-center gap-3 border-t border-border px-3 py-2.5"
          >
            <div className="h-5 w-5 animate-pulse rounded-full bg-muted" />
            <div
              className="h-4 animate-pulse rounded-full bg-muted/70"
              style={{ width: `${55 - i * 8}%` }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
