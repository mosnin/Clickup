import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireListAccess } from "./_authz";

const triggerValidator = v.union(
  v.literal("task_created"),
  v.literal("status_changed_to_complete"),
);

const actionValidator = v.union(
  v.object({ kind: v.literal("assign_user"), clerkId: v.string() }),
  v.object({
    kind: v.literal("set_priority"),
    priority: v.union(
      v.literal("urgent"),
      v.literal("high"),
      v.literal("normal"),
      v.literal("low"),
    ),
  }),
  v.object({ kind: v.literal("set_status"), statusId: v.id("listStatuses") }),
  v.object({ kind: v.literal("set_due_in_days"), days: v.number() }),
);

export const listForList = query({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) => {
    try {
      await requireListAccess(ctx, listId);
    } catch {
      return [];
    }
    return await ctx.db
      .query("listAutomations")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect();
  },
});

export const create = mutation({
  args: {
    listId: v.id("lists"),
    trigger: triggerValidator,
    action: actionValidator,
  },
  handler: async (ctx, args) => {
    await requireListAccess(ctx, args.listId);
    return await ctx.db.insert("listAutomations", {
      listId: args.listId,
      trigger: args.trigger,
      action: args.action,
      enabled: true,
      createdAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: {
    automationId: v.id("listAutomations"),
    trigger: v.optional(triggerValidator),
    action: v.optional(actionValidator),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const auto = await ctx.db.get(args.automationId);
    if (!auto) throw new Error("Automation not found");
    await requireListAccess(ctx, auto.listId);
    const patch: Record<string, unknown> = {};
    if (args.trigger !== undefined) patch.trigger = args.trigger;
    if (args.action !== undefined) patch.action = args.action;
    if (args.enabled !== undefined) patch.enabled = args.enabled;
    await ctx.db.patch(args.automationId, patch);
  },
});

export const remove = mutation({
  args: { automationId: v.id("listAutomations") },
  handler: async (ctx, { automationId }) => {
    const auto = await ctx.db.get(automationId);
    if (!auto) return;
    await requireListAccess(ctx, auto.listId);
    await ctx.db.delete(automationId);
  },
});

// Apply every enabled automation matching `trigger` against the given task.
// Called from tasks.create and tasks.update inside their own transactions
// so all patches are atomic. Actions are primitive db.patch calls — never
// re-enter tasks.update — so there's no recursion risk.
export async function applyAutomations(
  ctx: MutationCtx,
  task: Doc<"tasks">,
  trigger: "task_created" | "status_changed_to_complete",
): Promise<void> {
  const rules = await ctx.db
    .query("listAutomations")
    .withIndex("by_list", (q) => q.eq("listId", task.listId))
    .collect();

  let working = task;
  for (const rule of rules) {
    if (!rule.enabled || rule.trigger !== trigger) continue;
    const patch: Record<string, unknown> = {};
    switch (rule.action.kind) {
      case "assign_user": {
        const cid = rule.action.clerkId;
        if (!working.assigneeClerkIds.includes(cid)) {
          patch.assigneeClerkIds = [...working.assigneeClerkIds, cid];
        }
        break;
      }
      case "set_priority":
        if (working.priority !== rule.action.priority) {
          patch.priority = rule.action.priority;
        }
        break;
      case "set_status": {
        const status = await ctx.db.get(
          rule.action.statusId as Id<"listStatuses">,
        );
        if (status && status.listId === working.listId) {
          if (working.statusId !== status._id) {
            patch.statusId = status._id;
            if (
              status.category === "complete" ||
              status.category === "closed"
            ) {
              patch.completedAt = Date.now();
            } else {
              patch.completedAt = undefined;
            }
          }
        }
        break;
      }
      case "set_due_in_days": {
        const next = Date.now() + rule.action.days * 86_400_000;
        if (working.dueDate !== next) {
          patch.dueDate = next;
        }
        break;
      }
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(working._id, patch);
      working = { ...working, ...patch } as Doc<"tasks">;
    }
  }
}
