// The data stream: one query model, one answer shape.
//
// The ceiling this removes: `uiComponents.resolve` returned rows, and rows are
// all a list, a table or a card grid needs. A chart needs something rows cannot
// give it — *series*: a set of labelled points produced by grouping records
// along a dimension and reducing them with a measure. Without that abstraction
// there is nowhere for a bar chart to get its bars from, which is why the
// component vocabulary had four shapes and none of them drew anything.
//
// So every component — list, table, cards, metric, bar, donut, line, treemap —
// now asks one question and gets one shape of answer:
//
//     source → filter → dimension → measure  ⇒  { rows, series, scalar }
//
// A list reads `rows`. A chart reads `series`. A metric reads `scalar`. The
// resolver computes whichever the shape asked for and skips the rest, but the
// *envelope* is the same, which is what makes "pick a source, pick a shape"
// a real sentence rather than four special cases.
//
// **The vocabulary is closed, and that is a security boundary rather than a
// style rule.** Agents author these definitions. Every source, filter,
// dimension, measure and sort below is enumerated here, validated on the way
// in by `normalizeQuery`, and executed by a resolver with exactly one branch
// per value this file is willing to emit. Nothing is a script, an expression,
// or a path into the database. The worst a hostile definition can produce is a
// differently-grouped view of records its author could already read.

/** What a component reads from. */
export type SourceKind =
  | "tasks"
  | "pages"
  | "agents"
  | "activity"
  | "time"
  | "goals"
  | "sprints";

/**
 * How records are grouped into series.
 *
 * `none` means "don't group" — one series holding every record, which is what
 * a plain list wants. Date dimensions bucket rather than key by timestamp,
 * because a chart with one bar per millisecond is not a chart.
 */
export type Dimension =
  | "none"
  | "status"
  | "assignee"
  | "priority"
  | "list"
  | "project"
  | "space"
  | "sprint"
  | "due_day"
  | "due_week"
  | "due_month"
  | "created_day"
  | "created_week"
  | "created_month"
  | "completed_day"
  | "completed_week"
  /** A user-defined field on the list. Carries its id in `dimensionFieldId`. */
  | "custom_field";

/** How the records in one bucket are reduced to a number. */
export type Measure =
  | "count"
  | "completed"
  | "open"
  | "overdue"
  | "completion_rate"
  | "estimate_sum"
  | "time_logged"
  | "unassigned"
  | "spend"
  /** Sum of a numeric user-defined field. Carries `measureFieldId`. */
  | "custom_field_sum"
  | "custom_field_avg";

export type Priority = "urgent" | "high" | "normal" | "low";

export type StatusFilter = "any" | "open" | "in_progress" | "complete" | "closed";
export type AssigneeFilter = "anyone" | "me" | "unassigned" | "agents" | "humans";
export type DueFilter = "any" | "overdue" | "today" | "week" | "month" | "none";
/** The window records are drawn from, for anything time-shaped. */
export type Window = "all" | "7d" | "30d" | "90d" | "quarter" | "year";

export type SortKey =
  | "manual"
  | "due"
  | "priority"
  | "created"
  | "updated"
  | "title"
  | "value_desc"
  | "value_asc"
  | "label";

export type QueryFilter = {
  status: StatusFilter;
  /** Empty means every priority, which is different from listing all four. */
  priority: Priority[];
  assignee: AssigneeFilter;
  due: DueFilter;
  window: Window;
  blocked: boolean;
  needsApproval: boolean;
  /** Plain substring over the title. Never a pattern. */
  search: string;
  /** Restrict to one list, project or space. Empty means the whole scope. */
  scopeToId: string;
  scopeToKind: "" | "list" | "project" | "space" | "sprint";
};

export type DataQuery = {
  from: SourceKind;
  filter: QueryFilter;
  dimension: Dimension;
  /** A second grouping, which is what makes a stacked or grouped chart. */
  breakdown: Dimension;
  measure: Measure;
  sort: SortKey;
  /** Rows or buckets to return. A panel is a glance, not a report. */
  limit: number;
  /** Field ids for the two `custom_field` vocabulary entries. */
  dimensionFieldId: string;
  measureFieldId: string;
};

