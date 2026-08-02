import {
  QUERY_VOCABULARY,
  dimensionLabel,
  dimensionsFor,
  measureLabel,
  measuresFor,
  type DataQuery,
  type Dimension,
  type QueryFilter,
} from "@/lib/data-stream";
import {
  STYLE_ENUMS,
  STYLE_KEYS,
  type StyleKey,
} from "@/lib/component-style";
import {
  fieldsFor,
  isChartShape,
  normalizePanel,
  shapeLabel,
  shapesFor,
  type PanelDef,
} from "@/lib/panel";

// Saying what you want, about the whole panel.
//
// The composer already turned a sentence into a *look*. This is what lets the
// same sentence reach the other two thirds of a panel — what it asks and how
// it is drawn — because "only my overdue ones, as a donut, quieter" is one
// thought and splitting it across three controls is our problem, not theirs.
//
// Three properties hold it up, and none of them is "the model is good".
//
// **The vocabulary handed over is the one this panel can actually use.** Not
// the whole enumeration — the shapes *this source* can draw, the dimensions
// *this source* can be grouped by. A model offered `sprint_board` for a page
// panel will sometimes pick it, normalization will drop it, and the person
// sees a control that did nothing. Narrowing the list is the cheapest possible
// fix and it costs nothing at read time.
//
// **The sentence shown back is computed, never quoted.** The model returns its
// own prose about what it did; that prose is unverified, and after
// normalization it can be flatly untrue. So the model's line is shown as what
// it *understood*, and the change is described by diffing the two definitions.
// If nothing survived, the diff is empty and the UI can say so honestly
// instead of reading back a confident sentence about a panel that did not
// change.
//
// **Legality and coherence are separate.** `normalizePanel` answers "can this
// be drawn at all" and is applied to everything, including rows written years
// ago — so it must never change what a stored panel means. `coherePanel` here
// answers "is this what a person choosing it would have wanted", and is only
// applied where somebody is actively choosing. A donut grouped by nothing is
// legal, renders, and is one grey ring; repairing that at read time would
// silently rewrite panels nobody touched.

export type PanelChange = {
  /** Stable key, for tests and for keying a list. */
  key: string;
  /** What changed, in the product's words. */
  label: string;
  before: string;
  after: string;
};

/**
 * The lists a model may pick from for this panel.
 *
 * Narrowed by source on purpose — see the note above. `style` stays whole
 * because no style value is illegal for any source.
 */
export function vocabularyFor(def: PanelDef) {
  const from = def.query.from;
  return {
    sources: QUERY_VOCABULARY.sources,
    shapes: shapesFor(from),
    dimensions: dimensionsFor(from),
    measures: measuresFor(from),
    fields: fieldsFor(from).map((f) => f.key),
    filter: {
      status: QUERY_VOCABULARY.statuses,
      assignee: QUERY_VOCABULARY.assignees,
      due: QUERY_VOCABULARY.dues,
      priority: QUERY_VOCABULARY.priorities,
      window: QUERY_VOCABULARY.windows,
      blocked: [true, false],
      needsApproval: [true, false],
    },
    sorts: QUERY_VOCABULARY.sorts,
    style: STYLE_ENUMS,
  };
}

const QUERY_KEYS = new Set<keyof DataQuery>([
  "from",
  "filter",
  "dimension",
  "breakdown",
  "measure",
  "sort",
  "limit",
  "dimensionFieldId",
  "measureFieldId",
]);

const FILTER_KEYS = new Set<keyof QueryFilter>([
  "status",
  "priority",
  "assignee",
  "due",
  "window",
  "blocked",
  "needsApproval",
  "search",
  "scopeToId",
  "scopeToKind",
]);

const STYLE_KEY_SET = new Set<string>(STYLE_KEYS);

/**
 * Put a model's answer into the shape a panel is stored in.
 *
 * Models are unreliable at nesting and reliable at naming, so an answer of
 * `{ shape: "donut", palette: "vivid", due: "overdue" }` is common and, read
 * literally, mostly ignored. Rather than prompt harder, every top-level key is
 * routed to where it belongs by *name*: style keys into `style`, query keys
 * into `query`, filter keys into `query.filter`. A correctly nested answer
 * passes through untouched, so this only ever adds tolerance.
 */
