// Components as data.
//
// The ceiling this exists to remove: every panel in the app was an entry in a
// hardcoded registry, so "customising your UI" could only ever mean choosing
// which of nine panels to show and in what order. You could not author a tenth.
// That is a rearrangeable UI, not a dynamic one.
//
// A component here is a DEFINITION — what data, filtered how, presented as
// what — and a generic renderer turns it into a panel. Adding a kind of panel
// no longer requires code, which is what makes it possible for two people in
// the same workspace, over identical primitives, to be looking at applications
// that do not resemble each other.
//
// The bound that keeps this safe: a definition composes a CLOSED vocabulary.
// Sources, filters, shapes and fields are all enumerated, validated on the way
// in, and executed by a query that knows exactly how to run each one. Nothing
// here is a script, an expression, or a path into the database. An agent may
// author these, so "compose primitives, never author code" is a security
// property, not a style preference.

import type { GroupBy } from "./view-settings";

/** What a component reads. Each has a resolver the server knows how to run. */
export type SourceKind = "tasks" | "pages" | "agents" | "activity";

/** How it is drawn. */
export type Shape = "list" | "table" | "cards" | "metric" | "board";

export type Priority = "urgent" | "high" | "normal" | "low";

export type StatusFilter =
  | "any"
  | "open"
  | "in_progress"
  | "complete"
  | "closed";

export type AssigneeFilter = "anyone" | "me" | "unassigned" | "agents";

export type DueFilter = "any" | "overdue" | "today" | "week" | "none";

export type MetricKind =
  | "count"
  | "completion"
  | "overdue"
  | "estimate_sum"
  | "unassigned";

export type ComponentFilter = {
  status: StatusFilter;
  /** Empty means every priority, which is different from listing all four. */
  priority: Priority[];
  assignee: AssigneeFilter;
  due: DueFilter;
  /** Only tasks with an open blocker. */
  blocked: boolean;
  /** Only tasks waiting on a human approval. */
  needsApproval: boolean;
  /** Plain substring over the title. */
  search: string;
};

export type UiComponentDef = {
  title: string;
  from: SourceKind;
  filter: ComponentFilter;
  shape: Shape;
  /** Ordered visible fields; the renderer ignores ones its shape can't show. */
  fields: string[];
  group: GroupBy;
  sort: SortKey;
  /** Rows to render. Bounded because a panel is a glance, not a report. */
  limit: number;
  density: "compact" | "comfortable";
  /** Which metric a `metric` shape reports. Ignored by other shapes. */
  metric: MetricKind;
  /** A pastel token name, or "" for the neutral surface. */
  accent: string;
};

export type SortKey =
  | "manual"
  | "due"
  | "priority"
  | "created"
  | "updated"
  | "title";

export const DEFAULT_COMPONENT: UiComponentDef = {
  title: "Untitled panel",
  from: "tasks",
  filter: {
    status: "open",
    priority: [],
    assignee: "anyone",
    due: "any",
    blocked: false,
    needsApproval: false,
    search: "",
  },
  shape: "list",
  fields: ["status", "assignee", "due"],
  group: "none",
  sort: "manual",
  limit: 8,
  density: "comfortable",
  metric: "count",
  accent: "",
};

/** Fields a task row can show, and which shapes can show them. */
export const TASK_FIELDS = [
  { key: "status", label: "Status" },
  { key: "assignee", label: "Assignee" },
  { key: "priority", label: "Priority" },
  { key: "due", label: "Due date" },
  { key: "list", label: "List" },
  { key: "estimate", label: "Estimate" },
  { key: "blocked", label: "Blocked by" },
  // No "last updated": tasks carry no updatedAt, and a column that renders
  // blank forever is worse than one that isn't offered.
  { key: "added", label: "Added" },
] as const;

export const PAGE_FIELDS = [
  { key: "excerpt", label: "Excerpt" },
  { key: "updated", label: "Last updated" },
  { key: "author", label: "Last edited by" },
] as const;

export const AGENT_FIELDS = [
  { key: "status", label: "Online" },
  { key: "task", label: "Now working on" },
  { key: "spend", label: "Spend" },
] as const;

export const ACTIVITY_FIELDS = [
  { key: "actor", label: "Who" },
  { key: "when", label: "When" },
] as const;

/** The field catalog for a source. */
export function fieldsFor(from: SourceKind): readonly { key: string; label: string }[] {
  if (from === "pages") return PAGE_FIELDS;
  if (from === "agents") return AGENT_FIELDS;
  if (from === "activity") return ACTIVITY_FIELDS;
  return TASK_FIELDS;
}

/** Shapes that make sense for a source — a metric over activity is noise. */
export function shapesFor(from: SourceKind): Shape[] {
  if (from === "tasks") return ["list", "table", "cards", "board", "metric"];
  if (from === "pages") return ["list", "cards"];
  if (from === "agents") return ["list", "cards", "metric"];
  return ["list"];
}

const SOURCES: SourceKind[] = ["tasks", "pages", "agents", "activity"];
const PRIORITIES: Priority[] = ["urgent", "high", "normal", "low"];
const GROUPS: GroupBy[] = [
  "none",
  "status",
  "assignee",
  "priority",
  "due",
  "milestone",
];
const SORTS: SortKey[] = [
  "manual",
  "due",
  "priority",
  "created",
  "updated",
  "title",
];
const METRICS: MetricKind[] = [
  "count",
  "completion",
  "overdue",
  "estimate_sum",
  "unassigned",
];

