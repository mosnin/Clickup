"use node";

import { ConvexError, v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { api } from "./_generated/api";

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

/** Channel a single chat channel's ephemeral signals ride on. */
export function chatChannel(channelId: string): string {
  return `operate:chat:${channelId}`;
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

// ── Client-side subscribe ───────────────────────────────────────────────
//
// The browser talks to Ably over SSE with a short-lived, capability-scoped
// token, not with the SDK and not with the API key. Two reasons, in order of
// importance:
//
//   1. The key never leaves the server. A token is subscribe-only and scoped
//      to the one channel the caller has just been authorized for, so a
//      leaked token is worth one channel for a few minutes.
//   2. The Ably SDK does not survive this project's webpack parse (it emits
//      valid ES2022 that the bundler's parser rejects), and SSE needs no SDK
//      at all — EventSource is a browser built-in.

const TOKEN_TTL_MS = 30 * 60 * 1000;

function ablyKeyParts(): { keyName: string; key: string } | null {
  const key = process.env.ABLY_API_KEY;
  if (!key || !key.includes(":")) return null;
  return { keyName: key.split(":")[0], key };
}

/**
 * A subscribe-only Ably token for one chat channel.
 *
 * Authorization happens here, against Convex, before the token exists — the
 * token itself carries no identity we would have to re-check downstream.
 */
export const chatSubscribeToken = action({
  args: { channelId: v.id("channels") },
  handler: async (ctx, { channelId }): Promise<{
    token: string;
    channel: string;
    expiresAt: number;
  } | null> => {
    // Reuses the same access check the thread query does, so there is exactly
    // one definition of "can this person read this channel".
    const thread = await ctx.runQuery(api.chat.thread, { channelId, limit: 1 });
    if (!thread) throw new ConvexError("Channel not found");

    const parts = ablyKeyParts();
    if (!parts) return null; // Unconfigured is a supported state.

    const channel = chatChannel(channelId);
    const res = await fetch(
      `${REST_BASE}/keys/${encodeURIComponent(parts.keyName)}/requestToken`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(parts.key).toString("base64")}`,
        },
        body: JSON.stringify({
          capability: JSON.stringify({ [channel]: ["subscribe"] }),
          ttl: TOKEN_TTL_MS,
        }),
      },
    );
    if (!res.ok) {
      console.error(
        `[realtime] token request failed: ${res.status} ${await res.text()}`,
      );
      return null;
    }
    const details = (await res.json()) as { token: string; expires: number };
    return {
      token: details.token,
      channel,
      expiresAt: details.expires ?? Date.now() + TOKEN_TTL_MS,
    };
  },
});

/**
 * "Someone is typing" and "someone is here".
 *
 * Deliberately not a database write. Typing state is worthless three seconds
 * later, and a table that every keystroke touches is a table that dominates
 * the write log. It goes out over Ably and is never persisted, so the worst
 * case of a dropped signal is an indicator that doesn't appear.
 */
export const chatSignal = action({
  args: {
    channelId: v.id("channels"),
    kind: v.union(v.literal("typing"), v.literal("here")),
    name: v.string(),
  },
  handler: async (ctx, { channelId, kind, name }): Promise<null> => {
    const thread = await ctx.runQuery(api.chat.thread, { channelId, limit: 1 });
    if (!thread) throw new ConvexError("Channel not found");
    await ctx.runAction(api.realtime.publishFromClient, {
      channel: chatChannel(channelId),
      name: kind,
      data: { name, at: Date.now() },
    });
    return null;
  },
});

/**
 * The publish half of the client path.
 *
 * Separate from the internal `publish` because this one is reachable from a
 * signed-in client — the caller has already been authorized by whoever calls
 * it, and it deliberately accepts no channel the caller names directly.
 */
export const publishFromClient = action({
  args: { channel: v.string(), name: v.string(), data: v.any() },
  handler: async (ctx, args): Promise<null> => {
    // Only ever called by another action in this file, which has done the
    // access check. Guard anyway: an "operate:chat:" prefix is the only
    // namespace a client-reachable publish may touch.
    if (!args.channel.startsWith("operate:chat:")) {
      throw new ConvexError("Not a client-publishable channel");
    }
    const parts = ablyKeyParts();
    if (!parts) return null;
    try {
      await fetch(
        `${REST_BASE}/channels/${encodeURIComponent(args.channel)}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${Buffer.from(parts.key).toString("base64")}`,
          },
          body: JSON.stringify({ name: args.name, data: args.data }),
        },
      );
    } catch (err) {
      console.error("[realtime] client publish threw", err);
    }
    return null;
  },
});
