"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Calendar, Columns3, GanttChart, List as ListIcon } from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";

export type ViewKey = "list" | "board" | "calendar" | "gantt";

const VIEW_KEYS: ViewKey[] = ["list", "board", "calendar", "gantt"];

export function isViewKey(value: unknown): value is ViewKey {
  return typeof value === "string" && (VIEW_KEYS as string[]).includes(value);
}

const VIEWS: { key: ViewKey; label: string; Icon: typeof ListIcon }[] = [
  { key: "list", label: "List", Icon: ListIcon },
  { key: "board", label: "Board", Icon: Columns3 },
  { key: "calendar", label: "Calendar", Icon: Calendar },
  { key: "gantt", label: "Gantt", Icon: GanttChart },
];

export function ViewTabs({
  listId,
  active,
}: {
  listId: Id<"lists">;
  active: ViewKey;
}) {
  const searchParams = useSearchParams();
  // Preserve active filters (?f=, ?pri=) when switching views.
  function href(key: ViewKey): string {
    const params = new URLSearchParams(searchParams.toString());
    if (key === "list") params.delete("view");
    else params.set("view", key);
    const qs = params.toString();
    return qs ? `/dashboard/l/${listId}?${qs}` : `/dashboard/l/${listId}`;
  }
  return (
    <nav aria-label="Views" className="segmented text-sm">
      {VIEWS.map(({ key, label, Icon }) => (
        <Link
          key={key}
          href={href(key)}
          aria-current={active === key ? "page" : undefined}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors",
            active === key
              ? "segmented-on font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="h-4 w-4" />
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}
