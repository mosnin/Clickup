"use client";

// Where Pulse gets its events.
//
// The same two constraints `shell/channel-data.tsx` names, for the same
// reasons, so this file follows it rather than inventing a second shape:
//
//  1. References are built with `makeFunctionReference` rather than read off
//     `api.buzz.pulse`. The generated `api` type is a checked-in stub that only
//     knows the modules present when it was last generated, so `api.buzz.*`
//     does not typecheck until somebody runs `npx convex dev`. Naming the
//     function and its argument/return types here is the same contract,
//     expressed once.
//  2. A query against a function that is not deployed yet **throws during
//     render**. So the subscription is isolated behind a boundary and its
//     failure becomes a sentence on the screen. "Pulse could not load" is a
//     state this application will be in again; it should not be a white page.
//
// There is no sample-data fallback, deliberately. A feed showing notes that do
// not exist is a feed nobody trusts once they have clicked one.

import { Component, useMemo, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { ChatScope } from "@/lib/buzz/channel-types";
import {
  PULSE_PAGE_LIMIT,
  pulseAudience,
  projectPulse,
  toPulseNote,
  type PulseAudience,
  type PulseFeed,
  type PulseTab,
} from "@/lib/buzz/pulse";

/** The wire shape of a signed event. Mirrors `convex/buzz/_nostr.ts`. */
export type PulseEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

export type PulseAuthor = { pubkey: string; name: string; isAgent: boolean };

export type PulseFeedResult = {
  viewerPubkey: string;
  notes: PulseEvent[];
  reactions: PulseEvent[];
  contactPubkeys: string[];
  agentPubkeys: string[];
  likedNoteIds: string[];
  agentCount: number;
  authors: PulseAuthor[];
};

/** `api.buzz.pulse.feed` — one window of events per tab. */
export const pulseFeedQuery = makeFunctionReference<
  "query",
  { scopeType: ChatScope["scopeType"]; scopeId: string; tab: string; limit?: number },
  PulseFeedResult
>("buzz/pulse:feed");

/** `api.buzz.pulse.post`. */
export const pulsePost = makeFunctionReference<
  "mutation",
  { scopeType: ChatScope["scopeType"]; scopeId: string; body: string },
  { eventId: string }
>("buzz/pulse:post");

/** `api.buzz.pulse.upvote` — a toggle, idempotent in both directions. */
export const pulseUpvote = makeFunctionReference<
  "mutation",
  { scopeType: ChatScope["scopeType"]; scopeId: string; noteId: string; on: boolean },
  { reacted: boolean; changed: boolean }
>("buzz/pulse:upvote");

export type PulseState = {
  /** `undefined` while loading — the state that draws skeletons. */
  raw: PulseFeedResult | undefined;
  /** The fold. `undefined` while loading, for the same reason. */
  feed: PulseFeed | undefined;
  audience: PulseAudience;
  names: Map<string, PulseAuthor>;
};

/**
 * Subscribe, then fold — and the fold is `projectPulse`, not something written
 * here.
 *
 * The server hands over raw signed events on purpose (the same rule
 * `messages.list` follows): the derivation is a pure function over an array, so
 * it can be tested without a database and re-run on every live event without a
 * round trip.
 */
export function usePulse(scope: ChatScope | null, tab: PulseTab): PulseState {
  const raw = useQuery(
    pulseFeedQuery,
    scope
      ? {
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          tab,
          limit: PULSE_PAGE_LIMIT,
        }
      : "skip",
  );

  return useMemo(() => {
    const audience = pulseAudience({
      viewerPubkey: raw?.viewerPubkey ?? "",
      contactPubkeys: raw?.contactPubkeys ?? [],
      agentPubkeys: raw?.agentPubkeys ?? [],
      likedNoteIds: raw?.likedNoteIds ?? [],
    });
    const names = new Map((raw?.authors ?? []).map((author) => [author.pubkey, author]));
    if (!raw) return { raw, feed: undefined, audience, names };
    return {
      raw,
      feed: projectPulse(
        tab,
        raw.notes.map(toPulseNote),
        raw.reactions.map(toPulseNote),
        audience,
      ),
      audience,
      names,
    };
  }, [raw, tab]);
}

/**
 * The boundary that turns "the function is not deployed" into a sentence.
 *
 * Wrapped around the screen rather than around the whole shell: the sidebar and
 * the rail keep working when Pulse cannot load, which is the difference between
 * a degraded surface and no application.
 */
export class PulseBoundary extends Component<
  { children: ReactNode; fallback: (message: string) => ReactNode },
  { message: string | null }
> {
  state: { message: string | null } = { message: null };

  static getDerivedStateFromError(error: unknown) {
    return {
      message: error instanceof Error ? error.message : "Pulse could not be loaded",
    };
  }

  render() {
    return this.state.message === null
      ? this.props.children
      : this.props.fallback(this.state.message);
  }
}
