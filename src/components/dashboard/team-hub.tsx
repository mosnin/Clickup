"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { Timer } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { formatDurationCoarse } from "@/lib/duration";

export function TeamHub({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const members = useQuery(api.team.hub, { workspaceId });

  if (members === undefined) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-3xl bg-muted/40" />
        ))}
      </div>
    );
  }
  if (members === null) {
    return (
      <div className="rounded-3xl border border-border bg-muted/30 p-10 text-center text-sm text-muted-foreground">
        You don&apos;t have access to this workspace&apos;s team.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {members.length} member{members.length === 1 ? "" : "s"} ·{" "}
        {members.filter((m) => m.running).length} currently tracking time
      </p>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {members.map((m) => (
          <li
            key={m.clerkId}
            className="rounded-3xl border border-border bg-background p-4"
          >
            <div className="flex items-start gap-3">
              <Avatar name={m.name} clerkId={m.clerkId} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-medium">{m.name}</span>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {m.role}
                  </span>
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {m.email}
                </p>
              </div>
            </div>

            <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
              <Stat label="Open" value={m.openTasks} />
              <Stat label="Done · 7d" value={m.completedThisWeek} />
              <Stat
                label="Tracked · 7d"
                value={formatDurationCoarse(m.trackedThisWeekMs)}
              />
            </dl>

            {m.running && <RunningPill running={m.running} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RunningPill({
  running,
}: {
  running: { taskId: Id<"tasks">; taskTitle: string; startedAt: number };
}) {
  const location = useQuery(api.tasks.resolveLocation, {
    taskId: running.taskId,
  });
  const href = location
    ? `/dashboard/l/${location.listId}/t/${running.taskId}`
    : "#";
  return (
    <div className="mt-3 flex items-center gap-2 rounded-2xl border border-red-300/40 bg-red-50/40 p-2 text-xs">
      <Timer className="h-3.5 w-3.5 text-red-600" aria-hidden />
      <span className="font-medium text-red-700">Now</span>
      <Link
        href={href}
        className="ml-1 truncate text-muted-foreground hover:text-foreground"
        title={running.taskTitle}
      >
        {running.taskTitle}
      </Link>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="text-lg font-semibold">{value}</dd>
    </div>
  );
}

function Avatar({ name, clerkId }: { name: string; clerkId: string }) {
  const initial = (name || clerkId).trim().charAt(0).toUpperCase();
  return (
    <span
      aria-hidden
      className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-brand-600 text-sm font-medium text-white"
    >
      {initial}
    </span>
  );
}
