"use client";

// What a person sees while an agent is thinking.
//
// The band sits between the transcript and the composer, beside the typing
// line and drawn to the same rules, because it answers the same question about
// a different kind of colleague: somebody is about to say something, should I
// wait? Reserving its height rather than appearing and disappearing is the one
// layout decision worth defending — a line that pops in pushes the last message
// up by its own height, and a transcript that will not sit still while you read
// it is worse than no indicator at all.
//
// **The whole design problem is the ending, not the beginning.** Starting is
// easy: a frame arrives and the row appears. Stopping is where every version of
// this feature fails, because the process that would tell you it has stopped is
// exactly the process that crashed. So nothing here waits to be told. Liveness
// is a lease (`turnLiveness`), and a runtime that dies simply stops renewing
// it, which means the room stops lying about twenty-five seconds later without
// anything having to notice the death.
//
// That is also why this file owns a clock. A Convex query re-runs when data
// changes, not when time passes — and a turn goes stale precisely when no data
// is changing, so a server-computed boolean would freeze at the moment it
// stopped being true. The client re-derives with `deriveWorking` against its
// own tick, corrected onto the server's clock, and the clock stops when there
// is nothing live to count.

import { useMemo, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { ChatScope } from "@/lib/buzz/channel-types";
import { ActorAvatar } from "@/components/chat/transcript/avatar";
import { useRoomTurns, useServerClock, useTicker } from "./data";
import type { RoomTurn } from "./refs";
import {
  deriveWorking,
  foldClockOffset,
  serverTime,
  workingLabel,
  workingTickMs,
  type ClockOffset,
  type WorkingAgent,
} from "./signal";
import { formatTurnElapsed } from "./turn";

// ---------------------------------------------------------------------------
// Connected
// ---------------------------------------------------------------------------

export type RoomWorkingState = {
  /** The room's turns, whatever their liveness. The panel reads these too. */
  turns: RoomTurn[] | undefined;
  /** Only the ones still working, this tick. */
  working: WorkingAgent[];
  /** The tick everything was computed against, on the SERVER's clock. */
  now: number;
  /** Loading is distinct from empty and must not be drawn as "nobody is working". */
  loading: boolean;
  error: string | null;
  /** Must be rendered by the caller — the subscriptions live in here. */
  subscriptions: ReactNode;
};

/**
 * The room's working signal.
 *
 * One hook per room and never one per row: the alternative is every member row
 * holding its own subscription to the same two queries, which is the mistake
 * `PresenceProvider` exists to have already made once.
 */
export function useRoomWorkingSignal(
  scope: ChatScope | null,
  channelId: string,
): RoomWorkingState {
  const turns = useRoomTurns(scope, channelId);
  const clock = useServerClock(scope, channelId);

  // The offset is folded in a ref rather than in state: it is an input to a
  // render, not a reason for one, and a running minimum that re-rendered on
  // every sample would re-render the room every time the server answered.
  const offset = useMemo<{ value: ClockOffset }>(() => ({ value: null }), []);
  if (clock.sample) {
    offset.value = foldClockOffset(offset.value, {
      serverNow: clock.sample.now,
      clientNow: Date.now(),
    });
  }

  const tick = useTicker(workingTickMs(turns.turns));
  const now = serverTime(tick, offset.value);
  const working = useMemo(() => deriveWorking(turns.turns, now), [turns.turns, now]);

  return {
    turns: turns.turns,
    working,
    now,
    loading: turns.turns === undefined,
    error: turns.error ?? clock.error,
    // Two boundaries, keyed apart. Each is keyed on the room inside its own
    // hook, so without a discriminator here the siblings collide on one key and
    // React reconciles one of them away.
    subscriptions: (
      <>
        <span key="turns" hidden>
          {turns.subscription}
        </span>
        <span key="clock" hidden>
          {clock.subscription}
        </span>
      </>
    ),
  };
}

// ---------------------------------------------------------------------------
// The band
// ---------------------------------------------------------------------------

/**
 * `Honey is working · 1m 04s`, and the sentence it is saying while it works.
 *
 * Presentational on purpose — it takes the derived list and the tick rather
 * than subscribing — so the room, the gallery and the test all draw the
 * identical component from the identical inputs.
 */
export function AgentWorkingLine({
  working,
  now,
  className,
}: {
  working: readonly WorkingAgent[];
  now: number;
  className?: string;
}) {
  const names = working.map((agent) => agent.agentName ?? "An agent");
  const label = workingLabel(names);
  // The narration of whoever started first, which is the row the counter is
  // anchored to. One line, replaced — never a transcript. A second sentence
  // here would be an activity log in a 20px band.
  const narration = working[0]?.narration?.trim() ?? "";

  return (
    <div
      // `polite`, never `assertive`: a machine starting work is not an
      // interruption, and a screen reader announcing every turn in a busy room
      // would be unusable.
      aria-live="polite"
      {...(label ? { "data-testid": "agent-working-line" } : {})}
      className={cn("flex h-5 items-center gap-1.5 overflow-hidden px-1 text-xs", className)}
    >
      {label ? (
        <>
          <span className="flex shrink-0 items-center">
            {working.slice(0, 3).map((agent, index) => (
              <ActorAvatar
                key={agent.agentId}
                label={agent.agentName ?? "Agent"}
                pubkey={agent.agentPubkey}
                isAgent
                size={16}
                className={index === 0 ? "" : "-ml-1.5"}
              />
            ))}
          </span>
          <WorkingPulse />
          <span className="chat-quiet min-w-0 shrink-0 truncate">{label}</span>
          {narration ? (
            <span className="chat-quiet hidden min-w-0 flex-1 truncate sm:inline">
              {/* An em dash and not a colon: the narration is the agent's own
                  sentence, and a colon makes the room look like it is quoting a
                  log line. */}
              — {narration}
            </span>
          ) : (
            <span className="min-w-0 flex-1" />
          )}
          <TurnElapsed since={working[0].anchorAt} now={now} className="shrink-0" />
        </>
      ) : null}
    </div>
  );
}

/**
 * The one moving mark.
 *
 * A pulsing dot rather than Buzz's three staggered logo marks, and rather than
 * a spinner: the house rule spends icons on affordances, and a dot the same
 * shape as the presence dot two rows above says "this principal is doing
 * something" in a vocabulary the room already has. Tailwind's own `pulse`, so
 * it inherits `motion-reduce` without a media query of its own.
 */
export function WorkingPulse({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Agent turn in progress"
      className={cn(
        "size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--chat-accent)] motion-reduce:animate-none",
        className,
      )}
    />
  );
}

/**
 * How long it has been going.
 *
 * `tabular-nums`, because a counter whose digits change width makes the label
 * beside it jitter once a second — the reason Buzz's own working chip uses it.
 */
export function TurnElapsed({
  since,
  now,
  className,
}: {
  since: number;
  now: number;
  className?: string;
}) {
  return (
    <span
      // `whitespace-nowrap` is load-bearing rather than tidy: beside a
      // truncating narration the counter is the flex item that gives, and
      // "1m 35s" breaking across two lines makes the row two lines tall and
      // then snaps back the moment the sentence gets shorter.
      className={cn("chat-quiet whitespace-nowrap tabular-nums text-[0.6875rem]", className)}
      title="How long this turn has been running"
    >
      {formatTurnElapsed(Math.max(0, now - since))}
    </span>
  );
}
