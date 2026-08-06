import { cn } from "@/lib/utils";

// The one source of truth for task priority presentation. Every view (list,
// board, calendar, gantt, task page, my work) renders priority through this
// module so the color and label can never drift again.

export type TaskPriority = "urgent" | "high" | "normal" | "low";

// Theme tokens, not raw hex: the ramp lives in globals.css (@theme
// --color-priority-*) so a theme can retune it, and every view that renders
// priority through this module follows.
export const PRIORITY_COLOR: Record<TaskPriority, string> = {
  urgent: "var(--color-priority-urgent)",
  high: "var(--color-priority-high)",
  normal: "var(--color-priority-normal)",
  low: "var(--color-priority-low)",
};

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
};

export const PRIORITY_ORDER: TaskPriority[] = [
  "urgent",
  "high",
  "normal",
  "low",
];

/** Small colored dot; use where space is tight (calendar chips, mobile). */
export function PriorityDot({
  priority,
  className,
}: {
  priority: TaskPriority;
  className?: string;
}) {
  return (
    <span
      aria-label={`${PRIORITY_LABEL[priority]} priority`}
      title={`${PRIORITY_LABEL[priority]} priority`}
      className={cn("inline-block h-2 w-2 flex-shrink-0 rounded-full", className)}
      style={{ backgroundColor: PRIORITY_COLOR[priority] }}
    />
  );
}

/** Outlined chip with the state dot — the one chip language. */
export function PriorityChip({
  priority,
  className,
}: {
  priority: TaskPriority;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "ui-chip inline-flex flex-shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
        className,
      )}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: PRIORITY_COLOR[priority] }}
      />
      {PRIORITY_LABEL[priority]}
    </span>
  );
}
