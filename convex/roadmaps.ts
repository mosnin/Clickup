import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { canAccessSpace, requireIdentity } from "./_authz";
import type { Actor } from "./_agentAuth";
import { emitEvent, userActor } from "./events";
import { getRollup } from "./rollups";

// Roadmaps (Phase K): workspace-level phased containers that projects
// slot into — the organization layer that keeps a fleet of
// agent-created projects from turning into an unordered pile. A roadmap
// owns an ordered set of phases; a project may sit in exactly one phase of
// one roadmap, ordered by roadmapPosition. Reads are per-viewer: projects
// in private spaces the viewer can't access are skipped, mirroring
// portfolio.ts.

const DEFAULT_PHASES = ["Now", "Next", "Later"];

function phaseId(): string {
  // Mutations have no CSPRNG; collision space here is per-roadmap and tiny.
  return `ph_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Cores (shared by the human mutations below and agentApi) ────────────
// Same actor pattern as tasks/messages: both entry points call these so
// events and validation behave identically no matter who acted.

export async function createRoadmapCore(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  args: {
    name: string;
    description?: string;
    // Explicit phases at create time skip the Now/Next/Later defaults —
    // a planner laying out M1..M4 shouldn't inherit placeholder phases it
    // then has to delete.
    phases?: { name: string; targetDate?: number }[];
  },
  actor: Actor,
): Promise<Id<"roadmaps">> {
  const name = args.name.trim();
  if (!name) throw new ConvexError("Roadmap name is required");
  const explicit = (args.phases ?? [])
    .map((p) => ({ name: p.name.trim(), targetDate: p.targetDate }))
    .filter((p) => p.name);
  const siblings = await ctx.db
    .query("roadmaps")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  const roadmapId = await ctx.db.insert("roadmaps", {
    workspaceId,
    name,
    description: args.description?.trim() || undefined,
    phases:
      explicit.length > 0
        ? explicit.map((p) => ({ id: phaseId(), ...p }))
        : DEFAULT_PHASES.map((n) => ({ id: phaseId(), name: n })),
    position: siblings.length,
    createdAt: Date.now(),
  });
  await emitEvent(ctx, {
    scopeType: "workspace",
    scopeId: workspaceId,
    type: "roadmap.created",
    actor,
    entityType: "roadmap",
    entityId: roadmapId,
    entityTitle: name,
    payload: { phases: explicit.length || DEFAULT_PHASES.length },
  });
  return roadmapId;
}

export async function addPhaseCore(
  ctx: MutationCtx,
  roadmap: Doc<"roadmaps">,
  args: { name: string; targetDate?: number },
  actor: Actor,
): Promise<string> {
  const name = args.name.trim();
  if (!name) throw new ConvexError("Phase name is required");
  const id = phaseId();
  await ctx.db.patch(roadmap._id, {
    phases: [...roadmap.phases, { id, name, targetDate: args.targetDate }],
  });
  await emitEvent(ctx, {
    scopeType: "workspace",
    scopeId: roadmap.workspaceId,
    type: "roadmap.phase_added",
    actor,
    entityType: "roadmap",
    entityId: roadmap._id,
    entityTitle: roadmap.name,
    payload: { phaseName: name },
  });
  return id;
}

export async function updatePhaseCore(
  ctx: MutationCtx,
  roadmap: Doc<"roadmaps">,
  args: { phaseId: string; name?: string; targetDate?: number | null },
  actor: Actor,
): Promise<void> {
  if (!roadmap.phases.some((p) => p.id === args.phaseId)) {
    throw new ConvexError("Phase not found");
  }
  let phaseName = "";
  const phases = roadmap.phases.map((p) => {
    if (p.id !== args.phaseId) return p;
    const name = args.name !== undefined ? args.name.trim() : p.name;
    if (!name) throw new ConvexError("Phase name is required");
    phaseName = name;
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
  await emitEvent(ctx, {
    scopeType: "workspace",
    scopeId: roadmap.workspaceId,
    type: "roadmap.phase_updated",
    actor,
    entityType: "roadmap",
    entityId: roadmap._id,
    entityTitle: roadmap.name,
    payload: { phaseName },
  });
}

export async function removePhaseCore(
  ctx: MutationCtx,
  roadmap: Doc<"roadmaps">,
  phaseIdToRemove: string,
  actor: Actor,
): Promise<void> {
  const phase = roadmap.phases.find((p) => p.id === phaseIdToRemove);
  if (!phase) return;
  // Projects in the removed phase fall out of the roadmap (never lost —
  // they stay ordinary projects and show under "Unassigned").
  const assigned = await ctx.db
    .query("projects")
    .withIndex("by_roadmap", (q) => q.eq("roadmapId", roadmap._id))
    .collect();
  for (const project of assigned) {
    if (project.roadmapPhaseId === phaseIdToRemove) {
      await ctx.db.patch(project._id, {
        roadmapId: undefined,
        roadmapPhaseId: undefined,
        roadmapPosition: undefined,
      });
    }
  }
  await ctx.db.patch(roadmap._id, {
    phases: roadmap.phases.filter((p) => p.id !== phaseIdToRemove),
  });
  await emitEvent(ctx, {
    scopeType: "workspace",
    scopeId: roadmap.workspaceId,
    type: "roadmap.phase_removed",
    actor,
    entityType: "roadmap",
    entityId: roadmap._id,
    entityTitle: roadmap.name,
    payload: { phaseName: phase.name },
  });
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
  if (!membership) throw new ConvexError("Not a member of this workspace");
  return { identity, membership };
}

async function requireRoadmap(
  ctx: QueryCtx | MutationCtx,
  roadmapId: Id<"roadmaps">,
) {
  const roadmap = await ctx.db.get(roadmapId);
  if (!roadmap) throw new ConvexError("Roadmap not found");
  const { identity } = await requireWorkspaceMember(ctx, roadmap.workspaceId);
  return { roadmap, identity };
}

// Resolve the workspace that owns a project, or null when the project lives
// in a personal space — roadmaps are workspace-level, so a personal project
// can never join one.
async function workspaceOfProject(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"projects">,
) {
  const project = await ctx.db.get(projectId);
  if (!project) return null;
  const space = await ctx.db.get(project.spaceId);
  if (!space || space.parentType !== "workspace") return null;
  return { project, space, workspaceId: space.parentId as Id<"workspaces"> };
}

// A project's progress is the sum of its lists' rollups. Roadmap rows show
// "12 of 30 done" for the project as a whole, not for one board inside it.
async function progressForProject(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"projects">,
): Promise<{ total: number; done: number }> {
  const lists = await ctx.db
    .query("lists")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", "project").eq("parentId", projectId),
    )
    .collect();
  let total = 0;
  let done = 0;
  for (const l of lists) {
    const rollup = await getRollup(ctx, l._id);
    total += rollup?.total ?? 0;
    done += rollup?.done ?? 0;
  }
  return { total, done };
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
        .query("projects")
        .withIndex("by_roadmap", (q) => q.eq("roadmapId", rm._id))
        .collect();
      const projects = [];
      for (const project of assigned) {
        if (project.archivedAt !== undefined) continue;
        const resolved = await workspaceOfProject(ctx, project._id);
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
        const progress = await progressForProject(ctx, project._id);
        projects.push({
          projectId: project._id,
          name: project.name,
          color: project.color,
          projectStatus: project.projectStatus,
          targetDate: project.targetDate,
          phaseId: project.roadmapPhaseId,
          position: project.roadmapPosition ?? 0,
          total: progress.total,
          done: progress.done,
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
    const { identity } = await requireWorkspaceMember(ctx, args.workspaceId);
    const actor = await userActor(ctx, identity.subject);
    return await createRoadmapCore(
      ctx,
      args.workspaceId,
      { name: args.name, description: args.description },
      actor,
    );
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
      if (!name) throw new ConvexError("Roadmap name is required");
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
      .query("projects")
      .withIndex("by_roadmap", (q) => q.eq("roadmapId", roadmapId))
      .collect();
    for (const project of assigned) {
      await ctx.db.patch(project._id, {
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
    const { roadmap, identity } = await requireRoadmap(ctx, args.roadmapId);
    const actor = await userActor(ctx, identity.subject);
    await addPhaseCore(
      ctx,
      roadmap,
      { name: args.name, targetDate: args.targetDate },
      actor,
    );
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
    const { roadmap, identity } = await requireRoadmap(ctx, args.roadmapId);
    const actor = await userActor(ctx, identity.subject);
    await updatePhaseCore(
      ctx,
      roadmap,
      { phaseId: args.phaseId, name: args.name, targetDate: args.targetDate },
      actor,
    );
  },
});

export const removePhase = mutation({
  args: { roadmapId: v.id("roadmaps"), phaseId: v.string() },
  handler: async (ctx, args) => {
    const { roadmap, identity } = await requireRoadmap(ctx, args.roadmapId);
    const actor = await userActor(ctx, identity.subject);
    await removePhaseCore(ctx, roadmap, args.phaseId, actor);
  },
});

// Put a project into a roadmap phase (or pull it out with roadmapId: null).
export const assignProject = mutation({
  args: {
    projectId: v.id("projects"),
    roadmapId: v.union(v.id("roadmaps"), v.null()),
    phaseId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const resolved = await workspaceOfProject(ctx, args.projectId);
    if (!resolved) {
      throw new ConvexError("Only workspace projects can join a roadmap");
    }
    const { identity } = await requireWorkspaceMember(
      ctx,
      resolved.workspaceId,
    );
    if (!(await canAccessSpace(ctx, resolved.space, { subject: identity.subject }))) {
      throw new ConvexError("No access to this project");
    }
    if (args.roadmapId === null) {
      await ctx.db.patch(args.projectId, {
        roadmapId: undefined,
        roadmapPhaseId: undefined,
        roadmapPosition: undefined,
      });
      return;
    }
    const roadmap = await ctx.db.get(args.roadmapId);
    if (!roadmap || roadmap.workspaceId !== resolved.workspaceId) {
      throw new ConvexError("Roadmap belongs to a different workspace");
    }
    // An explicit phaseId that no longer exists (deleted concurrently) is
    // an error, not a silent drop into the first phase.
    const phase =
      args.phaseId !== undefined
        ? roadmap.phases.find((p) => p.id === args.phaseId)
        : roadmap.phases[0];
    if (!phase) {
      throw new ConvexError(
        args.phaseId !== undefined ? "Phase not found" : "Roadmap has no phases",
      );
    }
    const siblings = await ctx.db
      .query("projects")
      .withIndex("by_roadmap", (q) => q.eq("roadmapId", roadmap._id))
      .collect();
    const inPhase = siblings.filter(
      (p) => p.roadmapPhaseId === phase.id && p._id !== args.projectId,
    );
    // max+1, not count: unassigns leave gaps, so length would collide.
    const maxPosition = inPhase.reduce(
      (m, p) => Math.max(m, p.roadmapPosition ?? 0),
      -1,
    );
    await ctx.db.patch(args.projectId, {
      roadmapId: roadmap._id,
      roadmapPhaseId: phase.id,
      roadmapPosition: maxPosition + 1,
    });
  },
});

// Reorder the projects inside one phase.
export const reorderPhase = mutation({
  args: {
    roadmapId: v.id("roadmaps"),
    phaseId: v.string(),
    orderedIds: v.array(v.id("projects")),
  },
  handler: async (ctx, args) => {
    const { roadmap, identity } = await requireRoadmap(ctx, args.roadmapId);
    // Same per-space gate as listForWorkspace: workspace membership alone
    // must not let a caller rewrite ordering of projects in private spaces
    // they can't access.
    const spaceOk = new Map<string, boolean>();
    for (let i = 0; i < args.orderedIds.length; i++) {
      const project = await ctx.db.get(args.orderedIds[i]);
      if (
        !project ||
        project.roadmapId !== roadmap._id ||
        project.roadmapPhaseId !== args.phaseId
      ) {
        continue; // stale client order — skip rather than corrupt
      }
      const resolved = await workspaceOfProject(ctx, project._id);
      if (!resolved || resolved.workspaceId !== roadmap.workspaceId) continue;
      let ok = spaceOk.get(resolved.space._id);
      if (ok === undefined) {
        ok = await canAccessSpace(ctx, resolved.space, {
          subject: identity.subject,
        });
        spaceOk.set(resolved.space._id, ok);
      }
      if (!ok) continue;
      if (project.roadmapPosition !== i) {
        await ctx.db.patch(project._id, { roadmapPosition: i });
      }
    }
  },
});
