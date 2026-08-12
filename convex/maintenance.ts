import { internalMutation } from "./_generated/server";
import { presenceIsStale } from "./presence";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { emitEvent, scopeForList } from "./events";
import { notify } from "./notificationCenter";
import { CLAIM_TTL_MS } from "./tasks";
import {
  detectThrash,
  describeThrash,
  type ThrashRun,
} from "./_thrash";
import {
  MAX_EXECUTION_ATTEMPTS,
  decideRecovery,
  describeExhaustion,
} from "./_recovery";
import { contextLoadFromPackets, listPacketsForTask } from "./contextPackets";
import {
  abandonExecutionAssignmentForTask,
  finishExecutionAssignment,
} from "./executionLifecycle";

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
//   4. Tasks being failed at over and over → task.thrashing, the claim
//      released, and the task WITHHELD from the dispatcher until a human
//      clears it. Passes 1-3 all detect absence; this is the only one that
//      detects repetition, which is what an unattended agent actually does
//      when it is wrong. See convex/_thrash.ts.
//   5. Abandoned execution attempts → retried, reset, or escalated. The
//      lifecycle always modelled abandonment and nothing was ever on the
//      other side of it, so a stalled attempt waited for a human to notice.
//      See convex/_recovery.ts for the three-way decision.
//
// Both task passes are index ranges, not table scans: claimed tasks have
// claimedByActorId > "" (absent optional fields sort before every
// string), and due tasks have 0 < dueDate < now.
export const watchdog = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const statusCache = new Map<string, Doc<"listStatuses"> | null>();
    const listCache = new Map<string, Doc<"lists"> | null>();
    const getList = async (id: Doc<"tasks">["listId"]) => {
      let list = listCache.get(id);
      if (list === undefined) {
        list = await ctx.db.get(id);
        listCache.set(id, list);
      }
      return list;
    };

    // 1. Expired claims.
    const claimedTasks = await ctx.db
      .query("tasks")
      .withIndex("by_claimed", (q) => q.gt("claimedByActorId", ""))
      .collect();
    for (const task of claimedTasks) {
      if (
        task.claimedAt === undefined ||
        now - task.claimedAt <= CLAIM_TTL_MS
      ) {
        continue;
      }
      const claimantAgentId = ctx.db.normalizeId(
        "agents",
        task.claimedByActorId!,
      );
      if (claimantAgentId) {
        await abandonExecutionAssignmentForTask(
          ctx,
          task._id,
          claimantAgentId,
          "Task claim expired",
        );
      }
      await ctx.db.patch(task._id, {
        claimedByActorId: undefined,
        claimedAt: undefined,
      });
      const list = await getList(task.listId);
      const scope = list ? await scopeForList(ctx, list) : null;
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
    const dueTasks = await ctx.db
      .query("tasks")
      .withIndex("by_due", (q) => q.gt("dueDate", 0).lt("dueDate", now))
      .collect();
    for (const task of dueTasks) {
      if (
        task.overdueNotifiedAt !== undefined &&
        task.overdueNotifiedAt >= task.dueDate!
      ) {
        continue;
      }
      let status = statusCache.get(task.statusId);
      if (status === undefined) {
        status = await ctx.db.get(task.statusId);
        statusCache.set(task.statusId, status);
      }
      if (status?.category === "complete" || status?.category === "closed") {
        continue;
      }
      const list = await getList(task.listId);
      if (!list) continue;
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
      // In-app nudge for each human assignee.
      for (const cid of task.assigneeClerkIds) {
        if (ctx.db.normalizeId("agents", cid)) continue;
        await notify(ctx, {
          userClerkId: cid,
          type: "overdue",
          title: "Task overdue",
          body: task.title,
          href: `/dashboard/l/${task.listId}/t/${task._id}`,
        });
      }
    }

    // 2b. Due-soon reminder (within the next 24h, once per due date).
    const soonHorizon = now + 24 * 60 * 60 * 1000;
    const soonTasks = await ctx.db
      .query("tasks")
      .withIndex("by_due", (q) => q.gt("dueDate", now).lt("dueDate", soonHorizon))
      .collect();
    for (const task of soonTasks) {
      if (
        task.dueSoonNotifiedAt !== undefined &&
        task.dueSoonNotifiedAt >= task.dueDate!
      ) {
        continue;
      }
      let status = statusCache.get(task.statusId);
      if (status === undefined) {
        status = await ctx.db.get(task.statusId);
        statusCache.set(task.statusId, status);
      }
      if (status?.category === "complete" || status?.category === "closed") {
        continue;
      }
      await ctx.db.patch(task._id, { dueSoonNotifiedAt: now });
      for (const cid of task.assigneeClerkIds) {
        if (ctx.db.normalizeId("agents", cid)) continue;
        await notify(ctx, {
          userClerkId: cid,
          type: "due_soon",
          title: "Due within a day",
          body: task.title,
          href: `/dashboard/l/${task.listId}/t/${task._id}`,
        });
        const user = await ctx.db
          .query("users")
          .withIndex("by_clerk_id", (q) => q.eq("clerkId", cid))
          .unique();
        if (user?.email) {
          await ctx.scheduler.runAfter(
            0,
            internal.notifications.sendDueSoonEmail,
            {
              toEmail: user.email,
              toName: user.name,
              taskTitle: task.title,
              whenLabel: "within a day",
            },
          );
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
        await abandonExecutionAssignmentForTask(
          ctx,
          agent.currentTaskId,
          agent._id,
          "Agent stopped heartbeating for 30 minutes",
        );
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
            if (run.executionAssignmentId) {
              await finishExecutionAssignment(
                ctx,
                run.executionAssignmentId,
                agent._id,
                {
                  status: "abandoned",
                  error: "Agent stopped heartbeating for 30 minutes",
                },
              );
            }
          }
        }
      }
    }

    // 4. Thrash: the same task failed at over and over.
    //
    // Driven off each agent's own recent runs rather than a global scan.
    // `agentRuns` has no time-ordered index across the deployment, so the
    // bounded way to ask "what failed lately" is to ask each agent, which is
    // the same shape (and the same cost order) as pass 3 above. The window is
    // six hours and the watchdog runs every fifteen minutes, so a run is seen
    // by ~24 passes — which is exactly why the detector dedupes by run id and
    // reports only what is newer than its last notice.
    const runsForDetection: ThrashRun[] = [];
    const agentNames = new Map<string, string>();
    for (const agent of agents) {
      agentNames.set(agent._id, agent.name);
      const recent = await ctx.db
        .query("agentRuns")
        .withIndex("by_agent", (q) => q.eq("agentId", agent._id))
        .order("desc")
        .take(40);
      for (const run of recent) {
        if (!run.taskId) continue;
        runsForDetection.push({
          id: run._id,
          taskId: run.taskId,
          agentId: run.agentId,
          status: run.status,
          finishedAt: run.finishedAt,
        });
      }
    }

    // What has already been said, per task. Absent means never reported.
    const alreadyReported: Record<string, number | undefined> = {};
    for (const run of runsForDetection) {
      if (alreadyReported[run.taskId] !== undefined) continue;
      const t = await ctx.db.get(run.taskId as Doc<"tasks">["_id"]);
      alreadyReported[run.taskId] = t?.thrashNotifiedAt;
    }

    for (const finding of detectThrash(runsForDetection, now, alreadyReported)) {
      const task = await ctx.db.get(finding.taskId as Doc<"tasks">["_id"]);
      if (!task) continue;
      const status = await ctx.db.get(task.statusId);
      // A task that got there in the end is not thrashing, whatever the runs
      // say — the failures are history, not a live loop.
      if (status?.category === "complete" || status?.category === "closed") {
        continue;
      }
      const list = await getList(task.listId);
      if (!list) continue;
      const scope = await scopeForList(ctx, list);
      if (!scope) continue;

      const names = finding.agentIds
        .map((id) => agentNames.get(id))
        .filter((n): n is string => n !== undefined);

      await ctx.db.patch(task._id, {
        // The brake. Detection without one is a notification, and the loop it
        // detected carries on regardless — which is the whole complaint.
        thrashHeldAt: now,
        thrashNotifiedAt: finding.latestAt,
        thrashFailures: finding.failures,
        // Nobody is working on it productively; holding the claim only stops
        // a person from picking it up to look.
        claimedByActorId: undefined,
        claimedAt: undefined,
      });

      await emitEvent(ctx, {
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        type: "task.thrashing",
        actor: WATCHDOG_ACTOR,
        entityType: "task",
        entityId: task._id,
        entityTitle: task.title,
        listId: task.listId,
        payload: {
          failures: finding.failures,
          agentIds: finding.agentIds,
          summary: describeThrash(finding, names),
        },
      });

      // Who to nudge. Human assignees if there are any; otherwise whoever
      // created the task. A thrashing task very often has only AGENT
      // assignees — that is close to the definition of the problem — so
      // notifying assignees alone would send the alarm to the machines
      // causing it. The obligations queue carries it either way; this is the
      // nudge on top.
      const humans = task.assigneeClerkIds.filter(
        (cid) => !ctx.db.normalizeId("agents", cid),
      );
      const recipients =
        humans.length > 0
          ? humans
          : ctx.db.normalizeId("agents", task.createdByClerkId)
            ? []
            : [task.createdByClerkId];
      for (const cid of recipients) {
        await notify(ctx, {
          userClerkId: cid,
          type: "thrashing",
          title: `${task.title} is stuck in a loop`,
          body: describeThrash(finding, names),
          href: `/dashboard/l/${task.listId}/t/${task._id}`,
        });
      }
    }

    // 5. Abandoned execution attempts.
    //
    // Bounded by the index range rather than by walking plans: an abandoned
    // row is the only kind this pass acts on, and there are far fewer of them
    // than there are assignments.
    const abandoned = await ctx.db
      .query("executionAssignments")
      .withIndex("by_status_and_finished", (q) => q.eq("status", "abandoned"))
      .order("desc")
      .take(200);

    for (const assignment of abandoned) {
      const task = await ctx.db.get(assignment.taskId);
      if (!task) continue;
      const status = await ctx.db.get(task.statusId);
      // Somebody finished it after the attempt died. Nothing to recover.
      if (status?.category === "complete" || status?.category === "closed") {
        continue;
      }
      // Already held — by this pass on an earlier run, or by thrash detection.
      // Recovering a task a person has been asked to look at would be the
      // brake and the accelerator fighting each other.
      if (task.thrashHeldAt !== undefined) continue;

      // A newer attempt exists, so this row is history rather than a stall.
      const latest = await ctx.db
        .query("executionAssignments")
        .withIndex("by_task", (q) => q.eq("taskId", assignment.taskId))
        .order("desc")
        .first();
      if (latest && latest._id !== assignment._id) continue;

      const current = contextLoadFromPackets(
        await listPacketsForTask(ctx, assignment.taskId),
      );
      const decision = decideRecovery(
        {
          assignmentId: assignment._id,
          taskId: assignment.taskId,
          attempt: assignment.attempt,
          finishedAt: assignment.finishedAt,
          contextVersionFingerprint: assignment.contextVersionFingerprint,
          lastRecoveredAt: assignment.lastRecoveredAt,
        },
        current.contextVersionFingerprint,
        now,
      );
      if (decision.action === "wait") continue;

      const list = await getList(task.listId);
      if (!list) continue;
      const scope = await scopeForList(ctx, list);
      if (!scope) continue;

      if (decision.action === "escalate") {
        await ctx.db.patch(task._id, {
          // The same brake thrash detection uses, for the same reason and with
          // a different label — two flags that both mean "withheld until
          // somebody looks" is how the two drift apart.
          thrashHeldAt: now,
          holdReason: "attempts_exhausted",
          thrashFailures: decision.attempts,
          claimedByActorId: undefined,
          claimedAt: undefined,
        });
        await emitEvent(ctx, {
          ...scope,
          type: "execution.attempts_exhausted",
          actor: WATCHDOG_ACTOR,
          entityType: "task",
          entityId: task._id,
          entityTitle: task.title,
          listId: task.listId,
          payload: {
            assignmentId: assignment._id,
            attempts: decision.attempts,
            summary: describeExhaustion(decision.attempts),
          },
        });
        const humans = task.assigneeClerkIds.filter(
          (cid) => !ctx.db.normalizeId("agents", cid),
        );
        const recipients =
          humans.length > 0
            ? humans
            : ctx.db.normalizeId("agents", task.createdByClerkId)
              ? []
              : [task.createdByClerkId];
        for (const cid of recipients) {
          await notify(ctx, {
            userClerkId: cid,
            type: "thrashing",
            title: `${task.title} ran out of attempts`,
            body: describeExhaustion(decision.attempts),
            href: `/dashboard/l/${task.listId}/t/${task._id}`,
          });
        }
        continue;
      }

      // Retry or reset: hand the work back to the pull path. The cut line's
      // shape deliberately — no new wave is minted, the task simply becomes
      // findable again, and `next_task` already ranks and fences correctly.
      //
      // The count lives on the assignment because that is what `attempt` is
      // for, and because re-offering into the pull path mints nothing new to
      // put it on. Without this the cap could never be reached and the
      // escalation branch above would be unreachable code — a bound that
      // exists in the source and not in the behaviour.
      await ctx.db.patch(assignment._id, {
        attempt: decision.attempt,
        lastRecoveredAt: now,
        // A reset starts the fingerprint over too, or the very next pass
        // compares against the stale one and resets again forever.
        contextVersionFingerprint: current.contextVersionFingerprint,
      });
      await ctx.db.patch(task._id, {
        claimedByActorId: undefined,
        claimedAt: undefined,
      });
      await emitEvent(ctx, {
        ...scope,
        type: "execution.reoffered",
        actor: WATCHDOG_ACTOR,
        entityType: "task",
        entityId: task._id,
        entityTitle: task.title,
        listId: task.listId,
        payload: {
          assignmentId: assignment._id,
          attempt: decision.attempt,
          of: MAX_EXECUTION_ATTEMPTS,
          // Stated, because the two look identical from outside and mean
          // different things: one is another go at the same work, the other is
          // a fresh start at work that changed.
          reason:
            decision.action === "reset"
              ? "context_changed"
              : "previous_attempt_abandoned",
        },
      });
    }
  },
});

