"use client";

import type { ReactNode } from "react";
import { AnimatedNumber } from "@/components/motion";
import { cn } from "@/lib/utils";

// The big-number card every one of the design references opens with.
//
// We already draw this shape on Home, on the agent detail page and in
// reports — three times, three different ways, which is why those screens do
// not look like each other. One tile now.
//
// The one rule carried over from the references: **at most one tile on a
// screen is filled.** All three spend their accent on a single hero metric
// and leave the rest as ink on card. A row of four filled tiles is a row of
// four things shouting, which is a row of four things nobody reads — so
// `accent` is a prop somebody has to choose, never a default.

export function StatTile({
  label,
  value,
  hint,
  delta,
  accent = false,
  icon,
  className,
}: {
  label: string;
  /** A number animates; a string (a duration, a range) is rendered as-is. */
  value: number | string;
  /** Quiet line under the figure: "last 7 days", "of 40 planned". */
  hint?: ReactNode;
  /** Signed change. Green for up, ink for down — never red for "fewer". */
  delta?: { value: string; direction: "up" | "down" | "flat" };
  /** The screen's single hero metric. At most one per screen. */
  accent?: boolean;
  /** A semantic indicator, on its own tile. Never ornament. */
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bento flex min-w-0 flex-col rounded-2xl p-4",
        accent ? "bg-foreground text-background" : "bg-card",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className={cn(
            "text-sm",
            accent ? "text-background/70" : "text-muted-foreground",
          )}
        >
          {label}
        </span>
        {icon ? <span className="icon-tile shrink-0">{icon}</span> : null}
      </div>
      <span className="mt-2 text-3xl font-bold tabular-nums tracking-tight">
        {typeof value === "number" ? <AnimatedNumber value={value} /> : value}
      </span>
      {(hint || delta) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {delta ? (
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-[0.6875rem] font-medium tabular-nums",
                // Green is reserved for a positive delta, per the brand
                // system. A fall is ink rather than red: fewer overdue tasks
                // is a fall, and colouring every decrease as a warning is how
                // a dashboard learns to lie.
                delta.direction === "up"
                  ? "bg-pastel-green text-neutral-900"
                  : accent
                    ? "bg-background/15 text-background"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {delta.direction === "up" ? "↑" : delta.direction === "down" ? "↓" : "→"}{" "}
              {delta.value}
            </span>
          ) : null}
          {hint ? (
            <span
              className={cn(
                "text-xs",
                accent ? "text-background/70" : "text-muted-foreground",
              )}
            >
              {hint}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
