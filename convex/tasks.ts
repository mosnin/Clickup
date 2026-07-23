import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireListAccess, requireTaskAccess } from "./_authz";
import { applyAutomations } from "./listAutomations";
import type { Actor } from "./_agentAuth";
import { emitEvent, scopeForList, userActor } from "./events";
import { createMessageCore } from "./messages";
import { notify } from "./notificationCenter";
import { adjustRollup } from "./rollups";

// Task CRUD. Since Phase 12 the write paths are factored into *Core
// functions that take an explicit Actor, so the Clerk-authenticated
// mutations below and the API-key-authenticated agent surface
// (convex/agentApi.ts) share one implementation — including automations,
// notifications, recurrence, and event emission.

// How long an agent's claim on a task blocks other agents. A crashed
// agent's claim simply expires.
export const CLAIM_TTL_MS = 60 * 60 * 1000;

// For a given list of clerk IDs that have just been added as assignees on
// `task`, schedule an assignment email to each one (skipping the actor)
// and a single Slack post if the workspace has an enabled Slack
// integration. Assignee ids that don't resolve to a user row (i.e. agent
// ids) get no email — agents learn about assignments from events/webhooks.
async function scheduleAssignmentNotifications(
  ctx: MutationCtx,
  task: Doc<"tasks">,
  newAssigneeIds: string[],
  actor: Actor,
): Promise<void> {
  if (newAssigneeIds.length === 0) return;

  const recipientNames: string[] = [];
  for (const cid of newAssigneeIds) {
    if (cid === actor.id) continue;
    // Agent assignees get a direct push to their notifyUrl (if set) so
    // assignment reaches their runtime even without a webhook
    // subscription.
    const agentId = ctx.db.normalizeId("agents", cid);
    if (agentId) {
      const agent = await ctx.db.get(agentId);
      if (agent?.notifyUrl) {
        await ctx.scheduler.runAfter(0, internal.notifications.postAgentPing, {
          url: agent.notifyUrl,
          type: "task.assigned",
          payload: {
            taskId: task._id,
            listId: task.listId,
            title: task.title,
            byName: actor.name,
          },
          secret: agent.notifySecret,
        });
      }
      continue;
    }
    const recipient = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", cid))
      .unique();
    if (!recipient?.email) continue;
    recipientNames.push(recipient.name ?? recipient.email);
    // In-app notification (always) + email (when Resend is configured).
    await notify(ctx, {
      userClerkId: cid,
      type: "assignment",
      title: `${actor.name} assigned you a task`,
      body: task.title,
      href: `/dashboard/l/${task.listId}/t/${task._id}`,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.notifications.sendAssignmentEmail,
      {
        toEmail: recipient.email,
        toName: recipient.name,
        fromName: actor.name,
        taskTitle: task.title,
      },
    );
  }

  // Slack: resolve workspace from task → list → space → workspaceId.
  const list = await ctx.db.get(task.listId);
  if (!list) return;
  const scope = await scopeForList(ctx, list);
  if (!scope || scope.scopeType !== "workspace") return;
  const workspaceId = scope.scopeId as Id<"workspaces">;
  const slack = await ctx.db
    .query("integrations")
    .withIndex("by_workspace_and_kind", (q) =>
      q.eq("workspaceId", workspaceId).eq("kind", "slack"),
    )
    .unique();
  if (!slack || !slack.enabled || recipientNames.length === 0) return;
  const text = `${actor.name} assigned *${task.title}* to ${recipientNames.join(", ")}.`;
  await ctx.scheduler.runAfter(0, internal.notifications.postSlack, {
    webhookUrl: slack.config.webhookUrl,
    text,
  });
}

const recurrenceValidator = v.union(
  v.literal("daily"),
  v.literal("weekly"),
  v.literal("monthly"),
);

const checklistValidator = v.array(
  v.object({ id: v.string(), text: v.string(), done: v.boolean() }),
);

function addRecurrence(ts: number, recurrence: "daily" | "weekly" | "monthly"): number {
  const d = new Date(ts);
  switch (recurrence) {
    case "daily":
      d.setUTCDate(d.getUTCDate() + 1);
      break;
    case "weekly":
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case "monthly":
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
  }
  return d.getTime();
}

// When a recurring task is moved into a complete-category status, spawn
// the next instance on the same list with its dates advanced. The new
// task is open, retains the same priority/assignees/recurrence/etc., and
// is appended at the bottom of the list. Routed through createTaskCore so
// the new instance fires task_created automations and emits events like
// any other creation.
async function spawnRecurringInstance(
  ctx: MutationCtx,
  completedTask: Doc<"tasks">,
): Promise<void> {
  if (!completedTask.recurrence) return;

  const baseDue = completedTask.dueDate ?? Date.now();
  const newDue = addRecurrence(baseDue, completedTask.recurrence);
  const newStart = completedTask.startDate
    ? addRecurrence(completedTask.startDate, completedTask.recurrence)
    : undefined;

  await createTaskCore(
    ctx,
    {
      listId: completedTask.listId,
      title: completedTask.title,
      description: completedTask.description,
      priority: completedTask.priority,
      startDate: newStart,
      dueDate: newDue,
      assigneeIds: completedTask.assigneeClerkIds,
      parentTaskId: completedTask.parentTaskId,
      recurrence: completedTask.recurrence,
    },
    { type: "system", id: "recurrence", name: "Recurrence" },
  );
}

const priorityValidator = v.union(
  v.literal("urgent"),
  v.literal("high"),
  v.literal("normal"),
  v.literal("low"),
);

async function emitTaskEvent(
  ctx: MutationCtx,
  task: Doc<"tasks">,
  type: string,
  actor: Actor,
  payload?: unknown,
): Promise<void> {
  const list = await ctx.db.get(task.listId);
  if (!list) return;
  const scope = await scopeForList(ctx, list);
  if (!scope) return;
  await emitEvent(ctx, {
    ...scope,
    type,
    actor,
    entityType: "task",
    entityId: task._id,
    entityTitle: task.title,
    listId: task.listId,
    payload,
  });
}

// Validate that a sprint can hold tasks from this list (same workspace).
async function validateSprintForList(
  ctx: MutationCtx,
  sprintId: Id<"sprints">,
  list: Doc<"lists">,
): Promise<void> {
  const sprint = await ctx.db.get(sprintId);
  if (!sprint) throw new Error("Sprint not found");
  const scope = await scopeForList(ctx, list);
  if (
    !scope ||
    scope.scopeType !== "workspace" ||
    scope.scopeId !== sprint.workspaceId
  ) {
    throw new Error("Sprint belongs to a different workspace");
  }
}

// Validate dependency targets: they must exist and live in the same scope
// as the depending task, so access to one implies access to the other.
async function validateBlockers(
  ctx: MutationCtx,
  blockerIds: Id<"tasks">[],
  list: Doc<"lists">,
  selfId?: Id<"tasks">,
): Promise<void> {
  const scope = await scopeForList(ctx, list);
  for (const id of blockerIds) {
    if (selfId !== undefined && id === selfId) {
      throw new Error("A task can't block itself");
    }
    const blocker = await ctx.db.get(id);
    if (!blocker) throw new Error("Blocking task not found");
    const blockerList = await ctx.db.get(blocker.listId);
    if (!blockerList) throw new Error("Blocking task not found");
    const blockerScope = await scopeForList(ctx, blockerList);
    if (
      !scope ||
      !blockerScope ||
      blockerScope.scopeType !== scope.scopeType ||
      blockerScope.scopeId !== scope.scopeId
    ) {
      throw new Error("Blocking task is outside this scope");
    }
  }
}

async function openBlockers(
  ctx: MutationCtx,
  task: Doc<"tasks">,
): Promise<Doc<"tasks">[]> {
  const out: Doc<"tasks">[] = [];
  for (const id of task.blockedByTaskIds ?? []) {
    const blocker = await ctx.db.get(id);
    if (!blocker) continue;
    const status = await ctx.db.get(blocker.statusId);
    if (status?.category !== "complete" && status?.category !== "closed") {
      out.push(blocker);
    }
  }
  return out;
}

// Which listRollups buckets a status category contributes to. `done`
// covers both complete and closed (matches every other "is this task
// done" check in this file); `inProgress` mirrors the in_progress
// category only.
function categoryBuckets(
  category: string | undefined,
): { done: number; inProgress: number } {
  return {
    done: category === "complete" || category === "closed" ? 1 : 0,
    inProgress: category === "in_progress" ? 1 : 0,
  };
}

// ── Core write paths (shared with the agent API) ───────────────────────

export type CreateTaskArgs = {
  listId: Id<"lists">;
  title: string;
  description?: string;
  statusId?: Id<"listStatuses">;
  priority?: "urgent" | "high" | "normal" | "low";
  startDate?: number;
  dueDate?: number;
  assigneeIds?: string[];
  parentTaskId?: Id<"tasks">;
  recurrence?: "daily" | "weekly" | "monthly";
  sprintId?: Id<"sprints">;
  checklist?: { id: string; text: string; done: boolean }[];
  requiresApproval?: boolean;
  estimatePoints?: number;
  milestone?: boolean;
};

export async function createTaskCore(
  ctx: MutationCtx,
  args: CreateTaskArgs,
  actor: Actor,
): Promise<Id<"tasks">> {
  const list = await ctx.db.get(args.listId);
  if (!list) throw new Error("List not found");

  let statusId = args.statusId;
  if (!statusId) {
    const all = await ctx.db
      .query("listStatuses")
      .withIndex("by_list", (q) => q.eq("listId", args.listId))
      .collect();
    if (all.length === 0) {
      throw new Error("List has no statuses configured");
    }
    const sorted = [...all].sort((a, b) => a.position - b.position);
    statusId = (sorted.find((s) => s.category === "open") ?? sorted[0])._id;
  } else {
    const status = await ctx.db.get(statusId);
    if (!status || status.listId !== args.listId) {
      throw new Error("statusId must belong to the same list");
    }
  }

  if (args.sprintId) await validateSprintForList(ctx, args.sprintId, list);

  const siblings = await ctx.db
    .query("tasks")
    .withIndex("by_list", (q) => q.eq("listId", args.listId))
    .collect();

  // Assignment routing (Phase L): an explicit assignee always wins; when
  // the caller stays silent and the list has a routing rule, fill it in so
  // work never sits unassigned in a routed list.
  let assigneeIds = args.assigneeIds ?? [];
  const routing = list.routing;
  if (assigneeIds.length === 0 && routing && routing.assigneeIds.length > 0) {
    if (routing.mode === "fixed") {
      assigneeIds = [...routing.assigneeIds];
    } else if (routing.mode === "round_robin") {
      const idx =
        ((routing.lastIndex ?? -1) + 1) % routing.assigneeIds.length;
      assigneeIds = [routing.assigneeIds[idx]];
      await ctx.db.patch(list._id, {
        routing: { ...routing, lastIndex: idx },
      });
    } else {
      // least_loaded: fewest open tasks on this list right now (first
      // listed wins ties, so the order in the rule is a priority order).
      const openCount = new Map<string, number>();
      for (const id of routing.assigneeIds) openCount.set(id, 0);
      for (const t of siblings) {
        if (t.completedAt !== undefined) continue;
        for (const a of t.assigneeClerkIds) {
          const cur = openCount.get(a);
          if (cur !== undefined) openCount.set(a, cur + 1);
        }
      }
      let best = routing.assigneeIds[0];
      for (const id of routing.assigneeIds) {
        if ((openCount.get(id) ?? 0) < (openCount.get(best) ?? 0)) best = id;
      }
      assigneeIds = [best];
    }
  }

  const taskId = await ctx.db.insert("tasks", {
    listId: args.listId,
    title: args.title,
    description: args.description,
    statusId,
    priority: args.priority,
    startDate: args.startDate,
    dueDate: args.dueDate,
    assigneeClerkIds: assigneeIds,
    parentTaskId: args.parentTaskId,
    recurrence: args.recurrence,
    sprintId: args.sprintId,
    checklist: args.checklist,
    requiresApproval: args.requiresApproval || undefined,
    estimatePoints: args.estimatePoints,
    milestone: args.milestone || undefined,
    createdByClerkId: actor.id,
    position: siblings.length,
    createdAt: Date.now(),
  });

  const created = await ctx.db.get(taskId);
  if (created) {
    await applyAutomations(ctx, created, "task_created");
    const finalTask = (await ctx.db.get(taskId))!;
    // Rollup accounting happens after applyAutomations (not against the
    // just-inserted `created` doc) so a task_created automation that sets
    // statusId (see listAutomations.ts's set_status action) lands the new
    // task in the right bucket the first time, with no drift to repair.
    const finalStatus = await ctx.db.get(finalTask.statusId);
    const buckets = categoryBuckets(finalStatus?.category);
    await adjustRollup(ctx, finalTask.listId, {
      total: 1,
      done: buckets.done,
      inProgress: buckets.inProgress,
    });
    await scheduleAssignmentNotifications(
      ctx,
      finalTask,
      finalTask.assigneeClerkIds,
      actor,
    );
    await emitTaskEvent(ctx, finalTask, "task.created", actor, {
      assigneeIds: finalTask.assigneeClerkIds,
    });
    if (finalTask.assigneeClerkIds.length > 0) {
      await emitTaskEvent(ctx, finalTask, "task.assigned", actor, {
        assigneeIds: finalTask.assigneeClerkIds,
      });
    }
  }

  await ctx.scheduler.runAfter(0, internal.ai.indexTask, { taskId });

  return taskId;
}

export type UpdateTaskArgs = {
  taskId: Id<"tasks">;
  title?: string;
  description?: string;
  statusId?: Id<"listStatuses">;
  priority?: "urgent" | "high" | "normal" | "low" | null;
  startDate?: number | null;
  dueDate?: number | null;
  assigneeIds?: string[];
  recurrence?: "daily" | "weekly" | "monthly" | null;
  sprintId?: Id<"sprints"> | null;
  blockedByTaskIds?: Id<"tasks">[];
  checklist?: { id: string; text: string; done: boolean }[];
  requiresApproval?: boolean;
  estimatePoints?: number | null;
  milestone?: boolean;
};

export async function updateTaskCore(
  ctx: MutationCtx,
  args: UpdateTaskArgs,
  actor: Actor,
): Promise<void> {
  const task = await ctx.db.get(args.taskId);
  if (!task) throw new Error("Task not found");
  const list = await ctx.db.get(task.listId);
  if (!list) throw new Error("Orphan task");

  // Detect "transition into complete" before applying the patch so we
  // can run automations + spawn the recurring instance afterwards.
  const oldStatus = await ctx.db.get(task.statusId);
  const wasComplete =
    oldStatus?.category === "complete" || oldStatus?.category === "closed";

  let willBeComplete = wasComplete;
  let newStatusName: string | undefined;
  if (args.statusId !== undefined && args.statusId !== task.statusId) {
    const newStatus = await ctx.db.get(args.statusId);
    if (!newStatus || newStatus.listId !== task.listId) {
      throw new Error("statusId must belong to the same list");
    }
    newStatusName = newStatus.name;
    willBeComplete =
      newStatus.category === "complete" || newStatus.category === "closed";
    if (!wasComplete && willBeComplete) {
      const blockers = await openBlockers(ctx, task);
      if (blockers.length > 0) {
        throw new Error(
          `Task is blocked by incomplete task(s): ${blockers
            .map((b) => `"${b.title}"`)
            .join(", ")}`,
        );
      }
      // Human-in-the-loop gate: agents can't complete a gated task until
      // a human approves. A human completing it directly IS the approval.
      if (task.requiresApproval && task.approvedAt === undefined) {
        if (actor.type !== "user") {
          throw new Error(
            "This task requires human approval before it can be completed. Ask a human to approve it (or comment @mentioning them).",
          );
        }
      }
    }
  }

  const patch: Record<string, unknown> = {};
  const changedFields: string[] = [];
  if (args.title !== undefined) {
    patch.title = args.title;
    changedFields.push("title");
  }
  if (args.description !== undefined) {
    patch.description = args.description;
    changedFields.push("description");
  }
  if (args.statusId !== undefined) {
    patch.statusId = args.statusId;
    patch.completedAt = willBeComplete ? Date.now() : undefined;
    if (willBeComplete) {
      // Completing a task releases any claim on it.
      patch.claimedByActorId = undefined;
      patch.claimedAt = undefined;
    }
    // Reopening a gated task revokes the previous approval — otherwise an
    // agent could re-complete it later on the stale sign-off.
    if (wasComplete && !willBeComplete && task.requiresApproval) {
      patch.approvedAt = undefined;
      patch.approvedByClerkId = undefined;
    }
  }
  if (args.priority !== undefined) {
    // null = clear. The client can't send `undefined` (Convex drops the key
    // from the wire), so null is the only working "no priority" signal.
    patch.priority = args.priority ?? undefined;
    changedFields.push("priority");
  }
  if (args.startDate !== undefined) {
    patch.startDate = args.startDate ?? undefined;
    changedFields.push("startDate");
  }
  if (args.dueDate !== undefined) {
    patch.dueDate = args.dueDate ?? undefined;
    changedFields.push("dueDate");
  }
  let newlyAssigned: string[] = [];
  if (args.assigneeIds !== undefined) {
    patch.assigneeClerkIds = args.assigneeIds;
    newlyAssigned = args.assigneeIds.filter(
      (cid) => !task.assigneeClerkIds.includes(cid),
    );
  }
  if (args.recurrence !== undefined) {
    patch.recurrence = args.recurrence ?? undefined;
    changedFields.push("recurrence");
  }
  if (args.sprintId !== undefined) {
    if (args.sprintId !== null) {
      await validateSprintForList(ctx, args.sprintId, list);
    }
    patch.sprintId = args.sprintId ?? undefined;
    changedFields.push("sprint");
  }
  if (args.blockedByTaskIds !== undefined) {
    await validateBlockers(ctx, args.blockedByTaskIds, list, task._id);
    patch.blockedByTaskIds =
      args.blockedByTaskIds.length > 0 ? args.blockedByTaskIds : undefined;
    changedFields.push("dependencies");
  }
  if (args.checklist !== undefined) {
    patch.checklist = args.checklist.length > 0 ? args.checklist : undefined;
    changedFields.push("checklist");
  }
  if (args.estimatePoints !== undefined) {
    patch.estimatePoints = args.estimatePoints ?? undefined;
    changedFields.push("estimate");
  }
  if (args.milestone !== undefined) {
    patch.milestone = args.milestone || undefined;
    changedFields.push("milestone");
  }
  if (args.requiresApproval !== undefined) {
    // Agents may raise the gate but never lower it — otherwise the gate
    // is meaningless.
    if (args.requiresApproval === false && actor.type !== "user") {
      throw new Error("Only a human can remove the approval requirement");
    }
    patch.requiresApproval = args.requiresApproval || undefined;
    if (args.requiresApproval === false) {
      patch.approvedByClerkId = undefined;
      patch.approvedAt = undefined;
    }
    changedFields.push("requiresApproval");
  }
  // A human completing a gated task counts as approving it.
  if (
    !wasComplete &&
    willBeComplete &&
    task.requiresApproval &&
    task.approvedAt === undefined &&
    actor.type === "user"
  ) {
    patch.approvedByClerkId = actor.id;
    patch.approvedAt = Date.now();
  }

  await ctx.db.patch(args.taskId, patch);
  const updated = await ctx.db.get(args.taskId);
  if (!updated) return;

  if (newlyAssigned.length > 0) {
    await scheduleAssignmentNotifications(ctx, updated, newlyAssigned, actor);
    await emitTaskEvent(ctx, updated, "task.assigned", actor, {
      assigneeIds: newlyAssigned,
    });
  }

  if (args.statusId !== undefined && newStatusName !== undefined) {
    await emitTaskEvent(ctx, updated, "task.status_changed", actor, {
      from: oldStatus?.name,
      to: newStatusName,
    });
  }
  if (changedFields.length > 0) {
    await emitTaskEvent(ctx, updated, "task.updated", actor, {
      fields: changedFields,
    });
  }

  if (!wasComplete && willBeComplete) {
    await emitTaskEvent(ctx, updated, "task.completed", actor);
    await applyAutomations(ctx, updated, "status_changed_to_complete");
    await spawnRecurringInstance(ctx, updated);
  }

  // Rollup accounting: only status changes move a task between buckets
  // (total is unaffected by an update). Re-read the task instead of
  // trusting `newStatusName`/`willBeComplete` directly, because the
  // status_changed_to_complete automations above (and any set_status
  // action inside them — see listAutomations.ts) may have moved statusId
  // again after our own patch. Diffing actual old-category vs
  // actual-final-category means the rollup lands correctly however many
  // patches statusId went through in this call, with nothing left to
  // repair.
  if (args.statusId !== undefined) {
    const finalTask = (await ctx.db.get(args.taskId)) ?? updated;
    const finalStatus = await ctx.db.get(finalTask.statusId);
    const oldBuckets = categoryBuckets(oldStatus?.category);
    const newBuckets = categoryBuckets(finalStatus?.category);
    if (
      oldBuckets.done !== newBuckets.done ||
      oldBuckets.inProgress !== newBuckets.inProgress
    ) {
      await adjustRollup(ctx, list._id, {
        done: newBuckets.done - oldBuckets.done,
        inProgress: newBuckets.inProgress - oldBuckets.inProgress,
      });
    }
  }

  if (args.title !== undefined || args.description !== undefined) {
    await ctx.scheduler.runAfter(0, internal.ai.indexTask, {
      taskId: args.taskId,
    });
  }
}

// Soft work-lock so two agents don't pick up the same task. Claims expire
// after CLAIM_TTL_MS; humans can always force-release from the UI.
export async function claimTaskCore(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  actor: Actor,
): Promise<void> {
  const task = await ctx.db.get(taskId);
  if (!task) throw new Error("Task not found");
  const now = Date.now();
  if (
    task.claimedByActorId !== undefined &&
    task.claimedByActorId !== actor.id &&
    task.claimedAt !== undefined &&
    now - task.claimedAt < CLAIM_TTL_MS
  ) {
    throw new Error("Task is already claimed");
  }
  await ctx.db.patch(taskId, { claimedByActorId: actor.id, claimedAt: now });
  const updated = (await ctx.db.get(taskId))!;
  await emitTaskEvent(ctx, updated, "task.claimed", actor);
}

export async function releaseTaskCore(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  actor: Actor,
  force = false,
): Promise<void> {
  const task = await ctx.db.get(taskId);
  if (!task) throw new Error("Task not found");
  if (task.claimedByActorId === undefined) return;
  if (task.claimedByActorId !== actor.id && !force) {
    throw new Error("Task is claimed by someone else");
  }
  await ctx.db.patch(taskId, {
    claimedByActorId: undefined,
    claimedAt: undefined,
  });
  const updated = (await ctx.db.get(taskId))!;
  await emitTaskEvent(ctx, updated, "task.released", actor);
}

// Hand a task to another principal: reassign, release the actor's claim,
// leave a structured context comment, and emit task.handoff. `toId` is a
// clerkId or agent id in the same scope (validated by the callers'
// access checks + the mention machinery ignoring out-of-scope ids).
export async function handoffTaskCore(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  toId: string,
  note: string,
  actor: Actor,
): Promise<void> {
  const task = await ctx.db.get(taskId);
  if (!task) throw new Error("Task not found");
  if (task.claimedByActorId === actor.id) {
    await ctx.db.patch(taskId, {
      claimedByActorId: undefined,
      claimedAt: undefined,
    });
  }
  await updateTaskCore(ctx, { taskId, assigneeIds: [toId] }, actor);
  const updated = (await ctx.db.get(taskId))!;
  await emitTaskEvent(ctx, updated, "task.handoff", actor, {
    toId,
    note: note.slice(0, 500),
  });
  // Record the handoff context where the recipient will look first.
  const list = await ctx.db.get(task.listId);
  const scope = list ? await scopeForList(ctx, list) : null;
  await createMessageCore(
    ctx,
    {
      parentType: "task",
      parentId: taskId,
      body: `Handing this off. ${note}`.trim(),
      mentionIds: [toId],
    },
    actor,
    scope?.scopeType === "workspace"
      ? (scope.scopeId as Id<"workspaces">)
      : null,
  );
}

// Remove a task's contribution from its list's rollup row before the task
// itself is deleted. Reads the task's status as it stood at delete time
// (removeTaskCore doesn't mutate statusId first), so no extra lookups are
// needed beyond the status doc.
async function decrementRollupForTask(
  ctx: MutationCtx,
  task: Doc<"tasks">,
): Promise<void> {
  const status = await ctx.db.get(task.statusId);
  const buckets = categoryBuckets(status?.category);
  await adjustRollup(ctx, task.listId, {
    total: -1,
    done: -buckets.done,
    inProgress: -buckets.inProgress,
  });
}

// Delete everything hanging off a task: field values, comments (and
// their mentions), time entries, and clips (including their stored
// bytes). Shared by removeTaskCore and lists.remove so no path orphans
// rows.
export async function cleanupTaskArtifacts(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
): Promise<void> {
  const values = await ctx.db
    .query("taskFieldValues")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .collect();
  for (const v of values) await ctx.db.delete(v._id);

  const messages = await ctx.db
    .query("messages")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", "task").eq("parentId", taskId),
    )
    .collect();
  for (const m of messages) {
    const mentions = await ctx.db
      .query("mentions")
      .withIndex("by_message", (q) => q.eq("messageId", m._id))
      .collect();
    for (const men of mentions) await ctx.db.delete(men._id);
    await ctx.db.delete(m._id);
  }

  const entries = await ctx.db
    .query("timeEntries")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .collect();
  for (const e of entries) await ctx.db.delete(e._id);

  const clips = await ctx.db
    .query("clips")
    .withIndex("by_parent", (q) =>
      q.eq("parentType", "task").eq("parentId", taskId),
    )
    .collect();
  for (const c of clips) {
    await ctx.storage.delete(c.storageId);
    await ctx.db.delete(c._id);
  }

  const attachments = await ctx.db
    .query("attachments")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .collect();
  for (const a of attachments) {
    await ctx.storage.delete(a.storageId);
    await ctx.db.delete(a._id);
  }
}

