import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  canAccessSpace,
  requireProjectAccess,
  requireSpaceAccess,
} from "./_authz";
import type { Actor } from "./_agentAuth";
import { emitEvent, userActor } from "./events";

// Projects group lists inside a Space: Workspace → Space → Project → List →
// Task. A project is the unit of work people name ("the billing migration");
// a list is one board of tasks inside it.
//
// A project and a space-direct list are siblings under the same Space:
// projects carry their own `position` sequence, space-direct lists carry
// theirs, and every surface renders projects first, then space-direct lists
// (each by position, createdAt tiebreak). Keeping the two sequences separate
// is what makes `lists.reorder` and `projects.reorder` unable to corrupt each
// other.

export const PROJECT_STATUSES = [
  "on_track",
  "at_risk",
  "off_track",
  "paused",
] as const;

const projectStatusValidator = v.union(
  v.literal("on_track"),
  v.literal("at_risk"),
  v.literal("off_track"),
  v.literal("paused"),
);

export const listForSpace = query({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    // Soft-fail (return []) instead of throwing so the sidebar can render
    // gracefully when a stale spaceId is passed — but being logged in must
    // not be enough to enumerate a private space's projects by ID.
    const space = await ctx.db.get(spaceId);
    if (!space) return [];
    if (!(await canAccessSpace(ctx, space, { subject: identity.subject }))) {
      return [];
    }
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_space", (q) => q.eq("spaceId", spaceId))
      .collect();
    return projects
      .filter((p) => p.archivedAt === undefined)
      .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
  },
});

/** One project with its lists, for the project header/overview. */
export const get = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const project = await ctx.db.get(projectId);
    if (!project) return null;
    const space = await ctx.db.get(project.spaceId);
    if (!space) return null;
    if (!(await canAccessSpace(ctx, space, { subject: identity.subject }))) {
      return null;
    }
    const lists = await ctx.db
      .query("lists")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "project").eq("parentId", projectId),
      )
      .collect();
    return {
      project,
      spaceName: space.name,
      spaceId: space._id,
      lists: lists.sort(
        (a, b) => a.position - b.position || a.createdAt - b.createdAt,
      ),
    };
  },
});

// ── Cores (shared entry points) ─────────────────────────────────────────
//
// Structure changes are visible, trust-sensitive operations, so both the
// human mutations here and the agent-facing entry points in agentApi route
// through these — a rename/move/delete lands in the activity feed with the
// real actor attached. Mirrors renameListCore/removeListCore in lists.ts.

function scopeForSpace(space: Doc<"spaces">): {
  scopeType: "user" | "workspace";
  scopeId: string;
} {
  return { scopeType: space.parentType, scopeId: space.parentId };
}

export async function createProjectCore(
  ctx: MutationCtx,
  space: Doc<"spaces">,
  name: string,
  actor: Actor,
  meta?: { description?: string; ownerActorId?: string },
): Promise<Id<"projects">> {
  const trimmed = name.trim();
  if (!trimmed) throw new ConvexError("Project name is required");

  const siblings = await ctx.db
    .query("projects")
    .withIndex("by_space", (q) => q.eq("spaceId", space._id))
    .collect();
  // Append after the highest existing position rather than using the row
  // count — a deleted project leaves a gap, and `length` would collide.
  const position = siblings.reduce((max, p) => Math.max(max, p.position + 1), 0);

  const projectId = await ctx.db.insert("projects", {
    name: trimmed,
    spaceId: space._id,
    position,
    createdAt: Date.now(),
    description: meta?.description?.trim() || undefined,
    ownerActorId: meta?.ownerActorId,
  });

  await emitEvent(ctx, {
    ...scopeForSpace(space),
    type: "project.created",
    actor,
    entityType: "project",
    entityId: projectId,
    entityTitle: trimmed,
    payload: { spaceId: space._id },
  });

  return projectId;
}

export async function renameProjectCore(
  ctx: MutationCtx,
  project: Doc<"projects">,
  space: Doc<"spaces">,
  name: string,
  actor: Actor,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new ConvexError("Project name is required");
  if (trimmed === project.name) return;
  await ctx.db.patch(project._id, { name: trimmed });
  await emitEvent(ctx, {
    ...scopeForSpace(space),
    type: "project.renamed",
    actor,
    entityType: "project",
    entityId: project._id,
    entityTitle: trimmed,
    payload: { spaceId: space._id, from: project.name, to: trimmed },
  });
}

/**
 * Project identity: the summary, health, owner, notes and target date. This
 * is what used to live on `lists` when a list *was* a project.
 */
