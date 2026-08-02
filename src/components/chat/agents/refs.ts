// The Convex functions this folder calls, named by hand.
//
// Same treatment as `presence/refs.ts` and `transcript/messages-data.tsx`, for
// the same reason: `convex/_generated/api.d.ts` is a checked-in stub that
// predates `convex/buzz/*`, so `api.buzz.agents` does not typecheck until
// somebody runs `npx convex dev`. `makeFunctionReference` resolves the same
// path at runtime and keeps real argument types at the call sites.
//
// **Delete this file and import `api.buzz.agents.*` the first time the CLI
// regenerates the stub.**
//
// The row shapes are restated by hand rather than imported from
// `convex/buzz/agents.ts`, which is the same choice `presence/refs.ts` made for
// `RosterEntry` and it is not laziness: the server types are branded
// (`Id<"agents">`), so importing them would make every fixture in a test or a
// gallery unconstructable without a cast, and a cast in a fixture is a fixture
// that can drift from the thing it stands for without anybody noticing.
// `ChatTurn` itself IS imported, because it is a shared contract in
// `src/lib/buzz/` written to be read from both sides.

import { makeFunctionReference } from "convex/server";
import type { ChatScope } from "@/lib/buzz/channel-types";
import type { ChatTurn, TurnLiveness, WorkingAgent } from "@/lib/buzz/turn";

export type ScopeArgs = { scopeType: ChatScope["scopeType"]; scopeId: string };

export function scopeArgs(scope: ChatScope): ScopeArgs {
  return { scopeType: scope.scopeType, scopeId: scope.scopeId };
}

/**
 * An agent in this community, and whether it can be in this room.
 *
 * `blockedReason` is the field worth defending: the query returns the agents it
 * is refusing along with why, instead of filtering them out. An agent missing
 * from a picker is indistinguishable from an agent that does not exist, and the
 * two commonest blocks — no Chat identity yet, restricted to lists — are both
 * things a person can fix in ten seconds if anybody tells them.
 *
 * `lastSeenAt` is the whole of D9 in one optional number: absent means no
 * runtime has ever connected as this agent, which is not an outage and must not
 * be drawn as one.
 */
export type AttachableAgent = {
  agentId: string;
  name: string;
  /** Already an active member of this room. */
  attached: boolean;
  /** Has a Chat identity; `false` means a key must be minted before attaching. */
  hasKey: boolean;
  pubkey: string | null;
  blockedReason: string | null;
  lastSeenAt?: number;
};

/** A turn, plus the liveness the server computed when it read it. */
export type RoomTurn = ChatTurn & { liveness: TurnLiveness };

/**
 * `api.buzz.agents.working` — is anybody working in here, and since when.
 *
 * `now` comes back with the answer, and it is the most useful field on it: the
 * anchor is only meaningful against the clock it was measured on, and the
 * reader's may be minutes off. See `signal.ts:foldClockOffset`.
 */
export type RoomWorking = {
  working: boolean;
  agents: WorkingAgent[];
  anchorAt: number | null;
  now: number;
};

export const attachableAgents = makeFunctionReference<
  "query",
  ScopeArgs & { channelId: string },
  AttachableAgent[]
>("buzz/agents:attachable");

export const turnsFor = makeFunctionReference<
  "query",
  ScopeArgs & { channelId: string },
  RoomTurn[]
>("buzz/agents:turnsFor");

export const workingIn = makeFunctionReference<
  "query",
  ScopeArgs & { channelId: string },
  RoomWorking
>("buzz/agents:working");

/** `api.buzz.agents.attach` — the same membership call a person joining makes. */
export const attachAgent = makeFunctionReference<
  "mutation",
  ScopeArgs & { channelId: string; agentId: string },
  { attached: boolean; alreadyAttached: boolean; pubkey: string; role: string }
>("buzz/agents:attach");

export const detachAgent = makeFunctionReference<
  "mutation",
  ScopeArgs & { channelId: string; agentId: string },
  { detached: boolean; alreadyDetached: boolean }
>("buzz/agents:detach");
