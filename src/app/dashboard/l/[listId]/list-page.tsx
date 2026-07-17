"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { Plus, Settings, X } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { ViewTabs, type ViewKey, isViewKey } from "./view-tabs";
import { OverviewView } from "./views/overview-view";
import { ListView } from "./views/list-view";
import { BoardView } from "./views/board-view";
import { CalendarView } from "./views/calendar-view";
import { GanttView } from "./views/gantt-view";
import { TableView } from "./views/table-view";
import { WorkloadView } from "./views/workload-view";
import { TaskPeekPortal } from "@/components/dashboard/task-peek";
import { InlineCreate } from "@/components/dashboard/inline-create";
import { useToast } from "@/components/toast";

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

// Project health chip shown in the page header — same labels/colors as the
// Overview tab's Status card and the Home project cards, so the signal
// reads consistently everywhere it appears.
const PROJECT_STATUS_CHIP: Record<
  "on_track" | "at_risk" | "off_track" | "paused",
  { label: string; className: string }
> = {
  on_track: { label: "On track", className: "bg-pastel-green" },
  at_risk: { label: "At risk", className: "bg-pastel-yellow" },
  off_track: { label: "Off track", className: "bg-pastel-red" },
  paused: { label: "Paused", className: "bg-muted" },
};

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
      <header className="title-rule flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
              {list.name}
            </h1>
            {list.projectStatus && (
              <span
                className={cn(
                  "flex-shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium text-foreground",
                  PROJECT_STATUS_CHIP[list.projectStatus].className,
                )}
              >
                {PROJECT_STATUS_CHIP[list.projectStatus].label}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {filtered
              ? `${topLevelTasks.length} of ${allTop.length} task${allTop.length === 1 ? "" : "s"}`
              : `${allTop.length} task${allTop.length === 1 ? "" : "s"}`}
          </p>
          {list.description && (
            <p className="mt-1 max-w-xl truncate text-sm text-muted-foreground">
              {list.description}
            </p>
          )}
        </div>
        <Link
          href={`/dashboard/l/${list._id}/settings`}
          className="inline-flex h-9 items-center gap-1 rounded-full border border-border bg-background px-3 text-sm hover:bg-muted"
        >
          <Settings className="h-4 w-4" /> Settings
        </Link>
      </header>

      <ViewTabs listId={list._id} active={view} />

      <SavedViewsBar
        listId={list._id}
        view={view}
        flags={[...activeFlags].sort().join(",")}
        priority={priorityFilter}
      />

      <FilterBar activeFlags={activeFlags} priority={priorityFilter} />

      {view === "overview" && (
        <OverviewView
          listId={list._id}
          list={list}
          tasks={topLevelTasks}
          statuses={statuses}
        />
      )}
      {view === "list" && (
        <ListView
          listId={list._id}
          tasks={topLevelTasks}
          statuses={statuses}
          fields={fields}
          filtered={filtered}
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
      {view === "table" && (
        <TableView
          listId={list._id}
          tasks={topLevelTasks}
          statuses={statuses}
          fields={fields}
        />
      )}
      {view === "workload" && (
        <WorkloadView
          listId={list._id}
          tasks={topLevelTasks}
          statuses={statuses}
        />
      )}

      <TaskPeekPortal listId={list._id} />
    </div>
  );
}

// Saved views: named one-click presets of view + filters, shared with
// everyone on the list. The active chip reflects the current URL state.
function SavedViewsBar({
  listId,
  view,
  flags,
  priority,
}: {
  listId: Id<"lists">;
  view: ViewKey;
  flags: string;
  priority: string;
}) {
  const router = useRouter();
  const views = useQuery(api.savedViews.listForList, { listId });
  const create = useMutation(api.savedViews.create);
  const remove = useMutation(api.savedViews.remove);
  const { toast } = useToast();
  const [naming, setNaming] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  if (views === undefined) return null;
  const visible = views.filter((sv) => !hidden.has(sv._id));

  function hrefFor(sv: {
    view: string;
    flags?: string;
    priority?: string;
  }): string {
    const params = new URLSearchParams();
    if (sv.view !== "list") params.set("view", sv.view);
    if (sv.flags) params.set("f", sv.flags);
    if (sv.priority) params.set("pri", sv.priority);
    const qs = params.toString();
    return qs ? `/dashboard/l/${listId}?${qs}` : `/dashboard/l/${listId}`;
  }

  const isActive = (sv: { view: string; flags?: string; priority?: string }) =>
    sv.view === view &&
    (sv.flags ?? "") === flags &&
    (sv.priority ?? "") === priority;

  // Nothing saved and not naming: a single quiet affordance.
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {visible.length > 0 && (
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Views
        </span>
      )}
      {visible.map((sv) => {
        const active = isActive(sv);
        return (
          <span key={sv._id} className="group/sv relative inline-flex">
            <button
              type="button"
              onClick={() => router.replace(hrefFor(sv), { scroll: false })}
              aria-pressed={active}
              className={cn(
                "rounded-full px-3 py-1 pr-6 text-xs font-medium transition-colors",
                active
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              {sv.name}
            </button>
            <button
              type="button"
              aria-label={`Delete view ${sv.name}`}
              onClick={() => {
                setHidden((prev) => new Set([...prev, sv._id]));
                toast(`View "${sv.name}" deleted`, {
                  action: {
                    label: "Undo",
                    onClick: () =>
                      setHidden((prev) => {
                        const next = new Set(prev);
                        next.delete(sv._id);
                        return next;
                      }),
                  },
                  onExpire: () => remove({ savedViewId: sv._id }),
                });
              }}
              className={cn(
                "absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 opacity-0 transition-opacity group-hover/sv:opacity-100",
                active
                  ? "text-background/70 hover:text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        );
      })}
      {naming ? (
        <div className="w-44">
          <InlineCreate
            placeholder="View name…"
            onCancel={() => setNaming(false)}
            onSubmit={async (name) => {
              try {
                await create({
                  listId,
                  name,
                  view,
                  flags: flags || undefined,
                  priority: priority || undefined,
                });
                toast(`View "${name.trim()}" saved`);
              } catch (e) {
                const raw = e instanceof Error ? e.message : String(e);
                toast(
                  raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() ||
                    "Couldn't save view",
                  { kind: "error" },
                );
              }
              setNaming(false);
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setNaming(true)}
          className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3 w-3" /> Save view
        </button>
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
