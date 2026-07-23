"use client";

import { cn } from "@/lib/utils";

// Shared checklist primitives. ChecklistChip is the tiny "n/m" progress
// indicator rendered on task rows and board cards — a pure, cheap render
// so it's safe to drop into dense lists. Other workstreams import
// { ChecklistChip } with this exact signature; keep it stable.

export type ChecklistItem = { id: string; text: string; done: boolean };

const SIZE = 12;
const STROKE = 2;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ChecklistChip({
  checklist,
}: {
  checklist?: ChecklistItem[];
}) {
  if (!checklist || checklist.length === 0) return null;
  const total = checklist.length;
  const done = checklist.filter((i) => i.done).length;
  const allDone = done === total;
  const pct = total === 0 ? 0 : done / total;
  const offset = CIRCUMFERENCE * (1 - pct);

  return (
    <span
      title={`${done} of ${total} checklist items done`}
      className={cn(
        "inline-flex flex-shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
        allDone
          ? "bg-pastel-green text-foreground dark:text-black"
          : "bg-muted text-muted-foreground",
      )}
    >
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        aria-hidden
        className="flex-shrink-0"
      >
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.25}
          strokeWidth={STROKE}
        />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </svg>
      {done}/{total}
    </span>
  );
}
