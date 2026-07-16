import { cn } from "@/lib/utils";

// The one source of truth for task priority presentation. Every view (list,
// board, calendar, gantt, task page, my work) renders priority through this
// module so the color and label can never drift again.

export type TaskPriority = "urgent" | "high" | "normal" | "low";

export const PRIORITY_COLOR: Record<TaskPriority, string> = {
  urgent: "#f2b3ab",
  high: "#f2c291",
  normal: "#a9c6f2",
  low: "#c9ccd4",
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

/** Pastel pill with dot + label; the standard priority chip. */
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
        "inline-flex flex-shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium text-foreground/80",
        className,
      )}
      style={{ backgroundColor: `${PRIORITY_COLOR[priority]}66` }}
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
