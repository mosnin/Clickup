import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireIdentity } from "./_authz";
import type { Actor } from "./_agentAuth";
import { emitEvent, userActor } from "./events";

type ReadCtx = QueryCtx | MutationCtx;

const checkStatusValidator = v.union(
  v.literal("pending"),
  v.literal("submitted"),
  v.literal("passed"),
  v.literal("failed"),
);

const assuranceCheckValidator = v.object({
  checkId: v.union(v.id("outcomeChecks"), v.null()),
  criterionIndex: v.number(),
  criterion: v.string(),
  status: checkStatusValidator,
  submittedByAgentId: v.optional(v.id("agents")),
  submitterName: v.optional(v.string()),
  evidenceSummary: v.optional(v.string()),
  evidenceLinks: v.array(v.string()),
  submittedAt: v.optional(v.number()),
  reviewedByActorType: v.optional(
    v.union(v.literal("user"), v.literal("agent")),
  ),
  reviewedByActorId: v.optional(v.string()),
  reviewerName: v.optional(v.string()),
  reviewNote: v.optional(v.string()),
  reviewedAt: v.optional(v.number()),
});

const assuranceValidator = v.object({
  planId: v.id("executionPlans"),
  status: v.union(
    v.literal("unverified"),
    v.literal("in_review"),
    v.literal("verified"),
    v.literal("failed"),
  ),
  total: v.number(),
  pending: v.number(),
  submitted: v.number(),
  passed: v.number(),
  failed: v.number(),
  checks: v.array(assuranceCheckValidator),
});

function cleanText(value: string, label: string, max: number) {
  const text = value.trim();
  if (!text) throw new ConvexError(`${label} is required`);
  if (text.length > max) {
    throw new ConvexError(`${label} must be ${max} characters or fewer`);
  }
  return text;
}

function cleanLinks(links: string[]) {
  if (links.length > 20) {
    throw new ConvexError("evidenceLinks may contain at most 20 URLs");
  }
  return links.map((link) => {
    let parsed: URL;
    try {
      parsed = new URL(link);
    } catch {
      throw new ConvexError(`Invalid evidence URL: ${link}`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new ConvexError(`Evidence URL must use http or https: ${link}`);
    }
    return link;
  });
}

async function requirePlanMember(
  ctx: ReadCtx,
  planId: Id<"executionPlans">,
) {
  const identity = await requireIdentity(ctx);
  const plan = await ctx.db.get(planId);
  if (!plan) throw new ConvexError("Execution plan not found");
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q
        .eq("userClerkId", identity.subject)
        .eq("workspaceId", plan.workspaceId),
    )
    .unique();
  if (!membership) throw new ConvexError("Forbidden");
  return { identity, plan };
}

async function checkForCriterion(
  ctx: ReadCtx,
  planId: Id<"executionPlans">,
  criterionIndex: number,
) {
  return await ctx.db
    .query("outcomeChecks")
    .withIndex("by_plan", (q) =>
      q.eq("planId", planId).eq("criterionIndex", criterionIndex),
    )
    .unique();
}

export async function outcomeAssuranceView(
  ctx: ReadCtx,
  plan: Doc<"executionPlans">,
) {
  const stored = await ctx.db
    .query("outcomeChecks")
    .withIndex("by_plan", (q) => q.eq("planId", plan._id))
    .take(25);
  const byIndex = new Map(stored.map((row) => [row.criterionIndex, row]));
  const agentIds = new Set<Id<"agents">>();
  for (const row of stored) {
    if (row.submittedByAgentId) agentIds.add(row.submittedByAgentId);
    if (row.reviewedByActorType === "agent" && row.reviewedByActorId) {
      agentIds.add(row.reviewedByActorId as Id<"agents">);
    }
  }
  const agents = await Promise.all([...agentIds].map((id) => ctx.db.get(id)));
  const agentNames = new Map(
    agents.filter((agent) => agent !== null).map((agent) => [agent._id as string, agent.name]),
  );
  const userIds = new Set(
    stored
      .filter((row) => row.reviewedByActorType === "user")
      .map((row) => row.reviewedByActorId)
      .filter((id): id is string => Boolean(id)),
  );
  const users = await Promise.all(
    [...userIds].map((clerkId) =>
      ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", clerkId))
        .unique(),
    ),
  );
  const userNames = new Map(
    users
      .filter((user) => user !== null)
      .map((user) => [user.clerkId, user.name ?? user.email]),
  );
  const checks = plan.successCriteria.map((criterion, criterionIndex) => {
    const row = byIndex.get(criterionIndex);
    return {
      checkId: row?._id ?? null,
      criterionIndex,
      criterion,
      status: row?.status ?? ("pending" as const),
      submittedByAgentId: row?.submittedByAgentId,
      submitterName: row?.submittedByAgentId
        ? agentNames.get(row.submittedByAgentId)
        : undefined,
      evidenceSummary: row?.evidenceSummary,
      evidenceLinks: row?.evidenceLinks ?? [],
      submittedAt: row?.submittedAt,
      reviewedByActorType: row?.reviewedByActorType,
      reviewedByActorId: row?.reviewedByActorId,
      reviewerName:
        row?.reviewedByActorType === "agent"
          ? agentNames.get(row.reviewedByActorId ?? "")
          : userNames.get(row?.reviewedByActorId ?? ""),
      reviewNote: row?.reviewNote,
      reviewedAt: row?.reviewedAt,
    };
  });
  const counts = { pending: 0, submitted: 0, passed: 0, failed: 0 };
  for (const check of checks) counts[check.status] += 1;
  const status =
    counts.failed > 0
      ? ("failed" as const)
      : counts.passed === checks.length
        ? ("verified" as const)
        : counts.submitted > 0 || counts.passed > 0
          ? ("in_review" as const)
          : ("unverified" as const);
  return {
    planId: plan._id,
    status,
    total: checks.length,
    ...counts,
    checks,
  };
}