export async function removeTaskCore(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  actor: Actor,
): Promise<void> {
  const task = await ctx.db.get(taskId);
  if (!task) return;

  // Full-depth cascade: the UI allows nested subtasks, so a one-level
  // sweep would orphan grandchildren (invisible rows + rollup drift).
  const queue = [taskId];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    const subtasks = await ctx.db
      .query("tasks")
      .withIndex("by_parent_task", (q) => q.eq("parentTaskId", parentId))
      .collect();
    for (const s of subtasks) {
      queue.push(s._id);
      await cleanupTaskArtifacts(ctx, s._id);
      await decrementRollupForTask(ctx, s);
      await ctx.db.delete(s._id);
    }
  }

  await cleanupTaskArtifacts(ctx, taskId);
  await decrementRollupForTask(ctx, task);

  await emitTaskEvent(ctx, task, "task.deleted", actor);
  await ctx.db.delete(taskId);
  await ctx.scheduler.runAfter(0, internal.ai.dropEmbeddings, {
    parentType: "task",
    parentId: taskId,
  });
}

// ── Clerk-authenticated API (used by the web app) ──────────────────────

export const listForList = query({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) => {
    // Full hierarchy check, not just "is logged in" — task titles across
    // foreign workspaces must not be enumerable by ID.
    try {
      await requireListAccess(ctx, listId);
    } catch {
      return [];
    }
    return await ctx.db
      .query("tasks")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect();
  },
});