export function liftAnswer(input: unknown): Record<string, unknown> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const query: Record<string, unknown> = {
    ...((raw.query ?? {}) as Record<string, unknown>),
  };
  const filter: Record<string, unknown> = {
    ...((query.filter ?? {}) as Record<string, unknown>),
  };
  const style: Record<string, unknown> = {
    ...((raw.style ?? {}) as Record<string, unknown>),
  };

  for (const [key, value] of Object.entries(raw)) {
    if (key === "query" || key === "style") continue;
    if (STYLE_KEY_SET.has(key)) style[key] = value;
    else if (QUERY_KEYS.has(key as keyof DataQuery) && key !== "filter") {
      query[key] = value;
    } else if (FILTER_KEYS.has(key as keyof QueryFilter)) filter[key] = value;
    else out[key] = value;
  }

  // `from` is the one name a model reaches for that also reads as English
  // ("source"). Accepting the synonym costs one line and saves an answer.
  if (raw.source !== undefined && query.from === undefined) {
    query.from = raw.source;
    delete out.source;
  }

  out.query = { ...query, filter };
  out.style = style;
  return out;
}

/**
 * Merge an answer into a panel and report what actually changed.
 *
 * The merge is deep on exactly two levels — query and filter — because a model
 * asked for "overdue" returns only `due`, and a shallow merge would blank
 * every other filter it did not mention. Absence means "leave it alone" at
 * every level, which is the same rule the whole appearance system runs on.
 */
export function applyIntent(
  def: PanelDef,
  answer: unknown,
): { next: PanelDef; changes: PanelChange[] } {
  const lifted = liftAnswer(answer);
  const liftedQuery = (lifted.query ?? {}) as Record<string, unknown>;
  const liftedFilter = (liftedQuery.filter ?? {}) as Record<string, unknown>;

  const merged = {
    ...def,
    ...lifted,
    query: {
      ...def.query,
      ...liftedQuery,
      filter: { ...def.query.filter, ...liftedFilter },
    },
    style: { ...def.style, ...((lifted.style ?? {}) as object) },
  };

  const next = coherePanel(normalizePanel(merged), def);
  return { next, changes: diffPanels(def, next) };
}

/**
 * Repair a definition into the one a person choosing it meant.
 *
 * Only two rules, and both exist because the legal answer is a panel that
 * draws nothing worth looking at:
 *
 *   - A chart grouped by nothing is one bar. Somebody who says "make it a
 *     donut" wants slices, so a dimension is chosen for them — and it is
 *     visible in the builder afterwards, so the guess is correctable rather
 *     than hidden.
 *   - A record shape carrying no fields is a list of bare titles. When the
 *     source changes, its old fields are dropped by the normalizer as
 *     unknown; this puts the new source's first two back.
 *
 * `previous` is used only to tell "they just changed the source" from "this
 * panel has always had no fields", because the second is a legitimate choice.
 */
export function coherePanel(def: PanelDef, previous?: PanelDef): PanelDef {
  let out = def;

  if (isChartShape(out.shape) && out.query.dimension === "none") {
    const fallback = dimensionsFor(out.query.from).find((d) => d !== "none");
    if (fallback) {
      out = { ...out, query: { ...out.query, dimension: fallback } };
    }
  }

  const sourceChanged =
    previous !== undefined && previous.query.from !== out.query.from;
  if (sourceChanged && out.fields.length === 0) {
    out = {
      ...out,
      fields: fieldsFor(out.query.from)
        .slice(0, 2)
        .map((f) => f.key),
    };
  }

  return out;
}

const FILTER_LABELS: Record<string, string> = {
  status: "Status",
  priority: "Priority",
  assignee: "Assigned to",
  due: "Due",
  window: "Time window",
  blocked: "Blocked only",
  needsApproval: "Waiting on approval",
  search: "Matching",
  scopeToId: "Limited to",
  scopeToKind: "Limited to",
};