function pick<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * Coerce anything into a renderable definition.
 *
 * Total, like every other normalizer here: these arrive from a builder, from a
 * row written by an older build, and from an agent. A definition that cannot be
 * rendered must degrade to one that can, never throw — a panel that breaks a
 * screen is worse than a panel showing the wrong thing.
 *
 * The closed vocabulary is enforced here rather than trusted from the caller,
 * which is the whole security story: an agent can only ever express a
 * combination this function is willing to emit.
 */
export function normalizeComponent(input: unknown): UiComponentDef {
  const raw = (input ?? {}) as Partial<UiComponentDef> & {
    filter?: Partial<ComponentFilter>;
  };
  const d = DEFAULT_COMPONENT;
  const from = pick(raw.from, SOURCES, d.from);
  const catalog = new Set(fieldsFor(from).map((f) => f.key));

  const rawFields = Array.isArray(raw.fields) ? raw.fields : d.fields;
  const seen = new Set<string>();
  const fields: string[] = [];
  for (const key of rawFields) {
    if (typeof key !== "string" || !catalog.has(key) || seen.has(key)) continue;
    seen.add(key);
    fields.push(key);
  }

  const rawPriority = Array.isArray(raw.filter?.priority)
    ? raw.filter!.priority
    : [];
  const priority = PRIORITIES.filter((p) => rawPriority.includes(p));

  const title =
    typeof raw.title === "string" && raw.title.trim()
      ? raw.title.trim().slice(0, 60)
      : d.title;

  return {
    title,
    from,
    filter: {
      status: pick(
        raw.filter?.status,
        ["any", "open", "in_progress", "complete", "closed"] as const,
        d.filter.status,
      ),
      priority,
      assignee: pick(
        raw.filter?.assignee,
        ["anyone", "me", "unassigned", "agents"] as const,
        d.filter.assignee,
      ),
      due: pick(
        raw.filter?.due,
        ["any", "overdue", "today", "week", "none"] as const,
        d.filter.due,
      ),
      blocked: raw.filter?.blocked === true,
      needsApproval: raw.filter?.needsApproval === true,
      search:
        typeof raw.filter?.search === "string"
          ? raw.filter.search.trim().slice(0, 80)
          : "",
    },
    // A shape its source can't render falls back to the source's first shape,
    // not to the global default — a pages panel asked for "board" should
    // become a pages list, not a task list.
    shape: shapesFor(from).includes(raw.shape as Shape)
      ? (raw.shape as Shape)
      : shapesFor(from)[0],
    fields,
    group: pick(raw.group, GROUPS, d.group),
    sort: pick(raw.sort, SORTS, d.sort),
    limit:
      typeof raw.limit === "number" && Number.isFinite(raw.limit)
        ? Math.min(Math.max(Math.round(raw.limit), 1), 50)
        : d.limit,
    density: pick(raw.density, ["compact", "comfortable"] as const, d.density),
    metric: pick(raw.metric, METRICS, d.metric),
    accent:
      typeof raw.accent === "string" ? raw.accent.trim().slice(0, 24) : "",
  };
}

/**
 * A sentence describing what a component shows.
 *
 * Used in the tray, in an agent's proposal, and as the fallback title. A panel
 * whose definition you cannot read back in words is a panel you cannot audit —
 * which matters most when something else authored it.
 */
export function describeComponent(def: UiComponentDef): string {
  const parts: string[] = [];
  const noun =
    def.from === "tasks"
      ? "tasks"
      : def.from === "pages"
        ? "pages"
        : def.from === "agents"
          ? "agents"
          : "activity";

  if (def.shape === "metric") {
    const metricWord: Record<MetricKind, string> = {
      count: "How many",
      completion: "What share is complete",
      overdue: "How many are overdue",
      estimate_sum: "Total estimate",
      unassigned: "How many are unassigned",
    };
    parts.push(`${metricWord[def.metric]} of the ${noun}`);
  } else {
    parts.push(`${noun} as a ${def.shape}`);
  }

  if (def.from === "tasks") {
    if (def.filter.status !== "any") {
      parts.push(`status ${def.filter.status.replace("_", " ")}`);
    }
    if (def.filter.priority.length > 0) {
      parts.push(`priority ${def.filter.priority.join(" or ")}`);
    }
    if (def.filter.assignee !== "anyone") {
      parts.push(
        def.filter.assignee === "me"
          ? "assigned to me"
          : def.filter.assignee === "unassigned"
            ? "with nobody on them"
            : "assigned to agents",
      );
    }
    if (def.filter.due !== "any") parts.push(`due ${def.filter.due}`);
    if (def.filter.blocked) parts.push("blocked");
    if (def.filter.needsApproval) parts.push("waiting on approval");
  }
  if (def.filter.search) parts.push(`matching "${def.filter.search}"`);
  if (def.group !== "none") parts.push(`grouped by ${def.group}`);

  return parts.join(", ");
}

/** The id a user-authored component takes in a screen layout. */
export function componentWidgetId(id: string): string {
  return `custom:${id}`;
}

/** The stored id inside a layout widget id, or null for a built-in. */
export function componentIdFromWidgetId(widgetId: string): string | null {
  return widgetId.startsWith("custom:")
    ? widgetId.slice("custom:".length)
    : null;
}
