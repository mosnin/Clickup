import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { agentCanTouchList, sha256Hex } from "./_agentAuth";
import { canAccessSpace, requireIdentity } from "./_authz";
import { hasCapabilities } from "./capabilities";
import { listPacketsForTask } from "./contextPackets";
import { executionPlanSummary } from "./executionPlans";
import {
  executionPolicyFor,
  planAuthorization,
} from "./executionPolicy";
import { CLAIM_TTL_MS } from "./tasks";
import {
  ACTIVE_EXECUTION_STATUSES,
  EXECUTION_ASSIGNMENT_LEASE_MS,
  executionAssignmentFreshnessAt,
  isExecutionAssignmentStale,
  type ExecutionAssignmentStatus,
} from "./executionLifecycle";

export const DISPATCH_LEASE_MS = EXECUTION_ASSIGNMENT_LEASE_MS;

type ReadCtx = QueryCtx | MutationCtx;

async function requireHumanPlanAccess(
  ctx: QueryCtx,
  plan: Doc<"executionPlans">,
) {
  const identity = await requireIdentity(ctx);
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q
        .eq("userClerkId", identity.subject)
        .eq("workspaceId", plan.workspaceId),
    )
    .unique();
  if (!membership) throw new ConvexError("Forbidden");
  const space = await ctx.db.get(plan.spaceId);
  if (!space || !(await canAccessSpace(ctx, space, identity))) {
    throw new ConvexError("Forbidden");
  }
}

async function isTaskComplete(
  ctx: ReadCtx,
  task: Doc<"tasks">,
  statusCache: Map<string, boolean>,
) {
  const cached = statusCache.get(task.statusId);
  if (cached !== undefined) return cached;
  const status = await ctx.db.get(task.statusId);
  const complete =
    status?.category === "complete" || status?.category === "closed";
  statusCache.set(task.statusId, complete);
  return complete;
}

async function contextLoadForTask(
  ctx: ReadCtx,
  taskId: Id<"tasks">,
) {
  const packets = await listPacketsForTask(ctx, taskId);
  const contextCharacterCount = packets.reduce(
    (total, packet) =>
      total +
      packet.title.length +
      (packet.summary?.length ?? 0) +
      packet.content.length,
    0,
  );
  return {
    contextPacketCount: packets.length,
    contextCharacterCount,
    estimatedContextTokens: Math.ceil(contextCharacterCount / 4),
    contextVersionFingerprint: sha256Hex(
      packets
        .map((packet) => `${packet.packetId}:${packet.version}`)
        .sort()
        .join("|"),
    ),
    contextPackets: packets.map((packet) => ({
      packetId: packet.packetId,
      title: packet.title,
      version: packet.version,
      updatedAt: packet.updatedAt,
      characterCount:
        packet.title.length +
        (packet.summary?.length ?? 0) +
        packet.content.length,
    })),
  };
}

