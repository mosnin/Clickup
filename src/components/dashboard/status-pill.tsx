import type { Doc } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";

export function StatusPill({
  status,
  className,
}: {
  status: Doc<"listStatuses">;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-0.5 text-xs",
        className,
      )}
      title={status.category.replace("_", " ")}
    >
      <span
        aria-hidden
        className="inline-block h-2 w-2 rounded-full"
        style={{ backgroundColor: status.color }}
      />
      {status.name}
    </span>
  );
}
