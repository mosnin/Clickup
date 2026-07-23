import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireIdentity, requireListAccess } from "./_authz";
import { scopeForList } from "./events";

// Workspace field library (Phase L): define a custom field once, apply it
// to any list. Applying copies the definition into that list's own
// customFields row, so everything downstream (values, filters, editors)
// keeps working per-list exactly as before — the library is a stamp, not
// a reference.

const typeValidator = v.union(
  v.literal("text"),
  v.literal("number"),
  v.literal("dropdown"),
  v.literal("date"),
  v.literal("checkbox"),
);

const optionsValidator = v.array(
  v.object({
    id: v.string(),
    label: v.string(),
    color: v.optional(v.string()),
  }),
);

async function requireWorkspaceMember(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<string> {
  const identity = await requireIdentity(ctx);
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_workspace", (q) =>
      q.eq("userClerkId", identity.subject).eq("workspaceId", workspaceId),
    )
    .unique();
  if (!membership) throw new Error("Not a member of this workspace");
  return identity.subject;
}

export const listForWorkspace = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    try {
      await requireWorkspaceMember(ctx, workspaceId);
    } catch {
      return [];
    }
    const rows = await ctx.db
      .query("fieldLibrary")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const create = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    name: v.string(),
    type: typeValidator,
    options: v.optional(optionsValidator),
  },
  handler: async (ctx, args) => {
    const subject = await requireWorkspaceMember(ctx, args.workspaceId);
    const name = args.name.trim();
    if (!name) throw new Error("Field name is required");
    if (args.type === "dropdown" && (!args.options || args.options.length === 0)) {
      throw new Error("Dropdown fields need at least one option");
    }
    return await ctx.db.insert("fieldLibrary", {
      workspaceId: args.workspaceId,
      name,
      type: args.type,
      options: args.type === "dropdown" ? args.options : undefined,
      createdByActorId: subject,
      createdAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { fieldId: v.id("fieldLibrary") },
  handler: async (ctx, { fieldId }) => {
    const field = await ctx.db.get(fieldId);
    if (!field) return;
    await requireWorkspaceMember(ctx, field.workspaceId);
    // Copies already stamped onto lists live on untouched.
    await ctx.db.delete(fieldId);
  },
});

// Stamp a library field onto a list as a regular customFields row.
export const applyToList = mutation({
  args: { fieldId: v.id("fieldLibrary"), listId: v.id("lists") },
  handler: async (ctx, args) => {
    const field = await ctx.db.get(args.fieldId);
    if (!field) throw new Error("Field not found");
    await requireWorkspaceMember(ctx, field.workspaceId);
    const { list } = await requireListAccess(ctx, args.listId);
    const scope = await scopeForList(ctx, list);
    if (
      !scope ||
      scope.scopeType !== "workspace" ||
      scope.scopeId !== (field.workspaceId as string)
    ) {
      throw new Error("This field belongs to a different workspace");
    }
    const existing = await ctx.db
      .query("customFields")
      .withIndex("by_list", (q) => q.eq("listId", list._id))
      .collect();
    if (
      existing.some(
        (f) => f.name.toLowerCase() === field.name.toLowerCase(),
      )
    ) {
      throw new Error(`This list already has a "${field.name}" field`);
    }
    return await ctx.db.insert("customFields", {
      listId: list._id,
      name: field.name,
      type: field.type,
      options: field.options,
      position: existing.length,
      createdAt: Date.now(),
    });
  },
});
