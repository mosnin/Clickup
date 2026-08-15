import { ConvexError } from "convex/values";
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
  if (!identity) throw new ConvexError("Not authenticated");
  // Platform-admin suspension is enforced here so it covers every
  // authenticated read and write in one place. One indexed lookup; a
  // user row that doesn't exist yet (pre-bootstrap) is allowed through.
  // .first(), not .unique(): webhook + ensureCurrent can leave two users
  // rows for the same clerkId. unique() would take every requireIdentity
  // caller down; the suspension check only needs one of the rows.
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
    .first();
  if (user?.suspendedAt) {
    throw new ConvexError("Account suspended");
  }
  return { subject: identity.subject };
}

// Guard for mutation entry points that resolve identity directly via
// ctx.auth.getUserIdentity() (top-level creates like workspaces/spaces)
// rather than going through requireIdentity. Throws for a suspended user
// so account holds cover every write path, not just hierarchy-authed ones.
export async function assertNotSuspended(
  ctx: QueryCtx | MutationCtx,
  subject: string,
): Promise<void> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", subject))
    .first();
  if (user?.suspendedAt) throw new ConvexError("Account suspended");
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
  if (membership === null) return false;

  // Private spaces: only the creator, listed members, and the workspace
  // owner see inside — everyone else in the workspace is locked out even
  // though they can access the workspace itself. (Agents authenticate via
  // workspace scope in _agentAuth and are governed by their own list
  // restrictions, not this human-side gate.)
  if (space.private) {
    if (space.createdByClerkId === identity.subject) return true;
    if (space.memberClerkIds?.includes(identity.subject)) return true;
    const ws = await ctx.db.get(space.parentId as Id<"workspaces">);
    return ws?.ownerClerkId === identity.subject;
  }
  return true;
}

/**
 * The one place that knows how a list reaches its Space.
 *
 * A list hangs off a Space directly or off a Project inside one. "folder" is
 * the pre-Project spelling and only appears on rows the migration has not
 * reached; handling it here means no caller has to know the history. Every
 * other module resolves through this rather than re-deriving the walk — the
 * ad-hoc copies of it were where the parent-type bugs lived.
 */
export async function getSpaceForList(
  ctx: QueryCtx | MutationCtx,
  list: Doc<"lists">,
): Promise<Doc<"spaces"> | null> {
  if (list.parentType === "space") {
    return await ctx.db.get(list.parentId as Id<"spaces">);
  }
  if (list.parentType === "project") {
    const project = await ctx.db.get(list.parentId as Id<"projects">);
    if (!project) return null;
    return await ctx.db.get(project.spaceId);
  }
  const folder = await ctx.db.get(list.parentId as Id<"folders">);
  if (!folder) return null;
  return await ctx.db.get(folder.spaceId);
}

/**
 * The project a list belongs to, or null when it sits straight in a Space.
 * Lists are allowed to live outside a project — wrapping a one-off board in a
 * project would be structure nobody asked for.
 */
export async function getProjectForList(
  ctx: QueryCtx | MutationCtx,
  list: Doc<"lists">,
): Promise<Doc<"projects"> | null> {
  if (list.parentType !== "project") return null;
  return await ctx.db.get(list.parentId as Id<"projects">);
}

export async function requireListAccess(
  ctx: QueryCtx | MutationCtx,
  listId: Id<"lists">,
): Promise<{ list: Doc<"lists">; space: Doc<"spaces">; identity: Identity }> {
  const identity = await requireIdentity(ctx);
  const list = await ctx.db.get(listId);
  if (!list) throw new ConvexError("List not found");
  const space = await getSpaceForList(ctx, list);
  if (!space) throw new ConvexError("Orphan list");
  if (!(await canAccessSpace(ctx, space, identity))) {
    throw new ConvexError("Forbidden");
  }
  return { list, space, identity };
}

export async function requireSpaceAccess(
  ctx: QueryCtx | MutationCtx,
  spaceId: Id<"spaces">,
): Promise<{ space: Doc<"spaces">; identity: Identity }> {
  const identity = await requireIdentity(ctx);
  const space = await ctx.db.get(spaceId);
  if (!space) throw new ConvexError("Space not found");
  if (!(await canAccessSpace(ctx, space, identity))) {
    throw new ConvexError("Forbidden");
  }
  return { space, identity };
}

export async function requireProjectAccess(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"projects">,
): Promise<{
  project: Doc<"projects">;
  space: Doc<"spaces">;
  identity: Identity;
}> {
  const identity = await requireIdentity(ctx);
  const project = await ctx.db.get(projectId);
  if (!project) throw new ConvexError("Project not found");
  const space = await ctx.db.get(project.spaceId);
  if (!space) throw new ConvexError("Orphan project");
  if (!(await canAccessSpace(ctx, space, identity))) {
    throw new ConvexError("Forbidden");
  }
  return { project, space, identity };
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
  if (!task) throw new ConvexError("Task not found");
  const list = await ctx.db.get(task.listId);
  if (!list) throw new ConvexError("Orphan task");
  const space = await getSpaceForList(ctx, list);
  if (!space) throw new ConvexError("Orphan list");
  if (!(await canAccessSpace(ctx, space, identity))) {
    throw new ConvexError("Forbidden");
  }
  return { task, list, space, identity };
}

