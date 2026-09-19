"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { Id } from "@convex/_generated/dataModel";
import { DeelTabs, deelTabClass } from "@/components/dashboard/deel-ui";

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
    // Deel page tabs (Mobbin Talent / settings): sentence-case labels on
    // an underline, still real `<Link>`s so ⌘-click and the address stay.
    <DeelTabs label="Views">
      {VIEWS.map(({ key, label }) => (
        <Link
          key={key}
          href={href(key)}
          aria-current={active === key ? "page" : undefined}
          className={deelTabClass(active === key)}
        >
          {label}
        </Link>
      ))}
    </DeelTabs>
  );
}
