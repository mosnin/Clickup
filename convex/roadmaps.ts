import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { canAccessSpace, requireIdentity } from "./_authz";
import { getRollup } from "./rollups";

// Roadmaps (Phase K): workspace-level phased containers that projects
// (lists) slot into — the organization layer that keeps a fleet of
// agent-created projects from turning into an unordered pile. A roadmap
// owns an ordered set of phases; a list may sit in exactly one phase of
// one roadmap, ordered by roadmapPosition. Reads are per-viewer: projects
// in private spaces the viewer can't access are skipped, mirroring
// portfolio.ts.

const DEFAULT_PHASES = ["Now", "Next", "Later"];

function phaseId(): string {
  // Mutations have no CSPRNG; collision space here is per-roadmap and tiny.
  return `ph_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function requireWorkspaceMember(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
) {
  const identity = await requireIdentity(ctx);
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
    )
    .unique();
  if (!membership) throw new Error("Not a member of this workspace");
  return { identity, membership };
}

async function requireRoadmap(
  ctx: QueryCtx | MutationCtx,
  roadmapId: Id<"roadmaps">,
) {
  const roadmap = await ctx.db.get(roadmapId);
  if (!roadmap) throw new Error("Roadmap not found");
  const { identity } = await requireWorkspaceMember(ctx, roadmap.workspaceId);
  return { roadmap, identity };
}

// Resolve the workspace that owns a list (space- or folder-parented), or
// null for personal-space lists.
async function workspaceOfList(ctx: QueryCtx | MutationCtx, listId: Id<"lists">) {
  const list = await ctx.db.get(listId);
  if (!list) return null;
  let spaceId: Id<"spaces">;
  if (list.parentType === "space") {
    spaceId = list.parentId as Id<"spaces">;
  } else {
    const folder = await ctx.db.get(list.parentId as Id<"folders">);
    if (!folder) return null;
    spaceId = folder.spaceId;
  }
  const space = await ctx.db.get(spaceId);
  if (!space || space.parentType !== "workspace") return null;
  return { list, space, workspaceId: space.parentId as Id<"workspaces"> };
}

export const listForWorkspace = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    let identity;
    try {
      ({ identity } = await requireWorkspaceMember(ctx, workspaceId));
    } catch {
      return null;
    }

    const roadmaps = await ctx.db
      .query("roadmaps")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    roadmaps.sort((a, b) => a.position - b.position);

    // One pass over the workspace's roadmap-assigned lists, viewer-gated.
    const spaceOk = new Map<string, boolean>();
    const out = [];
    for (const rm of roadmaps) {
      const assigned = await ctx.db
        .query("lists")
        .withIndex("by_roadmap", (q) => q.eq("roadmapId", rm._id))
        .collect();
      const projects = [];
      for (const list of assigned) {
        const resolved = await workspaceOfList(ctx, list._id);
        if (!resolved || resolved.workspaceId !== workspaceId) continue;
        if (resolved.space.archivedAt !== undefined) continue;
        let ok = spaceOk.get(resolved.space._id);
        if (ok === undefined) {
          ok = await canAccessSpace(ctx, resolved.space, {
            subject: identity.subject,
          });
          spaceOk.set(resolved.space._id, ok);
        }
        if (!ok) continue;
        const rollup = await getRollup(ctx, list._id);
        projects.push({
          listId: list._id,
          name: list.name,
          color: list.color,
          projectStatus: list.projectStatus,
          targetDate: list.targetDate,
          phaseId: list.roadmapPhaseId,
          position: list.roadmapPosition ?? 0,
          total: rollup?.total ?? 0,
          done: rollup?.done ?? 0,
        });
      }
      projects.sort((a, b) => a.position - b.position);
      out.push({
        _id: rm._id,
        name: rm.name,
        description: rm.description,
        phases: rm.phases,
        projects,
      });
    }
    return out;
  },
});

export const create = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    name: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireWorkspaceMember(ctx, args.workspaceId);
    const name = args.name.trim();
    if (!name) throw new Error("Roadmap name is required");
    const siblings = await ctx.db
      .query("roadmaps")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    return await ctx.db.insert("roadmaps", {
      workspaceId: args.workspaceId,
      name,
      description: args.description?.trim() || undefined,
      phases: DEFAULT_PHASES.map((n) => ({ id: phaseId(), name: n })),
      position: siblings.length,
      createdAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: {
    roadmapId: v.id("roadmaps"),
    name: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const { roadmap } = await requireRoadmap(ctx, args.roadmapId);
    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (!name) throw new Error("Roadmap name is required");
      patch.name = name;
    }
    if (args.description !== undefined) {
      patch.description = args.description?.trim() || undefined;
    }
    await ctx.db.patch(roadmap._id, patch);
  },
});

export const remove = mutation({
  args: { roadmapId: v.id("roadmaps") },
  handler: async (ctx, { roadmapId }) => {
    const { roadmap } = await requireRoadmap(ctx, roadmapId);
    // Unassign every project first — deleting a roadmap never touches the
    // projects themselves.
    const assigned = await ctx.db
      .query("lists")
      .withIndex("by_roadmap", (q) => q.eq("roadmapId", roadmapId))
      .collect();
    for (const list of assigned) {
      await ctx.db.patch(list._id, {
        roadmapId: undefined,
        roadmapPhaseId: undefined,
        roadmapPosition: undefined,
      });
    }
    await ctx.db.delete(roadmap._id);
  },
});

export const addPhase = mutation({
  args: {
    roadmapId: v.id("roadmaps"),
    name: v.string(),
    targetDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { roadmap } = await requireRoadmap(ctx, args.roadmapId);
    const name = args.name.trim();
    if (!name) throw new Error("Phase name is required");
    await ctx.db.patch(roadmap._id, {
      phases: [
        ...roadmap.phases,
        { id: phaseId(), name, targetDate: args.targetDate },
      ],
    });
  },
});

export const updatePhase = mutation({
  args: {
    roadmapId: v.id("roadmaps"),
    phaseId: v.string(),
    name: v.optional(v.string()),
    targetDate: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    const { roadmap } = await requireRoadmap(ctx, args.roadmapId);
    const phases = roadmap.phases.map((p) => {
      if (p.id !== args.phaseId) return p;
      const name = args.name !== undefined ? args.name.trim() : p.name;
      if (!name) throw new Error("Phase name is required");
      return {
        ...p,
        name,
        targetDate:
          args.targetDate === undefined
            ? p.targetDate
            : (args.targetDate ?? undefined),
      };
    });
    await ctx.db.patch(roadmap._id, { phases });
  },
});

export const removePhase = mutation({
  args: { roadmapId: v.id("roadmaps"), phaseId: v.string() },
  handler: async (ctx, args) => {
    const { roadmap } = await requireRoadmap(ctx, args.roadmapId);
    if (!roadmap.phases.some((p) => p.id === args.phaseId)) return;
    // Projects in the removed phase fall out of the roadmap (never lost —
    // they stay ordinary projects and show under "Unassigned").
    const assigned = await ctx.db
      .query("lists")
      .withIndex("by_roadmap", (q) => q.eq("roadmapId", roadmap._id))
      .collect();
    for (const list of assigned) {
      if (list.roadmapPhaseId === args.phaseId) {
        await ctx.db.patch(list._id, {
          roadmapId: undefined,
          roadmapPhaseId: undefined,
          roadmapPosition: undefined,
        });
      }
    }
    await ctx.db.patch(roadmap._id, {
      phases: roadmap.phases.filter((p) => p.id !== args.phaseId),
    });
  },
});

// Put a project into a roadmap phase (or pull it out with roadmapId: null).
export const assignProject = mutation({
  args: {
    listId: v.id("lists"),
    roadmapId: v.union(v.id("roadmaps"), v.null()),
    phaseId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const resolved = await workspaceOfList(ctx, args.listId);
    if (!resolved) {
      throw new Error("Only workspace projects can join a roadmap");
    }
    const { identity } = await requireWorkspaceMember(
      ctx,
      resolved.workspaceId,
    );
    if (!(await canAccessSpace(ctx, resolved.space, { subject: identity.subject }))) {
      throw new Error("No access to this project");
    }
    if (args.roadmapId === null) {
      await ctx.db.patch(args.listId, {
        roadmapId: undefined,
        roadmapPhaseId: undefined,
        roadmapPosition: undefined,
      });
      return;
    }
    const roadmap = await ctx.db.get(args.roadmapId);
    if (!roadmap || roadmap.workspaceId !== resolved.workspaceId) {
      throw new Error("Roadmap belongs to a different workspace");
    }
    const phase =
      roadmap.phases.find((p) => p.id === args.phaseId) ?? roadmap.phases[0];
    if (!phase) throw new Error("Roadmap has no phases");
    const siblings = await ctx.db
      .query("lists")
      .withIndex("by_roadmap", (q) => q.eq("roadmapId", roadmap._id))
      .collect();
    const inPhase = siblings.filter(
      (l) => l.roadmapPhaseId === phase.id && l._id !== args.listId,
    );
    await ctx.db.patch(args.listId, {
      roadmapId: roadmap._id,
      roadmapPhaseId: phase.id,
      roadmapPosition: inPhase.length,
    });
  },
});

// Reorder the projects inside one phase.
export const reorderPhase = mutation({
  args: {
    roadmapId: v.id("roadmaps"),
    phaseId: v.string(),
    orderedIds: v.array(v.id("lists")),
  },
  handler: async (ctx, args) => {
    const { roadmap } = await requireRoadmap(ctx, args.roadmapId);
    for (let i = 0; i < args.orderedIds.length; i++) {
      const list = await ctx.db.get(args.orderedIds[i]);
      if (
        !list ||
        list.roadmapId !== roadmap._id ||
        list.roadmapPhaseId !== args.phaseId
      ) {
        continue; // stale client order — skip rather than corrupt
      }
      if (list.roadmapPosition !== i) {
        await ctx.db.patch(list._id, { roadmapPosition: i });
      }
    }
  },
});