// Confirms the caller can read/write a doc or whiteboard whose parent
// is one of "user" (personal), "workspace", or "space". Used by both
// docs.ts and whiteboards.ts.
export async function requireDocLikeParentAccess(
  ctx: QueryCtx | MutationCtx,
  parentType: "user" | "workspace" | "space" | "list",
  parentId: string,
): Promise<{ identity: Identity }> {
  const identity = await requireIdentity(ctx);
  if (parentType === "user") {
    if (parentId !== identity.subject) throw new ConvexError("Forbidden");
    return { identity };
  }
  // A doc attached to a project inherits the project's access exactly — there
  // is no separate doc-level permission, so a doc can never be reachable by
  // someone who cannot already open the project it explains.
  if (parentType === "list") {
    await requireListAccess(ctx, parentId as Id<"lists">);
    return { identity };
  }
  if (parentType === "workspace") {
    const workspaceId = parentId as Id<"workspaces">;
    const workspace = await ctx.db.get(workspaceId);
    if (!workspace) throw new ConvexError("Workspace not found");
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
      )
      .unique();
    if (!membership) throw new ConvexError("Forbidden");
    return { identity };
  }
  await requireSpaceAccess(ctx, parentId as Id<"spaces">);
  return { identity };
}

// Confirms the caller can read/write a message addressed at the given
// parent, regardless of which kind of parent it is (task, space,
// workspace, or channel). Returns the workspace context when applicable
// so callers can validate that mentioned users are members.
export async function requireMessageParentAccess(
  ctx: QueryCtx | MutationCtx,
  parentType: "task" | "space" | "workspace" | "channel" | "page",
  parentId: string,
): Promise<{ identity: Identity; workspaceId: Id<"workspaces"> | null }> {
  if (parentType === "page") {
    const identity = await requireIdentity(ctx);
    const page = await ctx.db.get(parentId as Id<"pages">);
    if (!page) throw new ConvexError("Page not found");
    if (page.scopeType === "user") {
      if (page.scopeId !== identity.subject) throw new ConvexError("Forbidden");
      return { identity, workspaceId: null };
    }
    const workspaceId = page.scopeId as Id<"workspaces">;
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
      )
      .unique();
    if (!membership) throw new ConvexError("Forbidden");
    return { identity, workspaceId };
  }
  if (parentType === "channel") {
    const identity = await requireIdentity(ctx);
    const channel = await ctx.db.get(parentId as Id<"channels">);
    if (!channel) throw new ConvexError("Channel not found");
    if (channel.scopeType === "user") {
      if (channel.scopeId !== identity.subject) throw new ConvexError("Forbidden");
      return { identity, workspaceId: null };
    }
    const workspaceId = channel.scopeId as Id<"workspaces">;
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
      )
      .unique();
    if (!membership) throw new ConvexError("Forbidden");
    return { identity, workspaceId };
  }
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
  if (!workspace) throw new ConvexError("Workspace not found");
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
    )
    .unique();
  if (!membership) throw new ConvexError("Forbidden");
  return { identity, workspaceId };
}

/**
 * May this person change things everyone in the space sees?
 *
 * The same bar privacy uses, for the same reason: a space's look is shared, so
 * changing it is a governance act rather than a preference. Exported so the
 * space mutations and this query can never drift apart on the answer.
 */
export async function mayGovernSpace(
  ctx: QueryCtx | MutationCtx,
  space: Doc<"spaces">,
  subject: string,
): Promise<boolean> {
  if (space.parentType === "user") return space.parentId === subject;
  if (space.createdByClerkId === subject) return true;
  // Legacy spaces predate creator attribution; any member may govern them,
  // which is what shipped and what those spaces' members already rely on.
  if (space.createdByClerkId === undefined) return true;
  const workspace = await ctx.db.get(space.parentId as Id<"workspaces">);
  return workspace?.ownerClerkId === subject;
}

// ── Pages ───────────────────────────────────────────────────────────────
//
// A page is scoped to a person or a workspace rather than nested in the
// space/project/list hierarchy, so its check is its own — but it belongs here
// with the others rather than in pages.ts, because presence, search and the
// agent surface all need it and a rule that lives in a feature file becomes a
// rule that gets re-implemented.

/**
 * Can this person see into this scope?
 *
 * Split out of `requireScopeAccess` so a caller holding a subject rather than
 * an ambient identity asks the same question — a cron re-checking whose
 * subscription it is about to evaluate, for instance. One definition, because
 * the second copy of an access rule is where the hole appears.
 */
export async function canAccessScope(
  ctx: QueryCtx | MutationCtx,
  scopeType: "user" | "workspace",
  scopeId: string,
  subject: string,
): Promise<boolean> {
  if (scopeType === "user") return scopeId === subject;
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q.eq("userClerkId", subject).eq("workspaceId", scopeId as Id<"workspaces">),
    )
    .unique();
  return membership !== null;
}

/**
 * A page's scope is a person or a workspace, exactly like a doc's top-level
 * parent — so this is the same check, not a new one.
 */
export async function requireScopeAccess(
  ctx: QueryCtx | MutationCtx,
  scope: { scopeType: "user" | "workspace"; scopeId: string },
): Promise<{ subject: string }> {
  const identity = await requireIdentity(ctx);
  if (
    !(await canAccessScope(ctx, scope.scopeType, scope.scopeId, identity.subject))
  ) {
    throw new ConvexError("Forbidden");
  }
  return { subject: identity.subject };
}

export async function requirePageAccess(
  ctx: QueryCtx | MutationCtx,
  pageId: Id<"pages">,
): Promise<{ page: Doc<"pages">; subject: string }> {
  const page = await ctx.db.get(pageId);
  if (!page) throw new ConvexError("Page not found");
  const { subject } = await requireScopeAccess(ctx, {
    scopeType: page.scopeType,
    scopeId: page.scopeId,
  });
  return { page, subject };
}
