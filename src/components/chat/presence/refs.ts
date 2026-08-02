// The Convex functions this folder calls, named by hand.
//
// Same treatment as `shell/channel-data.tsx` and `composer/message-composer.tsx`,
// and for the same reason: `convex/_generated/api.d.ts` is a checked-in stub
// that predates `convex/buzz/*`, so `api.buzz.presence` does not typecheck
// until somebody runs `npx convex dev`. `makeFunctionReference` resolves the
// identical path at runtime and keeps real argument types at the call sites,
// which is the part that would actually cost something to lose.
//
// **Delete this file and import `api.buzz.presence.*` the first time the CLI
// regenerates the stub.** A hand-written signature that outlives its generated
// twin is a signature that will eventually describe a function that no longer
// looks like that.

import { makeFunctionReference } from "convex/server";
import type { ChatScope } from "@/lib/buzz/channel-types";

export type ScopeArgs = { scopeType: "user" | "workspace"; scopeId: string };

export function scopeArgs(scope: ChatScope): ScopeArgs {
  return { scopeType: scope.scopeType, scopeId: scope.scopeId };
}

/** One person or agent, as the roster reports them. */
export type RosterEntry = {
  actorId: string;
  actorType: "user" | "agent";
  name: string;
  pubkey: string | null;
  status: "online" | "away" | "offline";
  lastSeenAt: number | null;
  statusText: string | null;
  statusEmoji: string | null;
  statusExpiresAt: number | null;
};

export type RosterSeed = { actorId: string; actorType: "user" | "agent" };

export const rosterRef = makeFunctionReference<
  "query",
  ScopeArgs & { seed?: RosterSeed[] },
  RosterEntry[] | null
>("buzz/presence:roster");

export const myStatusRef = makeFunctionReference<
  "query",
  ScopeArgs,
  { text: string; emoji: string; expiresAt: number | null } | null
>("buzz/presence:myStatus");

export const myPubkeyRef = makeFunctionReference<
  "query",
  Record<string, never>,
  { pubkey: string | null } | null
>("buzz/identity:myPubkey");

export const heartbeatRef = makeFunctionReference<
  "mutation",
  ScopeArgs & { state: "online" | "away" },
  { ok: true }
>("buzz/presence:heartbeat");

export const leaveRef = makeFunctionReference<"mutation", ScopeArgs, { ok: true }>(
  "buzz/presence:leave",
);

export const setStatusRef = makeFunctionReference<
  "mutation",
  ScopeArgs & { text: string; emoji: string; expiresAt?: number },
  { eventId: string }
>("buzz/presence:setStatus");

export const clearStatusRef = makeFunctionReference<"mutation", ScopeArgs, { eventId: string }>(
  "buzz/presence:clearStatus",
);

export const roomTokenRef = makeFunctionReference<
  "action",
  ScopeArgs & { channelId: string },
  { token: string; channel: string; expiresAt: number } | null
>("buzz/presence:roomToken");

export const signalRef = makeFunctionReference<
  "action",
  ScopeArgs & {
    channelId: string;
    kind: "typing" | "here";
    threadHeadId?: string;
    pubkey: string;
    name: string;
    isAgent?: boolean;
  },
  null
>("buzz/presence:signal");
