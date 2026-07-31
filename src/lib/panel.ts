import {
  DEFAULT_QUERY,
  describeQuery,
  normalizeQuery,
  type DataQuery,
  type SourceKind,
} from "@/lib/data-stream";
import {
  describeStyle,
  normalizeStyle,
  normalizeStylePatch,
  type StylePatch,
} from "@/lib/component-style";

// A panel: a question, a shape, and a look.
//
// This is the whole model, and it replaces two separate ideas that used to sit
// beside each other — a hardcoded registry of nine built-in panels, and a
// separate notion of "custom" ones. There is no registry of panels any more.
// There is a registry of *shapes*, and every panel is data pointing at one.
//
// That distinction is what makes "convert everything to definitions" honest.
// Every shape below is one this renderer actually draws.
//
// There was briefly a fourth category — "bespoke" shapes (sprint_board,
// roadmap, workload, activity_feed) whose bodies were meant to be code because
// sprint planning has drag targets and a roadmap has a timeline you scrub. No
// renderer was ever wired to them, so picking one produced a card reading
// "open it from the sidebar". **A control that produces a stub is worse than
// no control**, so they are gone. Two of them were never bespoke at all —
// "workload" is tasks grouped by assignee and "activity feed" is a list of
// activity, both fully expressible here — and those now ship as starting
// points in the builder (`PANEL_PRESETS`), which is better than a shape name
// because you can see how they are made and change them.
//
// The two that genuinely need code, sprint boards and roadmaps, keep their own
// pages until somebody builds them a panel body. Naming a shape does not
// summon a renderer.

/** Every way a panel can be drawn. */
export type PanelShape =
  // Record shapes — these read `rows`.
  | "list"
  | "table"
  | "cards"
  | "board"
  // One number — reads `scalar`.
  | "metric"
  | "metric_spark"
  // Charts — these read `series`.
  | "bar"
  | "column"
  | "line"
  | "area"
  | "donut"
  | "pie"
  | "radial"
  | "scatter"
  | "waterfall"
  | "treemap"
  | "rings"
  | "funnel"
  | "radar"
  | "heatmap";

export type PanelDef = {
  title: string;
  query: DataQuery;
  shape: PanelShape;
  /** Row fields, for the record shapes. Ignored by charts. */
  fields: string[];
  /** This panel's own style overrides. Sparse — absent keys inherit. */
  style: StylePatch;
  /** Optional sentence under the title. */
  caption: string;
};

export const DEFAULT_PANEL: PanelDef = {
  title: "Untitled panel",
  query: DEFAULT_QUERY,
  shape: "list",
  fields: ["status", "assignee", "due"],
  style: {},
  caption: "",
};

const RECORD_SHAPES: PanelShape[] = ["list", "table", "cards", "board"];
const METRIC_SHAPES: PanelShape[] = ["metric", "metric_spark"];
const CHART_SHAPES: PanelShape[] = [
  "bar",
  "column",
  "line",
  "area",
  "donut",
  "pie",
  "radial",
  "scatter",
  "waterfall",
  "treemap",
  "rings",
  "funnel",
  "radar",
  "heatmap",
];
export const ALL_SHAPES: PanelShape[] = [
  ...RECORD_SHAPES,
  ...METRIC_SHAPES,
  ...CHART_SHAPES,
];

export function isChartShape(shape: PanelShape): boolean {
  return CHART_SHAPES.includes(shape);
}
export function isRecordShape(shape: PanelShape): boolean {
  return RECORD_SHAPES.includes(shape);
}
export function isMetricShape(shape: PanelShape): boolean {
  return METRIC_SHAPES.includes(shape);
}

/**
 * Which part of the envelope a shape reads.
 *
 * The renderer uses this to decide what to draw; the resolver could use it to
 * skip work it does not need. One function so the two can never disagree about
 * what a shape wants.
 */
export function readsFrom(shape: PanelShape): "rows" | "series" | "scalar" {
  if (isMetricShape(shape)) return "scalar";
  if (isChartShape(shape)) return "series";
  return "rows";
}

const SHAPE_LABELS: Record<PanelShape, string> = {
  list: "List",
  table: "Table",
  cards: "Cards",
  board: "Board",
  metric: "Big number",
  metric_spark: "Number with a sparkline",
  bar: "Bar",
  column: "Column",
  line: "Line",
  area: "Area",
  donut: "Donut",
  pie: "Pie",
  radial: "Dial",
  scatter: "Scatter",
  waterfall: "Waterfall",
  treemap: "Treemap",
  rings: "Progress rings",
  funnel: "Funnel",
  radar: "Radar",
  heatmap: "Heatmap",
};

export function shapeLabel(shape: PanelShape): string {
  return SHAPE_LABELS[shape];
}

/**
 * Shapes that make sense for a source.
 *
 * A donut of activity is noise; a sprint board over pages is nothing. The
 * builder reads this to decide what to offer, and `normalizePanel` enforces it,
 * so a definition written against a newer build degrades to something
 * renderable rather than to a blank panel.
 */
export function shapesFor(from: SourceKind): PanelShape[] {
  switch (from) {
    case "tasks":
      return [...RECORD_SHAPES, ...METRIC_SHAPES, ...CHART_SHAPES];
    case "time":
      return ["list", "table", "metric", "metric_spark", "bar", "column", "line", "area", "donut", "treemap", "heatmap"];
    case "goals":
      // Rings before the rest: a goal is a value against its own target, which
      // is the one thing this shape says and no other shape here says well.
      return ["list", "cards", "metric", "rings", "radial", "bar", "column", "donut"];
    case "sprints":
      return ["list", "table", "cards", "metric", "column", "bar", "funnel"];
    case "agents":
      return ["list", "cards", "table", "metric", "column", "bar", "donut", "radar"];
    case "pages":
      return ["list", "cards", "table", "metric", "column", "line", "area"];
    case "activity":
      return ["list", "metric", "column", "line", "area", "heatmap"];
  }
}

