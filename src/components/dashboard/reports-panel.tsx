"use client";

import { useQuery } from "convex/react";
import { CheckCircle2, Clock, ListChecks, Target } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { formatDurationCoarse } from "@/lib/duration";
import { AnimatedBar, AnimatedNumber, Stagger, StaggerItem } from "@/components/motion";

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
          <div
            key={i}
            className="h-28 animate-pulse rounded-2xl bg-muted/40"
          />
        ))}
      </div>
    );
  }

  if (summary === null) {
    return (
      <div className="rounded-2xl border border-border bg-muted/30 p-10 text-center text-sm text-muted-foreground">
        You don&apos;t have access to this workspace&apos;s reports.
      </div>
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
      name: `${a.emoji ?? "🤖"} ${a.name}`,
    });
  }

  return (
    <div className="space-y-6">
      <Stagger className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          icon={ListChecks}
          label="Open tasks"
          value={summary.taskCounts.open + summary.taskCounts.inProgress}
          subtext={`${summary.taskCounts.inProgress} in progress`}
        />
        <Stat
          icon={CheckCircle2}
          label="Completed this week"
          value={summary.taskCounts.completedThisWeek}
          subtext={`of ${summary.taskCounts.total} total`}
        />
        <Stat
          icon={Clock}
          label="Tracked this week"
          value={formatDurationCoarse(summary.timeTrackedThisWeekMs)}
          subtext={summary.timeByUser.length
            ? `${summary.timeByUser.length} contributor${summary.timeByUser.length === 1 ? "" : "s"}`
            : "No entries yet"}
        />
        <Stat
          icon={Target}
          label="Goals"
          value={summary.goals.total}
          subtext={`${Math.round(summary.goals.avgProgress * 100)}% avg progress`}
        />
      </Stagger>

      <div className="grid gap-3 lg:grid-cols-2">
        <Widget title="Workload by assignee">
          {summary.taskCountByAssignee.length === 0 ? (
            <Empty>No tasks assigned yet.</Empty>
          ) : (
            <ul className="space-y-2">
              {summary.taskCountByAssignee
                .slice()
                .sort((a, b) => b.count - a.count)
                .slice(0, 8)
                .map(({ clerkId, count }) => {
                  const user = memberByClerkId.get(clerkId);
                  return (
                    <Bar
                      key={clerkId}
                      label={user?.name ?? user?.email ?? "Unknown"}
                      value={count}
                      max={Math.max(
                        ...summary.taskCountByAssignee.map((a) => a.count),
                      )}
                    />
                  );
                })}
            </ul>
          )}
        </Widget>

        <Widget title="Time tracked this week">
          {summary.timeByUser.length === 0 ? (
            <Empty>No time has been logged yet this week.</Empty>
          ) : (
            <ul className="space-y-2">
              {summary.timeByUser
                .slice()
                .sort((a, b) => b.ms - a.ms)
                .slice(0, 8)
                .map((entry) => {
                  const user = memberByClerkId.get(entry.clerkId);
                  return (
                    <Bar
                      key={entry.clerkId}
                      label={user?.name ?? user?.email ?? "Unknown"}
                      valueLabel={formatDurationCoarse(entry.ms)}
                      value={entry.ms}
                      max={Math.max(
                        ...summary.timeByUser.map((e) => e.ms),
                      )}
                    />
                  );
                })}
            </ul>
          )}
        </Widget>
      </div>
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  subtext,
}: {
  icon: typeof Clock;
  label: string;
  value: number | string;
  subtext?: string;
}) {
  return (
    <StaggerItem className="rounded-2xl border border-border bg-background p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <Icon className="h-3.5 w-3.5 text-muted-foreground/70" aria-hidden />
      </div>
      <p className="mt-2 text-3xl font-bold tracking-tight">
        <AnimatedNumber value={value} />
      </p>
      {subtext && (
        <p className="mt-1 text-xs text-muted-foreground">{subtext}</p>
      )}
    </StaggerItem>
  );
}

function Widget({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-background p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-2xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function Bar({
  label,
  value,
  valueLabel,
  max,
}: {
  label: string;
  value: number;
  valueLabel?: string;
  max: number;
}) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <li>
      <div className="flex items-center justify-between text-xs">
        <span className="truncate">{label}</span>
        <span className="text-muted-foreground">{valueLabel ?? value}</span>
      </div>
      <AnimatedBar
        pct={pct}
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"
        barClassName="h-full rounded-full bg-brand-600"
      />
    </li>
  );
}

// Keep the type export consistent with usage above.
export type _Member = Doc<"users">;
