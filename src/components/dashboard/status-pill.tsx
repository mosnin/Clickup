import type { Doc } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";

// Pastel chip: the status color as a soft fill (hex + alpha) with dark
// ink on top and a solid dot — matches the brand reference's series
// labels. Works with any user-chosen hex color.
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
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium text-foreground/80",
        className,
      )}
      style={{ backgroundColor: `${status.color}4d` }}
      title={status.category.replace("_", " ")}
    >
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: status.color }}
      />
      {status.name}
    </span>
  );
}
