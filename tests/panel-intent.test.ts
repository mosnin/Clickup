import { describe, expect, it } from "vitest";
import {
  applyIntent,
  blankPanelFor,
  coherePanel,
  diffPanels,
  liftAnswer,
  summarizeChanges,
  vocabularyFor,
} from "../src/lib/panel-intent";
import { normalizePanel, shapesFor, isChartShape } from "../src/lib/panel";
import { QUERY_VOCABULARY, dimensionsFor, measuresFor } from "../src/lib/data-stream";

// A sentence drives the whole panel.
//
// Everything here is about one worry: a model answers, most of it is dropped
// on the way in, and the person is shown a confident sentence about a panel
// that did not change. Two defences, both tested below — take the answer in
// whatever shape it arrives, and describe the result by diffing definitions
// rather than by quoting the model.

const base = normalizePanel({
  title: "Open work",
  query: { from: "tasks" },
  shape: "list",
  fields: ["status", "due"],
});

describe("an answer is read in whatever shape it arrives", () => {
  it("routes flat keys to where they belong", () => {
    // The common model answer: everything at the top level. Read literally,
    // all three of these are ignored.
    const lifted = liftAnswer({
      shape: "donut",
      palette: "vivid",
      due: "overdue",
    });
    expect(lifted.shape).toBe("donut");
    expect((lifted.style as Record<string, unknown>).palette).toBe("vivid");
    expect(
      ((lifted.query as Record<string, unknown>).filter as Record<string, unknown>)
        .due,
    ).toBe("overdue");
  });

  it("leaves a correctly nested answer alone", () => {
    const lifted = liftAnswer({
      query: { from: "pages", filter: { search: "spec" } },
      style: { palette: "vivid" },
    });
    const query = lifted.query as Record<string, unknown>;
    expect(query.from).toBe("pages");
    expect((query.filter as Record<string, unknown>).search).toBe("spec");
    expect((lifted.style as Record<string, unknown>).palette).toBe("vivid");
  });

  it("accepts `source` as a name for the source", () => {
    const lifted = liftAnswer({ source: "agents" });
    expect((lifted.query as Record<string, unknown>).from).toBe("agents");
  });

  it("does not let `source` overrule an explicit `from`", () => {
    const lifted = liftAnswer({ source: "agents", from: "pages" });
    expect((lifted.query as Record<string, unknown>).from).toBe("pages");
  });

  it("survives junk", () => {
    for (const junk of [null, undefined, 0, "", []]) {
      expect(() => liftAnswer(junk)).not.toThrow();
      expect(() => applyIntent(base, junk)).not.toThrow();
    }
  });
});

describe("merging keeps what the sentence did not mention", () => {
  it("does not blank the rest of the filter", () => {
    const filtered = normalizePanel({
      query: {
        from: "tasks",
        filter: { assignee: "me", status: "open", blocked: true },
      },
      shape: "list",
    });
    // "only the overdue ones" speaks to `due` and to nothing else. A shallow
    // merge would drop the other three and quietly widen the panel.
    const { next } = applyIntent(filtered, { due: "overdue" });
    expect(next.query.filter.due).toBe("overdue");
    expect(next.query.filter.assignee).toBe("me");
    expect(next.query.filter.status).toBe("open");
    expect(next.query.filter.blocked).toBe(true);
  });

  it("keeps style set earlier when the sentence is about data", () => {
    const styled = normalizePanel({
      query: { from: "tasks" },
      shape: "list",
      style: { palette: "vivid", grid: "none" },
    });
    const { next } = applyIntent(styled, { due: "overdue" });
    expect(next.style.palette).toBe("vivid");
    expect(next.style.grid).toBe("none");
  });

  it("keeps the query when the sentence is about style", () => {
    const asked = normalizePanel({
      query: { from: "tasks", filter: { assignee: "me" }, limit: 20 },
      shape: "list",
    });
    const { next } = applyIntent(asked, { palette: "vivid" });
    expect(next.query.filter.assignee).toBe("me");
    expect(next.query.limit).toBe(20);
  });

  it("drops a value the vocabulary does not contain", () => {
    const { next, changes } = applyIntent(base, {
      palette: "chartreuse",
      shape: "hologram",
    });
    expect(next.style.palette).toBeUndefined();
    expect(next.shape).toBe(base.shape);
    expect(changes).toHaveLength(0);
  });
});