export async function submitOutcomeEvidenceCore(
  ctx: MutationCtx,
  plan: Doc<"executionPlans">,
  criterionIndex: number,
  agentId: Id<"agents">,
  evidenceSummary: string,
  evidenceLinks: string[],
) {
  if (!Number.isInteger(criterionIndex)) {
    throw new ConvexError("criterionIndex must be an integer");
  }
  const criterion = plan.successCriteria[criterionIndex];
  if (criterion === undefined) {
    throw new ConvexError("criterionIndex is outside this plan's success criteria");
  }
  const summary = cleanText(evidenceSummary, "evidenceSummary", 2_000);
  const links = cleanLinks(evidenceLinks);
  if (links.length === 0) {
    throw new ConvexError("At least one evidence link is required");
  }
  const existing = await checkForCriterion(ctx, plan._id, criterionIndex);
  const now = Date.now();
  const patch = {
    criterion,
    status: "submitted" as const,
    submittedByAgentId: agentId,
    evidenceSummary: summary,
    evidenceLinks: links,
    submittedAt: now,
    reviewedByActorType: undefined,
    reviewedByActorId: undefined,
    reviewNote: undefined,
    reviewedAt: undefined,
    updatedAt: now,
  };
  if (existing) {
    await ctx.db.patch(existing._id, patch);
    return existing._id;
  }
  return await ctx.db.insert("outcomeChecks", {
    planId: plan._id,
    criterionIndex,
    ...patch,
  });
}

export async function reviewOutcomeCriterionCore(
  ctx: MutationCtx,
  plan: Doc<"executionPlans">,
  criterionIndex: number,
  verdict: "passed" | "failed",
  reviewNote: string,
  actor: Actor,
) {
  if (!Number.isInteger(criterionIndex)) {
    throw new ConvexError("criterionIndex must be an integer");
  }
  const criterion = plan.successCriteria[criterionIndex];
  if (criterion === undefined) {
    throw new ConvexError("criterionIndex is outside this plan's success criteria");
  }
  const existing = await checkForCriterion(ctx, plan._id, criterionIndex);
  if (!existing || existing.status === "pending") {
    throw new ConvexError("Evidence must be submitted before review");
  }
  if (
    actor.type === "agent" &&
    existing.submittedByAgentId === actor.id
  ) {
    throw new ConvexError(
      "Independent review required: an agent cannot approve its own evidence",
    );
  }
  const note = cleanText(reviewNote, "reviewNote", 2_000);
  const now = Date.now();
  await ctx.db.patch(existing._id, {
    status: verdict,
    reviewedByActorType: actor.type === "system" ? "user" : actor.type,
    reviewedByActorId: actor.id,
    reviewNote: note,
    reviewedAt: now,
    updatedAt: now,
  });
  await emitEvent(ctx, {
    scopeType: "workspace",
    scopeId: plan.workspaceId,
    type: `outcome.${verdict}`,
    actor,
    entityType: "executionPlan",
    entityId: plan._id,
    entityTitle: plan.name,
    payload: { criterionIndex, criterion, verdict },
  });
  return existing._id;
}

export const get = query({
  args: { planId: v.id("executionPlans") },
  returns: v.union(assuranceValidator, v.null()),
  handler: async (ctx, { planId }) => {
    const { plan } = await requirePlanMember(ctx, planId);
    return await outcomeAssuranceView(ctx, plan);
  },
});

export const review = mutation({
  args: {
    planId: v.id("executionPlans"),
    criterionIndex: v.number(),
    verdict: v.union(v.literal("passed"), v.literal("failed")),
    reviewNote: v.string(),
  },
  returns: v.id("outcomeChecks"),
  handler: async (ctx, args) => {
    const { identity, plan } = await requirePlanMember(ctx, args.planId);
    const actor = await userActor(ctx, identity.subject);
    return await reviewOutcomeCriterionCore(
      ctx,
      plan,
      args.criterionIndex,
      args.verdict,
      args.reviewNote,
      actor,
    );
  },
});
