import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireIdentity } from "./_authz";
import { emitEvent, userActor } from "./events";

export type ExecutionPolicy = {
  mode: "supervised" | "bounded_autonomous";
  version: number;
  maxPlanTasks: number;
  maxTasksPerWave: number;
  dailyTaskLimit: number;
  updatedByClerkId: string | null;
  updatedAt: number | null;
};

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  mode: "supervised",
  version: 0,
  maxPlanTasks: 25,
  maxTasksPerWave: 10,
  dailyTaskLimit: 100,
  updatedByClerkId: null,
  updatedAt: null,
};

export const executionPolicyValidator = v.object({
  mode: v.union(
    v.literal("supervised"),
    v.literal("bounded_autonomous"),
  ),
  version: v.number(),
  maxPlanTasks: v.number(),
  maxTasksPerWave: v.number(),
  dailyTaskLimit: v.number(),
  updatedByClerkId: v.union(v.string(), v.null()),
  updatedAt: v.union(v.number(), v.null()),
});

export function executionPolicyFor(
  workspace: Doc<"workspaces">,
): ExecutionPolicy {
  const stored = workspace.executionPolicy;
  if (!stored) return DEFAULT_EXECUTION_POLICY;
  return stored;
}

export function planAuthorization(
  plan: Doc<"executionPlans">,
  policy: ExecutionPolicy,
): {
  authorized: boolean;
  source: "legacy" | "human_review" | "workspace_policy" | "none";
  reason: string;
} {
  if (plan.reviewStatus === undefined) {
    return {
      authorized: true,
      source: "legacy",
      reason: "Plan predates execution authorization controls.",
    };
  }
  if (plan.reviewStatus === "pending") {
    return {
      authorized: false,
      source: "none",
      reason: "Awaiting owner or admin approval.",
    };
  }
  if (plan.reviewStatus === "rejected") {
    return {
      authorized: false,
      source: "none",
      reason: "Rejected by a workspace reviewer.",
    };
  }
  if (plan.authorizationSource !== "workspace_policy") {
    return {
      authorized: true,
      source: "human_review",
      reason: "Approved by a workspace owner or admin.",
    };
  }
  if (policy.mode !== "bounded_autonomous") {
    return {
      authorized: false,
      source: "workspace_policy",
      reason:
        "Workspace is no longer in bounded autonomous mode; human re-approval is required.",
    };
  }
  if (plan.authorizationPolicyVersion !== policy.version) {
    return {
      authorized: false,
      source: "workspace_policy",
      reason:
        "Workspace autonomy limits changed after this plan was authorized; human re-approval is required.",
    };
  }
  return {
    authorized: true,
    source: "workspace_policy",
    reason:
      plan.authorizationReason ??
      "Authorized by the active bounded-autonomy policy.",
  };
}

async function requireWorkspaceMembership(
  ctx: QueryCtx | MutationCtx,
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
  const workspace = await ctx.db.get(workspaceId);
  if (!workspace) throw new ConvexError("Workspace not found");
  return { identity, membership, workspace };
}

function validateInteger(
  value: number,
  label: string,
  min: number,
  max: number,
) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConvexError(`${label} must be an integer from ${min}-${max}`);
  }
}

export const getForWorkspace = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({
    policy: executionPolicyValidator,
    role: v.union(
      v.literal("owner"),
      v.literal("admin"),
      v.literal("member"),
    ),
    canEdit: v.boolean(),
  }),
  handler: async (ctx, { workspaceId }) => {
    const { membership, workspace } = await requireWorkspaceMembership(
      ctx,
      workspaceId,
    );
    return {
      policy: executionPolicyFor(workspace),
      role: membership.role,
      canEdit: membership.role === "owner",
    };
  },
});

export const update = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    mode: v.union(
      v.literal("supervised"),
      v.literal("bounded_autonomous"),
    ),
    maxPlanTasks: v.number(),
    maxTasksPerWave: v.number(),
    dailyTaskLimit: v.number(),
  },
  returns: executionPolicyValidator,
  handler: async (ctx, args) => {
    const { identity, membership, workspace } =
      await requireWorkspaceMembership(ctx, args.workspaceId);
    if (membership.role !== "owner") {
      throw new ConvexError(
        "Only workspace owners can change execution authority",
      );
    }
    validateInteger(args.maxPlanTasks, "maxPlanTasks", 1, 100);
    validateInteger(args.maxTasksPerWave, "maxTasksPerWave", 1, 25);
    validateInteger(args.dailyTaskLimit, "dailyTaskLimit", 1, 1_000);
    if (args.maxTasksPerWave > args.maxPlanTasks) {
      throw new ConvexError(
        "maxTasksPerWave cannot exceed maxPlanTasks",
      );
    }
    const current = executionPolicyFor(workspace);
    const updatedAt = Date.now();
    const policy = {
      mode: args.mode,
      version: current.version + 1,
      maxPlanTasks: args.maxPlanTasks,
      maxTasksPerWave: args.maxTasksPerWave,
      dailyTaskLimit: args.dailyTaskLimit,
      updatedByClerkId: identity.subject,
      updatedAt,
    } satisfies NonNullable<Doc<"workspaces">["executionPolicy"]>;
    await ctx.db.patch(args.workspaceId, { executionPolicy: policy });
    await emitEvent(ctx, {
      scopeType: "workspace",
      scopeId: args.workspaceId,
      type: "workspace.execution_policy_updated",
      actor: await userActor(ctx, identity.subject),
      entityType: "workspace",
      entityId: args.workspaceId,
      entityTitle: workspace.name,
      payload: {
        mode: policy.mode,
        version: policy.version,
        maxPlanTasks: policy.maxPlanTasks,
        maxTasksPerWave: policy.maxTasksPerWave,
        dailyTaskLimit: policy.dailyTaskLimit,
      },
    });
    return policy;
  },
});
