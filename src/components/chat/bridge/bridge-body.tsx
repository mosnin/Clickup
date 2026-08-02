"use client";

// A message body, in all three of the app's inline grammars.
//
// This is what `MessageRow` draws instead of its own mention-only renderer. It
// adds one thing: `#[Label](kind:id)` references, resolved live. Everything
// else is unchanged and imported rather than re-rolled — `parseBridgeBody` runs
// the app's one mention parser first and splits references out of the text
// parts only, so a `(` inside somebody's display name can never open a
// reference token.
//
// **React nodes, never `dangerouslySetInnerHTML`.** Bodies are written by
// agents that may have read a hostile document; a renderer with no HTML path
// has no sanitizer to keep correct. That was true of the mention renderer this
// replaces and it stays true here — the only new element types are a `<span>`
// and a `<Link>` whose href comes from the server's own resolver, never from
// the message.
//
// The chips get their data from context rather than from a query each: the
// transcript collects every task id on screen, subscribes once, and puts the
// answers here. Forty rows, one subscription.

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { parseBridgeBody, type TaskCard } from "@/lib/buzz/bridge";
import { RefChip, TaskChip, UnresolvedRef } from "./task-chip";
import type { ResolvedRef } from "./bridge-data";

type BridgeRefs = {
  tasks: Map<string, TaskCard>;
  others: Map<string, ResolvedRef>;
  /** False until the resolver has answered once — see below. */
  resolved: boolean;
};

const EMPTY: BridgeRefs = { tasks: new Map(), others: new Map(), resolved: false };

const BridgeRefsContext = createContext<BridgeRefs>(EMPTY);

/**
 * The answers, hoisted above every row that needs one.
 *
 * `resolved` exists so a chip can tell "the resolver said no" from "the
 * resolver has not spoken yet", and they render identically anyway — quiet,
 * unlinked, showing the author's label. The distinction is kept because the
 * temptation when they look the same is to drop it, and then a slow query
 * becomes indistinguishable from a permission refusal to whoever debugs it
 * next.
 */
export function BridgeRefsProvider({
  tasks,
  others,
  resolved,
  children,
}: {
  tasks: Map<string, TaskCard>;
  others?: Map<string, ResolvedRef>;
  resolved?: boolean;
  children: ReactNode;
}) {
  const value = useMemo<BridgeRefs>(
    () => ({
      tasks,
      others: others ?? new Map(),
      resolved: resolved ?? false,
    }),
    [tasks, others, resolved],
  );
  return (
    <BridgeRefsContext.Provider value={value}>
      {children}
    </BridgeRefsContext.Provider>
  );
}

export function useBridgeRefs(): BridgeRefs {
  return useContext(BridgeRefsContext);
}

export function BridgeBody({ body }: { body: string }) {
  const { tasks, others } = useBridgeRefs();
  const parts = useMemo(() => parseBridgeBody(body), [body]);

  return (
    <>
      {parts.map((part, index) => {
        if (part.kind === "text") return <span key={index}>{part.text}</span>;
        if (part.kind === "mention") {
          return (
            <span
              key={index}
              data-mention={part.actorId}
              className="rounded bg-[var(--chat-hover)] px-1 font-medium"
            >
              @{part.name}
            </span>
          );
        }
        if (part.refKind === "task") {
          return (
            <TaskChip
              key={index}
              id={part.id}
              label={part.label}
              card={tasks.get(part.id)}
            />
          );
        }
        const resolved = others.get(`${part.refKind}:${part.id}`);
        if (!resolved) return <UnresolvedRef key={index} label={part.label} />;
        return <RefChip key={index} ref={resolved} />;
      })}
    </>
  );
}