function words(value: unknown): string {
  if (value === true) return "on";
  if (value === false) return "off";
  if (Array.isArray(value)) return value.length === 0 ? "any" : value.join(", ");
  if (value === "" || value === undefined || value === null) return "any";
  return String(value).replace(/_/g, " ");
}

/**
 * What changed between two definitions, in words.
 *
 * This is the sentence the person is shown, and it is derived rather than
 * quoted precisely because the alternative — printing the model's own account
 * of what it did — is the one part of this pipeline nothing checks.
 */
export function diffPanels(before: PanelDef, after: PanelDef): PanelChange[] {
  const changes: PanelChange[] = [];
  const add = (key: string, label: string, a: unknown, b: unknown) => {
    if (words(a) === words(b)) return;
    changes.push({ key, label, before: words(a), after: words(b) });
  };

  add("title", "Name", before.title, after.title);
  add("from", "Showing", before.query.from, after.query.from);
  if (before.shape !== after.shape) {
    changes.push({
      key: "shape",
      label: "Drawn as",
      before: shapeLabel(before.shape).toLowerCase(),
      after: shapeLabel(after.shape).toLowerCase(),
    });
  }
  if (before.query.dimension !== after.query.dimension) {
    changes.push({
      key: "dimension",
      label: "Grouped by",
      before: dimensionLabel(before.query.dimension).toLowerCase(),
      after: dimensionLabel(after.query.dimension).toLowerCase(),
    });
  }
  if (before.query.breakdown !== after.query.breakdown) {
    changes.push({
      key: "breakdown",
      label: "Split by",
      before: dimensionLabel(before.query.breakdown).toLowerCase(),
      after: dimensionLabel(after.query.breakdown).toLowerCase(),
    });
  }
  if (before.query.measure !== after.query.measure) {
    changes.push({
      key: "measure",
      label: "Measuring",
      before: measureLabel(before.query.measure).toLowerCase(),
      after: measureLabel(after.query.measure).toLowerCase(),
    });
  }
  add("sort", "Sorted by", before.query.sort, after.query.sort);
  add("limit", "How many", before.query.limit, after.query.limit);
  add("fields", "Fields", before.fields, after.fields);
  add("caption", "Caption", before.caption, after.caption);

  for (const key of FILTER_KEYS) {
    add(
      `filter.${key}`,
      FILTER_LABELS[key] ?? key,
      before.query.filter[key],
      after.query.filter[key],
    );
  }

  for (const key of STYLE_KEYS) {
    add(`style.${key}`, styleLabel(key), before.style[key], after.style[key]);
  }

  return changes;
}

const STYLE_LABELS: Partial<Record<StyleKey, string>> = {
  palette: "Colour",
  frame: "Frame",
  fill: "Fill",
  padding: "Padding",
  corner: "Corners",
  titleStyle: "Title",
  titleAlign: "Title position",
  accentEdge: "Accent edge",
  chartFill: "Chart fill",
  curve: "Curve",
  barShape: "Bars",
  barWidth: "Bar width",
  axes: "Axes",
  grid: "Grid",
  dataLabels: "Numbers on marks",
  legend: "Legend",
  markers: "Markers",
  stackMode: "Stacking",
  donutHole: "Donut hole",
};

export function styleLabel(key: StyleKey): string {
  return STYLE_LABELS[key] ?? String(key);
}

/** One line for a banner: "Drawn as donut, grouped by assignee". */
export function summarizeChanges(changes: PanelChange[]): string {
  if (changes.length === 0) return "";
  return changes
    .slice(0, 4)
    .map((c) => `${c.label.toLowerCase()} → ${c.after}`)
    .join(", ");
}

