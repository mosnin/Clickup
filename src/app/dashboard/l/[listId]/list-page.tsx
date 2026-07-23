"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { Folder, Plus, Settings, Star, X } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/dashboard/page-header";
import { ViewTabs, type ViewKey, isViewKey } from "./view-tabs";
import { OverviewView } from "./views/overview-view";
import { ListView } from "./views/list-view";
import { BoardView } from "./views/board-view";
import { CalendarView } from "./views/calendar-view";
import { GanttView } from "./views/gantt-view";
import { TimelineView } from "./views/timeline-view";
import { TableView } from "./views/table-view";
import { WorkloadView } from "./views/workload-view";
import { NetworkView } from "./views/network-view";
import { TaskPeekPortal } from "@/components/dashboard/task-peek";
import { InlineCreate } from "@/components/dashboard/inline-create";
import { Picker } from "@/components/ui/picker";
import { useToast } from "@/components/toast";
import { useListScope } from "./use-list-scope";

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
  on_track: {
    label: "On track",
    className: "bg-pastel-green dark:text-neutral-900",
  },
  at_risk: {
    label: "At risk",
    className: "bg-pastel-yellow dark:text-neutral-900",
  },
  off_track: {
    label: "Off track",
    className: "bg-pastel-red dark:text-neutral-900",
  },
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
  const isFavorited = useQuery(api.favorites.isFavorite, {
    entityType: "list",
    entityId: id,
  });
  const toggleFavorite = useMutation(api.favorites.toggle);
  const { user } = useUser();
  const { toast } = useToast();
  const searchParams = useSearchParams();

  // Without an explicit ?view= the list's configured default view wins.
  // Fallback only — the URL is never rewritten on load.
  const configuredDefault = list?.defaultView;
  const defaultView: ViewKey = isViewKey(configuredDefault)
    ? configuredDefault
    : "list";
  const view: ViewKey = isViewKey(initialView) ? initialView : defaultView;

  const activeFlags = useMemo(
    () => new Set((searchParams.get("f") ?? "").split(",").filter(Boolean)),
    [searchParams],
  );
  const priorityFilter = searchParams.get("pri") ?? "";
  // Overview and Network both render the list's full, unfiltered task set
  // (Overview's stats are meant to reflect the whole project; Network needs
  // every dependency edge, subtasks included, to draw the graph) — so the
  // quick filters below have no effect on either. Hide the filter bar there
  // instead of leaving controls that silently do nothing.
  const filtersApply = view !== "overview" && view !== "network";

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
  // "Blocked" means "has a blocker that is still open" (matches
  // task-badges and the server's openBlockers), not "ever had a blocker".
  // Resolve same-list blockers against the already-loaded tasks (the full
  // set, subtasks included — a blocker can be any task); blocker ids not
  // found in this list are cross-list and count conservatively as open.
  const listTaskIds = new Set<Id<"tasks">>(tasks.map((t) => t._id));
  const openTaskIds = new Set<Id<"tasks">>(
    tasks.filter((t) => !doneStatusIds.has(t.statusId)).map((t) => t._id),
  );
  const topLevelTasks = applyFilters(
    allTop,
    activeFlags,
    priorityFilter,
    doneStatusIds,
    listTaskIds,
    openTaskIds,
    user?.id,
  );
  // Only claim "filtered" (and show the narrower count) on views that
  // actually apply these filters — Overview/Network always render allTop.
  const filtered = filtersApply && topLevelTasks.length !== allTop.length;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Folder}
        title={list.name}
        context={
          <>
            {list.projectStatus && (
              <Badge
                variant="outline"
                className={cn(
                  "flex-shrink-0 border-transparent text-foreground",
                  PROJECT_STATUS_CHIP[list.projectStatus].className,
                )}
              >
                {PROJECT_STATUS_CHIP[list.projectStatus].label}
              </Badge>
            )}
            <span className="flex-shrink-0">
              {filtered
                ? `${topLevelTasks.length} of ${allTop.length} task${allTop.length === 1 ? "" : "s"}`
                : `${allTop.length} task${allTop.length === 1 ? "" : "s"}`}
            </span>
            {list.description && (
              <span className="truncate" title={list.description}>
                {list.description}
              </span>
            )}
          </>
        }
        actions={
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={
                isFavorited ? "Remove from favorites" : "Add to favorites"
              }
              aria-pressed={!!isFavorited}
              onClick={async () => {
                try {
                  const result = await toggleFavorite({
                    entityType: "list",
                    entityId: list._id,
                  });
                  toast(
                    result.favorited
                      ? "Added to favorites"
                      : "Removed from favorites",
                  );
                } catch {
                  toast("Couldn't update favorites", { kind: "error" });
                }
              }}
              className={cn(
                "tap-target",
                isFavorited ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <Star
                className={cn("h-4 w-4", isFavorited && "fill-current")}
                aria-hidden
              />
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/dashboard/l/${list._id}/settings`}>
                <Settings className="h-4 w-4" />
                Settings
              </Link>
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 pt-1 pb-3">
          <ViewTabs listId={list._id} active={view} defaultView={defaultView} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <SavedViewsBar
              listId={list._id}
              view={view}
              flags={[...activeFlags].sort().join(",")}
              priority={priorityFilter}
            />
            {filtersApply && (
              <FilterBar activeFlags={activeFlags} priority={priorityFilter} />
            )}
            <BlueprintQuickCreate listId={list._id} />
          </div>
        </div>
      </PageHeader>

      {view === "overview" && (
        <OverviewView
          listId={list._id}
          list={list}
          tasks={allTop}
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
      {view === "timeline" && (
        <TimelineView
          listId={list._id}
          tasks={topLevelTasks}
          statuses={statuses}
        />
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
      {view === "network" && (
        <NetworkView listId={list._id} tasks={allTop} statuses={statuses} />
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
    // Always explicit: a bare URL falls back to the list's default view,
    // which may not be the view this preset saved.
    params.set("view", sv.view);
    if (sv.flags) params.set("f", sv.flags);
    if (sv.priority) params.set("pri", sv.priority);
    return `/dashboard/l/${listId}?${params.toString()}`;
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

// Instantiate a saved task blueprint into this list — hidden entirely when
// the scope has none, so the row stays quiet until blueprints exist.
function BlueprintQuickCreate({ listId }: { listId: Id<"lists"> }) {
  const scope = useListScope(listId);
  const blueprints = useQuery(
    api.taskBlueprints.listForScope,
    scope ?? "skip",
  );
  const instantiate = useMutation(api.taskBlueprints.instantiate);
  const { toast } = useToast();

  if (!blueprints || blueprints.length === 0) return null;

  return (
    <Picker
      dashed
      label="New from blueprint…"
      options={blueprints.map((b) => ({ id: b._id, label: b.name }))}
      onSelect={async (id) => {
        const bp = blueprints.find((b) => b._id === id);
        try {
          await instantiate({
            blueprintId: id as Id<"taskBlueprints">,
            listId,
          });
          toast(bp ? `Task created from "${bp.name}"` : "Task created");
        } catch (e) {
          const raw = e instanceof Error ? e.message : String(e);
          toast(
            raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() ||
              "Couldn't create the task",
            { kind: "error" },
          );
        }
      }}
    />
  );
}

function applyFilters(
  tasks: Doc<"tasks">[],
  flags: Set<string>,
  priority: string,
  doneStatusIds: Set<Id<"listStatuses">>,
  listTaskIds: Set<Id<"tasks">>,
  openTaskIds: Set<Id<"tasks">>,
  myId: string | undefined,
): Doc<"tasks">[] {
  // A task is blocked only while at least one of its blockers is still
  // open. Same-list blockers resolve against the loaded data; a blocker
  // id we can't see here lives in another list — treat it as open rather
  // than silently un-blocking the task.
  const hasOpenBlocker = (t: Doc<"tasks">) =>
    (t.blockedByTaskIds ?? []).some((id) =>
      listTaskIds.has(id) ? openTaskIds.has(id) : true,
    );
  return tasks.filter((t) => {
    if (flags.has("active") && doneStatusIds.has(t.statusId)) return false;
    if (flags.has("mine") && (!myId || !t.assigneeClerkIds.includes(myId)))
      return false;
    if (flags.has("unassigned") && t.assigneeClerkIds.length > 0) return false;
    if (flags.has("blocked") && !hasOpenBlocker(t)) return false;
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
