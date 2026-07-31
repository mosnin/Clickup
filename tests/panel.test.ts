import { describe, expect, it } from "vitest";
import {
  ALL_SHAPES,
  DEFAULT_PANEL,
  describePanel,
  fieldsFor,
  isChartShape,
  isMetricShape,
  isRecordShape,
  normalizePanel,
  panelIdFromWidgetId,
  panelWidgetId,
  readsFrom,
  shapeLabel,
  shapesFor,
  type PanelShape,
} from "../src/lib/panel";
import { QUERY_VOCABULARY, type SourceKind } from "../src/lib/data-stream";

// A panel: a question, a shape and a look.
//
// The failure this file mostly exists to prevent is silent and looks like
// success. The first component builder stored `from` and `filter` at the top
// level; read literally by the current normalizer those keys are ignored, so
// every panel anyone had authored would come back as "open tasks" — the filter
// gone, the panel still rendering, nobody any the wiser. Data loss that throws
// gets fixed in an hour. Data loss that renders gets shipped.

describe("normalization is total", () => {
  it("survives anything at all", () => {
    for (const junk of [null, undefined, 0, "", [], { shape: {} }]) {
      expect(() => normalizePanel(junk)).not.toThrow();
      const panel = normalizePanel(junk);
      expect(ALL_SHAPES).toContain(panel.shape);
      expect(QUERY_VOCABULARY.sources).toContain(panel.query.from);
    }
  });

  it("is idempotent", () => {
    const once = normalizePanel({
      title: "  Overdue  ",
      query: { from: "tasks", dimension: "assignee", measure: "overdue" },
      shape: "donut",
      fields: ["status", "due"],
      style: { palette: "contrast" },
    });
    expect(normalizePanel(once)).toEqual(once);
  });

  it("refuses a shape the source cannot render", () => {
    // A donut of pages by priority is nothing; offering it offers a blank.
    const panel = normalizePanel({ query: { from: "pages" }, shape: "radial" });
    expect(shapesFor("pages")).toContain(panel.shape);
    expect(panel.shape).not.toBe("radial");
  });

  it("degrades a shape this build has retired", () => {
    // `sprint_board`, `roadmap`, `workload` and `activity_feed` were shape
    // names with no renderer behind them. A stored panel naming one has to
    // come back as something drawable rather than as a card saying "open it
    // from the sidebar".
    for (const gone of ["sprint_board", "roadmap", "workload", "activity_feed"]) {
      const panel = normalizePanel({ query: { from: "tasks" }, shape: gone });
      expect(ALL_SHAPES, gone).toContain(panel.shape);
    }
  });

  it("drops fields the source does not have", () => {
    const panel = normalizePanel({
      query: { from: "pages" },
      fields: ["priority", "updated", "priority"],
    });
    expect(panel.fields).toEqual(["updated"]);
  });

  it("drops a style value it does not enumerate", () => {
    expect(normalizePanel({ style: { palette: "chartreuse" } }).style).toEqual({});
  });
});

describe("reading a definition written by the first builder", () => {
  // These rows have no version flag, so they are detected by shape.
  const legacy = {
    title: "Blocked work",
    from: "tasks",
    shape: "list",
    sort: "priority",
    limit: 12,
    group: "assignee",
    metric: "overdue",
    filter: {
      status: "open",
      assignee: "me",
      due: "overdue",
      blocked: true,
      priority: ["urgent", "high"],
      search: "migration",
    },
  };

  it("keeps the filter instead of quietly showing everything", () => {
    const panel = normalizePanel(legacy);
    expect(panel.query.filter.assignee).toBe("me");
    expect(panel.query.filter.due).toBe("overdue");
    expect(panel.query.filter.blocked).toBe(true);
    expect(panel.query.filter.priority).toEqual(["urgent", "high"]);
    expect(panel.query.filter.search).toBe("migration");
  });

  it("carries the rest of the old query across", () => {
    const panel = normalizePanel(legacy);
    expect(panel.query.from).toBe("tasks");
    expect(panel.query.sort).toBe("priority");
    expect(panel.query.limit).toBe(12);
    // `group` and `metric` are the old names for the dimension and the
    // measure — the same ideas, and their vocabularies are subsets.
    expect(panel.query.dimension).toBe("assignee");
    expect(panel.query.measure).toBe("overdue");
  });

  it("keeps the title and the shape", () => {
    const panel = normalizePanel(legacy);
    expect(panel.title).toBe("Blocked work");
    expect(panel.shape).toBe("list");
  });

  it("leaves a modern definition alone", () => {
    const modern = {
      title: "Today",
      query: { from: "tasks", filter: { assignee: "unassigned" } },
      shape: "column",
    };
    const panel = normalizePanel(modern);
    expect(panel.query.filter.assignee).toBe("unassigned");
    expect(panel.shape).toBe("column");
  });

  it("does not mistake a modern definition with no filter for a legacy one", () => {
    const panel = normalizePanel({ query: { from: "agents" }, shape: "cards" });
    expect(panel.query.from).toBe("agents");
    expect(panel.shape).toBe("cards");
  });

  it("survives a legacy row whose filter is nonsense", () => {
    const panel = normalizePanel({ from: "tasks", filter: "everything" });
    expect(panel.query.filter.status).toBe(DEFAULT_PANEL.query.filter.status);
  });
});