export async function executionReadinessCore(
  ctx: ReadCtx,
  plan: Doc<"executionPlans">,
  allowedAgentIds?: Set<string>,
) {
  const now = Date.now();
  const workspace = await ctx.db.get(plan.workspaceId);
  if (!workspace) throw new ConvexError("Workspace not found");
  const executionPolicy = executionPolicyFor(workspace);
  const authorization = planAuthorization(plan, executionPolicy);
  const waves = await ctx.db
    .query("executionWaves")
    .withIndex("by_plan", (q) => q.eq("planId", plan._id))
    .order("desc")
    .take(200);
  const executionAssignments = await ctx.db
    .query("executionAssignments")
    .withIndex("by_plan", (q) => q.eq("planId", plan._id))
    .order("desc")
    .take(1_000);
  const recentWorkspaceWaves = await ctx.db
    .query("executionWaves")
    .withIndex("by_workspace", (q) =>
      q
        .eq("workspaceId", plan.workspaceId)
        .gte("createdAt", now - 24 * 60 * 60 * 1_000),
    )
    .take(1_001);
  const tasksDispatchedLast24Hours = recentWorkspaceWaves.reduce(
    (total, wave) => total + wave.assignments.length,
    0,
  );
  const policyCapacityRemaining = Math.max(
    0,
    executionPolicy.dailyTaskLimit - tasksDispatchedLast24Hours,
  );
  const latestAssignmentByTask = new Map<
    string,
    Doc<"executionAssignments">
  >();
  for (const assignment of executionAssignments) {
    const current = latestAssignmentByTask.get(assignment.taskId);
    if (!current || current.dispatchedAt < assignment.dispatchedAt) {
      latestAssignmentByTask.set(assignment.taskId, assignment);
    }
  }
  const latestWaveByTask = new Map<
    string,
    { createdAt: number; agentId: Id<"agents"> }
  >();
  for (const wave of waves) {
    for (const assignment of wave.assignments) {
      const current = latestWaveByTask.get(assignment.taskId);
      if (!current || current.createdAt < wave.createdAt) {
        latestWaveByTask.set(assignment.taskId, {
          createdAt: wave.createdAt,
          agentId: assignment.agentId,
        });
      }
    }
  }

  const agents = (
    await ctx.db
      .query("agents")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "workspace").eq("parentId", plan.workspaceId),
      )
      .collect()
  ).filter(
    (agent) =>
      agent.status === "active" &&
      (agent.role ?? "member") === "member" &&
      (allowedAgentIds === undefined || allowedAgentIds.has(agent._id)),
  );

  const activeTaskIdsByAgent = new Map<string, Set<string>>();
  for (const agent of agents) {
    const ids = new Set<string>();
    if (agent.currentTaskId) ids.add(agent.currentTaskId);
    const claimed = await ctx.db
      .query("tasks")
      .withIndex("by_claimed", (q) => q.eq("claimedByActorId", agent._id))
      .collect();
    for (const task of claimed) {
      if (
        task.claimedAt !== undefined &&
        now - task.claimedAt < CLAIM_TTL_MS
      ) {
        ids.add(task._id);
      }
    }
    activeTaskIdsByAgent.set(agent._id, ids);
  }

  const statusCache = new Map<string, boolean>();
  for (const [taskId, assignment] of latestAssignmentByTask) {
    if (!ACTIVE_EXECUTION_STATUSES.has(assignment.status)) continue;
    const freshness = executionAssignmentFreshnessAt(assignment);
    if (now - freshness >= DISPATCH_LEASE_MS) continue;
    const task = await ctx.db.get(taskId as Id<"tasks">);
    if (!task || (await isTaskComplete(ctx, task, statusCache))) continue;
    activeTaskIdsByAgent.get(assignment.agentId)?.add(taskId);
  }
  for (const [taskId, lease] of latestWaveByTask) {
    if (latestAssignmentByTask.has(taskId)) continue;
    if (now - lease.createdAt >= DISPATCH_LEASE_MS) continue;
    const task = await ctx.db.get(taskId as Id<"tasks">);
    if (!task || (await isTaskComplete(ctx, task, statusCache))) continue;
    activeTaskIdsByAgent.get(lease.agentId)?.add(taskId);
  }

  const agentRows = agents.map((agent) => {
    const activeLoad = activeTaskIdsByAgent.get(agent._id)?.size ?? 0;
    const maxConcurrentTasks = agent.maxConcurrentTasks ?? 1;
    return {
      doc: agent,
      agentId: agent._id,
      name: agent.name,
      capabilities: agent.capabilities ?? [],
      maxConcurrentTasks,
      activeLoad,
      availableSlots: Math.max(0, maxConcurrentTasks - activeLoad),
      notifyConfigured: agent.notifyUrl !== undefined,
      allowedListIds: agent.allowedListIds,
    };
  });
  const plannedLoad = new Map(
    agentRows.map((agent) => [agent.agentId as string, agent.activeLoad]),
  );

  const recommendations: {
    taskId: Id<"tasks">;
    taskRef: string;
    title: string;
    listId: Id<"lists">;
    requiredCapabilities: string[];
    recommendedAgentId: Id<"agents">;
    recommendedAgentName: string;
    notifyConfigured: boolean;
    contextPacketCount: number;
    contextCharacterCount: number;
    estimatedContextTokens: number;
    contextVersionFingerprint: string;
    contextPackets: Array<{
      packetId: Id<"contextPackets">;
      title: string;
      version: number;
      updatedAt: number;
      characterCount: number;
    }>;
  }[] = [];
  const skipped: { taskRef: string; reason: string }[] = [];

  for (const manifestTask of plan.tasks) {
    const task = await ctx.db.get(manifestTask.taskId);
    if (!task) {
      skipped.push({ taskRef: manifestTask.ref, reason: "artifact_missing" });
      continue;
    }
    if (await isTaskComplete(ctx, task, statusCache)) {
      skipped.push({ taskRef: manifestTask.ref, reason: "complete" });
      continue;
    }
    let blocked = false;
    for (const blockerId of task.blockedByTaskIds ?? []) {
      const blocker = await ctx.db.get(blockerId);
      if (
        blocker &&
        !(await isTaskComplete(ctx, blocker, statusCache))
      ) {
        blocked = true;
        break;
      }
    }
    if (blocked) {
      skipped.push({
        taskRef: manifestTask.ref,
        reason: "dependency_blocked",
      });
      continue;
    }
    if (
      task.claimedByActorId &&
      task.claimedAt !== undefined &&
      now - task.claimedAt < CLAIM_TTL_MS
    ) {
      skipped.push({ taskRef: manifestTask.ref, reason: "already_claimed" });
      continue;
    }
    const latestAssignment = latestAssignmentByTask.get(task._id);
    if (
      latestAssignment &&
      ACTIVE_EXECUTION_STATUSES.has(latestAssignment.status)
    ) {
      const freshness = executionAssignmentFreshnessAt(latestAssignment);
      if (now - freshness < DISPATCH_LEASE_MS) {
        skipped.push({
          taskRef: manifestTask.ref,
          reason:
            latestAssignment.status === "dispatched"
              ? "assignment_dispatched"
              : `assignment_${latestAssignment.status}`,
        });
        continue;
      }
    }
    const previous = latestWaveByTask.get(task._id);
    if (
      !latestAssignment &&
      previous &&
      now - previous.createdAt < DISPATCH_LEASE_MS
    ) {
      skipped.push({ taskRef: manifestTask.ref, reason: "dispatch_lease" });
      continue;
    }

    const compatible = agentRows
      .filter((agent) => agentCanTouchList(agent.doc, task.listId))
      .filter((agent) =>
        hasCapabilities(
          agent.capabilities,
          task.requiredCapabilities,
        ),
      )
      .filter(
        (agent) =>
          (plannedLoad.get(agent.agentId) ?? 0) <
          agent.maxConcurrentTasks,
      )
      .sort((a, b) => {
        const aAssigned = task.assigneeClerkIds.includes(a.agentId) ? 0 : 1;
        const bAssigned = task.assigneeClerkIds.includes(b.agentId) ? 0 : 1;
        if (aAssigned !== bAssigned) return aAssigned - bAssigned;
        const loadDelta =
          (plannedLoad.get(a.agentId) ?? 0) -
          (plannedLoad.get(b.agentId) ?? 0);
        if (loadDelta !== 0) return loadDelta;
        return a.name.localeCompare(b.name);
      });
    const chosen = compatible[0];
    if (!chosen) {
      const capabilityMatchExists = agentRows.some(
        (agent) =>
          agentCanTouchList(agent.doc, task.listId) &&
          hasCapabilities(
            agent.capabilities,
            task.requiredCapabilities,
          ),
      );
      skipped.push({
        taskRef: manifestTask.ref,
        reason: capabilityMatchExists ? "capacity_exhausted" : "capability_gap",
      });
      continue;
    }
    plannedLoad.set(
      chosen.agentId,
      (plannedLoad.get(chosen.agentId) ?? 0) + 1,
    );
    const contextLoad = await contextLoadForTask(ctx, task._id);
    recommendations.push({
      taskId: task._id,
      taskRef: manifestTask.ref,
      title: task.title,
      listId: task.listId,
      requiredCapabilities: task.requiredCapabilities ?? [],
      recommendedAgentId: chosen.agentId,
      recommendedAgentName: chosen.name,
      notifyConfigured: chosen.notifyConfigured,
      ...contextLoad,
    });
  }

  const wavePolicyCapacity = Math.min(
    executionPolicy.maxTasksPerWave,
    policyCapacityRemaining,
  );
  const policyLimited = recommendations.splice(wavePolicyCapacity);
  for (const recommendation of policyLimited) {
    skipped.push({
      taskRef: recommendation.taskRef,
      reason: "policy_limit",
    });
  }

  return {
    plan: executionPlanSummary(plan),
    dispatchAuthorized: authorization.authorized,
    authorization,
    executionPolicy,
    tasksDispatchedLast24Hours,
    policyCapacityRemaining,
    openQuestions: plan.openQuestions,
    requiresOpenQuestionDisposition: plan.openQuestions.length > 0,
    agents: agentRows.map(
      ({ allowedListIds: _allowed, doc: _doc, ...agent }) => agent,
    ),
    recommendations,
    skipped,
    leaseMinutes: DISPATCH_LEASE_MS / 60_000,
    waves: waves
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 10)
      .map((wave) => ({
        waveId: wave._id,
        assignmentCount: wave.assignments.length,
        pollRequiredCount: wave.assignments.filter(
          (assignment) => assignment.delivery === "poll_required",
        ).length,
        openQuestionDisposition: wave.openQuestionDisposition,
        createdByAgentId: wave.createdByAgentId,
        createdAt: wave.createdAt,
      })),
  };
}

