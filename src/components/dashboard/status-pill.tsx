import type { Doc } from "@convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// Pastel chip: the status color as a soft fill (hex + alpha) with dark
// ink on top and a solid dot — matches the brand reference's series
// labels. Works with any user-chosen hex color. Rendered on the vendored
// Badge shell so shape/typography track the shared token grammar; the
// per-status color is a runtime override on top, never a token.
export function StatusPill({
  status,
  className,
}: {
  status: Doc<"listStatuses">;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 border-transparent font-medium text-foreground/80",
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
    </Badge>
  );
}