export const get = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    try {
      const { task } = await requireTaskAccess(ctx, taskId);
      return task;
    } catch {
      return null;
    }
  },
});

// Titles of the given tasks (for rendering dependency chips). Tasks the
// caller can't access are silently omitted.
export const titles = query({
  args: { taskIds: v.array(v.id("tasks")) },
  handler: async (ctx, { taskIds }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return {};
    const out: Record<string, string> = {};
    for (const id of taskIds) {
      try {
        const { task } = await requireTaskAccess(ctx, id);
        out[id] = task.title;
      } catch {
        // skip inaccessible tasks
      }
    }
    return out;
  },
});

// Approval queue for the inbox: every gated, unapproved, still-open task
// the current user can see. The global set of gated tasks is small, so we
// range the by_approval index and access-check each hit.
export const pendingApprovals = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const gated = await ctx.db
      .query("tasks")
      .withIndex("by_approval", (q) => q.eq("requiresApproval", true))
      .collect();
    const out = [];
    for (const task of gated) {
      if (task.approvedAt !== undefined) continue;
      const status = await ctx.db.get(task.statusId);
      if (status?.category === "complete" || status?.category === "closed") {
        continue;
      }
      try {
        await requireTaskAccess(ctx, task._id);
      } catch {
        continue;
      }
      const checklist = task.checklist ?? [];
      out.push({
        taskId: task._id,
        listId: task.listId,
        title: task.title,
        assigneeIds: task.assigneeClerkIds,
        checklistDone: checklist.filter((i) => i.done).length,
        checklistTotal: checklist.length,
        createdAt: task.createdAt,
      });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  },
});

