"use node";

import { ConvexError, v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";

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

/**
 * The channel a space's look is negotiated on.
 *
 * Its own namespace rather than the space's `scopeChannel`, which already
 * carries page fan-out — a client that only wants to watch someone drag a
 * slider should not have to filter document events out of the stream.
 */
export function spaceLookChannel(spaceId: string): string {
  return `operate:look:${spaceId}`;
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
    await ctx.runAction(internal.realtime.publishFromClient, {
      channel: chatChannel(channelId),
      name: kind,
      data: { name, at: Date.now() },
    });
    return null;
  },
});

/**
 * The publish half of the authorized client-signal path.
 *
 * Internal on purpose: the previous public `action` accepted any channel
 * string and did no identity check, so anyone who knew `NEXT_PUBLIC_CONVEX_URL`
 * could inject typing / look-preview / huddle events onto `operate:chat:*`
 * and `operate:look:*`. Callers (`chatSignal`, `spaceLookSignal`, Buzz
 * presence/huddle) do the access check, then hop here. The prefix guard
 * stays so a buggy caller still cannot aim the server key at inbox or
 * activity channels. `publish` remains the unrestricted server path.
 */
export const publishFromClient = internalAction({
  args: { channel: v.string(), name: v.string(), data: v.any() },
  handler: async (ctx, args): Promise<null> => {
    if (
      !args.channel.startsWith("operate:chat:") &&
      !args.channel.startsWith("operate:look:")
    ) {
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

// ── Watching someone change how a space looks ───────────────────────────
//
// The committed theme needs none of this: it is a Convex row, so a saved change
// already morphs for everyone standing in the space over the same subscription
// that renders it. What a query cannot carry is the drag itself — a write per
// frame is exactly what the debounce exists to prevent — and a shared look being
// tuned is precisely the moment other people want to watch. So the in-flight
// value goes over Ably and is never persisted: the worst case of a dropped
// signal is that a spectator's UI waits for the save, which is where it was
// heading anyway.

/** A subscribe-only token for one space's look channel. */
export const spaceLookToken = action({
  args: { spaceId: v.id("spaces") },
  handler: async (
    ctx,
    { spaceId },
  ): Promise<{ token: string; channel: string; expiresAt: number } | null> => {
    // Reuses the access check the themed shell already does, so there is one
    // definition of "can this person see this space".
    const context = await ctx.runQuery(api.appearance.spaceContext, {
      kind: "space",
      id: spaceId,
    });
    if (!context) throw new ConvexError("Space not found");

    const parts = ablyKeyParts();
    if (!parts) return null; // Unconfigured is a supported state.

    const channel = spaceLookChannel(spaceId);
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
        `[realtime] look token request failed: ${res.status} ${await res.text()}`,
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
 * Broadcast an in-flight change to a space's look.
 *
 * Gated on the right to change the space, not merely on membership: a signal
 * that repaints everyone's UI is a shared act, and letting any member emit one
 * would hand every member a way to make the room flash for the whole team.
 */
export const spaceLookSignal = action({
  args: {
    spaceId: v.id("spaces"),
    /** The in-flight patch, or null to say "I have stopped". */
    patch: v.union(v.any(), v.null()),
    /** Which tab is dragging, so a client can ignore its own echo. */
    origin: v.string(),
    byName: v.string(),
  },
  handler: async (ctx, { spaceId, patch, origin, byName }): Promise<null> => {
    const context = await ctx.runQuery(api.appearance.spaceContext, {
      kind: "space",
      id: spaceId,
    });
    if (!context) throw new ConvexError("Space not found");
    if (!context.mayTheme) {
      throw new ConvexError("Only the space creator or workspace owner can change how this space looks");
    }
    await ctx.runAction(internal.realtime.publishFromClient, {
      channel: spaceLookChannel(spaceId),
      name: "look.preview",
      data: { patch, origin, byName, at: Date.now() },
    });
    return null;
  },
});