export async function executionControlCore(
  ctx: ReadCtx,
  plan: Doc<"executionPlans">,
) {
  const rows = await ctx.db
    .query("executionAssignments")
    .withIndex("by_plan", (q) => q.eq("planId", plan._id))
    .order("desc")
    .take(100);
  const counts: Record<ExecutionAssignmentStatus, number> = {
    dispatched: 0,
    claimed: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    abandoned: 0,
  };
  let staleCount = 0;
  const now = Date.now();
  for (const row of rows) {
    if (isExecutionAssignmentStale(row, now)) {
      staleCount += 1;
    } else {
      counts[row.status] += 1;
    }
  }
  const assignments = [];
  for (const row of rows.slice(0, 25)) {
    const [task, agent, contextLoad] = await Promise.all([
      ctx.db.get(row.taskId),
      ctx.db.get(row.agentId),
      contextLoadForTask(ctx, row.taskId),
    ]);
    const stale = isExecutionAssignmentStale(row, now);
    const freshnessAt = executionAssignmentFreshnessAt(row);
    assignments.push({
      assignmentId: row._id,
      waveId: row.waveId,
      taskId: row.taskId,
      taskRef: row.taskRef,
      taskTitle: task?.title ?? "Deleted task",
      agentId: row.agentId,
      agentName: agent?.name ?? "Deleted agent",
      delivery: row.delivery,
      contextPacketCount: row.contextPacketCount,
      estimatedContextTokens: row.estimatedContextTokens,
      contextVersionFingerprint: row.contextVersionFingerprint,
      currentContextPacketCount: contextLoad.contextPacketCount,
      currentEstimatedContextTokens: contextLoad.estimatedContextTokens,
      currentContextVersionFingerprint:
        contextLoad.contextVersionFingerprint,
      contextDrifted:
        row.contextVersionFingerprint !== undefined &&
        row.contextVersionFingerprint !==
          contextLoad.contextVersionFingerprint,
      status: stale ? ("stale" as const) : row.status,
      recordedStatus: row.status,
      stale,
      staleSinceAt: stale
        ? freshnessAt + EXECUTION_ASSIGNMENT_LEASE_MS
        : undefined,
      attempt: row.attempt,
      runId: row.runId,
      dispatchedAt: row.dispatchedAt,
      claimedAt: row.claimedAt,
      startedAt: row.startedAt,
      lastHeartbeatAt: row.lastHeartbeatAt,
      finishedAt: row.finishedAt,
      summary: row.summary,
      error: row.error,
      links: row.links ?? [],
      retryable:
        stale || row.status === "failed" || row.status === "abandoned",
    });
  }
  return {
    plan: executionPlanSummary(plan),
    counts,
    staleCount,
    assignmentCount: rows.length,
    assignments,
  };
}

export const readiness = query({
  args: { planId: v.id("executionPlans") },
  handler: async (ctx, { planId }) => {
    const plan = await ctx.db.get(planId);
    if (!plan) return null;
    await requireHumanPlanAccess(ctx, plan);
    return await executionReadinessCore(ctx, plan);
  },
});

export const control = query({
  args: { planId: v.id("executionPlans") },
  handler: async (ctx, { planId }) => {
    const plan = await ctx.db.get(planId);
    if (!plan) return null;
    await requireHumanPlanAccess(ctx, plan);
    return await executionControlCore(ctx, plan);
  },
});