// Resolve a task's listId (for deep links from inbox/Brain/Teams Hub,
// where only the task id is known). Null when inaccessible.
export const resolveListId = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    try {
      const { task } = await requireTaskAccess(ctx, taskId);
      return task.listId;
    } catch {
      return null;
    }
  },
});

// Plain-text title search across every list the current user can see —
// powers the ⌘K palette. Same full-tree walk as reports.workspaceSummary:
// fine at target scale, needs a search index beyond a few thousand tasks.
export const quickSearch = query({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    const identity = await ctx.auth.getUserIdentity();
    const needle = text.trim().toLowerCase();
    if (!identity || needle.length < 2) return [];

    const spaces: Doc<"spaces">[] = [];
    const personal = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentType", "user").eq("parentId", identity.subject),
      )
      .unique();
    if (personal) spaces.push(personal);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userClerkId", identity.subject))
      .collect();
    for (const m of memberships) {
      const wsSpaces = await ctx.db
        .query("spaces")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "workspace").eq("parentId", m.workspaceId),
        )
        .collect();
      spaces.push(...wsSpaces);
    }

    const LIMIT = 12;
    const results: {
      taskId: Id<"tasks">;
      listId: Id<"lists">;
      title: string;
      listName: string;
    }[] = [];
    for (const space of spaces) {
      const lists = await ctx.db
        .query("lists")
        .withIndex("by_parent", (q) =>
          q.eq("parentType", "space").eq("parentId", space._id),
        )
        .collect();
      const folders = await ctx.db
        .query("folders")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();
      for (const folder of folders) {
        lists.push(
          ...(await ctx.db
            .query("lists")
            .withIndex("by_parent", (q) =>
              q.eq("parentType", "folder").eq("parentId", folder._id),
            )
            .collect()),
        );
      }
      for (const list of lists) {
        const tasks = await ctx.db
          .query("tasks")
          .withIndex("by_list", (q) => q.eq("listId", list._id))
          .collect();
        for (const t of tasks) {
          if (t.title.toLowerCase().includes(needle)) {
            results.push({
              taskId: t._id,
              listId: list._id,
              title: t.title,
              listName: list.name,
            });
            if (results.length >= LIMIT) return results;
          }
        }
      }
    }
    return results;
  },
});

