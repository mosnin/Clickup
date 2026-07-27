import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

export const AGENT_PING_RETRY_DELAYS_MS = [5_000, 30_000, 120_000] as const;

export async function enqueueAgentPingDelivery(
  ctx: MutationCtx,
  args: {
    scopeType: "user" | "workspace";
    scopeId: string;
    workspaceId?: Id<"workspaces">;
    sourceKind:
      | "execution_assignment"
      | "task_assignment"
      | "mention"
      | "revision";
    sourceId: string;
    executionAssignmentId?: Id<"executionAssignments">;
    agentId: Id<"agents">;
    taskId?: Id<"tasks">;
    messageId?: Id<"messages">;
    push: boolean;
    type: string;
    payload: unknown;
  },
) {
  const { push, ...delivery } = args;
  const deliveryId = await ctx.db.insert("agentPingDeliveries", {
    ...delivery,
    status: push ? "pending" : "poll_required",
    attempts: 0,
    createdAt: Date.now(),
  });
  if (push) {
    await ctx.scheduler.runAfter(
      0,
      internal.agentPingDeliveryAction.deliver,
      { deliveryId },
    );
  }
  return deliveryId;
}

export const _deliveryContext = internalQuery({
  args: { deliveryId: v.id("agentPingDeliveries") },
  handler: async (ctx, { deliveryId }) => {
    const delivery = await ctx.db.get(deliveryId);
    if (!delivery) return null;
    const agent = await ctx.db.get(delivery.agentId);
    if (!agent) return null;
    return { delivery, agent };
  },
});

export const _recordResult = internalMutation({
  args: {
    deliveryId: v.id("agentPingDeliveries"),
    ok: v.boolean(),
    responseStatus: v.optional(v.number()),
    error: v.optional(v.string()),
    final: v.boolean(),
  },
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery || delivery.status !== "pending") return;
    const now = Date.now();
    await ctx.db.patch(args.deliveryId, {
      attempts: delivery.attempts + 1,
      status: args.ok
        ? "delivered"
        : args.final
          ? "failed"
          : "pending",
      responseStatus: args.responseStatus,
      lastError: args.error,
      lastAttemptAt: now,
      completedAt: args.ok || args.final ? now : undefined,
    });
  },
});
