"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { Settings } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { ViewTabs, type ViewKey, isViewKey } from "./view-tabs";
import { ListView } from "./views/list-view";
import { BoardView } from "./views/board-view";
import { CalendarView } from "./views/calendar-view";
import { GanttView } from "./views/gantt-view";

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

  const view: ViewKey = isViewKey(initialView) ? initialView : "list";

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

  const topLevelTasks = tasks
    .filter((t) => !t.parentTaskId)
    .sort((a, b) => a.position - b.position);

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            {list.name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {topLevelTasks.length} task{topLevelTasks.length === 1 ? "" : "s"}
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