export const create = mutation({
  args: {
    listId: v.id("lists"),
    title: v.string(),
    description: v.optional(v.string()),
    statusId: v.optional(v.id("listStatuses")),
    priority: v.optional(priorityValidator),
    startDate: v.optional(v.number()),
    dueDate: v.optional(v.number()),
    assigneeClerkIds: v.optional(v.array(v.string())),
    parentTaskId: v.optional(v.id("tasks")),
    recurrence: v.optional(recurrenceValidator),
    sprintId: v.optional(v.id("sprints")),
    requiresApproval: v.optional(v.boolean()),
    estimatePoints: v.optional(v.number()),
    milestone: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { identity } = await requireListAccess(ctx, args.listId);
    const actor = await userActor(ctx, identity.subject);
    return await createTaskCore(
      ctx,
      {
        listId: args.listId,
        title: args.title,
        description: args.description,
        statusId: args.statusId,
        priority: args.priority,
        startDate: args.startDate,
        dueDate: args.dueDate,
        assigneeIds: args.assigneeClerkIds,
        parentTaskId: args.parentTaskId,
        recurrence: args.recurrence,
        sprintId: args.sprintId,
        requiresApproval: args.requiresApproval,
        estimatePoints: args.estimatePoints,
        milestone: args.milestone,
      },
      actor,
    );
  },
});

