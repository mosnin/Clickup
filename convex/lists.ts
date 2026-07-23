import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  canAccessSpace,
  requireFolderAccess,
  requireListAccess,
  requireSpaceAccess,
} from "./_authz";
import { seedDefaultStatuses } from "./listStatuses";
import { cleanupTaskArtifacts } from "./tasks";

const parentTypeValidator = v.union(
  v.literal("space"),
  v.literal("folder"),
);

export const listForParent = query({
  args: { parentType: parentTypeValidator, parentId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    // Resolve up to the owning space and gate on it — being logged in
    // must not be enough to enumerate a private space's projects by ID.
    let space;
    if (args.parentType === "space") {
      space = await ctx.db.get(args.parentId as Id<"spaces">);
    } else {
      const folder = await ctx.db.get(args.parentId as Id<"folders">);
      if (!folder) return [];
      space = await ctx.db.get(folder.spaceId);
    }
    if (!space) return [];
    if (!(await canAccessSpace(ctx, space, { subject: identity.subject }))) {
      return [];
    }
    return await ctx.db
      .query("lists")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", args.parentType).eq("parentId", args.parentId),
      )
      .collect();
  },
});

export const get = query({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const list = await ctx.db.get(listId);
    if (!list) return null;
    let space;
    if (list.parentType === "space") {
      space = await ctx.db.get(list.parentId as Id<"spaces">);
    } else {
      const folder = await ctx.db.get(list.parentId as Id<"folders">);
      if (!folder) return null;
      space = await ctx.db.get(folder.spaceId);
    }
    if (!space) return null;
    if (!(await canAccessSpace(ctx, space, { subject: identity.subject }))) {
      return null;
    }
    return list;
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    color: v.optional(v.string()),
    parentType: parentTypeValidator,
    parentId: v.string(),
  },
  handler: async (ctx, args) => {
    let spaceId: Id<"spaces">;
    if (args.parentType === "space") {
      await requireSpaceAccess(ctx, args.parentId as Id<"spaces">);
      spaceId = args.parentId as Id<"spaces">;
    } else {
      const { folder } = await requireFolderAccess(
        ctx,
        args.parentId as Id<"folders">,
      );
      spaceId = folder.spaceId;
    }

    const siblings = await ctx.db
      .query("lists")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", args.parentType).eq("parentId", args.parentId),
      )
      .collect();

    const listId = await ctx.db.insert("lists", {
      ...args,
      position: siblings.length,
      createdAt: Date.now(),
    });

    const space = await ctx.db.get(spaceId);
    await seedDefaultStatuses(ctx, listId, space?.defaultStatuses);

    return listId;
  },
});

// Reorder the lists under one parent (space or folder). Takes the full
// desired order; ids that no longer live under this parent are skipped
// (stale client state) rather than corrupting positions, and only rows
// whose position actually changed get patched.
export const reorder = mutation({
  args: {
    parentType: parentTypeValidator,
    parentId: v.string(),
    orderedIds: v.array(v.id("lists")),
  },
  handler: async (ctx, args) => {
    if (args.parentType === "space") {
      await requireSpaceAccess(ctx, args.parentId as Id<"spaces">);
    } else {
      await requireFolderAccess(ctx, args.parentId as Id<"folders">);
    }
    for (let i = 0; i < args.orderedIds.length; i++) {
      const list = await ctx.db.get(args.orderedIds[i]);
      if (
        !list ||
        list.parentType !== args.parentType ||
        list.parentId !== args.parentId
      ) {
        continue;
      }
      if (list.position !== i) {
        await ctx.db.patch(list._id, { position: i });
      }
    }
  },
});

export const rename = mutation({
  args: { listId: v.id("lists"), name: v.string() },
  handler: async (ctx, { listId, name }) => {
    const { list } = await requireListAccess(ctx, listId);
    await ctx.db.patch(list._id, { name });
  },
});

