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
