"use client";

// Where search gets its results — spec 01 §6.2.
//
// Two shapes copied from `transcript/messages-data.tsx`, because the problem is
// the same one and the fixes should not be two different fixes:
//
//  1. **The reference is built by hand** with `makeFunctionReference` rather
//     than read off `api.buzz.search`. The generated `api` object is a
//     checked-in stub that only knows the modules present when it was last
//     generated, so `api.buzz.*` does not typecheck until somebody runs
//     `npx convex dev`. Naming the function and its argument and return types
//     here is the same contract, expressed in the one file that has to know it.
//  2. **A query against a function that is not deployed throws during render**,
//     so the subscription lives inside a boundary and its failure becomes a
//     sentence in the results list rather than a white screen over the whole
//     application.
//
// The debounce and the two thresholds are here rather than in the dialog, so a
// second search surface (the in-channel find bar) gets the same timing without
// restating it. §6.2's rule holds: there is one length floor, and it lives in
// `src/lib/buzz/search-query.ts` beside the grammar that measures it.

import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { ChatScope } from "@/lib/buzz/channel-types";
import {
  SEARCH_DEBOUNCE_MS,
  buildSearchRequest,
  parseSearchQuery,
  searchTextIsQueryable,
  unresolvedOperator,
  type ParsedSearchQuery,
  type ResolvableAuthor,
  type ResolvableChannel,
} from "@/lib/buzz/search-query";

type ScopeArgs = { scopeType: ChatScope["scopeType"]; scopeId: string };

/** Mirrors `SearchHit` in `convex/buzz/search.ts`. */
export type SearchHit = {
  eventId: string;
  kind: number;
  pubkey: string;
  content: string;
  channelId: string;
  channelName: string;
  channelDisplayName: string;
  createdAt: number;
  threadRootId?: string;
  authorName: string;
  authorIsAgent: boolean;
};

export type SearchResponse = {
  hits: SearchHit[];
  found: number;
  truncated: boolean;
};

/** `api.buzz.search.messages`. */
export const searchMessages = makeFunctionReference<
  "query",
  ScopeArgs & {
    text: string;
    channelIds?: string[];
    authors?: string[];
    since?: number;
    until?: number;
    limit?: number;
  },
  SearchResponse
>("buzz/search:messages");

/**
 * A debounced value.
 *
 * §6.2's 300 ms, with the documented bypass: falling *below* the threshold
 * clears immediately rather than after a delay, so backspacing out of a search
 * empties the list at once instead of leaving stale results under an empty box
 * for a third of a second — which reads as the results being wrong.
 */
function useDebounced(value: string, delayMs: number, bypass: boolean): string {
  const [settled, setSettled] = useState(bypass ? "" : value);
  useEffect(() => {
    if (bypass) {
      setSettled("");
      return;
    }
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs, bypass]);
  return settled;
}

export type SearchState = {
  /** The live parse of what is in the box, before the debounce. */
  parsed: ParsedSearchQuery;
  /** `undefined` while a query is in flight or none is running. */
  response: SearchResponse | undefined;
  /** True while the debounce or the query has not settled. */
  pending: boolean;
  /**
   * Which operator named something that could not be resolved (§6.2, rule 93),
   * or null. No query runs when this is set, and the surface says *which*
   * operator rather than showing an empty list that looks like an answer.
   */
  unresolved: "in" | "from" | null;
  error: string | null;
  /** Must be rendered by the caller — this is where the subscription lives. */
  subscription: ReactNode;
};

/**
 * Run a search.
 *
 * `channels` is the caller's already-access-filtered room list, and `authors`
 * the people it knows about; both are what `in:` and `from:` resolve against.
 * Handing them in rather than querying for them here keeps this hook usable from
 * the in-channel find bar, which has one room and no directory at all.
 */
export function useSearch(
  scope: ChatScope | null,
  raw: string,
  directory: {
    channels: readonly ResolvableChannel[];
    authors: readonly ResolvableAuthor[];
  },
  options: { limit?: number; channelId?: string } = {},
): SearchState {
  const parsed = useMemo(() => parseSearchQuery(raw), [raw]);
  const queryable = searchTextIsQueryable(parsed);
  const debouncedText = useDebounced(parsed.text, SEARCH_DEBOUNCE_MS, !queryable);

  const request = useMemo(() => {
    if (!queryable || debouncedText.length === 0) return null;
    const built = buildSearchRequest(parsed, directory);
    if (!built) return null;
    // An explicit room (the find bar) wins over anything `in:` resolved to: the
    // bar is scoped by where you are standing, and a person typing `in:other`
    // inside it is asking a question the bar cannot answer.
    return options.channelId ? { ...built, channelIds: [options.channelId] } : built;
    // `directory` is a fresh object most renders; the parse and the debounced
    // text are what actually change the question being asked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, queryable, debouncedText, options.channelId, directory.channels, directory.authors]);

  const unresolved =
    queryable && debouncedText.length > 0 && request === null
      ? unresolvedOperator(parsed, directory)
      : null;

  const [response, setResponse] = useState<SearchResponse | undefined>();
  const [error, setError] = useState<string | null>(null);

  // A new question means the previous answer is not an answer. Cleared during
  // render rather than in an effect, because a frame of the last search's hits
  // under a new query is indistinguishable from a wrong result.
  const key = request
    ? JSON.stringify({ scope, request, limit: options.limit })
    : "none";
  const lastKey = useRef(key);
  if (lastKey.current !== key) {
    lastKey.current = key;
    setResponse(undefined);
    setError(null);
  }

  const subscription = (
    <SearchBoundary key={key} onError={setError}>
      <SearchSubscription
        scope={scope}
        request={request}
        limit={options.limit}
        onResult={setResponse}
        onOk={() => setError(null)}
      />
    </SearchBoundary>
  );

  return {
    parsed,
    response,
    pending:
      queryable &&
      unresolved === null &&
      (debouncedText !== parsed.text || (request !== null && response === undefined)),
    unresolved,
    error,
    subscription,
  };
}

function SearchSubscription({
  scope,
  request,
  limit,
  onResult,
  onOk,
}: {
  scope: ChatScope | null;
  request: {
    text: string;
    channelIds?: string[];
    authors?: string[];
    since?: number;
    until?: number;
  } | null;
  limit?: number;
  onResult: (response: SearchResponse) => void;
  onOk: () => void;
}) {
  const result = useQuery(
    searchMessages,
    scope && request
      ? {
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          ...request,
          ...(limit !== undefined ? { limit } : {}),
        }
      : "skip",
  );
  const last = useRef<SearchResponse | undefined>(undefined);
  useEffect(() => {
    if (result === undefined || last.current === result) return;
    last.current = result;
    onResult(result);
    onOk();
  }, [result, onResult, onOk]);
  return null;
}

class SearchBoundary extends Component<
  { children: ReactNode; onError: (message: string) => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // The reason, not a generic apology: "Could not find public function
    // buzz/search:messages" is the sentence that tells whoever is looking
    // exactly what is missing.
    this.props.onError(
      error instanceof Error ? error.message : "Search is unavailable",
    );
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
