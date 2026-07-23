import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireIdentity, requireListAccess, requireTaskAccess } from "./_authz";
import { createTaskCore } from "./tasks";
import { scopeForList, userActor } from "./events";

// Task blueprints (Phase L): reusable task definitions — everything a
// well-formed task carries except the list it lands on. Define "run the
// weekly outreach checklist" once (title, description, checklist,
// priority, estimate, SOP, approval gate), then instantiate it from the
// UI or let a recurring schedule materialize it. Scoped like skills:
// personal or workspace.

const priorityValidator = v.union(
  v.literal("urgent"),
  v.literal("high"),
  v.literal("normal"),
  v.literal("low"),
);

async function requireScopeMembership(
  ctx: QueryCtx | MutationCtx,
  scopeType: "user" | "workspace",
  scopeId: string,
): Promise<string> {
  const identity = await requireIdentity(ctx);
  if (scopeType === "user") {
    if (scopeId !== identity.subject) throw new Error("Forbidden");
  } else {
    const member = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q
          .eq("userClerkId", identity.subject)
          .eq("workspaceId", scopeId as Id<"workspaces">),
      )
      .unique();
    if (!member) throw new Error("Forbidden");
  }
  return identity.subject;
}

export const listForScope = query({
  args: {
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      await requireScopeMembership(ctx, args.scopeType, args.scopeId);
    } catch {
      return [];
    }
    const rows = await ctx.db
      .query("taskBlueprints")
      .withIndex("by_scope", (q) =>
        q.eq("scopeType", args.scopeType).eq("scopeId", args.scopeId),
      )
      .collect();
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const create = mutation({
  args: {
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    name: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    priority: v.optional(priorityValidator),
    checklist: v.optional(v.array(v.string())),
    estimatePoints: v.optional(v.number()),
    sopSlug: v.optional(v.string()),
    dueInDays: v.optional(v.number()),
    requiresApproval: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const subject = await requireScopeMembership(
      ctx,
      args.scopeType,
      args.scopeId,
    );
    const name = args.name.trim();
    const title = args.title.trim();
    if (!name) throw new Error("Blueprint name is required");
    if (!title) throw new Error("Task title is required");
    return await ctx.db.insert("taskBlueprints", {
      scopeType: args.scopeType,
      scopeId: args.scopeId,
      name,
      title,
      description: args.description?.trim() || undefined,
      priority: args.priority,
      checklist: (args.checklist ?? [])
        .map((c) => c.trim())
        .filter((c) => c.length > 0),
      estimatePoints: args.estimatePoints,
      sopSlug: args.sopSlug,
      dueInDays: args.dueInDays,
      requiresApproval: args.requiresApproval || undefined,
      createdByActorId: subject,
      createdAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: {
    blueprintId: v.id("taskBlueprints"),
    name: v.optional(v.string()),
    title: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    priority: v.optional(v.union(priorityValidator, v.null())),
    checklist: v.optional(v.array(v.string())),
    estimatePoints: v.optional(v.union(v.number(), v.null())),
    sopSlug: v.optional(v.union(v.string(), v.null())),
    dueInDays: v.optional(v.union(v.number(), v.null())),
    requiresApproval: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const bp = await ctx.db.get(args.blueprintId);
    if (!bp) throw new Error("Blueprint not found");
    await requireScopeMembership(ctx, bp.scopeType, bp.scopeId);
    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (!name) throw new Error("Blueprint name is required");
      patch.name = name;
    }
    if (args.title !== undefined) {
      const title = args.title.trim();
      if (!title) throw new Error("Task title is required");
      patch.title = title;
    }
    if (args.description !== undefined) {
      patch.description = args.description?.trim() || undefined;
    }
    if (args.priority !== undefined) {
      patch.priority = args.priority ?? undefined;
    }
    if (args.checklist !== undefined) {
      patch.checklist = args.checklist
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
    }
    if (args.estimatePoints !== undefined) {
      patch.estimatePoints = args.estimatePoints ?? undefined;
    }
    if (args.sopSlug !== undefined) {
      patch.sopSlug = args.sopSlug ?? undefined;
    }
    if (args.dueInDays !== undefined) {
      patch.dueInDays = args.dueInDays ?? undefined;
    }
    if (args.requiresApproval !== undefined) {
      patch.requiresApproval = args.requiresApproval || undefined;
    }
    await ctx.db.patch(bp._id, patch);
  },
});

export const remove = mutation({
  args: { blueprintId: v.id("taskBlueprints") },
  handler: async (ctx, { blueprintId }) => {
    const bp = await ctx.db.get(blueprintId);
    if (!bp) return;
    await requireScopeMembership(ctx, bp.scopeType, bp.scopeId);
    // Schedules keep their (now-dangling) blueprintId: the materializer
    // tolerates it and falls back to the schedule's own title/description,
    // and opsOverview simply shows no blueprint name. Cheaper than an
    // O(platform) scan to clear back-references.
    await ctx.db.delete(bp._id);
  },
});

// Capture an existing task as a blueprint — the fastest way to turn "we
// did this well once" into a repeatable operation.
export const saveFromTask = mutation({
  args: { taskId: v.id("tasks"), name: v.string() },
  handler: async (ctx, args) => {
    const { task, list } = await requireTaskAccess(ctx, args.taskId);
    const identity = await requireIdentity(ctx);
    const scope = await scopeForList(ctx, list);
    if (!scope) throw new Error("Couldn't resolve the task's scope");
    const name = args.name.trim();
    if (!name) throw new Error("Blueprint name is required");
    return await ctx.db.insert("taskBlueprints", {
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      name,
      title: task.title,
      description: task.description,
      priority: task.priority,
      checklist: (task.checklist ?? []).map((c) => c.text),
      estimatePoints: task.estimatePoints,
      sopSlug: list.sopSlug,
      requiresApproval: task.requiresApproval || undefined,
      createdByActorId: identity.subject,
      createdAt: Date.now(),
    });
  },
});

// Shared blueprint → CreateTaskArgs assembly, used by the mutation below
// and by the recurring-schedule materializer (scheduledTasks.ts).
export function blueprintTaskFields(bp: {
  title: string;
  description?: string;
  priority?: "urgent" | "high" | "normal" | "low";
  checklist: string[];
  estimatePoints?: number;
  dueInDays?: number;
  requiresApproval?: boolean;
}): {
  title: string;
  description?: string;
  priority?: "urgent" | "high" | "normal" | "low";
  checklist?: { id: string; text: string; done: boolean }[];
  estimatePoints?: number;
  dueDate?: number;
  requiresApproval?: boolean;
} {
  return {
    title: bp.title,
    description: bp.description,
    priority: bp.priority,
    checklist:
      bp.checklist.length > 0
        ? bp.checklist.map((text, i) => ({
            id: `bp_${Date.now().toString(36)}_${i}`,
            text,
            done: false,
          }))
        : undefined,
    estimatePoints: bp.estimatePoints,
    dueDate:
      bp.dueInDays !== undefined
        ? Date.now() + bp.dueInDays * 24 * 60 * 60 * 1000
        : undefined,
    requiresApproval: bp.requiresApproval,
  };
}

// Instantiate a blueprint into a list. Goes through createTaskCore, so
// routing, automations, rollups, and events all apply exactly as if a
// human typed the task in.
export const instantiate = mutation({
  args: {
    blueprintId: v.id("taskBlueprints"),
    listId: v.id("lists"),
    assigneeIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const bp = await ctx.db.get(args.blueprintId);
    if (!bp) throw new Error("Blueprint not found");
    await requireScopeMembership(ctx, bp.scopeType, bp.scopeId);
    const { list } = await requireListAccess(ctx, args.listId);
    const scope = await scopeForList(ctx, list);
    if (
      !scope ||
      scope.scopeType !== bp.scopeType ||
      scope.scopeId !== bp.scopeId
    ) {
      throw new Error("Blueprint belongs to a different scope");
    }
    const identity = await requireIdentity(ctx);
    const actor = await userActor(ctx, identity.subject);
    return await createTaskCore(
      ctx,
      {
        listId: args.listId,
        assigneeIds: args.assigneeIds,
        ...blueprintTaskFields(bp),
      },
      actor,
    );
  },
});
