// The Convex functions this folder calls, named by hand.
//
// Same treatment as `presence/refs.ts` and `agents/refs.ts`, for the same
// reason: `convex/_generated/api.d.ts` is a checked-in stub that predates
// `convex/buzz/*`, so `api.buzz.huddle` does not typecheck until somebody runs
// `npx convex dev`. `makeFunctionReference` resolves the identical path at
// runtime and keeps real argument types at the call sites.
//
// **Delete this file and import `api.buzz.huddle.*` the first time the CLI
// regenerates the stub.**
//
// The row shapes come from `@/lib/buzz/huddle`, which is deliberate and is the
// opposite of what `agents/refs.ts` had to do: a `HuddleSnapshot` holds no
// branded `Id<…>`, because a huddle is identified by an event id and a
// participant by a pubkey — both plain strings on both sides of the wire. So
// there is one definition of the shape, shared, and a fixture in a test is the
// same object the server returns.

import { makeFunctionReference } from "convex/server";
import type { ChatScope } from "@/lib/buzz/channel-types";
import type { HuddleSnapshot } from "@/lib/buzz/huddle";

export type ScopeArgs = { scopeType: ChatScope["scopeType"]; scopeId: string };

export function scopeArgs(scope: ChatScope): ScopeArgs {
  return { scopeType: scope.scopeType, scopeId: scope.scopeId };
}

export type HuddleRosterName = { name: string; isAgent: boolean };

export type HuddleView = {
  huddles: HuddleSnapshot[];
  names: Record<string, HuddleRosterName>;
  viewerPubkey: string | null;
};

export const huddlesForChannelRef = makeFunctionReference<
  "query",
  ScopeArgs & { channelId: string },
  HuddleView | null
>("buzz/huddle:forChannel");

export const startHuddleRef = makeFunctionReference<
  "mutation",
  ScopeArgs & { channelId: string; agentIds?: string[] },
  {
    huddleId: string;
    created: boolean;
    agentsInvited: string[];
    agentErrors: { agentId: string; error: string }[];
  }
>("buzz/huddle:start");

export const joinHuddleRef = makeFunctionReference<
  "mutation",
  ScopeArgs & { channelId: string; huddleId: string },
  { huddleId: string; joined: boolean }
>("buzz/huddle:join");

export const leaveHuddleRef = makeFunctionReference<
  "mutation",
  ScopeArgs & { channelId: string; huddleId: string },
  { huddleId: string; left: boolean; ended: boolean }
>("buzz/huddle:leave");

export const endHuddleRef = makeFunctionReference<
  "mutation",
  ScopeArgs & { channelId: string; huddleId: string },
  { ended: boolean }
>("buzz/huddle:end");

export const addHuddleAgentRef = makeFunctionReference<
  "mutation",
  ScopeArgs & { channelId: string; huddleId: string; agentId: string },
  { huddleId: string; joined: boolean }
>("buzz/huddle:addAgent");

export const reactInHuddleRef = makeFunctionReference<
  "mutation",
  ScopeArgs & { channelId: string; huddleId: string; emoji: string },
  { delivered: boolean }
>("buzz/huddle:react");

export const huddleCaptionRef = makeFunctionReference<
  "action",
  ScopeArgs & {
    channelId: string;
    huddleId: string;
    pubkey: string;
    name: string;
    text: string;
    isAgent?: boolean;
  },
  null
>("buzz/huddle:caption");

/**
 * The agents that could be pulled into a call, and why some cannot.
 *
 * `buzz.agents.attachable` rather than a huddle-specific query, because it
 * already answers every part of the question — paused, keyless, restricted to
 * lists, already in the room, and the sentence explaining each. A second copy
 * here would be a second place for those reasons to stop being said.
 */
export type AttachableAgent = {
  agentId: string;
  name: string;
  attached: boolean;
  hasKey: boolean;
  pubkey: string | null;
  blockedReason: string | null;
  lastSeenAt?: number;
};

export const attachableAgentsRef = makeFunctionReference<
  "query",
  ScopeArgs & { channelId: string },
  AttachableAgent[] | null
>("buzz/agents:attachable");

/** The room's realtime token — the same one typing uses. See `presence/refs.ts`. */
export const roomTokenRef = makeFunctionReference<
  "action",
  ScopeArgs & { channelId: string },
  { token: string; channel: string; expiresAt: number } | null
>("buzz/presence:roomToken");
