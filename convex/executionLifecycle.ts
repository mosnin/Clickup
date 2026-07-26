import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

type ReadCtx = QueryCtx | MutationCtx;

export type ExecutionAssignmentStatus =
  Doc<"executionAssignments">["status"];

export const ACTIVE_EXECUTION_STATUSES = new Set<ExecutionAssignmentStatus>([
  "dispatched",
  "claimed",
  "running",
]);

export const EXECUTION_ASSIGNMENT_LEASE_MS = 30 * 60 * 1000;

export function executionAssignmentFreshnessAt(
  assignment: Doc<"executionAssignments">,
) {
  return (
    assignment.lastHeartbeatAt ??
    assignment.claimedAt ??
    assignment.dispatchedAt
  );
}

export function isExecutionAssignmentStale(
  assignment: Doc<"executionAssignments">,
  now = Date.now(),
) {
  return (
    ACTIVE_EXECUTION_STATUSES.has(assignment.status) &&
    now - executionAssignmentFreshnessAt(assignment) >=
      EXECUTION_ASSIGNMENT_LEASE_MS
  );
}

export async function reconcileStaleExecutionAssignments(
  ctx: MutationCtx,
  planId: Id<"executionPlans">,
  now = Date.now(),
) {
  const rows = await ctx.db
    .query("executionAssignments")
    .withIndex("by_plan", (q) => q.eq("planId", planId))
    .order("desc")
    .take(1_000);
  const recovered = [];
  for (const assignment of rows) {
    if (!isExecutionAssignmentStale(assignment, now)) continue;
    const freshnessAt = executionAssignmentFreshnessAt(assignment);
    const previousStatus = assignment.status;
    const error =
      `Attempt automatically abandoned after ${Math.floor(
        (now - freshnessAt) / 60_000,
      )} minutes without an execution heartbeat.`;
    await ctx.db.patch(assignment._id, {
      status: "abandoned",
      error,
      finishedAt: now,
    });
    recovered.push({
      assignmentId: assignment._id,
      taskId: assignment.taskId,
      agentId: assignment.agentId,
      previousStatus,
      freshnessAt,
      error,
    });
  }
  return {
    recovered,
    scannedCount: rows.length,
    truncated: rows.length === 1_000,
  };
}

export async function latestExecutionAssignmentForTask(
  ctx: ReadCtx,
  taskId: Id<"tasks">,
) {
  const rows = await ctx.db
    .query("executionAssignments")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .order("desc")
    .take(1);
  return rows[0] ?? null;
}

export async function markExecutionAssignmentClaimed(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  agentId: Id<"agents">,
) {
  const assignment = await latestExecutionAssignmentForTask(ctx, taskId);
  if (
    !assignment ||
    assignment.agentId !== agentId ||
    !ACTIVE_EXECUTION_STATUSES.has(assignment.status)
  ) {
    return null;
  }
  const now = Date.now();
  await ctx.db.patch(assignment._id, {
    status: assignment.status === "running" ? "running" : "claimed",
    claimedAt: assignment.claimedAt ?? now,
    lastHeartbeatAt: now,
  });
  return (await ctx.db.get(assignment._id))!;
}

export async function touchExecutionAssignment(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  agentId: Id<"agents">,
) {
  const assignment = await latestExecutionAssignmentForTask(ctx, taskId);
  if (
    !assignment ||
    assignment.agentId !== agentId ||
    !ACTIVE_EXECUTION_STATUSES.has(assignment.status)
  ) {
    return null;
  }
  await ctx.db.patch(assignment._id, { lastHeartbeatAt: Date.now() });
  return (await ctx.db.get(assignment._id))!;
}

export async function markExecutionAssignmentRunning(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  agentId: Id<"agents">,
  runId: Id<"agentRuns">,
) {
  const assignment = await latestExecutionAssignmentForTask(ctx, taskId);
  if (
    !assignment ||
    assignment.agentId !== agentId ||
    !ACTIVE_EXECUTION_STATUSES.has(assignment.status)
  ) {
    return null;
  }
  const now = Date.now();
  await ctx.db.patch(assignment._id, {
    status: "running",
    runId,
    claimedAt: assignment.claimedAt ?? now,
    startedAt: assignment.startedAt ?? now,
    lastHeartbeatAt: now,
  });
  return (await ctx.db.get(assignment._id))!;
}

export async function finishExecutionAssignment(
  ctx: MutationCtx,
  assignmentId: Id<"executionAssignments">,
  agentId: Id<"agents">,
  outcome: {
    status: "succeeded" | "failed" | "abandoned";
    summary?: string;
    error?: string;
    links?: string[];
  },
) {
  const assignment = await ctx.db.get(assignmentId);
  if (!assignment || assignment.agentId !== agentId) return null;
  if (!ACTIVE_EXECUTION_STATUSES.has(assignment.status)) {
    return assignment;
  }
  await ctx.db.patch(assignment._id, {
    status: outcome.status,
    summary: outcome.summary?.slice(0, 2_000),
    error: outcome.error?.slice(0, 2_000),
    links: outcome.links?.slice(0, 20),
    finishedAt: Date.now(),
  });
  return (await ctx.db.get(assignment._id))!;
}

export async function abandonExecutionAssignmentForTask(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  agentId: Id<"agents">,
  reason: string,
) {
  const assignment = await latestExecutionAssignmentForTask(ctx, taskId);
  if (
    !assignment ||
    assignment.agentId !== agentId ||
    !ACTIVE_EXECUTION_STATUSES.has(assignment.status)
  ) {
    return null;
  }
  await ctx.db.patch(assignment._id, {
    status: "abandoned",
    error: reason.slice(0, 2_000),
    finishedAt: Date.now(),
  });
  return (await ctx.db.get(assignment._id))!;
}
