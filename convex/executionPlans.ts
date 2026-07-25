import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
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
  return { identity, membership };
}

export function executionPlanSummary(plan: Doc<"executionPlans">) {
  const authorizationSource =
    plan.reviewStatus === undefined
      ? "legacy"
      : plan.authorizationSource ??
        (plan.reviewStatus === "approved" ? "human_review" : "none");
  return {
    planId: plan._id,
    name: plan.name,
    objective: plan.objective,
    roadmapId: plan.roadmapId,
    projectCount: plan.projects.length,
    taskCount: plan.tasks.length,
    assumptionCount: plan.assumptions.length,
    openQuestionCount: plan.openQuestions.length,
    reviewStatus: plan.reviewStatus ?? "legacy_approved",
    authorizationSource,
    authorizationPolicyVersion: plan.authorizationPolicyVersion,
    authorizationReason: plan.authorizationReason,
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
    const { identity } = await requireWorkspaceMember(ctx, workspaceId);
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
    const { identity, membership } = await requireWorkspaceMember(
      ctx,
      plan.workspaceId,
    );
    const space = await ctx.db.get(plan.spaceId);
    if (!space || !(await canAccessSpace(ctx, space, identity))) return null;
    const reviews = await ctx.db
      .query("executionPlanReviews")
      .withIndex("by_plan", (q) => q.eq("planId", planId))
      .order("desc")
      .collect();
    const reviewerNames = new Map<string, string>();
    for (const review of reviews) {
      if (reviewerNames.has(review.reviewedByClerkId)) continue;
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) =>
          q.eq("clerkId", review.reviewedByClerkId),
        )
        .unique();
      reviewerNames.set(
        review.reviewedByClerkId,
        user?.name ?? user?.email ?? "Workspace reviewer",
      );
    }
    return {
      ...executionPlanView(plan),
      canReview:
        membership.role === "owner" || membership.role === "admin",
      reviews: reviews.map((review) => ({
        reviewId: review._id,
        decision: review.decision,
        note: review.note,
        reviewerName: reviewerNames.get(review.reviewedByClerkId)!,
        reviewedAt: review.reviewedAt,
      })),
    };
  },
});

export const review = mutation({
  args: {
    planId: v.id("executionPlans"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
    note: v.string(),
  },
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.planId);
    if (!plan) throw new ConvexError("Execution plan not found");
    const { identity, membership } = await requireWorkspaceMember(
      ctx,
      plan.workspaceId,
    );
    if (membership.role !== "owner" && membership.role !== "admin") {
      throw new ConvexError(
        "Only workspace owners and admins can authorize execution plans",
      );
    }
    const space = await ctx.db.get(plan.spaceId);
    if (!space || !(await canAccessSpace(ctx, space, identity))) {
      throw new ConvexError("Forbidden");
    }
    const note = args.note.trim();
    if (note.length < 10 || note.length > 2_000) {
      throw new ConvexError("Review note must be 10-2,000 characters");
    }
    const reviewedAt = Date.now();
    const reviewId = await ctx.db.insert("executionPlanReviews", {
      planId: args.planId,
      decision: args.decision,
      note,
      reviewedByClerkId: identity.subject,
      reviewedAt,
    });
    await ctx.db.patch(args.planId, {
      reviewStatus: args.decision,
      authorizationSource:
        args.decision === "approved" ? "human_review" : undefined,
      authorizationPolicyVersion: undefined,
      authorizationReason:
        args.decision === "approved"
          ? "Approved by a workspace owner or admin."
          : undefined,
    });
    return {
      reviewId,
      reviewStatus: args.decision,
      reviewedAt,
    };
  },
});
