"use client";

// Where the agent surfaces get their facts, and what they do when they cannot.
//
// Two disciplines copied wholesale from `transcript/messages-data.tsx`, because
// the failure modes are identical:
//
//  1. **A query against a function that is not deployed does not return an
//     error — it throws, during render.** `convex/buzz/agents.ts` is new, so on
//     a deployment that has not run `npx convex dev` these throw. Each sits
//     inside a boundary and its failure becomes a sentence, never a white
//     screen and never an invented agent.
//  2. **Nothing is fabricated on the way down.** An unanswered query is
//     `undefined` (loading) and a failed one is an error string; neither is
//     drawn as "nothing is working", because "we cannot tell" and "nothing is
//     happening" are different sentences and only one of them is true.

import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery } from "convex/react";
import type { ChatScope } from "@/lib/buzz/channel-types";
import {
  attachAgent,
  attachableAgents,
  detachAgent,
  scopeArgs,
  turnsFor,
  workingIn,
  type AttachableAgent,
  type RoomTurn,
  type RoomWorking,
} from "./refs";

// ---------------------------------------------------------------------------
// Live turns
// ---------------------------------------------------------------------------

export type RoomTurnsState = {
  /** `undefined` while the first result is in flight — the skeleton state. */
  turns: RoomTurn[] | undefined;
  error: string | null;
  /** Must be rendered by the caller: this is where the subscription lives. */
  subscription: ReactNode;
};

/**
 * Every turn this room is holding.
 *
 * Note what this hook does NOT do: decide which of them are still alive. That
 * needs a clock rather than a subscription — a crashed harness sends nothing,
 * so no query result will ever change to retire its row — and it lives in
 * `working-signal.tsx`.
 */