export const update = mutation({
  args: {
    taskId: v.id("tasks"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    statusId: v.optional(v.id("listStatuses")),
    priority: v.optional(v.union(priorityValidator, v.null())),
    startDate: v.optional(v.union(v.number(), v.null())),
    dueDate: v.optional(v.union(v.number(), v.null())),
    assigneeClerkIds: v.optional(v.array(v.string())),
    recurrence: v.optional(v.union(recurrenceValidator, v.null())),
    sprintId: v.optional(v.union(v.id("sprints"), v.null())),
    blockedByTaskIds: v.optional(v.array(v.id("tasks"))),
    checklist: v.optional(checklistValidator),
    requiresApproval: v.optional(v.boolean()),
    estimatePoints: v.optional(v.union(v.number(), v.null())),
    milestone: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { identity } = await requireTaskAccess(ctx, args.taskId);
    const actor = await userActor(ctx, identity.subject);
    await updateTaskCore(
      ctx,
      {
        taskId: args.taskId,
        title: args.title,
        description: args.description,
        statusId: args.statusId,
        priority: args.priority,
        startDate: args.startDate,
        dueDate: args.dueDate,
        assigneeIds: args.assigneeClerkIds,
        recurrence: args.recurrence,
        sprintId: args.sprintId,
        blockedByTaskIds: args.blockedByTaskIds,
        checklist: args.checklist,
        requiresApproval: args.requiresApproval,
        estimatePoints: args.estimatePoints,
        milestone: args.milestone,
      },
      actor,
    );
  },
});

// Human approval of a gated task. Emits task.approved so the agent
// waiting on it gets a webhook/event and can finish the job.
export const approve = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const { task, identity } = await requireTaskAccess(ctx, taskId);
    if (!task.requiresApproval) throw new Error("Task has no approval gate");
    const actor = await userActor(ctx, identity.subject);
    await ctx.db.patch(taskId, {
      approvedByClerkId: identity.subject,
      approvedAt: Date.now(),
    });
    const updated = (await ctx.db.get(taskId))!;
    await emitTaskEvent(ctx, updated, "task.approved", actor);
  },
});

