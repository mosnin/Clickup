import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireListAccess } from "./_authz";
import { sha256Hex, type Actor } from "./_agentAuth";
import { emitEvent, scopeForList, userActor } from "./events";

const MAX_TITLE = 120;
const MAX_SUMMARY = 500;
const MAX_CONTENT = 50_000;

function clean(
  value: string,
  label: string,
  max: number,
  required = true,
): string | undefined {
  const trimmed = value.trim();
  if (required && !trimmed) throw new ConvexError(`${label} is required`);
  if (trimmed.length > max) {
    throw new ConvexError(`${label} must be ${max.toLocaleString()} characters or fewer`);
  }
  return trimmed || undefined;
}

export type ContextPacketView = {
  packetId: Id<"contextPackets">;
  listId: Id<"lists">;
  title: string;
  summary?: string;
  content: string;
  version: number;
  createdByActorId: string;
  createdAt: number;
  updatedByActorId: string;
  updatedAt: number;
};

export type AgentContextReadiness = {
  ready: boolean;
  packets: Array<{
    packetId: Id<"contextPackets">;
    title: string;
    currentVersion: number;
    acknowledgedVersion?: number;
    acknowledgedAt?: number;
    state: "current" | "stale" | "unread";
  }>;
};

function view(packet: Doc<"contextPackets">): ContextPacketView {
  return {
    packetId: packet._id,
    listId: packet.listId,
    title: packet.title,
    summary: packet.summary,
    content: packet.content,
    version: packet.version,
    createdByActorId: packet.createdByActorId,
    createdAt: packet.createdAt,
    updatedByActorId: packet.updatedByActorId,
    updatedAt: packet.updatedAt,
  };
}

async function emitPacketEvent(
  ctx: MutationCtx,
  list: Doc<"lists">,
  packet: Doc<"contextPackets">,
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
    entityType: "context_packet",
    entityId: packet._id,
    entityTitle: packet.title,
    listId: list._id,
    payload,
  });
}

