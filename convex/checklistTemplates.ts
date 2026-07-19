import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireIdentity, requireTaskAccess } from "./_authz";
import { scopeForList, userActor } from "./events";
import { updateTaskCore } from "./tasks";

// Reusable checklist playbooks ("Definition of done", "Release steps").
// A template is just a named list of item texts scoped to a personal space
// or a workspace; applying one snapshots those texts onto a task's embedded
// checklist. Scope access mirrors webhooks.ts: a "user" scope must be the
// caller's own subject, a "workspace" scope requires membership.

async function requireScopeAccess(
  ctx: QueryCtx | MutationCtx,
  scopeType: "user" | "workspace",
  scopeId: string,
): Promise<{ subject: string }> {
  const identity = await requireIdentity(ctx);
  if (scopeType === "user") {
    if (scopeId !== identity.subject) throw new Error("Forbidden");
  } else {
    const member = await ctx.db
      .query("memberships")
      .withIndex("by_user_and_workspace", (q) =>
        q
          .eq("userClerkId", identity.subject)
          .eq("workspaceId", scopeId as Id<"workspaces">),
      )
      .unique();
    if (!member) throw new Error("Forbidden");
  }
  return { subject: identity.subject };
}

type TemplateWithSource = Doc<"checklistTemplates"> & {
  source: "workspace" | "personal";
};

// Templates available to a given task: its own scope's templates, plus —
// for a workspace task — the caller's personal-scope templates too, so a
// human can reuse their own playbooks inside a team list. Returns [] on
// access failure rather than throwing, so a read-only UI can render an
// empty popover instead of an error boundary.
export const listForTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }): Promise<TemplateWithSource[]> => {
    let access;
    try {
      access = await requireTaskAccess(ctx, taskId);
    } catch {
      return [];
    }
    const { list, identity } = access;
    const scope = await scopeForList(ctx, list);
    if (!scope) return [];

    const own = await ctx.db
      .query("checklistTemplates")
      .withIndex("by_scope", (q) =>
        q.eq("scopeType", scope.scopeType).eq("scopeId", scope.scopeId),
      )
      .collect();
    const results: TemplateWithSource[] = own.map((t) => ({
      ...t,
      source: scope.scopeType === "workspace" ? "workspace" : "personal",
    }));

    if (scope.scopeType === "workspace") {
      const personal = await ctx.db
        .query("checklistTemplates")
        .withIndex("by_scope", (q) =>
          q.eq("scopeType", "user").eq("scopeId", identity.subject),
        )
        .collect();
      for (const t of personal) {
        results.push({ ...t, source: "personal" });
      }
    }

    return results.sort((a, b) => b.createdAt - a.createdAt);
  },
});

export const create = mutation({
  args: {
    scopeType: v.union(v.literal("user"), v.literal("workspace")),
    scopeId: v.string(),
    name: v.string(),
    items: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const { subject } = await requireScopeAccess(
      ctx,
      args.scopeType,
      args.scopeId,
    );
    const items = args.items.map((i) => i.trim()).filter((i) => i.length > 0);
    if (items.length === 0) {
      throw new Error("A template needs at least one item");
    }
    const name = args.name.trim();
    if (!name) throw new Error("A template needs a name");

    const actor = await userActor(ctx, subject);
    return await ctx.db.insert("checklistTemplates", {
      scopeType: args.scopeType,
      scopeId: args.scopeId,
      name,
      items,
      createdByActorId: actor.id,
      createdAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { templateId: v.id("checklistTemplates") },
  handler: async (ctx, { templateId }) => {
    const template = await ctx.db.get(templateId);
    if (!template) throw new Error("Template not found");
    await requireScopeAccess(ctx, template.scopeType, template.scopeId);
    await ctx.db.delete(templateId);
  },
});

// Snapshots a task's current checklist item texts into a new template in
// the task's own scope.
export const saveFromTask = mutation({
  args: { taskId: v.id("tasks"), name: v.string() },
  handler: async (ctx, { taskId, name }) => {
    const { task, list, identity } = await requireTaskAccess(ctx, taskId);
    const items = (task.checklist ?? [])
      .map((i) => i.text.trim())
      .filter((t) => t.length > 0);
    if (items.length === 0) {
      throw new Error("This task has no checklist items to save yet");
    }
    const trimmedName = name.trim();
    if (!trimmedName) throw new Error("A template needs a name");

    const scope = await scopeForList(ctx, list);
    if (!scope) throw new Error("Orphan list");
    const actor = await userActor(ctx, identity.subject);
    return await ctx.db.insert("checklistTemplates", {
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      name: trimmedName,
      items,
      createdByActorId: actor.id,
      createdAt: Date.now(),
    });
  },
});

// Appends a template's items onto a task's existing checklist as fresh,
// unchecked entries. The template must live in the task's own scope or in
// the caller's personal scope (so a human can bring their own playbook
// into a team list). Routed through updateTaskCore so this behaves
// identically to every other checklist write (events, automations, etc.).
export const applyToTask = mutation({
  args: { taskId: v.id("tasks"), templateId: v.id("checklistTemplates") },
  handler: async (ctx, { taskId, templateId }) => {
    const { task, list, identity } = await requireTaskAccess(ctx, taskId);
    const template = await ctx.db.get(templateId);
    if (!template) throw new Error("Template not found");

    const scope = await scopeForList(ctx, list);
    if (!scope) throw new Error("Orphan list");
    const matchesTaskScope =
      template.scopeType === scope.scopeType &&
      template.scopeId === scope.scopeId;
    const matchesPersonalScope =
      template.scopeType === "user" && template.scopeId === identity.subject;
    if (!matchesTaskScope && !matchesPersonalScope) {
      throw new Error("Forbidden");
    }

    const existing = task.checklist ?? [];
    const appended = template.items.map((text) => ({
      id: Math.random().toString(36).slice(2, 10),
      text,
      done: false,
    }));
    const actor = await userActor(ctx, identity.subject);
    await updateTaskCore(
      ctx,
      { taskId, checklist: [...existing, ...appended] },
      actor,
    );
  },
});
