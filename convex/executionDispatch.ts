import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { agentCanTouchList } from "./_agentAuth";
import { canAccessSpace, requireIdentity } from "./_authz";
import { hasCapabilities } from "./capabilities";
import { executionPlanSummary } from "./executionPlans";
import { CLAIM_TTL_MS } from "./tasks";

export const DISPATCH_LEASE_MS = 30 * 60 * 1000;

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

export async function executionReadinessCore(
  ctx: ReadCtx,
  plan: Doc<"executionPlans">,
  allowedAgentIds?: Set<string>,
) {
  const now = Date.now();
  const waves = await ctx.db
    .query("executionWaves")
    .withIndex("by_plan", (q) => q.eq("planId", plan._id))
    .collect();
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
  for (const [taskId, lease] of latestWaveByTask) {
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
    const previous = latestWaveByTask.get(task._id);
    if (previous && now - previous.createdAt < DISPATCH_LEASE_MS) {
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
    recommendations.push({
      taskId: task._id,
      taskRef: manifestTask.ref,
      title: task.title,
      listId: task.listId,
      requiredCapabilities: task.requiredCapabilities ?? [],
      recommendedAgentId: chosen.agentId,
      recommendedAgentName: chosen.name,
      notifyConfigured: chosen.notifyConfigured,
    });
  }

  return {
    plan: executionPlanSummary(plan),
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

export const readiness = query({
  args: { planId: v.id("executionPlans") },
  handler: async (ctx, { planId }) => {
    const plan = await ctx.db.get(planId);
    if (!plan) return null;
    await requireHumanPlanAccess(ctx, plan);
    return await executionReadinessCore(ctx, plan);
  },
});
