"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { AnimatedList } from "@/components/ui/animated-list";
import { ActorGlyph } from "@/components/appearance/actor-glyph";
import { eventHref, eventLabel } from "@/lib/event-labels";
import { timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";

// What the machines are doing, as it happens.
//
// The activity feed answers "what happened here" over everything and everyone.
// This answers a different question — "are my agents working right now" — and
// the difference is worth its own surface, because the honest answer to the
// second one is usually a short list that changes while you watch it. Mixing
// it into the general feed buries it under your own edits.
//
// **It is a live card, so arriving has to read as arriving.** A row that
// appears with no motion is indistinguishable from a row that was always
// there, which is exactly the information the card exists to carry. Rows land
// at the top and push the rest down (`AnimatedList`), and the header's dot
// pulses for a moment when the newest row changes.
//
// **It shows agents only.** Filtering client-side rather than adding a query
// argument, because the feed is already capped and access-checked and a second
// index for "agent events" would be a table scan's worth of maintenance for a
// panel. If the filter ever needs to be cheaper, it belongs in `events.feed`.
//
// **Empty is a sentence, not a blank.** An agent-activity card with nothing in
// it on a new account looks broken; saying what would appear here is the whole
// difference between "nothing yet" and "this is not working".

type Scope = { scopeType: "user" | "workspace"; scopeId: string };

export function AgentStream({
  scope,
  limit = 8,
  className,
}: {
  scope?: Scope;
  /** How many rows are on screen. History is whatever the feed returns. */
  limit?: number;
  className?: string;
}) {
  const events = useQuery(api.events.feed, {
    scopeType: scope?.scopeType,
    scopeId: scope?.scopeId,
    limit: 60,
  });

  const rows = (events ?? [])
    .filter((e) => e.actorType === "agent")
    .map((e) => ({ ...e, id: e._id as string }));

  const live = useJustChanged(rows[0]?.id);

  if (events === undefined) {
    return (
      <div className={cn("space-y-2", className)}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-11 animate-pulse rounded-xl bg-muted/40" />
        ))}
      </div>
    );
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="mb-3 flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "h-1.5 w-1.5 rounded-full bg-muted-foreground/40 transition-all duration-300",
            live && "scale-150 bg-[var(--color-pastel-green)]",
          )}
        />
        <span className="text-tiny font-medium uppercase tracking-wider text-muted-foreground">
          Agents, live
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="text-mini leading-relaxed text-muted-foreground">
          Nothing from your agents yet. The moment one claims a task, comments,
          or finishes something, it lands here.
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <AnimatedList
            gap={6}
            items={rows}
            maxVisible={limit}
            renderItem={(e) => <Row event={e} />}
          />
        </div>
      )}
    </div>
  );
}

function Row({
  event,
}: {
  event: {
    type: string;
    entityType: string;
    entityId: string;
    entityTitle?: string;
    listId?: string;
    scopeType: "user" | "workspace";
    scopeId: string;
    actorName: string;
    actorId: string;
    createdAt: number;
  };
}) {
  const href = eventHref(event);
  const title = event.entityTitle ?? "an item";

  return (
    <div className="bento-tile flex items-center gap-2.5 rounded-xl px-2.5 py-2">
      <ActorGlyph isAgent name={event.actorName} seed={event.actorId} size="sm" />
      <span className="min-w-0 flex-1 truncate text-mini">
        <span className="font-medium">{event.actorName}</span>{" "}
        <span className="text-muted-foreground">{eventLabel(event.type)}</span>{" "}
        {href ? (
          <Link className="font-medium hover:underline" href={href}>
            {title}
          </Link>
        ) : (
          <span className="font-medium">{title}</span>
        )}
      </span>
      <span className="flex-shrink-0 text-tiny tabular-nums text-muted-foreground">
        {timeAgo(event.createdAt)}
      </span>
    </div>
  );
}

/**
 * True for a moment after `value` changes, false on first sight.
 *
 * First sight is excluded on purpose: a card that announces itself as live the
 * instant it mounts is announcing that it rendered, which is not news. It goes
 * off by itself so nothing has to remember to turn it off.
 */
function useJustChanged(value: string | undefined, ms = 1400): boolean {
  const [on, setOn] = useState(false);
  const seen = useRef<string | undefined>(undefined);
  const first = useRef(true);

  useEffect(() => {
    if (value === undefined || value === seen.current) return;
    const wasFirst = first.current;
    seen.current = value;
    first.current = false;
    if (wasFirst) return;
    setOn(true);
    const timer = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);

  return on;
}
