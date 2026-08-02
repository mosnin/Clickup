"use client";

// "Why didn't I get notified about this?"
//
// The single most common support question a chat product generates, answered
// in the place the question is asked — on the message itself — rather than in a
// help article that cannot see your settings.
//
// It is only trustworthy because it is not an explanation: the server runs the
// *same* `decide()` the delivery path ran and reports which numbered rule
// decided, and the sentence is looked up from that rule. Nothing is narrated,
// nothing is stored, nothing was written by a model. An explanation that can
// disagree with the thing it explains is worse than none, because people
// believe it.
//
// Off until asked for. A transcript that annotates every message with why it
// did or did not ring is a transcript nobody can read.

import { useQuery } from "convex/react";
import { cn } from "@/lib/utils";
import type { ChatScope } from "@/lib/buzz/channel-types";
import { explainQuery } from "./refs";

export function NotifyExplainer({
  scope,
  channelId,
  eventId,
  className,
}: {
  scope: ChatScope;
  channelId: string;
  eventId: string;
  className?: string;
}) {
  const answer = useQuery(explainQuery, {
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    channelId,
    eventId,
  });

  if (answer === undefined) {
    return (
      <p className={cn("text-xs text-muted-foreground", className)}>Checking…</p>
    );
  }

  return (
    <div className={cn("space-y-1 text-xs", className)}>
      <p className="font-medium">
        {answer.deliver ? "This would have notified you." : "This did not notify you."}
      </p>
      <p className="text-muted-foreground">{answer.explanation}</p>
      {/*
        The rule number, shown rather than hidden. It is the difference between
        an answer somebody can act on and an answer they have to take on faith:
        "rule 8" is a thing they can look up, quote in a bug report, and check
        against what they thought they had configured.
      */}
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
        {answer.item !== null
          ? `Suppression ${answer.item} · ${answer.reason}`
          : `Delivered · ${answer.reason}`}
        {answer.predicateStep !== null ? ` · step ${answer.predicateStep}` : ""}
      </p>
      {/*
        The half the server genuinely cannot see. Saying so is better than
        quietly giving an answer that is right about the durable path and wrong
        about the one the person is asking about.
      */}
      <p className="text-[10px] text-muted-foreground/70">
        Your browser also decides: an alert is skipped for a conversation you
        already have open, for anything already shown this session, and while
        the first page of history loads.
      </p>
    </div>
  );
}
