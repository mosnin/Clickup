"use client";

// Where the moderation surfaces get their rows.
//
// Built with `makeFunctionReference` rather than read off `api.buzz.moderation`,
// for the reason the rest of the Chat tree states: the generated `api` type is
// a checked-in stub that only knows the modules present when it was last
// generated. Naming each function and its argument/return types here is the
// same contract, expressed once, and it goes back to `api.buzz.moderation.*`
// the moment the stub is regenerated.
//
// The row shapes come from `src/lib/buzz/moderation.ts` — the same file the
// server imports its vocabulary from — so the wire contract has one definition
// rather than one on each side.

import { makeFunctionReference } from "convex/server";
import type { ChatScope } from "@/lib/buzz/channel-types";
import type {
  CommunityRestriction,
  ModerationAction,
  ModerationReport,
} from "@/lib/buzz/moderation";

type ScopeArgs = { scopeType: ChatScope["scopeType"]; scopeId: string };

/** `api.buzz.moderation.report` — any member; nothing is published. */
export const submitReport = makeFunctionReference<
  "mutation",
  ScopeArgs & {
    targetKind: "event" | "pubkey" | "blob";
    target: string;
    reportType: string;
    note?: string;
  },
  { reportId: string; created: boolean }
>("buzz/moderation:report");

/** `api.buzz.moderation.queue` — moderators only; 403s everybody else. */
export const moderationQueue = makeFunctionReference<
  "query",
  ScopeArgs & { status?: string; limit?: number },
  { reports: ModerationReport[]; withheld: number }
>("buzz/moderation:queue");

/** `api.buzz.moderation.audit` — the append-only trail, gated like the queue. */
export const moderationAudit = makeFunctionReference<
  "query",
  ScopeArgs & { limit?: number },
  { entries: ModerationAction[]; withheld: number }
>("buzz/moderation:audit");

/** `api.buzz.moderation.restrictions` — who is currently banned or timed out. */
export const moderationRestrictions = makeFunctionReference<
  "query",
  ScopeArgs,
  CommunityRestriction[]
>("buzz/moderation:restrictions");

/** `api.buzz.moderation.resolveReport` — enforcement first, decision second. */
export const resolveReport = makeFunctionReference<
  "mutation",
  ScopeArgs & {
    reportId: string;
    action: string;
    reason?: string;
    privateReason?: string;
  },
  { status: string }
>("buzz/moderation:resolveReport");

export const banMember = makeFunctionReference<
  "mutation",
  ScopeArgs & { pubkey: string; expiresAt?: number; reason?: string },
  { banned: boolean }
>("buzz/moderation:ban");

export const unbanMember = makeFunctionReference<
  "mutation",
  ScopeArgs & { pubkey: string; reason?: string },
  { banned: boolean }
>("buzz/moderation:unban");

export const timeoutMember = makeFunctionReference<
  "mutation",
  ScopeArgs & { pubkey: string; expiresAt: number; reason?: string },
  { until: number }
>("buzz/moderation:timeout");

export const untimeoutMember = makeFunctionReference<
  "mutation",
  ScopeArgs & { pubkey: string },
  { until: null }
>("buzz/moderation:untimeout");

/**
 * The server's own sentence, or a last resort.
 *
 * Moderation refusals are the ones a person most needs to read verbatim —
 * "An admin cannot restrict another admin" is the whole answer, and a generic
 * "something went wrong" turns a clear rule into a bug report.
 */
export function reasonOf(error: unknown): string {
  const data = (error as { data?: unknown })?.data;
  if (typeof data === "string" && data.length > 0) return data;
  return error instanceof Error ? error.message : "That did not work";
}