/** Row fields a source can show, for the record shapes. */
export function fieldsFor(from: SourceKind): { key: string; label: string }[] {
  switch (from) {
    case "tasks":
      return [
        { key: "status", label: "Status" },
        { key: "assignee", label: "Assignee" },
        { key: "assigneeName", label: "Assignee name" },
        { key: "priority", label: "Priority" },
        { key: "due", label: "Due date" },
        { key: "list", label: "List" },
        { key: "estimate", label: "Estimate" },
        { key: "blocked", label: "Blocked by" },
        { key: "added", label: "Added" },
      ];
    case "pages":
      return [
        { key: "updated", label: "Last updated" },
        { key: "author", label: "Last edited by" },
      ];
    case "agents":
      return [
        { key: "status", label: "Online" },
        { key: "task", label: "Now working on" },
        { key: "spend", label: "Spend" },
      ];
    case "activity":
      return [
        { key: "actor", label: "Who" },
        { key: "when", label: "When" },
      ];
    case "time":
      return [
        { key: "when", label: "When" },
        { key: "value", label: "Hours" },
      ];
    case "goals":
      return [
        { key: "value", label: "Progress" },
        { key: "due", label: "Target date" },
      ];
    case "sprints":
      return [
        { key: "status", label: "Status" },
        { key: "due", label: "Ends" },
      ];
  }
}

/**
 * Coerce anything into a renderable panel.
 *
 * Total, like every other normalizer here: definitions arrive from a builder,
 * from a row written by an older build, and from an agent. One that cannot be
 * drawn must degrade to one that can, never throw — a panel that breaks a
 * screen is worse than a panel showing the wrong thing.
 */
export function normalizePanel(input: unknown): PanelDef {
  const raw = liftLegacy(input) as Partial<PanelDef>;
  const query = normalizeQuery(raw.query);
  const allowed = shapesFor(query.from);
  const shape = allowed.includes(raw.shape as PanelShape)
    ? (raw.shape as PanelShape)
    : allowed[0];

  const catalog = new Set(fieldsFor(query.from).map((f) => f.key));
  const seen = new Set<string>();
  const fields: string[] = [];
  for (const key of Array.isArray(raw.fields) ? raw.fields : DEFAULT_PANEL.fields) {
    if (typeof key !== "string" || !catalog.has(key) || seen.has(key)) continue;
    seen.add(key);
    fields.push(key);
  }

  const title =
    typeof raw.title === "string" && raw.title.trim()
      ? raw.title.trim().slice(0, 60)
      : DEFAULT_PANEL.title;

  return {
    title,
    query,
    shape,
    fields,
    style: normalizeStylePatch(raw.style),
    caption:
      typeof raw.caption === "string" ? raw.caption.trim().slice(0, 140) : "",
  };
}

/**
 * Read a definition written before the query moved into its own object.
 *
 * The first component builder stored `from`, `filter`, `sort` and `limit` at
 * the top level. Read literally by the current normalizer those keys are
 * ignored and `query` is absent, so every panel anyone had authored would
 * quietly come back as "open tasks" — the filter silently gone, the panel
 * still rendering, nobody any the wiser. That is the worst kind of data loss
 * because it looks like the feature working.
 *
 * Detected by shape rather than by a version flag, because the old rows have
 * no flag to read. Lifting rather than migrating: the row is rewritten the
 * next time somebody saves it, and until then it renders correctly.
 */
function liftLegacy(input: unknown): Record<string, unknown> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const looksLegacy =
    raw.query === undefined &&
    (raw.from !== undefined || raw.filter !== undefined);
  if (!looksLegacy) return raw;

  const legacyFilter = (raw.filter ?? {}) as Record<string, unknown>;
  return {
    ...raw,
    query: {
      from: raw.from,
      sort: raw.sort,
      limit: raw.limit,
      // `group` was the old name for what is now the dimension, and the old
      // vocabulary is a subset of the new one — so the value carries across
      // unchanged and `normalizeQuery` drops anything this build dropped.
      dimension: raw.group,
      // The old metric lived beside the shape rather than inside the query;
      // as a measure it is the same idea under a better name.
      measure: raw.metric,
      filter: legacyFilter,
    },
  };
}

/**
 * A panel in words.
 *
 * A panel you cannot read back in a sentence is one you cannot audit, which
 * matters most when an agent wrote it. Used in the tray, in a proposal, and as
 * the fallback caption.
 */
export function describePanel(def: PanelDef): string {
  const style = normalizeStyle(def.style);
  const shape = shapeLabel(def.shape).toLowerCase();
  return `${shape} — ${describeQuery(def.query)} · ${describeStyle(style)}`;
}

/**
 * The id a panel takes inside a screen layout.
 *
 * The prefix is `custom:` rather than `panel:` because that is what is written
 * into every `screenLayouts` row that already exists. The word is a leftover
 * from when authored panels were a separate concept from built-in ones — a
 * distinction this file removes — but a prefix is a wire format, and renaming
 * one to match a better word would orphan every screen anybody has arranged.
 */
export function panelWidgetId(id: string): string {
  return `${PANEL_PREFIX}${id}`;
}

/** The stored id inside a layout widget id, or null if it is not a panel. */
export function panelIdFromWidgetId(widgetId: string): string | null {
  return widgetId.startsWith(PANEL_PREFIX)
    ? widgetId.slice(PANEL_PREFIX.length)
    : null;
}

const PANEL_PREFIX = "custom:";