describe("shapes", () => {
  it("classifies every shape exactly once", () => {
    for (const shape of ALL_SHAPES) {
      const kinds = [
        isRecordShape(shape),
        isMetricShape(shape),
        isChartShape(shape),
      ].filter(Boolean);
      expect(kinds.length, shape).toBe(1);
    }
  });

  it("routes each shape to the part of the envelope it reads", () => {
    // One function, so the resolver and the renderer can never disagree about
    // what a shape wants.
    expect(readsFrom("metric")).toBe("scalar");
    expect(readsFrom("metric_spark")).toBe("scalar");
    expect(readsFrom("donut")).toBe("series");
    expect(readsFrom("line")).toBe("series");
    expect(readsFrom("list")).toBe("rows");
    expect(readsFrom("table")).toBe("rows");
  });

  it("names every shape in words", () => {
    for (const shape of ALL_SHAPES) {
      expect(shapeLabel(shape as PanelShape).length, shape).toBeGreaterThan(0);
      expect(shapeLabel(shape as PanelShape)).not.toContain("_");
    }
  });

  it("offers every source at least one shape, all of them legal", () => {
    for (const source of QUERY_VOCABULARY.sources as readonly SourceKind[]) {
      const shapes = shapesFor(source);
      expect(shapes.length, source).toBeGreaterThan(0);
      for (const shape of shapes) expect(ALL_SHAPES, source).toContain(shape);
    }
  });

  it("offers every source fields for its record shapes", () => {
    for (const source of QUERY_VOCABULARY.sources as readonly SourceKind[]) {
      const fields = fieldsFor(source);
      expect(fields.length, source).toBeGreaterThan(0);
      for (const field of fields) {
        expect(field.label.length, `${source}.${field.key}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("widget ids", () => {
  it("round-trips", () => {
    expect(panelIdFromWidgetId(panelWidgetId("abc123"))).toBe("abc123");
  });

  it("reads the prefix already written into stored layouts", () => {
    // A prefix is a wire format. There was briefly a second scheme here
    // (`panel:`) that nothing wrote and nothing read, and a screen arranged
    // before it would have lost every authored panel to a renamed prefix.
    expect(panelWidgetId("abc")).toBe("custom:abc");
    expect(panelIdFromWidgetId("custom:abc")).toBe("abc");
  });

  it("says nothing for a built-in", () => {
    expect(panelIdFromWidgetId("overview")).toBeNull();
    expect(panelIdFromWidgetId("panel:abc")).toBeNull();
  });
});

describe("a panel reads back as a sentence", () => {
  it("says its shape, its question and its look", () => {
    // A panel you cannot read back in words is one you cannot audit, which
    // matters most when an agent wrote it.
    const text = describePanel(
      normalizePanel({
        query: { from: "tasks", dimension: "assignee", filter: { due: "overdue" } },
        shape: "donut",
        style: { palette: "contrast" },
      }),
    );
    expect(text).toContain("donut");
    expect(text).toContain("tasks");
    expect(text).toContain("overdue");
    expect(text).toContain("contrast");
  });

  it("describes every shape without throwing", () => {
    for (const shape of ALL_SHAPES) {
      const panel = normalizePanel({ query: { from: "tasks" }, shape });
      expect(describePanel(panel).length, shape).toBeGreaterThan(0);
    }
  });
});
