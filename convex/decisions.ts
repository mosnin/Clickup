import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireListAccess, requireTaskAccess } from "./_authz";
import type { Actor } from "./_agentAuth";
import {
  attachContextPacketCore,
  updateContextPacketCore,
} from "./contextPackets";
import { emitEvent, scopeForList, userActor } from "./events";

const MAX_KEY = 80;
const MAX_TITLE = 160;
const MAX_STATEMENT = 5_000;
const MAX_RATIONALE = 5_000;
const MAX_NOTE = 2_000;
const MAX_IMPACTED_TASKS = 100;

export type DecisionImpactStatus =
  | "pending"
  | "no_change"
  | "rework_required"
  | "resolved";

function required(value: string, label: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ConvexError(`${label} is required`);
  if (trimmed.length > max) {
    throw new ConvexError(`${label} must be ${max.toLocaleString()} characters or fewer`);
  }
  return trimmed;
}

function optional(value: string | undefined, label: string, max: number) {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new ConvexError(`${label} must be ${max.toLocaleString()} characters or fewer`);
  }
  return trimmed || undefined;
}

function normalizeKey(value: string): string {
  const key = required(value, "Decision key", MAX_KEY)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!key) throw new ConvexError("Decision key must contain a letter or number");
  return key;
}

async function emitDecisionEvent(
  ctx: MutationCtx,
  list: Doc<"lists">,
  decision: Doc<"decisions">,
  type: string,
  actor: Actor,
  payload?: unknown,
) {
  const scope = await scopeForList(ctx, list);
  if (!scope) return;
  await emitEvent(ctx, {
    ...scope,
    type,
    actor,
    entityType: "decision",
    entityId: decision._id,
    entityTitle: decision.title,
    listId: list._id,
    payload,
  });
}

async function validateImpactedTasks(
  ctx: QueryCtx | MutationCtx,
  listId: Id<"lists">,
  taskIds: Id<"tasks">[],
): Promise<Doc<"tasks">[]> {
  const unique = [...new Set(taskIds)];
  if (unique.length !== taskIds.length) {
    throw new ConvexError("Each impacted task may appear only once");
  }
  if (unique.length > MAX_IMPACTED_TASKS) {
    throw new ConvexError(`A decision can impact at most ${MAX_IMPACTED_TASKS} tasks`);
  }
  const tasks = await Promise.all(unique.map((taskId) => ctx.db.get(taskId)));
  for (const task of tasks) {
    if (!task) throw new ConvexError("One or more impacted tasks no longer exist");
    if (task.listId !== listId) {
      throw new ConvexError("Decisions can only impact tasks in the same list");
    }
  }
  return tasks as Doc<"tasks">[];
}

