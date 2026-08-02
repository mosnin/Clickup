"use client";

// ⌘K, across both dashboards.
//
// The palette already searched lists, pages, boards, agents and task titles.
// What it could not reach was everything anybody had *said* — which, in a
// product where half the work happens in rooms, is most of the record.
//
// This is a hook rather than a block of code inside `command-palette.tsx`
// because the palette is a Work-side file and the rule for editing one is a
// diff you can describe in a sentence. It is also why the results come back
// already shaped as palette items: the caller spreads them into its list and
// knows nothing about Chat.
//
// **One search, three sources, three separate gates.** `buzz/bridge:search`
// asks Chat's own `searchMessagesCore` (which owns the searchable-kind
// allowlist and every per-event read gate) and Work's tasks and pages through
// `_authz` — rather than building a combined index, which would be a fourth
// store holding a fourth copy of every visibility rule. Search is the worst
// possible place for a missing clause: an index answers instantly and
// confidently, and nothing in a result row says which gate it skipped.
//
// Scoped to one community at a time, deliberately. A cross-community search is
// a read that skips the tenancy fence by construction, so the palette asks
// about the workspace whose page the reader is standing on.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { ChatScope } from "@/lib/buzz/channel-types";
import { unifiedSearchQuery } from "./bridge-data";
import { MessagesBoundary } from "@/components/chat/transcript/messages-data";

export type ChatPaletteHit = {
  kind: "message" | "task" | "page" | "room";
  id: string;
  label: string;
  context: string;
  href: string;
};

/**
 * Chat results for a query string, across every community the reader is in.
 *
 * "Every community" is a small number — the same list the Chat rail's own
 * switcher draws — and each one is asked through its own scoped query, so the
 * tenancy fence is one call per tenant rather than one query that has to
 * remember to filter.
 */
export function useChatPaletteHits(
  query: string,
  enabled: boolean,
): { hits: ChatPaletteHit[]; subscriptions: ReactNode } {
  const text = query.trim();
  const active = enabled && text.length >= 2;
  const scopes = useQuery(api.chat.scopesForCurrentUser, active ? {} : "skip");
  const [byScope, setByScope] = useState<Record<string, ChatPaletteHit[]>>({});
  const [, setError] = useState<string | null>(null);

  const list = useMemo(
    () => (scopes ?? []).slice(0, 6) as ChatScope[],
    [scopes],
  );

  const subscriptions = active ? (
    <MessagesBoundary key={text} onError={setError}>
      {list.map((scope) => (
        <ScopeSearch
          key={`${scope.scopeType}:${scope.scopeId}`}
          scope={scope}
          text={text}
          onResult={(hits) =>
            setByScope((prev) => ({
              ...prev,
              [`${scope.scopeType}:${scope.scopeId}`]: hits,
            }))
          }
        />
      ))}
    </MessagesBoundary>
  ) : null;

  const hits = useMemo(() => {
    if (!active) return [];
    const seen = new Set<string>();
    const out: ChatPaletteHit[] = [];
    for (const rows of Object.values(byScope)) {
      for (const row of rows) {
        const key = `${row.kind}:${row.id}`;
        // The same task can come back from Chat's unified search and from the
        // palette's own `tasks.quickSearch`. Deduping here rather than trusting
        // the two to be disjoint: one row per thing is the whole reason the
        // palette is readable.
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(row);
      }
    }
    return out;
  }, [byScope, active]);

  return { hits, subscriptions };
}

function ScopeSearch({
  scope,
  text,
  onResult,
}: {
  scope: ChatScope;
  text: string;
  onResult: (hits: ChatPaletteHit[]) => void;
}) {
  const result = useQuery(unifiedSearchQuery, {
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    text,
  }) as ChatPaletteHit[] | undefined;
  // A ref rather than a dependency on `onResult`: the caller builds a fresh
  // closure every render, so keying the effect on it would re-run per render
  // and write state in a loop.
  const last = useRef<ChatPaletteHit[] | undefined>(undefined);
  useEffect(() => {
    if (!result || last.current === result) return;
    last.current = result;
    onResult(result);
  }, [result, onResult]);
  return null;
}
