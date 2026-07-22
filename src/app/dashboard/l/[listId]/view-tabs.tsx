"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Calendar,
  Columns3,
  GanttChart,
  LayoutDashboard,
  List as ListIcon,
  Network,
  Rows3,
  Table2,
  Users,
} from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";

export type ViewKey =
  | "overview"
  | "list"
  | "board"
  | "calendar"
  | "gantt"
  | "timeline"
  | "table"
  | "workload"
  | "network";

const VIEW_KEYS: ViewKey[] = [
  "overview",
  "list",
  "board",
  "calendar",
  "gantt",
  "timeline",
  "table",
  "workload",
  "network",
];

export function isViewKey(value: unknown): value is ViewKey {
  return typeof value === "string" && (VIEW_KEYS as string[]).includes(value);
}

const VIEWS: { key: ViewKey; label: string; Icon: typeof ListIcon }[] = [
  { key: "overview", label: "Overview", Icon: LayoutDashboard },
  { key: "list", label: "List", Icon: ListIcon },
  { key: "board", label: "Board", Icon: Columns3 },
  { key: "calendar", label: "Calendar", Icon: Calendar },
  { key: "gantt", label: "Gantt", Icon: GanttChart },
  { key: "timeline", label: "Timeline", Icon: Rows3 },
  { key: "table", label: "Table", Icon: Table2 },
  { key: "workload", label: "Workload", Icon: Users },
  { key: "network", label: "Network", Icon: Network },
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
    <nav
      aria-label="Views"
      className="flex items-center gap-1 overflow-x-auto text-sm"
    >
      {VIEWS.map(({ key, label, Icon }) => (
        <Link
          key={key}
          href={href(key)}
          aria-current={active === key ? "page" : undefined}
          className={cn(
            "inline-flex flex-shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors",
            active === key
              ? "bg-accent font-medium text-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          )}
        >
          <Icon className="h-4 w-4" />
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}