async function createImpactRows(
  ctx: MutationCtx,
  decisionId: Id<"decisions">,
  tasks: Doc<"tasks">[],
) {
  const now = Date.now();
  for (const task of tasks) {
    await ctx.db.insert("decisionImpacts", {
      decisionId,
      taskId: task._id,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
  }
}

async function bumpLinkedContext(
  ctx: MutationCtx,
  decision: Doc<"decisions">,
  list: Doc<"lists">,
  tasks: Doc<"tasks">[],
  actor: Actor,
) {
  if (!decision.contextPacketId) return;
  const packet = await ctx.db.get(decision.contextPacketId);
  if (!packet || packet.listId !== list._id) {
    throw new ConvexError("Linked context packet no longer belongs to this list");
  }
  for (const task of tasks) {
    await attachContextPacketCore(ctx, packet, task, actor);
  }
  await updateContextPacketCore(
    ctx,
    packet,
    list,
    { content: packet.content },
    actor,
  );
}

export async function createDecisionCore(
  ctx: MutationCtx,
  list: Doc<"lists">,
  args: {
    key: string;
    title: string;
    statement: string;
    rationale: string;
    contextPacketId?: Id<"contextPackets">;
    taskIds: Id<"tasks">[];
  },
  actor: Actor,
) {
  const key = normalizeKey(args.key);
  const latest = await ctx.db
    .query("decisions")
    .withIndex("by_list_and_key", (q) =>
      q.eq("listId", list._id).eq("key", key),
    )
    .order("desc")
    .first();
  if (latest?.status === "active") {
    throw new ConvexError(
      `Decision "${key}" is already active at v${latest.version}; supersede it instead`,
    );
  }
  if (args.contextPacketId) {
    const packet = await ctx.db.get(args.contextPacketId);
    if (!packet || packet.listId !== list._id) {
      throw new ConvexError("Context packet must belong to the same list");
    }
  }
  const tasks = await validateImpactedTasks(ctx, list._id, args.taskIds);
  const now = Date.now();
  const decisionId = await ctx.db.insert("decisions", {
    listId: list._id,
    key,
    version: (latest?.version ?? 0) + 1,
    title: required(args.title, "Title", MAX_TITLE),
    statement: required(args.statement, "Decision", MAX_STATEMENT),
    rationale: required(args.rationale, "Rationale", MAX_RATIONALE),
    status: "active",
    contextPacketId: args.contextPacketId,
    createdByActorType: actor.type,
    createdByActorId: actor.id,
    createdAt: now,
  });
  const decision = (await ctx.db.get(decisionId))!;
  await createImpactRows(ctx, decisionId, tasks);
  await bumpLinkedContext(ctx, decision, list, tasks, actor);
  await emitDecisionEvent(ctx, list, decision, "decision.created", actor, {
    key,
    version: decision.version,
    impactedTaskIds: tasks.map((task) => task._id),
  });
  return decision;
}

export async function supersedeDecisionCore(
  ctx: MutationCtx,
  current: Doc<"decisions">,
  list: Doc<"lists">,
  args: {
    title?: string;
    statement: string;
    rationale: string;
    taskIds?: Id<"tasks">[];
  },
  actor: Actor,
) {
  if (current.status !== "active" || current.supersededByDecisionId) {
    throw new ConvexError("Only the current active decision can be superseded");
  }
  const priorImpacts = await ctx.db
    .query("decisionImpacts")
    .withIndex("by_decision", (q) => q.eq("decisionId", current._id))
    .take(MAX_IMPACTED_TASKS);
  const mergedTaskIds = [
    ...new Set([
      ...priorImpacts.map((impact) => impact.taskId),
      ...(args.taskIds ?? []),
    ]),
  ];
  const tasks = await validateImpactedTasks(ctx, list._id, mergedTaskIds);
  const decisionId = await ctx.db.insert("decisions", {
    listId: list._id,
    key: current.key,
    version: current.version + 1,
    title:
      args.title === undefined
        ? current.title
        : required(args.title, "Title", MAX_TITLE),
    statement: required(args.statement, "Decision", MAX_STATEMENT),
    rationale: required(args.rationale, "Rationale", MAX_RATIONALE),
    status: "active",
    supersedesDecisionId: current._id,
    contextPacketId: current.contextPacketId,
    createdByActorType: actor.type,
    createdByActorId: actor.id,
    createdAt: Date.now(),
  });
  await ctx.db.patch(current._id, {
    status: "superseded",
    supersededByDecisionId: decisionId,
  });
  const decision = (await ctx.db.get(decisionId))!;
  await createImpactRows(ctx, decisionId, tasks);
  await bumpLinkedContext(ctx, decision, list, tasks, actor);
  await emitDecisionEvent(ctx, list, decision, "decision.superseded", actor, {
    supersedesDecisionId: current._id,
    version: decision.version,
    impactedTaskIds: tasks.map((task) => task._id),
  });
  return decision;
}

export async function assessDecisionImpactCore(
  ctx: MutationCtx,
  impact: Doc<"decisionImpacts">,
  status: Exclude<DecisionImpactStatus, "pending">,
  note: string | undefined,
  actor: Actor,
) {
  if (status === "resolved" && impact.status !== "rework_required") {
    throw new ConvexError("Only rework-required impacts can be resolved");
  }
  if (status === "rework_required" && !optional(note, "Assessment note", MAX_NOTE)) {
    throw new ConvexError("Explain what must be reworked");
  }
  const cleanedNote = optional(note, "Assessment note", MAX_NOTE);
  const now = Date.now();
  await ctx.db.patch(impact._id, {
    status,
    note: cleanedNote,
    assessedByActorType: actor.type,
    assessedByActorId: actor.id,
    assessedAt: now,
    updatedAt: now,
  });
  const decision = await ctx.db.get(impact.decisionId);
  const task = await ctx.db.get(impact.taskId);
  const list = decision ? await ctx.db.get(decision.listId) : null;
  if (decision && task && list) {
    await emitDecisionEvent(
      ctx,
      list,
      decision,
      status === "resolved" ? "decision.impact_resolved" : "decision.impact_assessed",
      actor,
      { taskId: task._id, impactId: impact._id, status, note: cleanedNote },
    );
  }
}

export async function requireDecisionImpactsResolved(
  ctx: QueryCtx | MutationCtx,
  taskId: Id<"tasks">,
) {
  const impacts = await ctx.db
    .query("decisionImpacts")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .order("desc")
    .take(200);
  const blocking = impacts.filter(
    (impact) =>
      impact.status === "pending" || impact.status === "rework_required",
  );
  if (blocking.length === 0) return;
  const decisions = await Promise.all(
    blocking.map((impact) => ctx.db.get(impact.decisionId)),
  );
  const labels = decisions
    .filter((decision): decision is Doc<"decisions"> => decision !== null)
    .map((decision) => `${decision.key} v${decision.version}`)
    .join(", ");
  throw new ConvexError(
    `Decision impact review required before working on this task: ${labels}. Read list_decisions_for_task, then call assess_decision_impact.`,
  );
}

export async function deleteDecisionsForList(
  ctx: MutationCtx,
  listId: Id<"lists">,
) {
  const decisions = await ctx.db
    .query("decisions")
    .withIndex("by_list", (q) => q.eq("listId", listId))
    .collect();
  for (const decision of decisions) {
    const impacts = await ctx.db
      .query("decisionImpacts")
      .withIndex("by_decision", (q) => q.eq("decisionId", decision._id))
      .collect();
    for (const impact of impacts) await ctx.db.delete(impact._id);
    await ctx.db.delete(decision._id);
  }
}

export async function decisionRowsForTask(
  ctx: QueryCtx | MutationCtx,
  taskId: Id<"tasks">,
) {
  const impacts = await ctx.db
    .query("decisionImpacts")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .order("desc")
    .take(200);
  const rows = await Promise.all(
    impacts.map(async (impact) => {
      const decision = await ctx.db.get(impact.decisionId);
      if (!decision) return null;
      return {
        decisionId: decision._id,
        impactId: impact._id,
        listId: decision.listId,
        key: decision.key,
        version: decision.version,
        title: decision.title,
        statement: decision.statement,
        rationale: decision.rationale,
        decisionStatus: decision.status,
        supersedesDecisionId: decision.supersedesDecisionId,
        supersededByDecisionId: decision.supersededByDecisionId,
        contextPacketId: decision.contextPacketId,
        createdByActorType: decision.createdByActorType,
        createdByActorId: decision.createdByActorId,
        createdAt: decision.createdAt,
        impactStatus: impact.status,
        assessmentNote: impact.note,
        assessedByActorType: impact.assessedByActorType,
        assessedByActorId: impact.assessedByActorId,
        assessedAt: impact.assessedAt,
      };
    }),
  );
  return rows.filter((row): row is NonNullable<typeof row> => row !== null);
}

export const listForTask = query({
  args: { taskId: v.id("tasks") },
  returns: v.any(),
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) return [];
    try {
      await requireTaskAccess(ctx, taskId);
    } catch {
      return [];
    }
    return await decisionRowsForTask(ctx, taskId);
  },
});

