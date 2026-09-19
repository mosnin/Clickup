"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { formatDurationCoarse } from "@/lib/duration";
import { Stagger, StaggerItem } from "@/components/motion";
import {
  EmptyBlob,
  KvCard,
  KvRow,
  NameLink,
  StatusDot,
  TotalCount,
} from "@/components/dashboard/deel-ui";

export function TeamHub({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const members = useQuery(api.team.hub, { workspaceId });

  if (members === undefined) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-28 animate-pulse rounded-[var(--ui-radius-card)] bg-muted/40"
          />
        ))}
      </div>
    );
  }
  if (members === null) {
    return (
      <EmptyBlob
        title="Team is out of reach"
        message="You don't have access to this workspace's team."
      />
    );
  }

  const tracking = members.filter((m) => m.running).length;

  return (
    <div className="space-y-3">
      <TotalCount
        count={members.length}
        singular="member"
      />
      <p className="text-sm text-muted-foreground">
        {tracking} currently tracking time
      </p>
      <Stagger className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {members.map((m) => (
          <StaggerItem key={m.clerkId}>
            <KvCard
              title={m.name}
              action={
                <span className="text-xs text-muted-foreground">{m.role}</span>
              }
            >
              <KvRow label="Open">{m.openTasks}</KvRow>
              <KvRow label="Done · 7d">{m.completedThisWeek}</KvRow>
              <KvRow label="Tracked · 7d">
                {formatDurationCoarse(m.trackedThisWeekMs)}
              </KvRow>
              {m.running && (
                <div className="flex items-center gap-2 px-5 py-3">
                  <StatusDot color="var(--color-danger)" label="Now" />
                  <RunningTaskLink
                    taskId={m.running.taskId}
                    title={m.running.taskTitle}
                  />
                </div>
              )}
            </KvCard>
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
      <span className="truncate text-sm text-muted-foreground" title={title}>
        {title}
      </span>
    );
  }
  return (
    <NameLink
      href={`/dashboard/l/${listId}/t/${taskId}`}
      className="truncate text-sm"
      title={title}
    >
      {title}
    </NameLink>
  );
}