export async function listPacketsForTask(
  ctx: QueryCtx | MutationCtx,
  taskId: Id<"tasks">,
): Promise<ContextPacketView[]> {
  const links = await ctx.db
    .query("taskContextPackets")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .collect();
  const packets = await Promise.all(links.map((link) => ctx.db.get(link.packetId)));
  return packets
    .filter((packet): packet is Doc<"contextPackets"> => packet !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(view);
}

/**
 * What this task's context costs, and a fingerprint of its versions.
 *
 * Lifted out of the wave dispatcher, which computed it per assignment. It was
 * always a property of the TASK — keeping it on the push path meant an agent
 * that pulled its own work had no way to tell whether the context it read had
 * moved since, which is the one question the fingerprint exists to answer.
 * Both callers now compute it from the same packets.
 */
export function contextLoadFromPackets(
  packets: Awaited<ReturnType<typeof listPacketsForTask>>,
) {
  const contextCharacterCount = packets.reduce(
    (total, packet) =>
      total +
      packet.title.length +
      (packet.summary?.length ?? 0) +
      packet.content.length,
    0,
  );
  return {
    contextPacketCount: packets.length,
    contextCharacterCount,
    estimatedContextTokens: Math.ceil(contextCharacterCount / 4),
    contextVersionFingerprint: sha256Hex(
      packets
        .map((packet) => `${packet.packetId}:${packet.version}`)
        .sort()
        .join("|"),
    ),
    contextPackets: packets.map((packet) => ({
      packetId: packet.packetId,
      title: packet.title,
      version: packet.version,
      updatedAt: packet.updatedAt,
      characterCount:
        packet.title.length +
        (packet.summary?.length ?? 0) +
        packet.content.length,
    })),
  };
}

export async function contextReadinessForAgent(
  ctx: QueryCtx | MutationCtx,
  taskId: Id<"tasks">,
  agentId: Id<"agents">,
): Promise<AgentContextReadiness> {
  const packets = await listPacketsForTask(ctx, taskId);
  const receipts = await ctx.db
    .query("agentContextReceipts")
    .withIndex("by_agent_task", (q) =>
      q.eq("agentId", agentId).eq("taskId", taskId),
    )
    .collect();
  const byPacket = new Map(receipts.map((receipt) => [receipt.packetId, receipt]));
  const rows = packets.map((packet) => {
    const receipt = byPacket.get(packet.packetId);
    const state =
      receipt === undefined
        ? ("unread" as const)
        : receipt.version === packet.version
          ? ("current" as const)
          : ("stale" as const);
    return {
      packetId: packet.packetId,
      title: packet.title,
      currentVersion: packet.version,
      acknowledgedVersion: receipt?.version,
      acknowledgedAt: receipt?.acknowledgedAt,
      state,
    };
  });
  return {
    ready: rows.every((row) => row.state === "current"),
    packets: rows,
  };
}

export async function requireCurrentContext(
  ctx: QueryCtx | MutationCtx,
  taskId: Id<"tasks">,
  agentId: Id<"agents">,
): Promise<void> {
  const readiness = await contextReadinessForAgent(ctx, taskId, agentId);
  if (readiness.ready) return;
  const required = readiness.packets
    .filter((packet) => packet.state !== "current")
    .map(
      (packet) =>
        `${packet.title} v${packet.currentVersion} (${packet.packetId})`,
    )
    .join(", ");
  throw new ConvexError(
    `Context acknowledgement required before working on this task. Read get_task, then call acknowledge_task_context with the current versions: ${required}`,
  );
}

export async function acknowledgeTaskContextCore(
  ctx: MutationCtx,
  taskId: Id<"tasks">,
  agentId: Id<"agents">,
  packetVersions: Array<{
    packetId: Id<"contextPackets">;
    version: number;
  }>,
): Promise<AgentContextReadiness> {
  const packets = await listPacketsForTask(ctx, taskId);
  const supplied = new Map(
    packetVersions.map((packet) => [packet.packetId, packet.version]),
  );
  if (
    packetVersions.length !== supplied.size ||
    supplied.size !== packets.length
  ) {
    throw new ConvexError(
      "Acknowledge every context packet attached to the task exactly once",
    );
  }
  for (const packet of packets) {
    const version = supplied.get(packet.packetId);
    if (version !== packet.version) {
      throw new ConvexError(
        `Context changed while you were reading it: ${packet.title} is now v${packet.version}. Call get_task again.`,
      );
    }
  }

  const now = Date.now();
  for (const packet of packets) {
    const existing = await ctx.db
      .query("agentContextReceipts")
      .withIndex("by_agent_task_packet", (q) =>
        q
          .eq("agentId", agentId)
          .eq("taskId", taskId)
          .eq("packetId", packet.packetId),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        version: packet.version,
        acknowledgedAt: now,
      });
    } else {
      await ctx.db.insert("agentContextReceipts", {
        agentId,
        taskId,
        packetId: packet.packetId,
        version: packet.version,
        acknowledgedAt: now,
      });
    }
  }
  return await contextReadinessForAgent(ctx, taskId, agentId);
}

export async function createContextPacketCore(
  ctx: MutationCtx,
  list: Doc<"lists">,
  args: { title: string; summary?: string; content: string },
  actor: Actor,
): Promise<Id<"contextPackets">> {
  const now = Date.now();
  const packetId = await ctx.db.insert("contextPackets", {
    listId: list._id,
    title: clean(args.title, "Title", MAX_TITLE)!,
    summary:
      args.summary === undefined
        ? undefined
        : clean(args.summary, "Summary", MAX_SUMMARY, false),
    content: clean(args.content, "Context", MAX_CONTENT)!,
    version: 1,
    createdByActorId: actor.id,
    createdAt: now,
    updatedByActorId: actor.id,
    updatedAt: now,
  });
  const packet = (await ctx.db.get(packetId))!;
  await emitPacketEvent(ctx, list, packet, "context.created", actor, {
    version: 1,
  });
  return packetId;
}