// Humans can claim work too ("I'm on it") — same soft lock agents use.
export const claim = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const { identity } = await requireTaskAccess(ctx, taskId);
    const actor = await userActor(ctx, identity.subject);
    await claimTaskCore(ctx, taskId, actor);
  },
});

// Force-release a claim from the UI (e.g. an agent died mid-task).
export const releaseClaim = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const { identity } = await requireTaskAccess(ctx, taskId);
    const actor = await userActor(ctx, identity.subject);
    await releaseTaskCore(ctx, taskId, actor, true);
  },
});

// Toggle convenience: flip task between its first "open" and first
// "complete" status. Used by the row-level checkbox in the list view so
// the UI doesn't need to know status IDs.
export const toggleComplete = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const { task, list, identity } = await requireTaskAccess(ctx, taskId);
    const statuses = await ctx.db
      .query("listStatuses")
      .withIndex("by_list", (q) => q.eq("listId", list._id))
      .collect();
    const sorted = [...statuses].sort((a, b) => a.position - b.position);
    const current = await ctx.db.get(task.statusId);
    const isDone =
      current?.category === "complete" || current?.category === "closed";
    // Never fall back to position 0 (usually "To Do") — if the list has no
    // status in a suitable category, refuse with a clear error instead of
    // silently misfiling the task.
    const next = isDone
      ? (sorted.find((s) => s.category === "open") ??
        sorted.find((s) => s.category === "in_progress"))
      : (sorted.find((s) => s.category === "complete") ??
        sorted.find((s) => s.category === "closed"));
    if (!next) {
      throw new Error(
        isDone
          ? "This list has no open-category status to reopen into — add one in List settings."
          : "This list has no complete-category status — add one in List settings.",
      );
    }
    const actor = await userActor(ctx, identity.subject);
    await updateTaskCore(ctx, { taskId, statusId: next._id }, actor);
  },
});

