"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { formatDurationCoarse } from "@/lib/duration";
import {
  DeelBar,
  EmptyBlob,
  KvCard,
  MetricStrip,
} from "@/components/dashboard/deel-ui";

export function ReportsPanel({
  workspaceId,
}: {
  workspaceId: Id<"workspaces">;
}) {
  const summary = useQuery(api.reports.workspaceSummary, { workspaceId });
  const members = useQuery(api.workspaces.listMembers, { workspaceId });
  const agents = useQuery(api.agents.listForWorkspace, { workspaceId });

  if (summary === undefined || members === undefined) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-[var(--ui-radius-card)] bg-muted/40" />
        ))}
      </div>
    );
  }

  if (summary === null) {
    return (
      <EmptyBlob
        title="Reports are out of reach"
        message="You don't have access to this workspace's reports."
      />
    );
  }

  // Agents appear in workload/time widgets like any assignee — merge them
  // into the name map so they don't render as "Unknown".
  const memberByClerkId = new Map<
    string,
    { clerkId: string; name?: string; email?: string }
  >(members.map((m) => [m.clerkId, m]));
  for (const a of agents ?? []) {
    memberByClerkId.set(a._id, {
      clerkId: a._id,
      name: a.name,
    });
  }

  return (
    <div className="space-y-6">
      <MetricStrip
        className="sm:grid-cols-2 lg:grid-cols-4"
        items={[
          {
            value: summary.taskCounts.open + summary.taskCounts.inProgress,
            label: `${summary.taskCounts.inProgress} in progress`,
          },
          {
            value: summary.taskCounts.completedThisWeek,
            label: `Completed this week · of ${summary.taskCounts.total} total`,
          },
          {
            value: formatDurationCoarse(summary.timeTrackedThisWeekMs),
            label: summary.timeByUser.length
              ? `${summary.timeByUser.length} contributor${summary.timeByUser.length === 1 ? "" : "s"}`
              : "No entries yet",
          },
          {
            value: summary.goals.total,
            label: `${Math.round(summary.goals.avgProgress * 100)}% avg progress`,
          },
        ]}
      />

      <div className="grid gap-3 lg:grid-cols-2">
        <KvCard title="Workload by assignee">
          <div className="space-y-3 px-5 py-4">
            {summary.taskCountByAssignee.length === 0 ? (
              <EmptyBlob title="No tasks assigned yet" />
            ) : (
              summary.taskCountByAssignee
                .slice()
                .sort((a, b) => b.count - a.count)
                .slice(0, 8)
                .map(({ clerkId, count }) => {
                  const user = memberByClerkId.get(clerkId);
                  return (
                    <DeelBar
                      key={clerkId}
                      label={user?.name ?? user?.email ?? "Unknown"}
                      value={count}
                      max={Math.max(
                        ...summary.taskCountByAssignee.map((a) => a.count),
                      )}
                    />
                  );
                })
            )}
          </div>
        </KvCard>

        <KvCard title="Time tracked this week">
          <div className="space-y-3 px-5 py-4">
            {summary.timeByUser.length === 0 ? (
              <EmptyBlob title="No time logged this week" />
            ) : (
              summary.timeByUser
                .slice()
                .sort((a, b) => b.ms - a.ms)
                .slice(0, 8)
                .map((entry) => {
                  const user = memberByClerkId.get(entry.clerkId);
                  return (
                    <DeelBar
                      key={entry.clerkId}
                      label={user?.name ?? user?.email ?? "Unknown"}
                      value={entry.ms}
                      valueLabel={formatDurationCoarse(entry.ms)}
                      max={Math.max(...summary.timeByUser.map((e) => e.ms))}
                    />
                  );
                })
            )}
          </div>
        </KvCard>
      </div>
    </div>
  );
}

// Keep the type export consistent with usage above.
export type _Member = Doc<"users">;
