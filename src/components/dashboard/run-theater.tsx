"use client";

import { useQuery } from "convex/react";
import { AnimatePresence, motion } from "motion/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { EASE, SPRING } from "@/components/motion";
import { LiveNumber } from "@/components/dashboard/live-number";
import { timeAgo } from "@/lib/time";
import { TextShimmer } from "@/components/beui/text-shimmer";
import { cn } from "@/lib/utils";

// The run, unfolding.
//
// Before this, an agent's run was two bookends — started, finished — and the
// person waiting stared at a pulsing dot for the whole middle. This renders
// the middle: chapters materializing into a checklist as the agent declares
// them, its current sentence, and a row of live numbers that resolve as they
// move. The AG-UI idea, on this stack's one transport — the run document is a
// Convex subscription, so every event the agent emits repaints this without a
// socket of its own.
//
// Absent when nothing is live. A theater with no performance is not a panel
// with an empty state; it is nothing.

export function RunTheater({ taskId }: { taskId: Id<"tasks"> }) {
  const run = useQuery(api.agents.liveRunForTask, { taskId });

  return (
    <AnimatePresence initial={false}>
      {run && (
        <motion.section
          key={run.runId}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.35, ease: EASE }}
          aria-label={`${run.agentName} is working on this now`}
          className="bento-tile rounded-2xl p-4"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="min-w-0 text-sm">
              <span className="font-medium">{run.agentName}</span>{" "}
              <span className="text-muted-foreground">
                is working: {run.title}
              </span>
            </p>
            <span className="text-tiny text-muted-foreground">
              started {timeAgo(run.startedAt)}
            </span>
          </div>

          {/* The current sentence. Replaced in place, never a transcript —
              a person glances at this, they don't read it. */}
          <AnimatePresence mode="wait" initial={false}>
            {run.lastNarration && (
              <motion.p
                key={run.lastNarration}
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                transition={{ duration: 0.2, ease: EASE }}
                aria-live="polite"
                className="mt-1.5 text-xs italic"
              >
                {/* The beui thinking shimmer: light travels along the words
                    while the agent works, so "live" is visible in the line
                    itself rather than asserted by a dot next to it. */}
                <TextShimmer duration={2.2}>{run.lastNarration}</TextShimmer>
              </motion.p>
            )}
          </AnimatePresence>

          {run.steps.length > 0 && (
            <ol className="mt-3 space-y-1.5">
              <AnimatePresence initial={false}>
                {run.steps.map((step) => (
                  <motion.li
                    key={step.key}
                    layout
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={SPRING}
                    className="flex items-start gap-2 text-xs"
                  >
                    <StepMark status={step.status} />
                    <span
                      className={cn(
                        "min-w-0",
                        step.status === "done" && "text-muted-foreground",
                        step.status === "failed" && "text-foreground",
                      )}
                    >
                      {step.title}
                      {step.detail && (
                        <span className="text-muted-foreground">
                          {" "}
                          — {step.detail}
                        </span>
                      )}
                    </span>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ol>
          )}

          {run.liveState && Object.keys(run.liveState).length > 0 && (
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
              {Object.entries(run.liveState)
                .slice(0, 8)
                .map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <span className="block text-micro uppercase tracking-wider text-muted-foreground">
                      {label}
                    </span>
                    <span className="text-sm tabular-nums">
                      {typeof value === "number" ? (
                        // The digits resolve when the value moves — the point
                        // of a live number is noticing it changed.
                        <LiveNumber value={value} />
                      ) : (
                        String(value)
                      )}
                    </span>
                  </div>
                ))}
            </div>
          )}
        </motion.section>
      )}
    </AnimatePresence>
  );
}

function StepMark({ status }: { status: "running" | "done" | "failed" }) {
  if (status === "done") {
    return (
      <span
        aria-label="done"
        className="mt-0.5 flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full bg-foreground text-background"
      >
        <svg viewBox="0 0 8 8" className="h-2 w-2" aria-hidden>
          <path
            d="M1 4.2 3 6l4-4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span
        aria-label="failed"
        className="mt-0.5 flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full border-2 border-foreground text-micro font-bold"
      >
        !
      </span>
    );
  }
  return (
    <span aria-label="running" className="relative mt-0.5 h-3.5 w-3.5 flex-shrink-0">
      <span className="absolute inset-[3px] rounded-full bg-foreground" />
      <motion.span
        aria-hidden
        className="absolute inset-0 rounded-full ring-2 ring-foreground/30"
        animate={{ opacity: [0.2, 0.8, 0.2], scale: [1, 1.25, 1] }}
        transition={{ duration: 1.6, repeat: Infinity, ease: EASE }}
      />
    </span>
  );
}
