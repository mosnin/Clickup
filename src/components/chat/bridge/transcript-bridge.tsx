"use client";

// One subscription for every Work object a screenful of messages names.
//
// The alternative — a query per chip — is the version that reads fine in a
// three-message room and opens forty subscriptions in a real one. So the
// transcript collects the ids it can see, asks once, and puts the answers in
// context for the rows to read.
//
// Two queries rather than one, and the split is on purpose: tasks are asked for
// by id and come back as **cards** (status, assignee, due) because a task is
// the thing people actually track in a conversation, while every other kind
// only needs a name and a link. Folding them together would mean one wire shape
// carrying five optional fields that are meaningful for one kind.
//
// The id list is derived from the bodies on screen, so it shrinks as the reader
// scrolls away and nothing is subscribed to for a room they have left.

import { useMemo, type ReactNode } from "react";
import type { ChatScope } from "@/lib/buzz/channel-types";
import { parseBridgeBody, taskIdsIn, type TaskCard } from "@/lib/buzz/bridge";
import { BridgeRefsProvider } from "./bridge-body";
import { useResolvedRefs, useTaskCards } from "./bridge-data";

export function TranscriptBridge({
  scope,
  bodies,
  children,
}: {
  scope: ChatScope | null;
  bodies: readonly string[];
  children: ReactNode;
}) {
  const taskIds = useMemo(() => taskIdsIn(bodies), [bodies]);
  const otherRefs = useMemo(() => {
    const seen = new Map<string, { kind: string; id: string; label: string }>();
    for (const body of bodies) {
      for (const part of parseBridgeBody(body)) {
        if (part.kind !== "ref" || part.refKind === "task") continue;
        const key = `${part.refKind}:${part.id}`;
        if (seen.has(key)) continue;
        seen.set(key, { kind: part.refKind, id: part.id, label: part.label });
      }
    }
    return [...seen.values()];
  }, [bodies]);

  const { cards, subscription: cardsSubscription } = useTaskCards(taskIds);
  const { refs, resolved, subscription: refsSubscription } = useResolvedRefs(
    scope,
    otherRefs,
  );

  const emptyTasks = useMemo(() => new Map<string, TaskCard>(), []);

  return (
    <>
      {cardsSubscription}
      {refsSubscription}
      <BridgeRefsProvider
        tasks={taskIds.length === 0 ? emptyTasks : cards}
        others={refs}
        resolved={resolved}
      >
        {children}
      </BridgeRefsProvider>
    </>
  );
}
