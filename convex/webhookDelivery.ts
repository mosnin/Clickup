"use node";

import { createHmac } from "crypto";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { RETRY_DELAYS_MS } from "./webhooks";

// Webhook delivery worker. Scheduled from emitEvent() (convex/events.ts)
// with a fresh delivery row; retries reschedule themselves with backoff.
// Failures never propagate to the mutation that emitted the event.
//
// Receivers verify authenticity by recomputing
//   HMAC-SHA256(secret, rawBody)
// and comparing it to the `X-Webhook-Signature: sha256=<hex>` header.

const TIMEOUT_MS = 10_000;

export const deliver = internalAction({
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, { deliveryId }) => {
    const context = await ctx.runQuery(internal.webhooks._deliveryContext, {
      deliveryId,
    });
    if (!context) return;
    const { delivery, sub, event } = context;
    if (delivery.status !== "pending" || !sub.enabled) return;

    const body = JSON.stringify({
      // Bump when the payload shape changes so consumers can branch.
      apiVersion: 1,
      id: event._id,
      type: event.type,
      createdAt: event.createdAt,
      scope: { type: event.scopeType, id: event.scopeId },
      actor: {
        type: event.actorType,
        id: event.actorId,
        name: event.actorName,
      },
      entity: {
        type: event.entityType,
        id: event.entityId,
        title: event.entityTitle,
      },
      listId: event.listId,
      payload: event.payload,
      attempt: delivery.attempts + 1,
    });
    const signature = createHmac("sha256", sub.secret)
      .update(body)
      .digest("hex");

    let ok = false;
    let responseStatus: number | undefined;
    let error: string | undefined;
    try {
      const res = await fetch(sub.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Event": event.type,
          "X-Webhook-Delivery": delivery._id,
          "X-Webhook-Signature": `sha256=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      responseStatus = res.status;
      ok = res.ok;
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const attemptIndex = delivery.attempts; // 0-based attempt just made
    const final = ok || attemptIndex >= RETRY_DELAYS_MS.length;
    await ctx.runMutation(internal.webhooks._recordResult, {
      deliveryId,
      ok,
      responseStatus,
      error,
      final,
    });
    if (!ok && !final) {
      await ctx.scheduler.runAfter(
        RETRY_DELAYS_MS[attemptIndex],
        internal.webhookDelivery.deliver,
        { deliveryId },
      );
    }
  },
});
