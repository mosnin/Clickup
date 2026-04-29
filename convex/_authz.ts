import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

// Helpers for resolving a list/folder/space up the hierarchy and confirming
// the current Clerk identity is allowed to read or write it.
//
// A user can access a Space if either:
//   - parentType === "user" and parentId === identity.subject, or
//   - parentType === "workspace" and a memberships row exists for
//     (identity.subject, parentId).

export type Identity = { subject: string };

export async function requireIdentity(
  ctx: QueryCtx | MutationCtx,
): Promise<Identity> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  return { subject: identity.subject };
}

export async function canAccessSpace(
  ctx: QueryCtx | MutationCtx,
  space: Doc<"spaces">,
  identity: Identity,
): Promise<boolean> {
  if (space.parentType === "user") {
    return space.parentId === identity.subject;
  }
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q
        .eq("userClerkId", identity.subject)
        .eq("workspaceId", space.parentId as Id<"workspaces">),
    )
    .unique();
  return membership !== null;
}

export async function getSpaceForList(
  ctx: QueryCtx | MutationCtx,
  list: Doc<"lists">,
): Promise<Doc<"spaces"> | null> {
  if (list.parentType === "space") {
    return await ctx.db.get(list.parentId as Id<"spaces">);
  }
  const folder = await ctx.db.get(list.parentId as Id<"folders">);
  if (!folder) return null;
  return await ctx.db.get(folder.spaceId);
}

export async function requireListAccess(
  ctx: QueryCtx | MutationCtx,
  listId: Id<"lists">,
): Promise<{ list: Doc<"lists">; space: Doc<"spaces">; identity: Identity }> {
  const identity = await requireIdentity(ctx);
  const list = await ctx.db.get(listId);
  if (!list) throw new Error("List not found");
  const space = await getSpaceForList(ctx, list);
  if (!space) throw new Error("Orphan list");
  if (!(await canAccessSpace(ctx, space, identity))) {
    throw new Error("Forbidden");
  }
  return { list, space, identity };
}

export async function requireSpaceAccess(
  ctx: QueryCtx | MutationCtx,
  spaceId: Id<"spaces">,
): Promise<{ space: Doc<"spaces">; identity: Identity }> {
  const identity = await requireIdentity(ctx);
  const space = await ctx.db.get(spaceId);
  if (!space) throw new Error("Space not found");
  if (!(await canAccessSpace(ctx, space, identity))) {
    throw new Error("Forbidden");
  }
  return { space, identity };
}

export async function requireFolderAccess(
  ctx: QueryCtx | MutationCtx,
  folderId: Id<"folders">,
): Promise<{
  folder: Doc<"folders">;
  space: Doc<"spaces">;
  identity: Identity;
}> {
  const identity = await requireIdentity(ctx);
  const folder = await ctx.db.get(folderId);
  if (!folder) throw new Error("Folder not found");
  const space = await ctx.db.get(folder.spaceId);
  if (!space) throw new Error("Orphan folder");
  if (!(await canAccessSpace(ctx, space, identity))) {
    throw new Error("Forbidden");
  }
  return { folder, space, identity };
}

export async function requireTaskAccess(
  ctx: QueryCtx | MutationCtx,
  taskId: Id<"tasks">,
): Promise<{
  task: Doc<"tasks">;
  list: Doc<"lists">;
  space: Doc<"spaces">;
  identity: Identity;
}> {
  const identity = await requireIdentity(ctx);
  const task = await ctx.db.get(taskId);
  if (!task) throw new Error("Task not found");
  const list = await ctx.db.get(task.listId);
  if (!list) throw new Error("Orphan task");
  const space = await getSpaceForList(ctx, list);
  if (!space) throw new Error("Orphan list");
  if (!(await canAccessSpace(ctx, space, identity))) {
    throw new Error("Forbidden");
  }
  return { task, list, space, identity };
}

// Confirms the caller can read/write a message addressed at the given
// parent, regardless of which kind of parent it is (task, space, or
// workspace). Returns the workspace context when applicable so callers
// can validate that mentioned users are members.
export async function requireMessageParentAccess(
  ctx: QueryCtx | MutationCtx,
  parentType: "task" | "space" | "workspace",
  parentId: string,
): Promise<{ identity: Identity; workspaceId: Id<"workspaces"> | null }> {
  if (parentType === "task") {
    const { space } = await requireTaskAccess(ctx, parentId as Id<"tasks">);
    return {
      identity: await requireIdentity(ctx),
      workspaceId:
        space.parentType === "workspace"
          ? (space.parentId as Id<"workspaces">)
          : null,
    };
  }
  if (parentType === "space") {
    const { space } = await requireSpaceAccess(ctx, parentId as Id<"spaces">);
    return {
      identity: await requireIdentity(ctx),
      workspaceId:
        space.parentType === "workspace"
          ? (space.parentId as Id<"workspaces">)
          : null,
    };
  }
  // workspace
  const identity = await requireIdentity(ctx);
  const workspaceId = parentId as Id<"workspaces">;
  const workspace = await ctx.db.get(workspaceId);
  if (!workspace) throw new Error("Workspace not found");
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
    )
    .unique();
  if (!membership) throw new Error("Forbidden");
  return { identity, workspaceId };
}