// Bulk reorder used by Board drag-drop. `orderedIds` is the new order of
// ONE status column ("bucket"); `statusId` is that column's status.
// `position` is a LIST-WIDE ordinal (List/Table/Workload sort every
// top-level task by it), so we must never renumber just the bucket 0..N —
// that collides with every other column's positions. Instead we rebuild
// the GLOBAL order: walk the current list-wide sequence and replace the
// slots occupied by the bucket's members, in place, with the new bucket
// order (a task dragged in from another column enters at the slot the
// bucket order dictates and leaves its old slot), then renumber the whole
// sequence 0..N, patching only tasks whose position actually changed.
// Status changes are validated FIRST (same refusal rules as
// updateTaskCore: open blockers, agent-vs-approval-gate) so a refused
// drop aborts before any write; accepted changes route through
// updateTaskCore so drag-to-Complete emits events, fires automations,
// spawns recurrence, and clears claims exactly like changing status
// anywhere else. O(list) writes worst case — fine at target scale.
export const reorder = mutation({
  args: {
    listId: v.id("lists"),
    orderedIds: v.array(v.id("tasks")),
    statusId: v.optional(v.id("listStatuses")),
  },
  handler: async (ctx, { listId, orderedIds, statusId }) => {
    const { identity } = await requireListAccess(ctx, listId);
    let newStatus: Doc<"listStatuses"> | null = null;
    if (statusId) {
      newStatus = await ctx.db.get(statusId);
      if (!newStatus || newStatus.listId !== listId) {
        throw new Error("statusId must belong to the same list");
      }
    }
    const actor = await userActor(ctx, identity.subject);

    // Resolve the bucket's tasks, dropping ids that no longer exist or
    // don't belong to this list.
    const bucketTasks: Doc<"tasks">[] = [];
    for (const id of orderedIds) {
      const task = await ctx.db.get(id);
      if (!task || task.listId !== listId) continue;
      bucketTasks.push(task);
    }

    // (a) Validate every status change up front — same refusal checks as
    // updateTaskCore — and abort entirely (patching nothing) on refusal.
    if (statusId && newStatus) {
      const willBeComplete =
        newStatus.category === "complete" || newStatus.category === "closed";
      const refused: string[] = [];
      for (const task of bucketTasks) {
        if (task.statusId === statusId) continue;
        const oldStatus = await ctx.db.get(task.statusId);
        const wasComplete =
          oldStatus?.category === "complete" ||
          oldStatus?.category === "closed";
        if (wasComplete || !willBeComplete) continue;
        const blockers = await openBlockers(ctx, task);
        if (blockers.length > 0) {
          refused.push(
            `"${task.title}": Task is blocked by incomplete task(s): ${blockers
              .map((b) => `"${b.title}"`)
              .join(", ")}`,
          );
          continue;
        }
        // Human-in-the-loop gate: agents can't complete a gated task; a
        // human completing it counts as approval (handled by the core).
        if (
          task.requiresApproval &&
          task.approvedAt === undefined &&
          actor.type !== "user"
        ) {
          refused.push(
            `"${task.title}": This task requires human approval before it can be completed.`,
          );
        }
      }
      if (refused.length > 0) {
        throw new Error(refused.join(" · "));
      }
    }

    // (b) Load the list's top-level tasks in their current global order.
    const all = await ctx.db
      .query("tasks")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect();
    const oldGlobal = all
      .filter((t) => !t.parentTaskId)
      .sort(
        (a, b) => a.position - b.position || a._creationTime - b._creationTime,
      );

    // (c)+(d) Rebuild the global sequence: the slots occupied by the
    // bucket's members (including the dragged task's old slot, wherever
    // its previous column put it) are refilled, in place, with the new
    // bucket order. Everything else keeps its slot.
    const present = new Set(oldGlobal.map((t) => t._id));
    const newBucketIds = bucketTasks
      .map((t) => t._id)
      .filter((id) => present.has(id));
    const bucketSet = new Set(newBucketIds);
    let cursor = 0;
    const newGlobal = oldGlobal.map((t) =>
      bucketSet.has(t._id) ? newBucketIds[cursor++] : t._id,
    );

    // Apply status changes through the shared core (validated above, so
    // these should not refuse; if one still throws, the whole mutation —
    // including every position patch — rolls back).
    if (statusId) {
      for (const task of bucketTasks) {
        if (task.statusId !== statusId) {
          await updateTaskCore(ctx, { taskId: task._id, statusId }, actor);
        }
      }
    }

    // (e) Renumber the entire sequence 0..N, patching only real changes.
    const oldPositionById = new Map(oldGlobal.map((t) => [t._id, t.position]));
    for (let i = 0; i < newGlobal.length; i++) {
      if (oldPositionById.get(newGlobal[i]) !== i) {
        await ctx.db.patch(newGlobal[i], { position: i });
      }
    }
  },
});

export const remove = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) return;
    const { identity } = await requireTaskAccess(ctx, taskId);
    const actor = await userActor(ctx, identity.subject);
    await removeTaskCore(ctx, taskId, actor);
  },
});