// Project metadata: description, health status, owner, notes, target date.
// null clears an optional field; omitted fields stay untouched.
export const updateMeta = mutation({
  args: {
    listId: v.id("lists"),
    description: v.optional(v.union(v.string(), v.null())),
    projectStatus: v.optional(
      v.union(
        v.literal("on_track"),
        v.literal("at_risk"),
        v.literal("off_track"),
        v.literal("paused"),
        v.null(),
      ),
    ),
    ownerActorId: v.optional(v.union(v.string(), v.null())),
    notes: v.optional(v.union(v.string(), v.null())),
    targetDate: v.optional(v.union(v.number(), v.null())),
    sopSlug: v.optional(v.union(v.string(), v.null())),
    defaultView: v.optional(
      v.union(
        v.literal("list"),
        v.literal("board"),
        v.literal("calendar"),
        v.literal("gantt"),
        v.literal("table"),
        v.literal("workload"),
        v.null(),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const { list } = await requireListAccess(ctx, args.listId);
    const patch: Record<string, unknown> = {};
    for (const key of [
      "description",
      "projectStatus",
      "ownerActorId",
      "notes",
      "targetDate",
      "sopSlug",
      "defaultView",
    ] as const) {
      if (args[key] !== undefined) {
        patch[key] = args[key] === null ? undefined : args[key];
      }
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(list._id, patch);
    }
  },
});

// Assignment routing rule for a list (Phase L). null clears the rule.
// Explicitly-assigned tasks are never touched — routing only fills in an
// assignee when a task is created without one (see tasks.createTaskCore).
export const setRouting = mutation({
  args: {
    listId: v.id("lists"),
    routing: v.union(
      v.object({
        mode: v.union(
          v.literal("fixed"),
          v.literal("round_robin"),
          v.literal("least_loaded"),
        ),
        assigneeIds: v.array(v.string()),
      }),
      v.null(),
    ),
  },
  handler: async (ctx, args) => {
    const { list, space } = await requireListAccess(ctx, args.listId);
    if (args.routing === null) {
      await ctx.db.patch(list._id, { routing: undefined });
      return;
    }
    if (args.routing.assigneeIds.length === 0) {
      throw new Error("Pick at least one assignee to route to");
    }
    // Every roster entry must be a real principal in this list's scope —
    // routing fires automatically on every future task, so a bad entry
    // here means recurring notifications to someone outside the team.
    const scopeType = space.parentType;
    const scopeId = space.parentId;
    for (const id of args.routing.assigneeIds) {
      const agentId = ctx.db.normalizeId("agents", id);
      if (agentId) {
        const agent = await ctx.db.get(agentId);
        if (
          !agent ||
          agent.parentType !== scopeType ||
          agent.parentId !== scopeId
        ) {
          throw new Error("Agent isn't part of this space");
        }
        continue;
      }
      if (scopeType === "user") {
        if (id !== scopeId) throw new Error("Unknown assignee");
      } else {
        const membership = await ctx.db
          .query("memberships")
          .withIndex("by_user_and_workspace", (q) =>
            q
              .eq("userClerkId", id)
              .eq("workspaceId", scopeId as Id<"workspaces">),
          )
          .unique();
        if (!membership) {
          throw new Error("Assignees must be members of this workspace");
        }
      }
    }
    await ctx.db.patch(list._id, {
      // Fresh rule, fresh rotation cursor.
      routing: { ...args.routing, lastIndex: undefined },
    });
  },
});

export const remove = mutation({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) => {
    const { list } = await requireListAccess(ctx, listId);

    // Goals tracking this list: freeze each at its current derived value
    // BEFORE the cascade destroys the tasks/statuses it derives from —
    // deleting a project must never zero a goal's history.
    const linkedGoals = await ctx.db
      .query("goals")
      .withIndex("by_source", (q) => q.eq("sourceListId", list._id))
      .collect();
    if (linkedGoals.length > 0) {
      const statusRows = await ctx.db
        .query("listStatuses")
        .withIndex("by_list", (q) => q.eq("listId", list._id))
        .collect();
      const doneIds = new Set(
        statusRows
          .filter((s) => s.category === "complete" || s.category === "closed")
          .map((s) => s._id),
      );
      const taskRows = await ctx.db
        .query("tasks")
        .withIndex("by_list", (q) => q.eq("listId", list._id))
        .collect();
      const done = taskRows.filter((t) => doneIds.has(t.statusId)).length;
      for (const goal of linkedGoals) {
        const complete =
          goal.status !== "abandoned" &&
          goal.targetValue > 0 &&
          done >= goal.targetValue;
        await ctx.db.patch(goal._id, {
          sourceListId: undefined,
          currentValue: done,
          status:
            goal.status === "abandoned"
              ? "abandoned"
              : complete
                ? "complete"
                : "open",
          completedAt: complete ? goal.completedAt ?? Date.now() : undefined,
        });
      }
    }

    // Cascade everything that hangs off this list: tasks (with their
    // comments/mentions/time entries/clips/field values), statuses,
    // custom fields, automations, and recurring schedules.
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_list", (q) => q.eq("listId", list._id))
      .collect();
    for (const t of tasks) {
      await cleanupTaskArtifacts(ctx, t._id);
      await ctx.db.delete(t._id);
    }

    const statuses = await ctx.db
      .query("listStatuses")
      .withIndex("by_list", (q) => q.eq("listId", list._id))
      .collect();
    for (const s of statuses) await ctx.db.delete(s._id);

    const fields = await ctx.db
      .query("customFields")
      .withIndex("by_list", (q) => q.eq("listId", list._id))
      .collect();
    for (const f of fields) await ctx.db.delete(f._id);

    const automations = await ctx.db
      .query("listAutomations")
      .withIndex("by_list", (q) => q.eq("listId", list._id))
      .collect();
    for (const a of automations) await ctx.db.delete(a._id);

    const schedules = await ctx.db
      .query("scheduledTasks")
      .withIndex("by_list", (q) => q.eq("listId", list._id))
      .collect();
    for (const st of schedules) await ctx.db.delete(st._id);

    const rollup = await ctx.db
      .query("listRollups")
      .withIndex("by_list", (q) => q.eq("listId", list._id))
      .unique();
    if (rollup) await ctx.db.delete(rollup._id);

    await ctx.db.delete(list._id);
  },
});