/**
 * Panels worth starting from.
 *
 * These replace what used to be four "bespoke" shape names whose bodies were
 * never written. A preset is strictly better than a shape name for the same
 * idea: it lands as an ordinary definition, so you can see how it is made,
 * change one thing about it, and learn the vocabulary by watching it move.
 * A shape called `workload` teaches nothing and can only be what it is.
 *
 * Each is a partial definition run through the same normalizer as everything
 * else, so a preset can never express something an agent or the pickers could
 * not.
 */
export const PANEL_PRESETS: {
  id: string;
  name: string;
  description: string;
  def: unknown;
}[] = [
  {
    id: "workload",
    name: "Workload",
    description: "Who is carrying how much.",
    def: {
      title: "Workload",
      query: { from: "tasks", dimension: "assignee", measure: "open" },
      shape: "bar",
    },
  },
  {
    id: "burn",
    name: "Finished each day",
    description: "How much is landing, day by day.",
    def: {
      title: "Finished each day",
      query: {
        from: "tasks",
        dimension: "completed_day",
        measure: "completed",
        // No window, and that absence is the fix rather than an omission.
        // `filter.window` is matched against when a task was ADDED, not when
        // it was finished (see the note on `Window` in data-stream.ts), so the
        // `30d` this carried meant "tasks created in the last 30 days,
        // bucketed by the day they landed" — a chart that silently drops every
        // long-running task finished this week and looks right doing it. The
        // preset promises "how much is landing, day by day"; over completion
        // history that is now what it is. Recency is the resolver's job: a
        // date dimension keeps its most recent buckets when it has more than
        // fit.
        filter: { status: "any" },
      },
      shape: "area",
    },
  },
  {
    id: "overdue",
    name: "Overdue by owner",
    description: "What is late, and whose it is.",
    def: {
      title: "Overdue",
      query: {
        from: "tasks",
        dimension: "assignee",
        measure: "overdue",
        filter: { due: "overdue" },
      },
      shape: "column",
    },
  },
  {
    id: "mine",
    name: "On my plate",
    description: "Your open work, soonest first.",
    def: {
      title: "On my plate",
      query: { from: "tasks", filter: { assignee: "me" }, sort: "due" },
      shape: "list",
      fields: ["status", "due", "list"],
    },
  },
  {
    id: "blocked",
    name: "Blocked",
    description: "Work that cannot move.",
    def: {
      title: "Blocked",
      query: { from: "tasks", filter: { blocked: true } },
      shape: "list",
      fields: ["assigneeName", "blocked", "due"],
    },
  },
  {
    id: "activity",
    name: "Activity",
    description: "What people and agents did lately.",
    def: {
      title: "Activity",
      query: { from: "activity", filter: { window: "7d" }, limit: 12 },
      shape: "list",
      fields: ["actor", "when"],
    },
  },
  {
    id: "spend",
    name: "Agent spend",
    description: "What the fleet is costing.",
    def: {
      title: "Agent spend",
      query: { from: "agents", dimension: "none", measure: "spend" },
      shape: "metric",
    },
  },
  {
    id: "status",
    name: "Where everything stands",
    description: "Every open task by status.",
    def: {
      title: "Where everything stands",
      query: { from: "tasks", dimension: "status", measure: "count" },
      shape: "donut",
    },
  },
];

/** A preset as a real definition. */
export function presetPanel(id: string): PanelDef | null {
  const preset = PANEL_PRESETS.find((p) => p.id === id);
  if (!preset) return null;
  return coherePanel(normalizePanel(preset.def));
}

/**
 * A blank panel to build from, aimed at a source.
 *
 * Starting from "untitled, tasks, list" every time makes the first two clicks
 * identical for everybody; starting from the source they picked makes the
 * panel already about something.
 */
export function blankPanelFor(from: PanelDef["query"]["from"]): PanelDef {
  const shape = shapesFor(from)[0];
  const dimension: Dimension =
    dimensionsFor(from).find((d) => d !== "none") ?? "none";
  return coherePanel(
    normalizePanel({
      title: "",
      query: { from, dimension: isChartShape(shape) ? dimension : "none" },
      shape,
      fields: fieldsFor(from)
        .slice(0, 2)
        .map((f) => f.key),
    }),
  );
}