export const DEFAULT_QUERY: DataQuery = {
  from: "tasks",
  filter: {
    status: "open",
    priority: [],
    assignee: "anyone",
    due: "any",
    window: "all",
    blocked: false,
    needsApproval: false,
    search: "",
    scopeToId: "",
    scopeToKind: "",
  },
  dimension: "none",
  breakdown: "none",
  measure: "count",
  sort: "manual",
  limit: 8,
  dimensionFieldId: "",
  measureFieldId: "",
};

// ── The answer ──────────────────────────────────────────────────────────

/** One record, for the shapes that draw records. */
export type DataRow = {
  id: string;
  title: string;
  href: string | null;
  /** Everything a field could want to show, by field key. */
  meta: Record<string, unknown>;
};

export type SeriesPoint = {
  /** Stable identity for the bucket — an id where one exists, else the label. */
  key: string;
  label: string;
  value: number;
  /** Present when the bucket maps to something with a colour of its own. */
  color?: string;
};

export type Series = {
  key: string;
  label: string;
  points: SeriesPoint[];
};

export type DataEnvelope = {
  rows: DataRow[];
  series: Series[];
  /** The measure applied to everything matching, ungrouped. */
  scalar: number;
  /** How many records matched before `limit`. */
  total: number;
  meta: {
    /** What one unit of `value` means, for axis and tooltip formatting. */
    unit: "count" | "percent" | "hours" | "points" | "currency";
    dimensionLabel: string;
    measureLabel: string;
  };
};

export const EMPTY_ENVELOPE: DataEnvelope = {
  rows: [],
  series: [],
  scalar: 0,
  total: 0,
  meta: { unit: "count", dimensionLabel: "", measureLabel: "" },
};

// ── Vocabulary ──────────────────────────────────────────────────────────

const SOURCES: SourceKind[] = [
  "tasks",
  "pages",
  "agents",
  "activity",
  "time",
  "goals",
  "sprints",
];

const DIMENSIONS: Dimension[] = [
  "none",
  "status",
  "assignee",
  "priority",
  "list",
  "project",
  "space",
  "sprint",
  "due_day",
  "due_week",
  "due_month",
  "created_day",
  "created_week",
  "created_month",
  "completed_day",
  "completed_week",
  "custom_field",
];

const MEASURES: Measure[] = [
  "count",
  "completed",
  "open",
  "overdue",
  "completion_rate",
  "estimate_sum",
  "time_logged",
  "unassigned",
  "spend",
  "custom_field_sum",
  "custom_field_avg",
];

const PRIORITIES: Priority[] = ["urgent", "high", "normal", "low"];
const STATUSES: StatusFilter[] = ["any", "open", "in_progress", "complete", "closed"];
const ASSIGNEES: AssigneeFilter[] = ["anyone", "me", "unassigned", "agents", "humans"];
const DUES: DueFilter[] = ["any", "overdue", "today", "week", "month", "none"];
const WINDOWS: Window[] = ["all", "7d", "30d", "90d", "quarter", "year"];
const SORTS: SortKey[] = [
  "manual",
  "due",
  "priority",
  "created",
  "updated",
  "title",
  "value_desc",
  "value_asc",
  "label",
];
const SCOPE_KINDS: QueryFilter["scopeToKind"][] = [
  "",
  "list",
  "project",
  "space",
  "sprint",
];

export const QUERY_VOCABULARY = {
  sources: SOURCES,
  dimensions: DIMENSIONS,
  measures: MEASURES,
  priorities: PRIORITIES,
  statuses: STATUSES,
  assignees: ASSIGNEES,
  dues: DUES,
  windows: WINDOWS,
  sorts: SORTS,
  scopeKinds: SCOPE_KINDS,
} as const;

function pick<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Ids are opaque strings, but they are still bounded and still plain. */
function cleanId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().slice(0, 64);
  return /^[A-Za-z0-9_-]*$/.test(trimmed) ? trimmed : "";
}

