import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireListAccess } from "./_authz";

const categoryValidator = v.union(
  v.literal("open"),
  v.literal("in_progress"),
  v.literal("complete"),
  v.literal("closed"),
);

// Default 4 statuses every list starts with. Mirrors ClickUp's defaults
// closely; users can rename/recolor/add more from the list settings page.
export const DEFAULT_STATUSES = [
  { name: "To Do", color: "#c9ccd4", category: "open" as const },
  {
    name: "In Progress",
    color: "#a9c6f2",
    category: "in_progress" as const,
  },
  { name: "Complete", color: "#a9dcbd", category: "complete" as const },
  { name: "Closed", color: "#c2c2ca", category: "closed" as const },
];

// Internal helper used by lists.create. Not a mutation — invoked
// directly inside the same write transaction.
export async function seedDefaultStatuses(
  ctx: MutationCtx,
  listId: Id<"lists">,
  // Space-level default statuses (ClickUp-style): when provided, new lists
  // in that space inherit these instead of the global four.
  overrides?: { name: string; color: string; category: "open" | "in_progress" | "complete" | "closed" }[],
): Promise<Id<"listStatuses">[]> {
  const defs =
    overrides && overrides.length > 0 ? overrides : DEFAULT_STATUSES;
  const ids: Id<"listStatuses">[] = [];
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    const id = await ctx.db.insert("listStatuses", {
      listId,
      name: def.name,
      color: def.color,
      category: def.category,
      position: i,
      createdAt: Date.now(),
    });
    ids.push(id);
  }
  return ids;
}

export const listForList = query({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) => {
    // Full hierarchy check — status names must not be enumerable by ID.
    try {
      await requireListAccess(ctx, listId);
    } catch {
      return [];
    }
    const statuses = await ctx.db
      .query("listStatuses")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect();
    return statuses.sort((a, b) => a.position - b.position);
  },
});

export const create = mutation({
  args: {
    listId: v.id("lists"),
    name: v.string(),
    color: v.string(),
    category: categoryValidator,
  },
  handler: async (ctx, args) => {
    await requireListAccess(ctx, args.listId);
    const siblings = await ctx.db
      .query("listStatuses")
      .withIndex("by_list", (q) => q.eq("listId", args.listId))
      .collect();
    return await ctx.db.insert("listStatuses", {
      listId: args.listId,
      name: args.name,
      color: args.color,
      category: args.category,
      position: siblings.length,
      createdAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: {
    statusId: v.id("listStatuses"),
    name: v.optional(v.string()),
    color: v.optional(v.string()),
    category: v.optional(categoryValidator),
  },
  handler: async (ctx, args) => {
    const status = await ctx.db.get(args.statusId);
    if (!status) throw new Error("Status not found");
    await requireListAccess(ctx, status.listId);

    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) patch.name = args.name;
    if (args.color !== undefined) patch.color = args.color;
    if (args.category !== undefined) patch.category = args.category;
    await ctx.db.patch(args.statusId, patch);
  },
});

export const remove = mutation({
  args: {
    statusId: v.id("listStatuses"),
    // The status to reassign tasks to. Required because every task must
    // have a statusId — we never leave them dangling.
    replaceWithId: v.id("listStatuses"),
  },
  handler: async (ctx, { statusId, replaceWithId }) => {
    if (statusId === replaceWithId) {
      throw new Error("Replacement status must differ from the deleted one");
    }
    const status = await ctx.db.get(statusId);
    if (!status) throw new Error("Status not found");
    await requireListAccess(ctx, status.listId);

    const replacement = await ctx.db.get(replaceWithId);
    if (!replacement || replacement.listId !== status.listId) {
      throw new Error("Replacement status must belong to the same list");
    }

    const tasksToReassign = await ctx.db
      .query("tasks")
      .withIndex("by_list_and_status", (q) =>
        q.eq("listId", status.listId).eq("statusId", statusId),
      )
      .collect();
    for (const t of tasksToReassign) {
      await ctx.db.patch(t._id, { statusId: replaceWithId });
    }

    await ctx.db.delete(statusId);
  },
});

export const reorder = mutation({
  args: {
    listId: v.id("lists"),
    orderedIds: v.array(v.id("listStatuses")),
  },
  handler: async (ctx, { listId, orderedIds }) => {
    await requireListAccess(ctx, listId);
    for (let i = 0; i < orderedIds.length; i++) {
      const status = await ctx.db.get(orderedIds[i]);
      if (!status || status.listId !== listId) continue;
      await ctx.db.patch(orderedIds[i], { position: i });
    }
  },
});