describe("the sentence shown back is computed, not quoted", () => {
  it("reports nothing when nothing survived", () => {
    // The failure this prevents: the model says "made it a hologram", the
    // value is dropped, and the UI reads its sentence back anyway.
    const { changes } = applyIntent(base, { shape: "hologram" });
    expect(changes).toHaveLength(0);
    expect(summarizeChanges(changes)).toBe("");
  });

  it("names each thing that did change", () => {
    const { changes } = applyIntent(base, {
      shape: "donut",
      due: "overdue",
      palette: "vivid",
    });
    const keys = changes.map((c) => c.key);
    expect(keys).toContain("shape");
    expect(keys).toContain("filter.due");
    expect(keys).toContain("style.palette");
  });

  it("says what a value went from and to", () => {
    const { changes } = applyIntent(base, { shape: "donut" });
    const shape = changes.find((c) => c.key === "shape");
    expect(shape?.before).toBe("list");
    expect(shape?.after).toBe("donut");
  });

  it("reads a boolean as on and off rather than true and false", () => {
    const { changes } = applyIntent(base, { blocked: true });
    const blocked = changes.find((c) => c.key === "filter.blocked");
    expect(blocked?.after).toBe("on");
    expect(blocked?.before).toBe("off");
  });

  it("is empty for a panel compared with itself", () => {
    expect(diffPanels(base, base)).toHaveLength(0);
  });

  it("summarizes in the product's words, not key names", () => {
    const { changes } = applyIntent(base, { shape: "donut" });
    const text = summarizeChanges(changes);
    expect(text).toContain("donut");
    expect(text).not.toContain("shape:");
  });
});

describe("coherence — legal is not the same as meant", () => {
  it("gives a chart something to group by", () => {
    // A donut grouped by nothing is one grey ring. It is legal, it renders,
    // and it is not what anybody who said "donut" wanted.
    const { next } = applyIntent(base, { shape: "donut" });
    expect(next.query.dimension).not.toBe("none");
    expect(dimensionsFor(next.query.from)).toContain(next.query.dimension);
  });

  it("leaves a dimension the sentence chose alone", () => {
    const { next } = applyIntent(base, { shape: "donut", dimension: "priority" });
    expect(next.query.dimension).toBe("priority");
  });

  it("does not invent a dimension for a list", () => {
    const { next } = applyIntent(base, { title: "Renamed" });
    expect(next.query.dimension).toBe("none");
  });

  it("restores fields when the source changes under them", () => {
    // The old source's fields are dropped as unknown; a record shape with no
    // fields is a list of bare titles.
    const { next } = applyIntent(base, { from: "agents" });
    expect(next.query.from).toBe("agents");
    expect(next.fields.length).toBeGreaterThan(0);
  });

  it("respects a panel that has always had no fields", () => {
    // Somebody who cleared every field wants bare titles; repairing that on
    // every read would overrule a real choice.
    const bare = normalizePanel({ query: { from: "tasks" }, shape: "list", fields: [] });
    expect(coherePanel(bare).fields).toEqual([]);
  });

  it("never produces something the normalizer would reject", () => {
    for (const source of QUERY_VOCABULARY.sources) {
      for (const shape of shapesFor(source)) {
        const def = coherePanel(normalizePanel({ query: { from: source }, shape }));
        expect(normalizePanel(def), `${source}/${shape}`).toEqual(def);
      }
    }
  });
});

describe("the vocabulary handed over is the one this panel can use", () => {
  it("offers only shapes this source can draw", () => {
    // Offering `sprint_board` for pages produces an answer that normalization
    // drops, which reads as a control that did nothing.
    const pages = normalizePanel({ query: { from: "pages" } });
    expect(vocabularyFor(pages).shapes).toEqual(shapesFor("pages"));
    expect(vocabularyFor(pages).shapes).not.toContain("sprint_board");
  });

  it("narrows dimensions and measures to the source too", () => {
    const agents = normalizePanel({ query: { from: "agents" }, shape: "cards" });
    expect(vocabularyFor(agents).dimensions).toEqual(dimensionsFor("agents"));
    expect(vocabularyFor(agents).measures).toEqual(measuresFor("agents"));
  });

  it("hands over every style axis, since none is source-specific", () => {
    expect(Object.keys(vocabularyFor(base).style).length).toBeGreaterThan(10);
  });
});

describe("a blank panel is already about something", () => {
  it("starts on the source you picked, drawable", () => {
    for (const source of QUERY_VOCABULARY.sources) {
      const def = blankPanelFor(source);
      expect(def.query.from, source).toBe(source);
      expect(shapesFor(source), source).toContain(def.shape);
      if (isChartShape(def.shape)) {
        expect(def.query.dimension, source).not.toBe("none");
      }
    }
  });

  it("leaves the name empty so the field reads as yours to fill", () => {
    expect(blankPanelFor("tasks").title).toBe("Untitled panel");
  });
});