/**
 * Which dimensions a source can actually be grouped by.
 *
 * Offering "group agents by due date" is offering a control that produces one
 * empty bucket. The builder reads this to decide what to show, and
 * `normalizeQuery` enforces it, so a definition written against a newer build
 * degrades to something renderable rather than to a blank panel.
 */
export function dimensionsFor(from: SourceKind): Dimension[] {
  switch (from) {
    case "tasks":
      return DIMENSIONS;
    case "time":
      return ["none", "assignee", "list", "project", "created_day", "created_week"];
    case "goals":
      return ["none", "space", "created_month"];
    case "sprints":
      return ["none", "status", "space"];
    case "agents":
      return ["none", "status", "space"];
    case "pages":
      return ["none", "space", "created_day", "created_week", "created_month"];
    case "activity":
      return ["none", "assignee", "created_day", "created_week"];
  }
}

/** Which measures make sense over a source. */
export function measuresFor(from: SourceKind): Measure[] {
  switch (from) {
    case "tasks":
      return MEASURES;
    case "time":
      return ["time_logged", "count"];
    case "goals":
      return ["count", "completion_rate"];
    case "sprints":
      return ["count", "completed", "completion_rate", "estimate_sum"];
    case "agents":
      return ["count", "spend"];
    case "pages":
    case "activity":
      return ["count"];
  }
}

/** What one unit of a measure means — drives axis and tooltip formatting. */
export function unitFor(measure: Measure): DataEnvelope["meta"]["unit"] {
  if (measure === "completion_rate") return "percent";
  if (measure === "time_logged") return "hours";
  if (measure === "estimate_sum") return "points";
  if (measure === "spend") return "currency";
  return "count";
}

const DIMENSION_LABELS: Record<Dimension, string> = {
  none: "Everything",
  status: "Status",
  assignee: "Assignee",
  priority: "Priority",
  list: "List",
  project: "Project",
  space: "Space",
  sprint: "Sprint",
  due_day: "Due day",
  due_week: "Due week",
  due_month: "Due month",
  created_day: "Created day",
  created_week: "Created week",
  created_month: "Created month",
  completed_day: "Completed day",
  completed_week: "Completed week",
  custom_field: "Field",
};

const MEASURE_LABELS: Record<Measure, string> = {
  count: "How many",
  completed: "Completed",
  open: "Open",
  overdue: "Overdue",
  completion_rate: "Share complete",
  estimate_sum: "Estimate",
  time_logged: "Time logged",
  unassigned: "Unassigned",
  spend: "Spend",
  custom_field_sum: "Field total",
  custom_field_avg: "Field average",
};

export function dimensionLabel(d: Dimension): string {
  return DIMENSION_LABELS[d];
}
export function measureLabel(m: Measure): string {
  return MEASURE_LABELS[m];
}

/**
 * Coerce anything into a runnable query.
 *
 * Total by construction: these arrive from a builder, from a row written by an
 * older build, and from an agent. A query that cannot be run must degrade to
 * one that can, never throw — a panel that breaks a screen is worse than a
 * panel showing the wrong thing.
 *
 * Note what happens to a dimension or measure the source doesn't support: it
 * falls back to that source's *first* option rather than to the global
 * default. For dimensions this is belt and braces — every source's list starts
 * with "none", which is the global default too. For measures it is load-
 * bearing: a time panel asked for an impossible measure must become a time
 * panel measuring time, because falling back to the global "count" would turn
 * "hours logged per person" into "number of time entries" — a different
 * question, with a plausible-looking answer.
 */
