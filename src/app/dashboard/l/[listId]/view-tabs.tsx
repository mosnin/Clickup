"use client";

import Link from "next/link";
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
  return (
    <nav
      aria-label="Views"
      className="inline-flex items-center gap-1 rounded-full border border-border bg-background p-1 text-sm"
    >
      {VIEWS.map(({ key, label, Icon }) => (
        <Link
          key={key}
          href={
            key === "list"
              ? `/dashboard/l/${listId}`
              : `/dashboard/l/${listId}?view=${key}`
          }
          aria-current={active === key ? "page" : undefined}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors",
            active === key
              ? "bg-muted font-medium text-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <Icon className="h-4 w-4" />
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}
