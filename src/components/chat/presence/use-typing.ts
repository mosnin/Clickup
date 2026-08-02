"use client";

// Typing indicators.
//
// **Typing is not a database write, and that is the constraint the whole file
// is shaped around.** A row per keystroke — even throttled to one per three
// seconds per typist — is a table that takes more writes from people *about*
// to say something than from people saying it, and the durable log would carry
// a permanent record of everyone's hesitation. So this rides Ably, exactly as
// `realtime.chatSignal` already does for the Work side, and nothing it
// produces is ever stored (06-protocol §16.22).
//
// Consequences worth stating rather than discovering:
//
//   • **Ably unconfigured is a supported state.** The hook reports its
//     transport, the send is a no-op the server absorbs, and the room works —
//     it simply never shows dots. A room that hard-failed without Ably would
//     be a regression against how the rest of this app behaves.
//   • **A dropped signal costs an indicator, never data.** That is what lets
//     every publish here be fire-and-forget.
//   • **All state resets on channel change.** Carrying entries between rooms
//     would put one room's typists under another room's transcript, which is
//     worse than showing nothing.
//
// Every rule about *what* to draw lives in `src/lib/buzz/presence.ts` and is
// tested there. This file is the plumbing: a subscription, a throttle clock in
// a ref, and a prune interval that only runs while somebody is typing.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction } from "convex/react";
import { useAblyStream, type AblyStatus, type ChannelSignal } from "@/lib/use-ably-channel";
import type { ChatScope } from "@/lib/buzz/channel-types";
import {
  EMPTY_TYPING_STATE,
  IDLE_TYPING_CLOCK,
  TYPING_PRUNE_INTERVAL_MS,
  noteMessageFrom,
  noteMessageSent,
  pruneTyping,
  receiveTypingSignal,
  shouldSendTyping,
  typingIn,
  type TypingClock,
  type TypingEntry,
  type TypingScope,
  type TypingState,
} from "@/lib/buzz/presence";
import { roomTokenRef, scopeArgs, signalRef } from "./refs";

export type RoomTyping = {
  /** Everyone typing in this scope, oldest claim first. Never includes you. */
  typists: TypingEntry[];
  /** Call on every change to the composer. Throttled internally. */
  notifyTyping: () => void;
  /** Call when *you* send, so your own next announcement is held back. */
  notifyMessageSent: () => void;
  /** Call when somebody else's message lands, so their dots go out with it. */
  noteMessage: (pubkey: string, threadHeadId?: string | null) => void;
  /** `"live"`, or `"unavailable"` when Ably is not configured on this deployment. */
  transport: AblyStatus;
};

export function useRoomTyping(input: {
  scope: ChatScope | null;
  channelId: string | null;
  /** Set inside a thread pane. Typing in a thread is a different claim. */
  threadHeadId?: string | null;
  /** Yours — so your own echo is dropped rather than drawn back at you. */
  selfPubkey: string | null;
  selfName: string;
}): RoomTyping {
  const { scope, channelId, selfPubkey, selfName } = input;
  const threadHeadId = input.threadHeadId ?? null;

  const issueToken = useAction(roomTokenRef);
  const sendSignal = useAction(signalRef);
  const [state, setState] = useState<TypingState>(EMPTY_TYPING_STATE);
  const clock = useRef<TypingClock>(IDLE_TYPING_CLOCK);

  // Everything the signal handler needs, held in a ref: `useAblyStream` keeps
  // the handler in a ref of its own precisely so the stream is not torn down
  // and reopened whenever a parent re-renders, and closing over state here
  // would give that back.
  const context = useRef({ selfPubkey, channelId });
  context.current = { selfPubkey, channelId };

  const onSignal = useCallback((signal: ChannelSignal) => {
    if (signal.name !== "typing") return;
    const { selfPubkey: self, channelId: room } = context.current;
    if (!room) return;
    const data = signal.data as {
      pubkey?: string;
      name?: string;
      isAgent?: boolean;
      channelId?: string;
      threadHeadId?: string | null;
      sentAt?: number;
    };
    if (!data.pubkey || !data.channelId) return;
    setState((current) =>
      receiveTypingSignal(
        current,
        {
          pubkey: data.pubkey as string,
          name: data.name || "Someone",
          isAgent: data.isAgent ?? false,
          channelId: data.channelId as string,
          threadHeadId: data.threadHeadId ?? null,
          sentAt: typeof data.sentAt === "number" ? data.sentAt : Date.now(),
        },
        {
          now: Date.now(),
          selfPubkey: self ?? "",
          // The scope is the *room*; which thread an entry belongs to is
          // carried on the entry, so one subscription serves the transcript
          // and the thread pane at once.
          scope: { channelId: room, threadHeadId: null },
        },
      ),
    );
  }, []);

  const authorize = useCallback(async () => {
    if (!scope || !channelId) return null;
    return await issueToken({ ...scopeArgs(scope), channelId });
  }, [scope, channelId, issueToken]);

  const transport = useAblyStream(
    scope && channelId ? `${scope.scopeType}:${scope.scopeId}:${channelId}` : null,
    authorize,
    onSignal,
  );

  // A room change wipes everything, including the throttle clock — walking
  // into a room and typing must announce immediately rather than wait out a
  // window opened somewhere else.
  useEffect(() => {
    setState(EMPTY_TYPING_STATE);
    clock.current = IDLE_TYPING_CLOCK;
  }, [channelId]);

  // Prune only while somebody is typing. A permanent one-second timer in a
  // chat client is a permanent one-second wake-up on a phone.
  const busy = Object.keys(state.entries).length > 0;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(
      () => setState((current) => pruneTyping(current, Date.now())),
      TYPING_PRUNE_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [busy]);

  const notifyTyping = useCallback(() => {
    if (!scope || !channelId || !selfPubkey) return;
    const typingScope: TypingScope = { channelId, threadHeadId };
    const decision = shouldSendTyping(clock.current, { scope: typingScope, now: Date.now() });
    clock.current = decision.clock;
    if (!decision.send) return;
    void sendSignal({
      ...scopeArgs(scope),
      channelId,
      kind: "typing",
      ...(threadHeadId ? { threadHeadId } : {}),
      pubkey: selfPubkey,
      name: selfName,
    }).catch(() => {
      // Fire-and-forget: an indicator that failed to publish is an indicator
      // that does not appear, which is the designed worst case.
    });
  }, [scope, channelId, threadHeadId, selfPubkey, selfName, sendSignal]);

  const notifyMessageSent = useCallback(() => {
    clock.current = noteMessageSent(clock.current, Date.now());
  }, []);

  const noteMessage = useCallback((pubkey: string, thread?: string | null) => {
    setState((current) => noteMessageFrom(current, { pubkey, threadHeadId: thread ?? null }, Date.now()));
  }, []);

  const typists = useMemo(() => typingIn(state, threadHeadId), [state, threadHeadId]);

  return { typists, notifyTyping, notifyMessageSent, noteMessage, transport };
}