export async function updateContextPacketCore(
  ctx: MutationCtx,
  packet: Doc<"contextPackets">,
  list: Doc<"lists">,
  args: { title?: string; summary?: string | null; content?: string },
  actor: Actor,
): Promise<number> {
  const patch: Partial<Doc<"contextPackets">> = {};
  if (args.title !== undefined) patch.title = clean(args.title, "Title", MAX_TITLE)!;
  if (args.summary !== undefined) {
    patch.summary =
      args.summary === null
        ? undefined
        : clean(args.summary, "Summary", MAX_SUMMARY, false);
  }
  if (args.content !== undefined) {
    patch.content = clean(args.content, "Context", MAX_CONTENT)!;
  }
  if (Object.keys(patch).length === 0) return packet.version;
  const version = packet.version + 1;
  await ctx.db.patch(packet._id, {
    ...patch,
    version,
    updatedByActorId: actor.id,
    updatedAt: Date.now(),
  });
  const updated = (await ctx.db.get(packet._id))!;
  await emitPacketEvent(ctx, list, updated, "context.updated", actor, {
    version,
  });
  return version;
}

export async function attachContextPacketCore(
  ctx: MutationCtx,
  packet: Doc<"contextPackets">,
  task: Doc<"tasks">,
  actor: Actor,
): Promise<boolean> {
  if (packet.listId !== task.listId) {
    throw new ConvexError("Context packets can only attach to tasks in the same project");
  }
  const existing = await ctx.db
    .query("taskContextPackets")
    .withIndex("by_task_and_packet", (q) =>
      q.eq("taskId", task._id).eq("packetId", packet._id),
    )
    .unique();
  if (existing) return false;
  await ctx.db.insert("taskContextPackets", {
    taskId: task._id,
    packetId: packet._id,
    attachedByActorId: actor.id,
    attachedAt: Date.now(),
  });
  return true;
}

export async function detachContextPacketCore(
  ctx: MutationCtx,
  packetId: Id<"contextPackets">,
  taskId: Id<"tasks">,
): Promise<boolean> {
  const existing = await ctx.db
    .query("taskContextPackets")
    .withIndex("by_task_and_packet", (q) =>
      q.eq("taskId", taskId).eq("packetId", packetId),
    )
    .unique();
  if (!existing) return false;
  await ctx.db.delete(existing._id);
  const receipts = await ctx.db
    .query("agentContextReceipts")
    .withIndex("by_packet", (q) => q.eq("packetId", packetId))
    .collect();
  for (const receipt of receipts) {
    if (receipt.taskId === taskId) await ctx.db.delete(receipt._id);
  }
  return true;
}

export async function deleteContextPacketCore(
  ctx: MutationCtx,
  packet: Doc<"contextPackets">,
  list: Doc<"lists">,
  actor: Actor,
): Promise<number> {
  const links = await ctx.db
    .query("taskContextPackets")
    .withIndex("by_packet", (q) => q.eq("packetId", packet._id))
    .collect();
  for (const link of links) await ctx.db.delete(link._id);
  const receipts = await ctx.db
    .query("agentContextReceipts")
    .withIndex("by_packet", (q) => q.eq("packetId", packet._id))
    .collect();
  for (const receipt of receipts) await ctx.db.delete(receipt._id);
  await ctx.db.delete(packet._id);
  await emitPacketEvent(ctx, list, packet, "context.deleted", actor, {
    detachedTaskCount: links.length,
    version: packet.version,
  });
  return links.length;
}

export async function deleteContextPacketsForList(
  ctx: MutationCtx,
  listId: Id<"lists">,
) {
  const packets = await ctx.db
    .query("contextPackets")
    .withIndex("by_list", (q) => q.eq("listId", listId))
    .collect();
  for (const packet of packets) {
    const links = await ctx.db
      .query("taskContextPackets")
      .withIndex("by_packet", (q) => q.eq("packetId", packet._id))
      .collect();
    for (const link of links) await ctx.db.delete(link._id);
    const receipts = await ctx.db
      .query("agentContextReceipts")
      .withIndex("by_packet", (q) => q.eq("packetId", packet._id))
      .collect();
    for (const receipt of receipts) await ctx.db.delete(receipt._id);
    await ctx.db.delete(packet._id);
  }
}

export const listForList = query({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) => {
    try {
      await requireListAccess(ctx, listId);
    } catch {
      return [];
    }
    const packets = await ctx.db
      .query("contextPackets")
      .withIndex("by_list", (q) => q.eq("listId", listId))
      .collect();
    return packets.sort((a, b) => b.updatedAt - a.updatedAt).map(view);
  },
});