export function normalizeQuery(input: unknown): DataQuery {
  const raw = (input ?? {}) as Partial<DataQuery> & {
    filter?: Partial<QueryFilter>;
  };
  const d = DEFAULT_QUERY;
  const from = pick(raw.from, SOURCES, d.from);

  const allowedDimensions = dimensionsFor(from);
  const allowedMeasures = measuresFor(from);

  const dimension = allowedDimensions.includes(raw.dimension as Dimension)
    ? (raw.dimension as Dimension)
    : allowedDimensions[0];
  // A breakdown equal to the dimension would split every bucket into exactly
  // one sub-bucket — a stacked chart with one stack, which is a plain chart
  // wearing a legend.
  const rawBreakdown = allowedDimensions.includes(raw.breakdown as Dimension)
    ? (raw.breakdown as Dimension)
    : "none";
  const breakdown = rawBreakdown === dimension ? "none" : rawBreakdown;

  const measure = allowedMeasures.includes(raw.measure as Measure)
    ? (raw.measure as Measure)
    : allowedMeasures[0];

  const rawPriority = Array.isArray(raw.filter?.priority)
    ? raw.filter!.priority
    : [];
  const priority = PRIORITIES.filter((p) => rawPriority.includes(p));

  const scopeToKind = pick(raw.filter?.scopeToKind, SCOPE_KINDS, "");
  const scopeToId = cleanId(raw.filter?.scopeToId);

  return {
    from,
    filter: {
      status: pick(raw.filter?.status, STATUSES, d.filter.status),
      priority,
      assignee: pick(raw.filter?.assignee, ASSIGNEES, d.filter.assignee),
      due: pick(raw.filter?.due, DUES, d.filter.due),
      window: pick(raw.filter?.window, WINDOWS, d.filter.window),
      blocked: raw.filter?.blocked === true,
      needsApproval: raw.filter?.needsApproval === true,
      search:
        typeof raw.filter?.search === "string"
          ? raw.filter.search.trim().slice(0, 80)
          : "",
      // A scope is a pair; half of one selects nothing, so drop both.
      scopeToKind: scopeToId && scopeToKind ? scopeToKind : "",
      scopeToId: scopeToId && scopeToKind ? scopeToId : "",
    },
    dimension,
    breakdown,
    measure,
    sort: pick(raw.sort, SORTS, d.sort),
    limit:
      typeof raw.limit === "number" && Number.isFinite(raw.limit)
        ? Math.min(Math.max(Math.round(raw.limit), 1), 60)
        : d.limit,
    // Only meaningful for the two custom_field vocabulary entries; carrying a
    // field id on a query that doesn't reference one is stored noise that
    // later reads as an intention.
    dimensionFieldId:
      dimension === "custom_field" ? cleanId(raw.dimensionFieldId) : "",
    measureFieldId:
      measure === "custom_field_sum" || measure === "custom_field_avg"
        ? cleanId(raw.measureFieldId)
        : "",
  };
}

/**
 * The query in words.
 *
 * A definition you cannot read back in a sentence is one you cannot audit,
 * which matters most when something else wrote it. Used in the tray, in an
 * agent's proposal, and as a panel's fallback title.
 */
export function describeQuery(q: DataQuery): string {
  const noun: Record<SourceKind, string> = {
    tasks: "tasks",
    pages: "pages",
    agents: "agents",
    activity: "activity",
    time: "time entries",
    goals: "goals",
    sprints: "sprints",
  };

  const parts: string[] = [];
  parts.push(`${measureLabel(q.measure).toLowerCase()} of ${noun[q.from]}`);

  if (q.filter.status !== "any" && q.from === "tasks") {
    parts.push(`status ${q.filter.status.replace("_", " ")}`);
  }
  if (q.filter.priority.length > 0) {
    parts.push(`priority ${q.filter.priority.join(" or ")}`);
  }
  if (q.filter.assignee !== "anyone") {
    const words: Record<AssigneeFilter, string> = {
      anyone: "",
      me: "assigned to me",
      unassigned: "with nobody on them",
      agents: "assigned to agents",
      humans: "assigned to people",
    };
    parts.push(words[q.filter.assignee]);
  }
  if (q.filter.due !== "any") parts.push(`due ${q.filter.due}`);
  if (q.filter.window !== "all") parts.push(`over the last ${q.filter.window}`);
  if (q.filter.blocked) parts.push("blocked");
  if (q.filter.needsApproval) parts.push("waiting on approval");
  if (q.filter.search) parts.push(`matching "${q.filter.search}"`);
  if (q.dimension !== "none") {
    parts.push(`by ${dimensionLabel(q.dimension).toLowerCase()}`);
  }
  if (q.breakdown !== "none") {
    parts.push(`split by ${dimensionLabel(q.breakdown).toLowerCase()}`);
  }

  return parts.filter(Boolean).join(", ");
}