// Retention windows.
const EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const USAGE_RETENTION_DAYS = 14;
const DEVICE_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;
// Comfortably longer than the longest rate-limit window, so pruning can
// never hand somebody a fresh budget early.
const RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000;
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

    // Device authorization requests. They live 10 minutes and are useless
    // the moment they expire, but a claimed row has to outlive its own code
    // — that terminal row is what makes a replayed device_code an
    // invalid_grant rather than a second key. A day's grace is far longer
    // than any live code, so nothing is deleted while it could still matter.
    const oldAuthRequests = await ctx.db
      .query("agentAuthRequests")
      .withIndex("by_expires", (q) =>
        q.lt("expiresAt", now - DEVICE_REQUEST_RETENTION_MS),
      )
      .take(PRUNE_BATCH);
    for (const request of oldAuthRequests) await ctx.db.delete(request._id);

    // Rate-limit counters. One row per distinct caller, reused across
    // windows, so this only reclaims callers who have gone quiet — a row is
    // safe to drop once its window can no longer be the current one.
    const coldLimits = await ctx.db
      .query("rateLimits")
      .withIndex("by_updated", (q) =>
        q.lt("updatedAt", now - RATE_LIMIT_RETENTION_MS),
      )
      .take(PRUNE_BATCH);
    for (const row of coldLimits) await ctx.db.delete(row._id);

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

    // Presence is swept opportunistically by whoever writes it, so this only
    // catches surfaces nobody has visited since — a page two people left at
    // once leaves rows with nobody to clear them.
    const stalePresence = await ctx.db
      .query("presence")
      .order("asc")
      .take(PRUNE_BATCH);
    for (const row of stalePresence) {
      if (presenceIsStale(row, now)) await ctx.db.delete(row._id);
    }

    // The page-only presence table this replaced. Drained rather than migrated
    // (a row is worthless after 45 seconds), and the definition comes out of the
    // schema once this has run everywhere.
    const legacyPresence = await ctx.db
      .query("pagePresence")
      .order("asc")
      .take(PRUNE_BATCH);
    for (const row of legacyPresence) await ctx.db.delete(row._id);

    const oldCodes = await ctx.db
      .query("oauthAuthorizationCodes")
      .order("asc")
      .take(PRUNE_BATCH);
    for (const code of oldCodes) {
      if (code.expiresAt < now) await ctx.db.delete(code._id);
    }

    const oldOAuthTokens = await ctx.db
      .query("oauthAccessTokens")
      .order("asc")
      .take(PRUNE_BATCH);
    for (const token of oldOAuthTokens) {
      if (token.refreshExpiresAt < now) await ctx.db.delete(token._id);
    }
  },
});