export const listForTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) return [];
    try {
      await requireListAccess(ctx, task.listId);
    } catch {
      return [];
    }
    return await listPacketsForTask(ctx, taskId);
  },
});

export const readinessForTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) return [];
    try {
      await requireListAccess(ctx, task.listId);
    } catch {
      return [];
    }

    const packets = await listPacketsForTask(ctx, taskId);
    const receipts = await ctx.db
      .query("agentContextReceipts")
      .withIndex("by_task", (q) => q.eq("taskId", taskId))
      .collect();
    const relevantIds = new Set(task.assigneeClerkIds);
    if (task.claimedByActorId) relevantIds.add(task.claimedByActorId);
    const agents: Doc<"agents">[] = [];
    for (const id of relevantIds) {
      const agentId = ctx.db.normalizeId("agents", id);
      if (!agentId) continue;
      const agent = await ctx.db.get(agentId);
      if (agent) agents.push(agent);
    }

    return packets.map((packet) => ({
      packetId: packet.packetId,
      currentVersion: packet.version,
      agents: agents.map((agent) => {
        const receipt = receipts.find(
          (row) =>
            row.agentId === agent._id && row.packetId === packet.packetId,
        );
        return {
          agentId: agent._id,
          agentName: agent.name,
          acknowledgedVersion: receipt?.version,
          acknowledgedAt: receipt?.acknowledgedAt,
          state:
            receipt === undefined
              ? ("unread" as const)
              : receipt.version === packet.version
                ? ("current" as const)
                : ("stale" as const),
        };
      }),
    }));
  },
});

export const create = mutation({
  args: {
    listId: v.id("lists"),
    title: v.string(),
    summary: v.optional(v.string()),
    content: v.string(),
    taskIds: v.optional(v.array(v.id("tasks"))),
  },
  handler: async (ctx, args) => {
    const { list, identity } = await requireListAccess(ctx, args.listId);
    const actor = await userActor(ctx, identity.subject);
    const packetId = await createContextPacketCore(ctx, list, args, actor);
    const packet = (await ctx.db.get(packetId))!;
    for (const taskId of args.taskIds ?? []) {
      const task = await ctx.db.get(taskId);
      if (!task) throw new ConvexError("Task not found");
      await attachContextPacketCore(ctx, packet, task, actor);
    }
    return { packetId };
  },
});

export const update = mutation({
  args: {
    packetId: v.id("contextPackets"),
    title: v.optional(v.string()),
    summary: v.optional(v.union(v.string(), v.null())),
    content: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const packet = await ctx.db.get(args.packetId);
    if (!packet) throw new ConvexError("Context packet not found");
    const { list, identity } = await requireListAccess(ctx, packet.listId);
    const version = await updateContextPacketCore(
      ctx,
      packet,
      list,
      args,
      await userActor(ctx, identity.subject),
    );
    return { version };
  },
});

export const remove = mutation({
  args: { packetId: v.id("contextPackets") },
  handler: async (ctx, { packetId }) => {
    const packet = await ctx.db.get(packetId);
    if (!packet) throw new ConvexError("Context packet not found");
    const { list, identity } = await requireListAccess(ctx, packet.listId);
    const detachedTaskCount = await deleteContextPacketCore(
      ctx,
      packet,
      list,
      await userActor(ctx, identity.subject),
    );
    return { deleted: true, detachedTaskCount };
  },
});

export const attach = mutation({
  args: { packetId: v.id("contextPackets"), taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const packet = await ctx.db.get(args.packetId);
    const task = await ctx.db.get(args.taskId);
    if (!packet || !task) throw new ConvexError("Context packet or task not found");
    const { identity } = await requireListAccess(ctx, task.listId);
    return {
      attached: await attachContextPacketCore(
        ctx,
        packet,
        task,
        await userActor(ctx, identity.subject),
      ),
    };
  },
});

export const detach = mutation({
  args: { packetId: v.id("contextPackets"), taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new ConvexError("Task not found");
    await requireListAccess(ctx, task.listId);
    return {
      detached: await detachContextPacketCore(ctx, args.packetId, args.taskId),
    };
  },
});