// ── Bucketing (pure, so the resolver stays a thin walk) ──────────────────

/** Midnight local, so a "day" is the reader's day rather than UTC's. */
export function startOfLocalDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Monday-based, because a sprint week is not a calendar week. */
export function startOfLocalWeek(at: number): number {
  const d = new Date(startOfLocalDay(at));
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d.getTime();
}

export function startOfLocalMonth(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d.getTime();
}

/** How far back a window reaches from `now`, or null for "everything". */
export function windowStart(window: Window, now: number): number | null {
  const DAY = 86_400_000;
  switch (window) {
    case "all":
      return null;
    case "7d":
      return now - 7 * DAY;
    case "30d":
      return now - 30 * DAY;
    case "90d":
      return now - 90 * DAY;
    case "quarter":
      return now - 91 * DAY;
    case "year":
      return now - 365 * DAY;
  }
}

/** Which date field a dimension buckets on, or null if it isn't a date. */
export function dateFieldFor(
  dimension: Dimension,
): "due" | "created" | "completed" | null {
  if (dimension.startsWith("due_")) return "due";
  if (dimension.startsWith("created_")) return "created";
  if (dimension.startsWith("completed_")) return "completed";
  return null;
}

/** The bucket a timestamp falls in, for a date dimension. */
export function bucketFor(dimension: Dimension, at: number): number {
  if (dimension.endsWith("_week")) return startOfLocalWeek(at);
  if (dimension.endsWith("_month")) return startOfLocalMonth(at);
  return startOfLocalDay(at);
}

/**
 * Fill the gaps in a date-dimensioned series.
 *
 * A week with no completed tasks is a real answer and has to be drawn as a
 * zero, not skipped — a line chart that omits its empty days is a line chart
 * that lies about its slope. Only for date dimensions: there is no such thing
 * as a missing assignee.
 */
export function fillDateBuckets(
  points: SeriesPoint[],
  dimension: Dimension,
  now: number,
  maxBuckets = 60,
): SeriesPoint[] {
  if (dateFieldFor(dimension) === null || points.length === 0) return points;

  const step =
    dimension.endsWith("_month")
      ? null // months are uneven; walked with the Date API below
      : dimension.endsWith("_week")
        ? 7 * 86_400_000
        : 86_400_000;

  const keys = points.map((p) => Number(p.key)).filter((n) => Number.isFinite(n));
  if (keys.length === 0) return points;
  const byKey = new Map(points.map((p) => [p.key, p]));
  const start = Math.min(...keys);
  const end = Math.max(...keys, bucketFor(dimension, now));

  const out: SeriesPoint[] = [];
  if (step === null) {
    const cursor = new Date(start);
    while (cursor.getTime() <= end && out.length < maxBuckets) {
      const key = String(cursor.getTime());
      out.push(byKey.get(key) ?? { key, label: "", value: 0 });
      cursor.setMonth(cursor.getMonth() + 1);
    }
  } else {
    for (let t = start; t <= end && out.length < maxBuckets; t += step) {
      const key = String(t);
      out.push(byKey.get(key) ?? { key, label: "", value: 0 });
    }
  }
  return out;
}

/** Sort a series' points by whichever ordering the query asked for. */
export function sortPoints(points: SeriesPoint[], sort: SortKey): SeriesPoint[] {
  const out = [...points];
  if (sort === "value_desc") out.sort((a, b) => b.value - a.value);
  else if (sort === "value_asc") out.sort((a, b) => a.value - b.value);
  else if (sort === "label") out.sort((a, b) => a.label.localeCompare(b.label));
  // Everything else keeps the resolver's order, which for a date dimension is
  // chronological and for a status dimension is the workflow's own order —
  // both of which are more meaningful than anything re-sorting could produce.
  return out;
}