export function useRoomTurns(scope: ChatScope | null, channelId: string): RoomTurnsState {
  const [turns, setTurns] = useState<RoomTurn[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const key = scope ? `${scope.scopeType}:${scope.scopeId}:${channelId}` : "none";

  // A new room is a new set of turns. Reset in the render phase rather than in
  // an effect: an effect paints one frame of the previous room's working agent
  // under the new room's header, which reads as the wrong agent working rather
  // than as a load.
  const lastKey = useRef(key);
  if (lastKey.current !== key) {
    lastKey.current = key;
    setTurns(undefined);
    setError(null);
  }

  const onResult = useCallback((next: RoomTurn[]) => {
    setTurns(next);
    setError(null);
  }, []);

  return {
    turns,
    error,
    subscription: (
      <AgentBoundary key={key} onError={setError}>
        <TurnsSubscription scope={scope} channelId={channelId} onResult={onResult} />
      </AgentBoundary>
    ),
  };
}

/** One subscription, rendering nothing, so the boundary wraps only the throw. */
function TurnsSubscription({
  scope,
  channelId,
  onResult,
}: {
  scope: ChatScope | null;
  channelId: string;
  onResult: (turns: RoomTurn[]) => void;
}) {
  const result = useQuery(turnsFor, scope ? { ...scopeArgs(scope), channelId } : "skip");
  const last = useRef<RoomTurn[] | undefined>(undefined);
  useEffect(() => {
    if (result === undefined || last.current === result) return;
    last.current = result;
    onResult(result);
  }, [result, onResult]);
  return null;
}

// ---------------------------------------------------------------------------
// The server's clock
// ---------------------------------------------------------------------------

/**
 * The room's working answer, read for one field: `now`.
 *
 * The list of agents on it is not used — the client re-derives that against its
 * own ticking clock, or the signal could never decay. What only the server can
 * supply is the clock the anchors were measured on, and without it every
 * elapsed counter in the room is wrong by however far this laptop has drifted.
 */
export function useServerClock(
  scope: ChatScope | null,
  channelId: string,
): { sample: RoomWorking | undefined; error: string | null; subscription: ReactNode } {
  const [sample, setSample] = useState<RoomWorking | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const key = scope ? `${scope.scopeType}:${scope.scopeId}:${channelId}` : "none";

  const lastKey = useRef(key);
  if (lastKey.current !== key) {
    lastKey.current = key;
    setSample(undefined);
    setError(null);
  }

  const onResult = useCallback((next: RoomWorking) => {
    setSample(next);
    setError(null);
  }, []);

  return {
    sample,
    error,
    subscription: (
      <AgentBoundary key={key} onError={setError}>
        <WorkingSubscription scope={scope} channelId={channelId} onResult={onResult} />
      </AgentBoundary>
    ),
  };
}

function WorkingSubscription({
  scope,
  channelId,
  onResult,
}: {
  scope: ChatScope | null;
  channelId: string;
  onResult: (working: RoomWorking) => void;
}) {
  const result = useQuery(workingIn, scope ? { ...scopeArgs(scope), channelId } : "skip");
  const last = useRef<RoomWorking | undefined>(undefined);
  useEffect(() => {
    if (result === undefined || last.current === result) return;
    last.current = result;
    onResult(result);
  }, [result, onResult]);
  return null;
}

// ---------------------------------------------------------------------------
// Who may be in this room
// ---------------------------------------------------------------------------

export type RoomAgentsState = {
  /** Every agent in the community, attached or not. `undefined` = loading. */
  all: AttachableAgent[] | undefined;
  /** The ones actually in this room. */
  attached: AttachableAgent[];
  /** The ones that could be added, refusals included — with their reasons. */
  candidates: AttachableAgent[];
  error: string | null;
  subscription: ReactNode;
};

/**
 * One query answers both halves of this surface, and that is the point.
 *
 * "Who is in this room" and "who could be" are the same list with a flag, so
 * asking them separately would be two answers that can disagree — a picker
 * offering an agent the member list is already showing.
 */
export function useRoomAgents(scope: ChatScope | null, channelId: string): RoomAgentsState {
  const [all, setAll] = useState<AttachableAgent[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const key = scope ? `${scope.scopeType}:${scope.scopeId}:${channelId}` : "none";

  const lastKey = useRef(key);
  if (lastKey.current !== key) {
    lastKey.current = key;
    setAll(undefined);
    setError(null);
  }

  const onResult = useCallback((next: AttachableAgent[]) => {
    setAll(next);
    setError(null);
  }, []);

  return {
    all,
    attached: (all ?? []).filter((agent) => agent.attached),
    candidates: (all ?? []).filter((agent) => !agent.attached),
    error,
    subscription: (
      <AgentBoundary key={key} onError={setError}>
        <AttachableSubscription scope={scope} channelId={channelId} onResult={onResult} />
      </AgentBoundary>
    ),
  };
}

function AttachableSubscription({
  scope,
  channelId,
  onResult,
}: {
  scope: ChatScope | null;
  channelId: string;
  onResult: (agents: AttachableAgent[]) => void;
}) {
  const result = useQuery(
    attachableAgents,
    scope ? { ...scopeArgs(scope), channelId } : "skip",
  );
  const last = useRef<AttachableAgent[] | undefined>(undefined);
  useEffect(() => {
    if (result === undefined || last.current === result) return;
    last.current = result;
    onResult(result);
  }, [result, onResult]);
  return null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type AgentRoomActions = {
  attach: (agentId: string) => Promise<void>;
  detach: (agentId: string) => Promise<void>;
};

/**
 * Put an agent in a room, or take it out.
 *
 * Bundled with the scope baked in for the same reason the message actions are:
 * every call needs the same three arguments, and a call site that assembles
 * them by hand is a call site that can attach an agent to a room in a community
 * it is not a member of.
 */
export function useAgentRoomActions(
  scope: ChatScope | null,
  channelId: string,
): AgentRoomActions {
  const attach = useMutation(attachAgent);
  const detach = useMutation(detachAgent);

  return useMemo(() => {
    const base = scope ? { ...scopeArgs(scope), channelId } : null;
    const refuse = async (): Promise<void> => {
      throw new Error("No community selected");
    };
    if (!base) return { attach: refuse, detach: refuse };
    return {
      async attach(agentId: string) {
        await attach({ ...base, agentId });
      },
      async detach(agentId: string) {
        await detach({ ...base, agentId });
      },
    };
  }, [scope, channelId, attach, detach]);
}

// ---------------------------------------------------------------------------
// The boundary, and the clock
// ---------------------------------------------------------------------------

class AgentBoundary extends Component<
  { children: ReactNode; onError: (message: string) => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // The reason, not an apology. "Could not find public function
    // buzz/agents:turnsFor" is the sentence that tells whoever is looking
    // exactly which half of the build has not landed.
    this.props.onError(
      error instanceof Error ? error.message : "Agent activity could not be loaded",
    );
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * A clock, for the one thing here whose truth changes with no data arriving.
 *
 * `ms === null` stops it, and every caller passes null when there is nothing
 * live: a room with no turn in it must not re-render once a second for the rest
 * of the afternoon just so a counter that is not on screen stays correct.
 */
export function useTicker(ms: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (ms === null) return undefined;
    // Read once immediately, so a turn that expired while the clock was stopped
    // is not carried on screen for a further interval.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
