import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireIdentity } from "./_authz";

const parentTypeValidator = v.union(
  v.literal("user"),
  v.literal("workspace"),
);

const targetTypeValidator = v.union(
  v.literal("number"),
  v.literal("money"),
  v.literal("boolean"),
);

const statusValidator = v.union(
  v.literal("open"),
  v.literal("complete"),
  v.literal("abandoned"),
);

async function checkParentAccess(
  ctx: Parameters<typeof requireIdentity>[0],
  parentType: "user" | "workspace",
  parentId: string,
): Promise<{ subject: string }> {
  const identity = await requireIdentity(ctx);
  if (parentType === "user") {
    if (parentId !== identity.subject) throw new Error("Forbidden");
  } else {
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q
          .eq("userClerkId", identity.subject)
          .eq("workspaceId", parentId as Id<"workspaces">),
      )
      .unique();
    if (!membership) throw new Error("Forbidden");
  }
  return identity;
}

export const listForParent = query({
  args: { parentType: parentTypeValidator, parentId: v.string() },
  handler: async (ctx, { parentType, parentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    try {
      await checkParentAccess(ctx, parentType, parentId);
    } catch {
      return [];
    }
    const all = await ctx.db
      .query("goals")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", parentType).eq("parentId", parentId),
      )
      .collect();
    return all.sort((a, b) => b.createdAt - a.createdAt);
  },
});

export const get = query({
  args: { goalId: v.id("goals") },
  handler: async (ctx, { goalId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const goal = await ctx.db.get(goalId);
    if (!goal) return null;
    try {
      await checkParentAccess(ctx, goal.parentType, goal.parentId);
    } catch {
      return null;
    }
    return goal;
  },
});

export const create = mutation({
  args: {
    parentType: parentTypeValidator,
    parentId: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    targetType: targetTypeValidator,
    targetValue: v.number(),
    unit: v.optional(v.string()),
    dueDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await checkParentAccess(
      ctx,
      args.parentType,
      args.parentId,
    );
    if (args.targetType === "boolean" && args.targetValue !== 1) {
      // Normalize: a boolean goal always targets 1.
      args.targetValue = 1;
    }
    return await ctx.db.insert("goals", {
      parentType: args.parentType,
      parentId: args.parentId,
      title: args.title,
      description: args.description,
      targetType: args.targetType,
      targetValue: args.targetValue,
      currentValue: 0,
      unit: args.unit,
      dueDate: args.dueDate,
      status: "open",
      ownerClerkId: identity.subject,
      createdAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: {
    goalId: v.id("goals"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    targetValue: v.optional(v.number()),
    unit: v.optional(v.string()),
    dueDate: v.optional(v.union(v.number(), v.null())),
    status: v.optional(statusValidator),
  },
  handler: async (ctx, args) => {
    const goal = await ctx.db.get(args.goalId);
    if (!goal) throw new Error("Goal not found");
    await checkParentAccess(ctx, goal.parentType, goal.parentId);

    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.description !== undefined) patch.description = args.description;
    if (args.targetValue !== undefined) patch.targetValue = args.targetValue;
    if (args.unit !== undefined) patch.unit = args.unit;
    if (args.dueDate !== undefined) patch.dueDate = args.dueDate ?? undefined;
    if (args.status !== undefined) {
      patch.status = args.status;
      patch.completedAt = args.status === "complete" ? Date.now() : undefined;
    }
    await ctx.db.patch(args.goalId, patch);
  },
});

export const setProgress = mutation({
  args: { goalId: v.id("goals"), currentValue: v.number() },
  handler: async (ctx, { goalId, currentValue }) => {
    const goal = await ctx.db.get(goalId);
    if (!goal) throw new Error("Goal not found");
    await checkParentAccess(ctx, goal.parentType, goal.parentId);

    const patch: Record<string, unknown> = { currentValue };
    if (
      goal.status === "open" &&
      goal.targetValue > 0 &&
      currentValue >= goal.targetValue
    ) {
      patch.status = "complete";
      patch.completedAt = Date.now();
    }
    await ctx.db.patch(goalId, patch);
  },
});

export const remove = mutation({
  args: { goalId: v.id("goals") },
  handler: async (ctx, { goalId }) => {
    const goal = await ctx.db.get(goalId);
    if (!goal) return;
    await checkParentAccess(ctx, goal.parentType, goal.parentId);
    await ctx.db.delete(goalId);
  },
});
