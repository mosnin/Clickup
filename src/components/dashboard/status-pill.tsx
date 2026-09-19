import type { Doc } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { StatusDot } from "@/components/dashboard/deel-ui";

// Deel 2025 status (Mobbin people / compliance): a coloured DOT + the
// word. A pastel fill chip is operate's old row language and reads as
// a second status indicator next to the table.

export function StatusPill({
  status,
  className,
}: {
  status: Doc<"listStatuses">;
  className?: string;
}) {
  return (
    <StatusDot
      color={status.color}
      label={status.name}
      className={cn("text-xs", className)}
    />
  );
}
