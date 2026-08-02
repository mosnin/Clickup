// The realtime transport, stood in for.
//
// Typing is the one thing in Chat that never touches the database — it rides
// Ably and nothing it produces is stored (`presence/use-typing.ts`). That makes
// it the one signal the Convex stub cannot supply, and it would have left the
// typing line as the only band under the transcript nobody had ever looked at.
//
// So this stubs the module rather than the component: the shipping
// `useRoomTyping` runs, the shipping reducer folds the signal, and the shipping
// `TypingLine` draws the result. The gallery only decides what came down the
// wire. Signals are re-sent on an interval because a typing entry expires after
// five seconds by design — one delivery would photograph an empty band.

import { useEffect, useRef } from "react";

export type ChannelSignal = { name: string; data: unknown };
export type AblyStatus = "idle" | "connecting" | "live" | "unavailable";
export type ChannelAuth = {
  token: string;
  channel: string;
  expiresAt: number;
} | null;

/** Signals the gallery wants delivered, set before it renders. */
export const gallerySignals: ChannelSignal[] = [];

export function useAblyStream(
  channel: string | null,
  _authorize: () => Promise<ChannelAuth | null>,
  onSignal: (signal: ChannelSignal) => void,
): AblyStatus {
  const handler = useRef(onSignal);
  handler.current = onSignal;

  useEffect(() => {
    if (!channel || gallerySignals.length === 0) return;
    const deliver = () => {
      for (const signal of gallerySignals) handler.current(signal);
    };
    deliver();
    const timer = setInterval(deliver, 2_000);
    return () => clearInterval(timer);
  }, [channel]);

  return gallerySignals.length > 0 ? "live" : "unavailable";
}

export function useAblyChannel(
  channelId: string | null,
  onSignal: (signal: ChannelSignal) => void,
): AblyStatus {
  return useAblyStream(channelId, async () => null, onSignal);
}

export const TYPING_TTL_MS = 5_000;
export const TYPING_THROTTLE_MS = 2_500;
