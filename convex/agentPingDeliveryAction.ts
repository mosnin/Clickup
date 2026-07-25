"use node";

import { createHmac } from "crypto";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { AGENT_PING_RETRY_DELAYS_MS } from "./agentPingDeliveries";

const TIMEOUT_MS = 10_000;

export const deliver = internalAction({
  args: { deliveryId: v.id("agentPingDeliveries") },
  handler: async (ctx, { deliveryId }) => {
    const context = await ctx.runQuery(
      internal.agentPingDeliveries._deliveryContext,
      { deliveryId },
    );
    if (!context || context.delivery.status !== "pending") return;
    const { delivery, agent } = context;
    const attemptIndex = delivery.attempts;
    const body = JSON.stringify({
      apiVersion: 1,
      deliveryId,
      type: delivery.type,
      payload: delivery.payload,
      attempt: attemptIndex + 1,
    });

    let ok = false;
    let responseStatus: number | undefined;
    let error: string | undefined;
    if (!agent.notifyUrl) {
      error = "Agent notify URL is no longer configured";
    } else {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Ping-Delivery": deliveryId,
      };
      if (agent.notifySecret) {
        headers["X-Ping-Signature"] =
          `sha256=${createHmac("sha256", agent.notifySecret).update(body).digest("hex")}`;
      }
      try {
        const response = await fetch(agent.notifyUrl, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        responseStatus = response.status;
        ok = response.ok;
        if (!ok) error = `HTTP ${response.status}`;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    }

    const final =
      ok || attemptIndex >= AGENT_PING_RETRY_DELAYS_MS.length;
    await ctx.runMutation(internal.agentPingDeliveries._recordResult, {
      deliveryId,
      ok,
      responseStatus,
      error,
      final,
    });
    if (!ok && !final) {
      await ctx.scheduler.runAfter(
        AGENT_PING_RETRY_DELAYS_MS[attemptIndex],
        internal.agentPingDeliveryAction.deliver,
        { deliveryId },
      );
    }
  },
});
