import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  canAccessSpace,
  requireIdentity,
  requireSpaceAccess,
} from "./_authz";
import { getRollup } from "./rollups";

export const personal = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "user").eq("parentId", identity.subject),
      )
      // .first(), not .unique(): tolerate a duplicated personal-space row.
      .first();
  },
});

export const listForWorkspace = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
      )
      .unique();
    if (!membership) return [];

    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "workspace").eq("parentId", workspaceId),
      )
      .collect();
    // Private spaces are visible only to the creator, listed members, and
    // the workspace owner — same rule the sidebar tree applies. Never hand
    // back memberClerkIds/description of a space the caller can't enter.
    const ws = await ctx.db.get(workspaceId);
    return spaces.filter((sp) => {
      if (!sp.private) return true;
      return (
        sp.createdByClerkId === identity.subject ||
        (sp.memberClerkIds ?? []).includes(identity.subject) ||
        ws?.ownerClerkId === identity.subject
      );
    });
  },
});

export const get = query({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const space = await ctx.db.get(spaceId);
    if (!space) return null;
    if (!(await canAccessSpace(ctx, space, { subject: identity.subject }))) {
      return null;
    }
    return space;
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    color: v.optional(v.string()),
    parentType: v.union(v.literal("user"), v.literal("workspace")),
    parentId: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);

    if (args.parentType === "user") {
      if (args.parentId !== identity.subject) {
        throw new Error("Cannot create a personal space for another user");
      }
    } else {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_user_and_workspace", (q) =>
          q
            .eq("userClerkId", identity.subject)
            .eq("workspaceId", args.parentId as Id<"workspaces">),
        )
        .unique();
      if (!membership) throw new Error("Not a member of this workspace");
    }

    const siblings = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", args.parentType).eq("parentId", args.parentId),
      )
      .collect();

    return await ctx.db.insert("spaces", {
      ...args,
      position: siblings.length,
      createdAt: Date.now(),
      createdByClerkId: identity.subject,
    });
  },
});

const STATUS_CATEGORY = v.union(
  v.literal("open"),
  v.literal("in_progress"),
  v.literal("complete"),
  v.literal("closed"),
);

