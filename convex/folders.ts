import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  canAccessSpace,
  requireFolderAccess,
  requireSpaceAccess,
} from "./_authz";
import type { Actor } from "./_agentAuth";
import { emitEvent, userActor } from "./events";

// Folders group lists inside a Space. A folder and a space-direct list are
// siblings under the same Space: folders carry their own `position`
// sequence, space-direct lists carry theirs, and every surface renders
// folders first, then space-direct lists (each by position, createdAt
// tiebreak). Keeping the two sequences separate is what makes
// `lists.reorder` and `folders.reorder` unable to corrupt each other.

export const listForSpace = query({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    // Soft-fail (return []) instead of throwing so the sidebar can render
    // gracefully when a stale spaceId is passed — but being logged in must
    // not be enough to enumerate a private space's folders by ID.
    const space = await ctx.db.get(spaceId);
    if (!space) return [];
    if (!(await canAccessSpace(ctx, space, { subject: identity.subject }))) {
      return [];
    }
    const folders = await ctx.db
      .query("folders")
      .withIndex("by_space", (q) => q.eq("spaceId", spaceId))
      .collect();
    return folders.sort(
      (a, b) => a.position - b.position || a.createdAt - b.createdAt,
    );
  },
});

// ── Cores (shared entry points) ─────────────────────────────────────────
//
// Structure changes are visible, trust-sensitive operations, so both the
// human mutations here and any future agent-facing entry point route
// through these — a rename/move/delete lands in the activity feed with the
// real actor attached. Mirrors renameListCore/removeListCore in lists.ts.

function scopeForSpace(space: Doc<"spaces">): {
  scopeType: "user" | "workspace";
  scopeId: string;
} {
  return { scopeType: space.parentType, scopeId: space.parentId };
}

export async function createFolderCore(
  ctx: MutationCtx,
  space: Doc<"spaces">,
  name: string,
  actor: Actor,
): Promise<Id<"folders">> {
  const trimmed = name.trim();
  if (!trimmed) throw new ConvexError("Folder name is required");

  const siblings = await ctx.db
    .query("folders")
    .withIndex("by_space", (q) => q.eq("spaceId", space._id))
    .collect();
  // Append after the highest existing position rather than using the row
  // count — a deleted folder leaves a gap, and `length` would collide.
  const position = siblings.reduce((max, f) => Math.max(max, f.position + 1), 0);

  const folderId = await ctx.db.insert("folders", {
    name: trimmed,
    spaceId: space._id,
    position,
    createdAt: Date.now(),
  });

  await emitEvent(ctx, {
    ...scopeForSpace(space),
    type: "folder.created",
    actor,
    entityType: "folder",
    entityId: folderId,
    entityTitle: trimmed,
    payload: { spaceId: space._id },
  });

  return folderId;
}

export async function renameFolderCore(
  ctx: MutationCtx,
  folder: Doc<"folders">,
  space: Doc<"spaces">,
  name: string,
  actor: Actor,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new ConvexError("Folder name is required");
  if (trimmed === folder.name) return;
  await ctx.db.patch(folder._id, { name: trimmed });
  await emitEvent(ctx, {
    ...scopeForSpace(space),
    type: "folder.renamed",
    actor,
    entityType: "folder",
    entityId: folder._id,
    entityTitle: trimmed,
    payload: { spaceId: space._id, from: folder.name, to: trimmed },
  });
}

// Deleting a folder is a grouping change, NOT a content deletion: every
// list inside it moves up to the parent Space (appended after the existing
// space-direct lists) and keeps its tasks, statuses, fields and history.
export async function removeFolderCore(
  ctx: MutationCtx,
  folder: Doc<"folders">,
  space: Doc<"spaces">,
  actor: Actor,
): Promise<void> {
  const children = await ctx.db
    .query("lists")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", "folder").eq("parentId", folder._id),
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

  await ctx.db.delete(folder._id);

  await emitEvent(ctx, {
    ...scopeForSpace(space),
    type: "folder.deleted",
    actor,
    entityType: "folder",
    entityId: folder._id,
    entityTitle: folder.name,
    payload: { spaceId: space._id, movedListCount: children.length },
  });
}

// Reorder the folders under one space. Takes the full desired order; ids
// that no longer live in this space are skipped (stale client state)
// rather than corrupting positions. Folder positions are a sequence of
// their own — lists carry an independent `position` per parent, so this
// can never disturb list ordering (and `lists.reorder` can never disturb
// folders).
export async function reorderFoldersCore(
  ctx: MutationCtx,
  spaceId: Id<"spaces">,
  orderedIds: Id<"folders">[],
): Promise<void> {
  for (let i = 0; i < orderedIds.length; i++) {
    const folder = await ctx.db.get(orderedIds[i]);
    if (!folder || folder.spaceId !== spaceId) continue;
    if (folder.position !== i) {
      await ctx.db.patch(folder._id, { position: i });
    }
  }
}

// ── Public mutations ────────────────────────────────────────────────────

export const create = mutation({
  args: { spaceId: v.id("spaces"), name: v.string() },
  handler: async (ctx, { spaceId, name }) => {
    const { space, identity } = await requireSpaceAccess(ctx, spaceId);
    const actor = await userActor(ctx, identity.subject);
    return await createFolderCore(ctx, space, name, actor);
  },
});

export const rename = mutation({
  args: { folderId: v.id("folders"), name: v.string() },
  handler: async (ctx, { folderId, name }) => {
    const { folder, space, identity } = await requireFolderAccess(
      ctx,
      folderId,
    );
    const actor = await userActor(ctx, identity.subject);
    await renameFolderCore(ctx, folder, space, name, actor);
  },
});

export const remove = mutation({
  args: { folderId: v.id("folders") },
  handler: async (ctx, { folderId }) => {
    const { folder, space, identity } = await requireFolderAccess(
      ctx,
      folderId,
    );
    const actor = await userActor(ctx, identity.subject);
    await removeFolderCore(ctx, folder, space, actor);
  },
});

export const reorder = mutation({
  args: { spaceId: v.id("spaces"), orderedIds: v.array(v.id("folders")) },
  handler: async (ctx, { spaceId, orderedIds }) => {
    await requireSpaceAccess(ctx, spaceId);
    await reorderFoldersCore(ctx, spaceId, orderedIds);
  },
});
