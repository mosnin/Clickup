import { internalMutation } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { emitEvent, scopeForList } from "./events";
import { CLAIM_TTL_MS } from "./tasks";

// Unattended-operation safety nets, driven from convex/crons.ts.

const WATCHDOG_ACTOR = {
  type: "system" as const,
  id: "watchdog",
  name: "Watchdog",
};

// How long an agent may hold currentTaskId without a heartbeat before we
// flag it as stalled.
const AGENT_STALL_MS = 30 * 60 * 1000;

// Sweep for stuck work:
//   1. Expired claims → release + task.claim_expired.
//   2. Overdue open tasks → task.overdue (once per overdue period).
//   3. Agents holding a current task but silent for 30+ min →
//      agent.stalled (their status line is cleared so the flag fires
//      once and Mission Control stops showing a stale "Now: …").
//
// The task pass is a full-table walk — same tradeoff as
// reports.workspaceSummary; fine at target scale, needs an index/cursor
// past a few thousand tasks.
export const watchdog = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const statusCache = new Map<string, Doc<"listStatuses"> | null>();
    const listCache = new Map<string, Doc<"lists"> | null>();

    const tasks = await ctx.db.query("tasks").collect();
    for (const task of tasks) {
      let status = statusCache.get(task.statusId);
      if (status === undefined) {
        status = await ctx.db.get(task.statusId);
        statusCache.set(task.statusId, status);
      }
      const isDone =
        status?.category === "complete" || status?.category === "closed";

      let list = listCache.get(task.listId);
      if (list === undefined) {
        list = await ctx.db.get(task.listId);
        listCache.set(task.listId, list);
      }
      if (!list) continue;

      // 1. Expired claims.
      if (
        task.claimedByActorId !== undefined &&
        task.claimedAt !== undefined &&
        now - task.claimedAt > CLAIM_TTL_MS
      ) {
        await ctx.db.patch(task._id, {
          claimedByActorId: undefined,
          claimedAt: undefined,
        });
        const scope = await scopeForList(ctx, list);
        if (scope) {
          await emitEvent(ctx, {
            ...scope,
            type: "task.claim_expired",
            actor: WATCHDOG_ACTOR,
            entityType: "task",
            entityId: task._id,
            entityTitle: task.title,
            listId: task.listId,
            payload: { previousClaimant: task.claimedByActorId },
          });
        }
      }

      // 2. Overdue nag (once per overdue period: reset when dueDate moves).
      if (
        !isDone &&
        task.dueDate !== undefined &&
        task.dueDate < now &&
        (task.overdueNotifiedAt === undefined ||
          task.overdueNotifiedAt < task.dueDate)
      ) {
        await ctx.db.patch(task._id, { overdueNotifiedAt: now });
        const scope = await scopeForList(ctx, list);
        if (scope) {
          await emitEvent(ctx, {
            ...scope,
            type: "task.overdue",
            actor: WATCHDOG_ACTOR,
            entityType: "task",
            entityId: task._id,
            entityTitle: task.title,
            listId: task.listId,
            payload: {
              dueDate: task.dueDate,
              assigneeIds: task.assigneeClerkIds,
            },
          });
        }
      }
    }

    // 3. Stalled agents.
    const agents = await ctx.db.query("agents").collect();
    for (const agent of agents) {
      if (
        agent.currentTaskId !== undefined &&
        agent.lastSeenAt !== undefined &&
        now - agent.lastSeenAt > AGENT_STALL_MS
      ) {
        await ctx.db.patch(agent._id, {
          currentTaskId: undefined,
          statusText: undefined,
        });
        await emitEvent(ctx, {
          scopeType: agent.parentType,
          scopeId: agent.parentId,
          type: "agent.stalled",
          actor: WATCHDOG_ACTOR,
          entityType: "agent",
          entityId: agent._id,
          entityTitle: agent.name,
          payload: {
            lastSeenAt: agent.lastSeenAt,
            taskId: agent.currentTaskId,
          },
        });
        // Mark any run it left open as abandoned.
        const runs = await ctx.db
          .query("agentRuns")
          .withIndex("by_agent", (q) => q.eq("agentId", agent._id))
          .order("desc")
          .take(5);
        for (const run of runs) {
          if (run.status === "running") {
            await ctx.db.patch(run._id, {
              status: "abandoned",
              finishedAt: now,
            });
          }
        }
      }
    }
  },
});

// Retention windows.
const EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const USAGE_RETENTION_DAYS = 14;
const PRUNE_BATCH = 500;

// Daily pruning. Tables are append-only, so oldest-by-_creationTime and
// oldest-by-createdAt coincide; each run deletes at most one batch per
// table and the next day's run catches up if there's backlog.
export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    const oldEvents = await ctx.db.query("events").order("asc").take(PRUNE_BATCH);
    for (const e of oldEvents) {
      if (e.createdAt < now - EVENT_RETENTION_MS) await ctx.db.delete(e._id);
    }

    const oldDeliveries = await ctx.db
      .query("webhookDeliveries")
      .order("asc")
      .take(PRUNE_BATCH);
    for (const d of oldDeliveries) {
      if (d.createdAt < now - DELIVERY_RETENTION_MS) {
        await ctx.db.delete(d._id);
      }
    }

    const cutoffDay = new Date(now - USAGE_RETENTION_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const oldUsage = await ctx.db
      .query("agentUsage")
      .order("asc")
      .take(PRUNE_BATCH);
    for (const u of oldUsage) {
      if (u.day < cutoffDay) await ctx.db.delete(u._id);
    }
  },
});
