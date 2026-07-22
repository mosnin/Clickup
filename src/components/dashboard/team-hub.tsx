"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { Timer } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { formatDurationCoarse } from "@/lib/duration";
import { Card, CardContent } from "@/components/ui/card";
import { Monogram } from "@/components/dashboard/monogram";
import { AnimatedNumber, Stagger, StaggerItem } from "@/components/motion";

export function TeamHub({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const members = useQuery(api.team.hub, { workspaceId });

  if (members === undefined) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Card key={i} className="h-28 animate-pulse bg-muted/40" />
        ))}
      </div>
    );
  }
  if (members === null) {
    return (
      <Card className="items-center py-10 text-center">
        <CardContent className="text-sm text-muted-foreground">
          You don&apos;t have access to this workspace&apos;s team.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {members.length} member{members.length === 1 ? "" : "s"} ·{" "}
        {members.filter((m) => m.running).length} currently tracking time
      </p>
      <Stagger className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {members.map((m) => (
          <StaggerItem key={m.clerkId}>
            <Card className="lift gap-0 p-4">
              <div className="flex items-start gap-3">
                <Monogram name={m.name} size="lg" />
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

              {m.running && (
                <div className="mt-3 flex items-center gap-2 rounded-2xl border border-red-300/40 bg-red-50/40 p-2 text-xs">
                  <Timer className="h-3.5 w-3.5 text-red-600" aria-hidden />
                  <span className="font-medium text-red-700">Now</span>
                  <RunningTaskLink
                    taskId={m.running.taskId}
                    title={m.running.taskTitle}
                  />
                </div>
              )}
            </Card>
          </StaggerItem>
        ))}
      </Stagger>
    </div>
  );
}

// Resolves the running task's listId so the link actually navigates.
function RunningTaskLink({
  taskId,
  title,
}: {
  taskId: Id<"tasks">;
  title: string;
}) {
  const listId = useQuery(api.tasks.resolveListId, { taskId });
  if (!listId) {
    return (
      <span className="ml-1 truncate text-muted-foreground" title={title}>
        {title}
      </span>
    );
  }
  return (
    <Link
      href={`/dashboard/l/${listId}/t/${taskId}`}
      className="ml-1 truncate text-muted-foreground hover:text-foreground"
      title={title}
    >
      {title}
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="text-lg font-bold tracking-tight"><AnimatedNumber value={value} /></dd>
    </div>
  );
}
