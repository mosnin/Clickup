import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireListAccess } from "./_authz";
import { createTaskCore } from "./tasks";
import { blueprintTaskFields } from "./taskBlueprints";
import { scopeForList, userActor } from "./events";
import type { Actor } from "./_agentAuth";

// Time-based recurring tasks: "every Monday at 09:00 UTC create 'Weekly
// standup notes' in list X, due the same day". Complements the existing
// completion-triggered tasks.recurrence. An hourly cron
// (convex/crons.ts) materializes every enabled definition whose
// nextRunAt has passed.

const cadenceValidator = v.union(
  v.literal("daily"),
  v.literal("weekly"),
  v.literal("monthly"),
);

const priorityValidator = v.union(
  v.literal("urgent"),
  v.literal("high"),
  v.literal("normal"),
  v.literal("low"),
);

type Cadence = "daily" | "weekly" | "monthly";

// Next occurrence of the schedule strictly after `after`.
export function computeNextRunAt(
  after: number,
  cadence: Cadence,
  hourUtc: number,
  dayOfWeek?: number,
  dayOfMonth?: number,
): number {
  const d = new Date(after);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(hourUtc);
  if (cadence === "daily") {
    while (d.getTime() <= after) d.setUTCDate(d.getUTCDate() + 1);
    return d.getTime();
  }
  if (cadence === "weekly") {
    const target = ((dayOfWeek ?? 1) % 7 + 7) % 7;
    while (d.getUTCDay() !== target || d.getTime() <= after) {
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return d.getTime();
  }
  // monthly — clamp to 1..28 so every month works.
  const dom = Math.min(Math.max(dayOfMonth ?? 1, 1), 28);
  d.setUTCDate(dom);
  while (d.getTime() <= after) {
    d.setUTCMonth(d.getUTCMonth() + 1);
    d.setUTCDate(dom);
  }
  return d.getTime();
}

export type CreateScheduledTaskArgs = {
  listId: Id<"lists">;
  title: string;
  description?: string;
  priority?: "urgent" | "high" | "normal" | "low";
  assigneeIds?: string[];
  cadence: Cadence;
  dayOfWeek?: number;
  dayOfMonth?: number;
  hourUtc?: number;
  dueInDays?: number;
  blueprintId?: Id<"taskBlueprints">;
};

export async function createScheduledTaskCore(
  ctx: MutationCtx,
  args: CreateScheduledTaskArgs,
  actor: Actor,
): Promise<Id<"scheduledTasks">> {
  if (!args.title.trim()) throw new Error("Title is required");
  const hourUtc = Math.min(Math.max(args.hourUtc ?? 9, 0), 23);
  return await ctx.db.insert("scheduledTasks", {
    listId: args.listId,
    title: args.title.trim(),
    description: args.description,
    priority: args.priority,
    assigneeIds: args.assigneeIds ?? [],
    cadence: args.cadence,
    dayOfWeek: args.dayOfWeek,
    dayOfMonth: args.dayOfMonth,
    hourUtc,
    dueInDays: args.dueInDays,
    blueprintId: args.blueprintId,
    nextRunAt: computeNextRunAt(
      Date.now(),
      args.cadence,
      hourUtc,
      args.dayOfWeek,
      args.dayOfMonth,
    ),
    enabled: true,
    createdByActorId: actor.id,
    createdAt: Date.now(),
  });
}

// ── Clerk-authenticated API ────────────────────────────────────────────

export const listForList = query({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) => {
    try {
      await requireListAccess(ctx, listId);
    } catch {
      return [];
    }
    return await ctx.db
      .query("scheduledTasks")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect();
  },
});

export const create = mutation({
  args: {
    listId: v.id("lists"),
    title: v.string(),
    description: v.optional(v.string()),
    priority: v.optional(priorityValidator),
    assigneeIds: v.optional(v.array(v.string())),
    cadence: cadenceValidator,
    dayOfWeek: v.optional(v.number()),
    dayOfMonth: v.optional(v.number()),
    hourUtc: v.optional(v.number()),
    dueInDays: v.optional(v.number()),
    blueprintId: v.optional(v.id("taskBlueprints")),
  },
  handler: async (ctx, args) => {
    const { identity, list } = await requireListAccess(ctx, args.listId);
    if (args.blueprintId) {
      const bp = await ctx.db.get(args.blueprintId);
      const scope = bp && (await scopeForList(ctx, list));
      if (
        !bp ||
        !scope ||
        scope.scopeType !== bp.scopeType ||
        scope.scopeId !== bp.scopeId
      ) {
        throw new Error("Blueprint belongs to a different scope");
      }
    }
    const actor = await userActor(ctx, identity.subject);
    return await createScheduledTaskCore(ctx, args, actor);
  },
});

export const update = mutation({
  args: {
    scheduledTaskId: v.id("scheduledTasks"),
    enabled: v.optional(v.boolean()),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const st = await ctx.db.get(args.scheduledTaskId);
    if (!st) throw new Error("Not found");
    await requireListAccess(ctx, st.listId);
    const patch: Record<string, unknown> = {};
    if (args.enabled !== undefined) {
      patch.enabled = args.enabled;
      if (args.enabled) {
        patch.nextRunAt = computeNextRunAt(
          Date.now(),
          st.cadence,
          st.hourUtc,
          st.dayOfWeek,
          st.dayOfMonth,
        );
      }
    }
    if (args.title !== undefined && args.title.trim()) {
      patch.title = args.title.trim();
    }
    if (args.description !== undefined) patch.description = args.description;
    await ctx.db.patch(args.scheduledTaskId, patch);
  },
});

export const remove = mutation({
  args: { scheduledTaskId: v.id("scheduledTasks") },
  handler: async (ctx, { scheduledTaskId }) => {
    const st = await ctx.db.get(scheduledTaskId);
    if (!st) return;
    await requireListAccess(ctx, st.listId);
    await ctx.db.delete(scheduledTaskId);
  },
});

// ── Cron worker ────────────────────────────────────────────────────────

// Materialize every due definition into a real task. Runs hourly; the
// scheduler actor shows up in the activity feed as "Scheduler".
export const materializeDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("scheduledTasks")
      .withIndex("by_next_run", (q) =>
        q.eq("enabled", true).lte("nextRunAt", now),
      )
      .collect();
    const actor: Actor = { type: "system", id: "scheduler", name: "Scheduler" };
    for (const st of due) {
      const list = await ctx.db.get(st.listId);
      if (!list) {
        await ctx.db.patch(st._id, { enabled: false });
        continue;
      }
      // A linked blueprint supplies the full task shape (checklist, SOP'd
      // list, estimate, approval gate); the schedule's own fields cover
      // the bare-title case and act as the fallback if the blueprint was
      // deleted out from under the link.
      const bp = st.blueprintId ? await ctx.db.get(st.blueprintId) : null;
      await createTaskCore(
        ctx,
        bp
          ? {
              listId: st.listId,
              assigneeIds: st.assigneeIds,
              ...blueprintTaskFields(bp),
            }
          : {
              listId: st.listId,
              title: st.title,
              description: st.description,
              priority: st.priority,
              assigneeIds: st.assigneeIds,
              dueDate:
                st.dueInDays !== undefined
                  ? now + st.dueInDays * 86_400_000
                  : undefined,
            },
        actor,
      );
      await ctx.db.patch(st._id, {
        lastRunAt: now,
        nextRunAt: computeNextRunAt(
          now,
          st.cadence,
          st.hourUtc,
          st.dayOfWeek,
          st.dayOfMonth,
        ),
      });
    }
  },
});
