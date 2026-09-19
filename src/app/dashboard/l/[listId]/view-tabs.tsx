"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
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

const VIEWS: { key: ViewKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "list", label: "List" },
  { key: "board", label: "Board" },
  { key: "calendar", label: "Calendar" },
  { key: "gantt", label: "Gantt" },
  { key: "timeline", label: "Timeline" },
  { key: "table", label: "Table" },
  { key: "workload", label: "Workload" },
  { key: "network", label: "Network" },
];

export function ViewTabs({
  listId,
  active,
  defaultView = "list",
}: {
  listId: Id<"lists">;
  active: ViewKey;
  /** The view a bare URL (no ?view=) resolves to — the list's configured
   * default. Its tab drops the param; every other tab sets it explicitly. */
  defaultView?: ViewKey;
}) {
  const searchParams = useSearchParams();
  // Preserve active filters (?f=, ?pri=) when switching views.
  function href(key: ViewKey): string {
    const params = new URLSearchParams(searchParams.toString());
    if (key === defaultView) params.delete("view");
    else params.set("view", key);
    const qs = params.toString();
    return qs ? `/dashboard/l/${listId}?${qs}` : `/dashboard/l/${listId}`;
  }
  return (
    // The app's raised-white-on-recessed-track segmented control
    // (`.segmented`/`.segmented-on`, straight from globals.css) — same look
    // as every other view/mode toggle. Still a `<nav>` of real `<Link>`s
    // (not the Tabs primitive): this strip changes the URL and needs
    // `aria-current`, ⌘-click and shareable addresses, which a tablist
    // built for in-page panes doesn't give you.
    <nav aria-label="Views" className="max-w-full overflow-x-auto overscroll-x-contain">
      <div className="flex items-center gap-0.5">
        {VIEWS.map(({ key, label }) => (
          <Link
            key={key}
            href={href(key)}
            aria-current={active === key ? "page" : undefined}
            className={cn(
              "inline-flex flex-shrink-0 rounded-full px-2.5 py-1 text-xs font-medium",
              active === key
                ? "bg-card text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
