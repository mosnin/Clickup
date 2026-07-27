import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireListAccess } from "./_authz";
import { createTaskCore, validateTaskAssignees } from "./tasks";
import { blueprintTaskFields } from "./taskBlueprints";
import { emitEvent, scopeForList, userActor } from "./events";
import type { Actor } from "./_agentAuth";
import { notify } from "./notificationCenter";

// Time-based recurring tasks: "every Monday at 09:00 UTC create 'Weekly
// standup notes' in list X, due the same day". Complements the existing
// completion-triggered tasks.recurrence. An hourly cron
// (convex/crons.ts) materializes every enabled definition whose
// nextRunAt has passed.

const cadenceValidator = v.union(
  v.literal("hourly"),
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

type Cadence = "hourly" | "daily" | "weekly" | "monthly";

function scheduleFailureSummary(error: string): string {
  const normalized = error.toLowerCase();
  if (normalized.includes("assignee") && normalized.includes("scope")) {
    return "The assigned agent no longer has access to this list. Choose another assignee or update its access.";
  }
  return "The task could not be created. Check the schedule settings, then retry.";
}

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
  if (cadence === "hourly") {
    d.setUTCHours(d.getUTCHours() + 1);
    return d.getTime();
  }
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
  if (!args.title.trim()) throw new ConvexError("Title is required");
  const list = await ctx.db.get(args.listId);
  if (!list) throw new ConvexError("List not found");
  await validateTaskAssignees(ctx, list, args.assigneeIds ?? []);
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
        throw new ConvexError("Blueprint belongs to a different scope");
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
    if (!st) throw new ConvexError("Not found");
    await requireListAccess(ctx, st.listId);
    const patch: Record<string, unknown> = {};
    if (args.enabled !== undefined) {
      patch.enabled = args.enabled;
      if (args.enabled) {
        patch.lastError = undefined;
        patch.lastErrorAt = undefined;
        patch.consecutiveFailures = 0;
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

// Fan due definitions into isolated transactions. One malformed recurring
// operation must not roll back every healthy autonomous loop in the batch.
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
    for (const st of due) {
      await ctx.scheduler.runAfter(0, internal.scheduledTasks.materializeOne, {
        scheduledTaskId: st._id,
      });
    }
  },
});

export const materializeOne = internalAction({
  args: { scheduledTaskId: v.id("scheduledTasks") },
  handler: async (ctx, args) => {
    try {
      await ctx.runMutation(internal.scheduledTasks._materializeOne, args);
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : String(cause);
      await ctx.runMutation(
        internal.scheduledTasks._recordMaterializationFailure,
        {
          ...args,
          error: message.slice(0, 500),
        },
      );
    }
  },
});

export const _materializeOne = internalMutation({
  args: { scheduledTaskId: v.id("scheduledTasks") },
  handler: async (ctx, { scheduledTaskId }) => {
    const st = await ctx.db.get(scheduledTaskId);
    const now = Date.now();
    if (!st || !st.enabled || st.nextRunAt > now) return;
    const list = await ctx.db.get(st.listId);
    if (!list) {
      await ctx.db.patch(st._id, {
        enabled: false,
        lastError: "List no longer exists",
        lastErrorAt: now,
        consecutiveFailures: (st.consecutiveFailures ?? 0) + 1,
      });
      return;
    }
    const actor: Actor = {
      type: "system",
      id: "scheduler",
      name: "Scheduler",
    };
    // A linked blueprint supplies the full task shape (checklist, SOP'd
    // list, estimate, approval gate); the schedule's own fields cover the
    // bare-title case and act as the fallback if the blueprint was deleted.
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
      lastError: undefined,
      lastErrorAt: undefined,
      consecutiveFailures: 0,
      nextRunAt: computeNextRunAt(
        now,
        st.cadence,
        st.hourUtc,
        st.dayOfWeek,
        st.dayOfMonth,
      ),
    });
  },
});

export const _recordMaterializationFailure = internalMutation({
  args: {
    scheduledTaskId: v.id("scheduledTasks"),
    error: v.string(),
  },
  handler: async (ctx, { scheduledTaskId, error }) => {
    const st = await ctx.db.get(scheduledTaskId);
    if (!st || !st.enabled) return;
    const failures = (st.consecutiveFailures ?? 0) + 1;
    await ctx.db.patch(st._id, {
      consecutiveFailures: failures,
      lastError: error,
      lastErrorAt: Date.now(),
      // Three isolated retries are enough to prove this definition needs
      // intervention; pause it instead of producing an infinite error loop.
      enabled: failures < 3,
    });
    if (failures !== 3) return;
    const list = await ctx.db.get(st.listId);
    const scope = list ? await scopeForList(ctx, list) : null;
    if (!list || !scope) return;
    await emitEvent(ctx, {
      ...scope,
      type: "schedule.auto_paused",
      actor: { type: "system", id: "scheduler", name: "Scheduler" },
      entityType: "scheduled_task",
      entityId: st._id,
      entityTitle: st.title,
      listId: list._id,
      payload: { error, consecutiveFailures: failures },
    });
    const recipients: string[] = [];
    if (scope.scopeType === "user") {
      recipients.push(scope.scopeId);
    } else {
      const memberships = await ctx.db
        .query("memberships")
        .withIndex("by_workspace", (q) =>
          q.eq("workspaceId", scope.scopeId as Id<"workspaces">),
        )
        .collect();
      recipients.push(
        ...memberships
          .filter(
            (membership) =>
              membership.role === "owner" || membership.role === "admin",
          )
          .map((membership) => membership.userClerkId),
      );
    }
    for (const userClerkId of recipients) {
      await notify(ctx, {
        userClerkId,
        type: "schedule_failed",
        title: `Recurring operation paused: ${st.title}`,
        // Keep raw diagnostic details in the schedule and event audit record;
        // notification surfaces receive safe, actionable product language.
        body: scheduleFailureSummary(error),
        href:
          scope.scopeType === "workspace"
            ? `/dashboard/w/${scope.scopeId}?tab=operations`
            : `/dashboard/l/${st.listId}/settings`,
      });
    }
  },
});