// Space identity + governance: description, color, privacy, default
// statuses, archive. null clears an optional field; omitted = untouched.
export const updateMeta = mutation({
  args: {
    spaceId: v.id("spaces"),
    name: v.optional(v.string()),
    color: v.optional(v.union(v.string(), v.null())),
    description: v.optional(v.union(v.string(), v.null())),
    private: v.optional(v.boolean()),
    memberClerkIds: v.optional(v.array(v.string())),
    archived: v.optional(v.boolean()),
    defaultStatuses: v.optional(
      v.union(
        v.array(
          v.object({
            name: v.string(),
            color: v.string(),
            category: STATUS_CATEGORY,
          }),
        ),
        v.null(),
      ),
    ),
    features: v.optional(
      v.object({
        sprints: v.optional(v.boolean()),
        timeTracking: v.optional(v.boolean()),
        goals: v.optional(v.boolean()),
        whiteboards: v.optional(v.boolean()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const { space, identity } = await requireSpaceAccess(ctx, args.spaceId);
    if (space.parentType === "user" && args.private !== undefined) {
      throw new Error("Personal spaces are always private");
    }
    // Only the creator or the workspace owner may change privacy, so a
    // member can't lock teammates out of a shared space.
    if (args.private !== undefined || args.memberClerkIds !== undefined) {
      const ws =
        space.parentType === "workspace"
          ? await ctx.db.get(space.parentId as Id<"workspaces">)
          : null;
      const mayGovern =
        space.createdByClerkId === identity.subject ||
        ws?.ownerClerkId === identity.subject ||
        space.createdByClerkId === undefined; // legacy spaces: any member
      if (!mayGovern) {
        throw new Error("Only the space creator or workspace owner can change privacy");
      }
    }

    const patch: Record<string, unknown> = {};
    if (args.name !== undefined && args.name.trim()) patch.name = args.name.trim();
    if (args.color !== undefined) patch.color = args.color ?? undefined;
    if (args.description !== undefined) {
      patch.description = args.description ?? undefined;
    }
    if (args.private !== undefined) {
      patch.private = args.private || undefined;
      // Going private always keeps the actor inside.
      if (args.private) {
        const members = new Set(args.memberClerkIds ?? space.memberClerkIds ?? []);
        members.add(identity.subject);
        patch.memberClerkIds = [...members];
      }
    } else if (args.memberClerkIds !== undefined) {
      const members = new Set(args.memberClerkIds);
      members.add(identity.subject);
      patch.memberClerkIds = [...members];
    }
    if (args.archived !== undefined) {
      patch.archivedAt = args.archived ? Date.now() : undefined;
    }
    if (args.defaultStatuses !== undefined) {
      patch.defaultStatuses = args.defaultStatuses ?? undefined;
    }
    if (args.features !== undefined) patch.features = args.features;
    if (Object.keys(patch).length > 0) await ctx.db.patch(space._id, patch);
  },
});

// The Space page's live payload: identity + governance + everything inside,
// with per-list rollups. Access (incl. privacy) enforced via requireSpaceAccess.
export const overview = query({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const space = await ctx.db.get(spaceId);
    if (!space) return null;
    if (!(await canAccessSpace(ctx, space, { subject: identity.subject }))) {
      return null;
    }

    const now = Date.now();
    const folders = await ctx.db
      .query("folders")
      .withIndex("by_space", (q) => q.eq("spaceId", spaceId))
      .collect();
    const folderName = new Map(folders.map((f) => [f._id as string, f.name]));

    const direct = await ctx.db
      .query("lists")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "space").eq("parentId", spaceId),
      )
      .collect();
    const nested = (
      await Promise.all(
        folders.map((f) =>
          ctx.db
            .query("lists")
            .withIndex("by_parent", (q) =>
              q.eq("parentType", "folder").eq("parentId", f._id),
            )
            .collect(),
        ),
      )
    ).flat();

    const lists = await Promise.all(
      [...direct, ...nested].map(async (list) => {
        const rollup = await getRollup(ctx, list._id);
        const folder =
          list.parentType === "folder"
            ? folderName.get(list.parentId) ?? null
            : null;

        // total/done come from the maintained rollup (convex/rollups.ts,
        // kept up to date by tasks.ts's *Core write paths). Overdue still
        // needs per-task due dates, so only scan tasks when the rollup
        // shows open ones exist (or there's no rollup row yet to trust —
        // queries can't write, so that case just falls back to a plain
        // scan without persisting anything).
        if (rollup && rollup.total - rollup.done <= 0) {
          return {
            listId: list._id,
            name: list.name,
            folder,
            projectStatus: list.projectStatus,
            description: list.description,
            total: rollup.total,
            done: rollup.done,
            overdue: 0,
          };
        }

        const statuses = await ctx.db
          .query("listStatuses")
          .withIndex("by_list", (q) => q.eq("listId", list._id))
          .collect();
        const doneIds = new Set(
          statuses
            .filter((s) => s.category === "complete" || s.category === "closed")
            .map((s) => s._id),
        );
        const tasks = await ctx.db
          .query("tasks")
          .withIndex("by_list", (q) => q.eq("listId", list._id))
          .collect();
        let scannedDone = 0;
        let overdue = 0;
        for (const t of tasks) {
          const isDone = doneIds.has(t.statusId);
          if (isDone) scannedDone += 1;
          else if (t.dueDate && t.dueDate < now) overdue += 1;
        }
        return {
          listId: list._id,
          name: list.name,
          folder,
          projectStatus: list.projectStatus,
          description: list.description,
          total: rollup ? rollup.total : tasks.length,
          done: rollup ? rollup.done : scannedDone,
          overdue,
        };
      }),
    );

    const docs = await ctx.db
      .query("docs")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "space").eq("parentId", spaceId),
      )
      .collect();
    const whiteboards = await ctx.db
      .query("whiteboards")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "space").eq("parentId", spaceId),
      )
      .collect();

    // Resolve member names for the privacy panel.
    const memberNames: { clerkId: string; name: string }[] = [];
    for (const cid of space.memberClerkIds ?? []) {
      const u = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", cid))
        .unique();
      memberNames.push({ clerkId: cid, name: u?.name ?? u?.email ?? "Member" });
    }

    return {
      space,
      lists,
      docs: docs
        .filter((d) => d.parentDocId === undefined)
        .map((d) => ({ docId: d._id, title: d.title })),
      whiteboards: whiteboards.map((w) => ({
        whiteboardId: w._id,
        title: w.title,
      })),
      folders: folders.map((f) => ({ folderId: f._id, name: f.name })),
      members: memberNames,
      canGovern:
        space.parentType === "user" ||
        space.createdByClerkId === identity.subject ||
        space.createdByClerkId === undefined ||
        (space.parentType === "workspace" &&
          (await ctx.db.get(space.parentId as Id<"workspaces">))
            ?.ownerClerkId === identity.subject),
    };
  },
});

export const rename = mutation({
  args: { spaceId: v.id("spaces"), name: v.string() },
  handler: async (ctx, { spaceId, name }) => {
    const { space } = await requireSpaceAccess(ctx, spaceId);
    await ctx.db.patch(space._id, { name });
  },
});
