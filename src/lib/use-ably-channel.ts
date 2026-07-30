"use client";

import { useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

// Ably, over SSE, with no SDK.
//
// The browser gets a short-lived subscribe-only token from Convex (which does
// the access check first) and opens an EventSource. That buys three things
// the Ably SDK would also buy, without the SDK: the API key never reaches the
// client, the token is scoped to one channel, and nothing has to survive the
// bundler — EventSource is a browser built-in.
//
// What rides on this channel is deliberately ephemeral: typing, presence, and
// a nudge that a message landed. Convex remains the source of truth, so a
// dropped event costs an indicator, never data. That is the whole reason this
// can be fire-and-forget.

export type ChannelSignal = {
  name: string;
  data: { name?: string; at?: number; [key: string]: unknown };
};

const SSE_BASE = "https://realtime.ably.io/sse";
/** Re-auth this far before the token dies, so the stream never gaps. */
const REFRESH_MARGIN_MS = 60_000;

export type AblyStatus = "idle" | "connecting" | "live" | "unavailable";

export type ChannelAuth = {
  token: string;
  channel: string;
  expiresAt: number;
};

/**
 * Subscribe to one Ably channel's ephemeral signals.
 *
 * `subject` is what identifies the stream — change it and the stream is torn
 * down and reopened; null means "not subscribed". `authorize` mints the token
 * and is held in a ref alongside `onSignal`, because callers rebuild both every
 * render and a dependency on either would reopen the stream on every keystroke.
 *
 * Generic in the channel rather than specific to chat: the access check and the
 * channel name both live server-side inside `authorize`, so nothing here has to
 * know what is being subscribed to.
 */
export function useAblyStream(
  subject: string | null,
  authorize: () => Promise<ChannelAuth | null>,
  onSignal: (signal: ChannelSignal) => void,
): AblyStatus {
  const [status, setStatus] = useState<AblyStatus>("idle");
  const handlerRef = useRef(onSignal);
  handlerRef.current = onSignal;
  const authorizeRef = useRef(authorize);
  authorizeRef.current = authorize;

  useEffect(() => {
    if (!subject) {
      setStatus("idle");
      return;
    }
    let source: EventSource | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    async function connect() {
      setStatus("connecting");
      let auth: ChannelAuth | null;
      try {
        auth = await authorizeRef.current();
      } catch {
        // A refused token is not a broken app: the thread still renders from
        // Convex. Say "unavailable" and stop.
        if (!cancelled) setStatus("unavailable");
        return;
      }
      // Ably isn't configured on this deployment — a supported state.
      if (!auth) {
        if (!cancelled) setStatus("unavailable");
        return;
      }
      if (cancelled) return;

      const url = `${SSE_BASE}?v=1.2&channels=${encodeURIComponent(
        auth.channel,
      )}&accessToken=${encodeURIComponent(auth.token)}`;
      source = new EventSource(url);
      source.onopen = () => {
        if (!cancelled) setStatus("live");
      };
      source.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data) as {
            name?: string;
            data?: unknown;
          };
          if (!parsed.name) return;
          const data =
            typeof parsed.data === "string"
              ? (JSON.parse(parsed.data) as ChannelSignal["data"])
              : ((parsed.data ?? {}) as ChannelSignal["data"]);
          handlerRef.current({ name: parsed.name, data });
        } catch {
          // A malformed frame is a dropped nudge. Nothing to recover.
        }
      };
      source.onerror = () => {
        // EventSource reconnects on its own; an expired token is the one
        // failure it can't recover from, which the refresh below prevents.
        if (!cancelled) setStatus("connecting");
      };

      const wait = Math.max(auth.expiresAt - Date.now() - REFRESH_MARGIN_MS, 30_000);
      refreshTimer = setTimeout(() => {
        source?.close();
        void connect();
      }, wait);
    }

    void connect();
    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      source?.close();
    };
  }, [subject]);

  return status;
}

/**
 * Subscribe to a chat channel.
 *
 * The thin wrapper that was the whole hook before a second kind of channel
 * existed. It still owns exactly one thing: which Convex action authorizes a
 * chat channel.
 */
export function useAblyChannel(
  channelId: Id<"channels"> | null,
  onSignal: (signal: ChannelSignal) => void,
): AblyStatus {
  const issueToken = useAction(api.realtime.chatSubscribeToken);
  return useAblyStream(
    channelId,
    () => issueToken({ channelId: channelId! }),
    onSignal,
  );
}

/** How long a typing indicator survives without a fresh signal. */
export const TYPING_TTL_MS = 5_000;
/** How often the client re-announces while someone keeps typing. */
export const TYPING_THROTTLE_MS = 2_500;