export async function updateProjectMetaCore(
  ctx: MutationCtx,
  project: Doc<"projects">,
  space: Doc<"spaces">,
  patch: {
    description?: string;
    projectStatus?: (typeof PROJECT_STATUSES)[number] | null;
    ownerActorId?: string | null;
    notes?: string;
    targetDate?: number | null;
    color?: string;
  },
  actor: Actor,
): Promise<void> {
  const next: Record<string, unknown> = {};
  if (patch.description !== undefined) {
    next.description = patch.description.trim() || undefined;
  }
  if (patch.notes !== undefined) next.notes = patch.notes.trim() || undefined;
  if (patch.color !== undefined) next.color = patch.color || undefined;
  // null is an explicit clear; undefined means "not in this patch".
  if (patch.projectStatus !== undefined) {
    next.projectStatus = patch.projectStatus ?? undefined;
  }
  if (patch.ownerActorId !== undefined) {
    next.ownerActorId = patch.ownerActorId ?? undefined;
  }
  if (patch.targetDate !== undefined) {
    next.targetDate = patch.targetDate ?? undefined;
  }
  if (Object.keys(next).length === 0) return;

  await ctx.db.patch(project._id, next);
  await emitEvent(ctx, {
    ...scopeForSpace(space),
    type: "project.updated",
    actor,
    entityType: "project",
    entityId: project._id,
    entityTitle: project.name,
    payload: { spaceId: space._id, fields: Object.keys(next) },
  });
}

// Deleting a project is a grouping change, NOT a content deletion: every
// list inside it moves up to the parent Space (appended after the existing
// space-direct lists) and keeps its tasks, statuses, fields and history.
export async function removeProjectCore(
  ctx: MutationCtx,
  project: Doc<"projects">,
  space: Doc<"spaces">,
  actor: Actor,
): Promise<void> {
  const children = await ctx.db
    .query("lists")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", "project").eq("parentId", project._id),
    )
    .collect();

  const spaceLists = await ctx.db
    .query("lists")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", "space").eq("parentId", space._id),
    )
    .collect();
  let next = spaceLists.reduce((max, l) => Math.max(max, l.position + 1), 0);

  for (const list of [...children].sort(
    (a, b) => a.position - b.position || a.createdAt - b.createdAt,
  )) {
    await ctx.db.patch(list._id, {
      parentType: "space",
      parentId: space._id,
      position: next,
    });
    next += 1;
  }

  await ctx.db.delete(project._id);

  await emitEvent(ctx, {
    ...scopeForSpace(space),
    type: "project.deleted",
    actor,
    entityType: "project",
    entityId: project._id,
    entityTitle: project.name,
    payload: { spaceId: space._id, movedListCount: children.length },
  });
}

// Reorder the projects under one space. Takes the full desired order; ids
// that no longer live in this space are skipped (stale client state) rather
// than corrupting positions. Project positions are a sequence of their own —
// lists carry an independent `position` per parent, so this can never disturb
// list ordering (and `lists.reorder` can never disturb projects).
export async function reorderProjectsCore(
  ctx: MutationCtx,
  spaceId: Id<"spaces">,
  orderedIds: Id<"projects">[],
): Promise<void> {
  for (let i = 0; i < orderedIds.length; i++) {
    const project = await ctx.db.get(orderedIds[i]);
    if (!project || project.spaceId !== spaceId) continue;
    if (project.position !== i) {
      await ctx.db.patch(project._id, { position: i });
    }
  }
}

// ── Public mutations ────────────────────────────────────────────────────

export const create = mutation({
  args: {
    spaceId: v.id("spaces"),
    name: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, { spaceId, name, description }) => {
    const { space, identity } = await requireSpaceAccess(ctx, spaceId);
    const actor = await userActor(ctx, identity.subject);
    return await createProjectCore(ctx, space, name, actor, { description });
  },
});

export const rename = mutation({
  args: { projectId: v.id("projects"), name: v.string() },
  handler: async (ctx, { projectId, name }) => {
    const { project, space, identity } = await requireProjectAccess(
      ctx,
      projectId,
    );
    const actor = await userActor(ctx, identity.subject);
    await renameProjectCore(ctx, project, space, name, actor);
  },
});

export const updateMeta = mutation({
  args: {
    projectId: v.id("projects"),
    description: v.optional(v.string()),
    projectStatus: v.optional(v.union(projectStatusValidator, v.null())),
    ownerActorId: v.optional(v.union(v.string(), v.null())),
    notes: v.optional(v.string()),
    targetDate: v.optional(v.union(v.number(), v.null())),
    color: v.optional(v.string()),
  },
  handler: async (ctx, { projectId, ...patch }) => {
    const { project, space, identity } = await requireProjectAccess(
      ctx,
      projectId,
    );
    const actor = await userActor(ctx, identity.subject);
    await updateProjectMetaCore(ctx, project, space, patch, actor);
  },
});

export const remove = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const { project, space, identity } = await requireProjectAccess(
      ctx,
      projectId,
    );
    const actor = await userActor(ctx, identity.subject);
    await removeProjectCore(ctx, project, space, actor);
  },
});

export const reorder = mutation({
  args: { spaceId: v.id("spaces"), orderedIds: v.array(v.id("projects")) },
  handler: async (ctx, { spaceId, orderedIds }) => {
    await requireSpaceAccess(ctx, spaceId);
    await reorderProjectsCore(ctx, spaceId, orderedIds);
  },
});
