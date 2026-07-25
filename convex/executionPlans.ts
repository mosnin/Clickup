import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { canAccessSpace, requireIdentity } from "./_authz";

async function requireWorkspaceMember(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
) {
  const identity = await requireIdentity(ctx);
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q
        .eq("userClerkId", identity.subject)
        .eq("workspaceId", workspaceId),
    )
    .unique();
  if (!membership) throw new ConvexError("Forbidden");
  return identity;
}

export function executionPlanSummary(plan: Doc<"executionPlans">) {
  return {
    planId: plan._id,
    name: plan.name,
    objective: plan.objective,
    roadmapId: plan.roadmapId,
    projectCount: plan.projects.length,
    taskCount: plan.tasks.length,
    assumptionCount: plan.assumptions.length,
    openQuestionCount: plan.openQuestions.length,
    createdByAgentId: plan.createdByAgentId,
    createdAt: plan.createdAt,
  };
}

export function executionPlanView(plan: Doc<"executionPlans">) {
  return {
    ...executionPlanSummary(plan),
    spaceId: plan.spaceId,
    sourceContext: plan.sourceContext,
    successCriteria: plan.successCriteria,
    assumptions: plan.assumptions,
    openQuestions: plan.openQuestions,
    projects: plan.projects,
    tasks: plan.tasks,
  };
}

export const listForWorkspace = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const identity = await requireWorkspaceMember(ctx, workspaceId);
    const plans = await ctx.db
      .query("executionPlans")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .order("desc")
      .take(20);
    const visible = [];
    for (const plan of plans) {
      const space = await ctx.db.get(plan.spaceId);
      if (space && (await canAccessSpace(ctx, space, identity))) {
        visible.push(executionPlanSummary(plan));
      }
    }
    return visible;
  },
});

export const get = query({
  args: { planId: v.id("executionPlans") },
  handler: async (ctx, { planId }) => {
    const plan = await ctx.db.get(planId);
    if (!plan) return null;
    const identity = await requireWorkspaceMember(ctx, plan.workspaceId);
    const space = await ctx.db.get(plan.spaceId);
    if (!space || !(await canAccessSpace(ctx, space, identity))) return null;
    return executionPlanView(plan);
  },
});