export const create = mutation({
  args: {
    listId: v.id("lists"),
    key: v.string(),
    title: v.string(),
    statement: v.string(),
    rationale: v.string(),
    contextPacketId: v.optional(v.id("contextPackets")),
    taskIds: v.array(v.id("tasks")),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { list, identity } = await requireListAccess(ctx, args.listId);
    const decision = await createDecisionCore(
      ctx,
      list,
      args,
      await userActor(ctx, identity.subject),
    );
    return { decisionId: decision._id, version: decision.version };
  },
});

export const supersede = mutation({
  args: {
    decisionId: v.id("decisions"),
    title: v.optional(v.string()),
    statement: v.string(),
    rationale: v.string(),
    taskIds: v.optional(v.array(v.id("tasks"))),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const current = await ctx.db.get(args.decisionId);
    if (!current) throw new ConvexError("Decision not found");
    const { list, identity } = await requireListAccess(ctx, current.listId);
    const decision = await supersedeDecisionCore(
      ctx,
      current,
      list,
      args,
      await userActor(ctx, identity.subject),
    );
    return { decisionId: decision._id, version: decision.version };
  },
});

export const assessImpact = mutation({
  args: {
    impactId: v.id("decisionImpacts"),
    status: v.union(
      v.literal("no_change"),
      v.literal("rework_required"),
      v.literal("resolved"),
    ),
    note: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const impact = await ctx.db.get(args.impactId);
    if (!impact) throw new ConvexError("Decision impact not found");
    const { identity } = await requireTaskAccess(ctx, impact.taskId);
    await assessDecisionImpactCore(
      ctx,
      impact,
      args.status,
      args.note,
      await userActor(ctx, identity.subject),
    );
    return null;
  },
});
