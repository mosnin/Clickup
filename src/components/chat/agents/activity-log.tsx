"use client";

// The activity transcript: what the agent actually did, in the room, while you
// waited.
//
// The rule this surface exists to enforce is negative: **a turn that fires
// forty tool calls must not draw forty rows.** Not because forty rows are ugly
// — because they are forty rows of a conversation's screen, and the room stops
// being a room. So the fold in `activity.ts` runs first and this file draws
// what came out of it, which is between three and eight rows for almost any
// turn, each of which opens.
//
// Two things are deliberately never folded away, and they are the reason a
// summary is trustworthy enough to leave closed: a **failed** step and a
// **permission** prompt always stand alone. Those are the rows a person is
// scanning for, so a burst that could swallow one would be a burst nobody could
// afford to leave collapsed — and an affordance you cannot afford to trust is
// an affordance you open every time, which is forty rows again with extra
// clicks.
//
// Everything is computed from the steps handed in. There is no second fetch, no
// stored summary and no sentence written by a model: an explanation that can
// disagree with the rows beneath it is worse than none, because people believe
// it. And when no steps arrive, the log says so rather than drawing a skeleton
// — a skeleton is a promise that rows are coming, and for a runtime that
// reports none they never are.

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnimatePresence, motion } from "@/components/motion";
import {
  buildTurnActivity,
  RENDER_CLASS_LABEL,
  type ActivitySegment,
  type ActivityTone,
  type ChatTurnStep,
  type ClassifiedStep,
} from "./activity";
import { formatTurnElapsed, turnLiveness, type ChatTurn } from "./turn";
import { TurnElapsed } from "./working-signal";

/** The tone marks. Ink and weight, no colour: meaning is carried by the word. */
const TONE_LABEL: Record<ActivityTone, string> = {
  read: "read",
  write: "wrote",
  admin: "changed access",
  neutral: "",
};

export function AgentActivityLog({
  turn,
  steps,
  now,
  className,
}: {
  turn: ChatTurn;
  /**
   * The runtime's account of its own work.
   *
   * A prop, and today nobody in Chat passes one. The turn record deliberately
   * carries a sentence rather than a transcript (`convex/buzz/_tables.ts` says
   * why: a turn is about a conversation, a run is about work), so a step stream
   * has to come from whichever runtime is reporting one. The fold is complete
   * and tested; until something supplies steps this draws the honest empty
   * state, because a plausible one would be believed.
   */
  steps?: readonly ChatTurnStep[];
  now: number;
  className?: string;
}) {
  const runs = buildTurnActivity(steps);
  const liveness = turnLiveness(turn, now);
  const live = liveness === "working";
  const name = turn.agentName ?? "An agent";
  const multiSession = runs.length > 1;

  return (
    <section
      data-agent-activity={turn.turnId}
      data-liveness={liveness}
      aria-label={`${name}: activity`}
      className={cn("flex min-w-0 flex-col gap-2", className)}
    >
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="text-mini font-semibold">{name}</h3>
        <span className="chat-quiet text-tiny uppercase tracking-wide">
          {/* The liveness ladder's own word, not a boolean. "stalled" is the
              one a person most needs — an agent that stopped reporting is not
              an agent that finished, and drawing them the same way is how a
              crashed harness reads as a silent decision not to answer. */}
          {liveness === "ended" ? turn.state : liveness}
        </span>
        <span className="min-w-0 flex-1" />
        <TurnElapsed since={turn.startedAt} now={live ? now : turn.lastActivityAt} />
      </header>

      {turn.narration ? (
        <p className="chat-quiet text-xs leading-relaxed">{turn.narration}</p>
      ) : null}

      {turn.error ? (
        <p className="text-xs font-medium text-destructive">{turn.error}</p>
      ) : null}

      {runs.length === 0 || runs.every((run) => run.segments.length === 0) ? (
        <p className="chat-quiet text-xs">
          {/* The honest reading of an empty stream, and it is not a skeleton: a
              skeleton is a promise that rows are coming, and for a runtime that
              reports no steps they never are. A turn without steps is not a
              broken turn — the room already has what the agent said. */}
          {live
            ? "No steps reported yet."
            : "This turn reported no steps."}
        </p>
      ) : (
        <ol className="flex min-w-0 flex-col gap-px">
          {runs.map((run) => (
            <li key={run.key} className="contents">
              {multiSession ? (
                <div className="flex items-center gap-2 pb-1 pt-2">
                  <span className="chat-quiet text-micro uppercase tracking-wide">
                    {run.sessionId === "unknown" ? "Session" : `Session ${short(run.sessionId)}`}
                  </span>
                  <span className="h-px min-w-0 flex-1 bg-[var(--chat-hairline)]" />
                </div>
              ) : null}
              {run.segments.map((segment) => (
                <SegmentRow key={segment.id} segment={segment} now={now} />
              ))}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function short(sessionId: string): string {
  return sessionId.length <= 10 ? sessionId : `${sessionId.slice(0, 6)}…`;
}

function SegmentRow({ segment, now }: { segment: ActivitySegment; now: number }) {
  if (segment.kind === "step") return <StepRow item={segment.item} now={now} />;
  return <SummaryRow segment={segment} now={now} />;
}

/**
 * A fold, closed by default.
 *
 * Closed is the correct default and it is not a space saving: the summary is
 * the answer at the altitude a person reading a conversation is standing at,
 * and the rows underneath are the answer at the altitude of somebody debugging
 * a runtime. Opening is cheap; being handed the second altitude unasked is what
 * makes an activity feed unreadable.
 */
function SummaryRow({
  segment,
  now,
}: {
  segment: Extract<ActivitySegment, { kind: "summary" }>;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const tone = TONE_LABEL[segment.tone];

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        data-activity-summary={segment.variant}
        className="tap-target flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs transition-colors hover:bg-[var(--chat-hover)]"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "chat-quiet size-3 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 truncate font-medium">{segment.label}</span>
        {tone ? (
          <span className="chat-quiet shrink-0 text-micro uppercase tracking-wide">
            {tone}
          </span>
        ) : null}
      </button>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.ol
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden pl-4"
          >
            {segment.children.map((child) => (
              <li key={child.id} className="min-w-0">
                <StepRow item={child} now={now} />
              </li>
            ))}
          </motion.ol>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** One leaf. The label, what it acted on, and how long it took. */
function StepRow({ item, now }: { item: ClassifiedStep; now: number }) {
  const failed = item.descriptor.renderClass === "error";
  const running = item.step.status === "running";
  const finished = item.step.finishedAt;

  return (
    <div
      data-activity-step={item.step.key}
      data-render-class={item.descriptor.renderClass}
      className="flex min-w-0 items-baseline gap-1.5 px-1 py-0.5 text-xs"
    >
      <span
        className={cn(
          "shrink-0 truncate",
          failed ? "font-medium text-destructive" : "font-medium",
        )}
        title={RENDER_CLASS_LABEL[item.descriptor.renderClass]}
      >
        {item.label}
      </span>
      {item.descriptor.preview ? (
        <span className="chat-quiet min-w-0 flex-1 truncate" title={item.descriptor.preview}>
          {item.descriptor.preview}
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      <span className="chat-quiet shrink-0 tabular-nums text-micro">
        {running
          ? formatTurnElapsed(Math.max(0, now - item.step.startedAt))
          : finished
            ? formatTurnElapsed(Math.max(0, finished - item.step.startedAt))
            : ""}
      </span>
    </div>
  );
}
