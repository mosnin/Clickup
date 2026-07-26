"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";

// Real-time fan-out over Ably.
//
// Convex already pushes every query result to subscribed clients, so this is
// not how the dashboard stays fresh — that part needs no help. Ably exists here
// for the two things Convex subscriptions can't do:
//
//   1. Presence. "Is atlas-01 online right now" is a liveness question, not a
//      data question. Polling lastSeenAt makes an agent look online for up to a
//      minute after it dies and offline for a second after it wakes.
//   2. Notifications that reach a person who is not looking at the relevant
//      query — or not looking at the app at all.
//
// Convex stays the source of truth. Ably carries a signal, never state: every
// message is small, and a client that misses one recovers by reading Convex.
// That means a dropped message is a missed nudge, never lost data.
//
// Publishing is fire-and-forget on purpose. A failed publish must never roll
// back the mutation that caused it — the change is already committed and
// authoritative; only the nudge is lost.

const REST_BASE = "https://rest.ably.io";

/** Channel a scope's activity is published on. */
export function scopeChannel(
  scopeType: "user" | "workspace",
  scopeId: string,
): string {
  return `operate:${scopeType}:${scopeId}`;
}

/** Channel one person's own notifications land on. */
export function userChannel(clerkId: string): string {
  return `operate:inbox:${clerkId}`;
}

export const publish = internalAction({
  args: {
    channel: v.string(),
    name: v.string(),
    data: v.any(),
  },
  handler: async (_ctx, { channel, name, data }) => {
    const key = process.env.ABLY_API_KEY;
    if (!key) {
      // Unconfigured is a supported state, not an error: the app is fully
      // functional without Ably (Convex subscriptions still drive every
      // view), so this stays a one-line log rather than a thrown action.
      console.log("[realtime] ABLY_API_KEY not set; skipping publish");
      return { published: false as const };
    }
    try {
      const res = await fetch(
        `${REST_BASE}/channels/${encodeURIComponent(channel)}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${Buffer.from(key).toString("base64")}`,
          },
          body: JSON.stringify({ name, data }),
        },
      );
      if (!res.ok) {
        console.error(
          `[realtime] publish ${channel}/${name} failed: ${res.status} ${await res.text()}`,
        );
        return { published: false as const };
      }
      return { published: true as const };
    } catch (err) {
      console.error(`[realtime] publish ${channel}/${name} threw`, err);
      return { published: false as const };
    }
  },
});
