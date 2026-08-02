import { describe, expect, it } from "vitest";
import {
  HOME_PANEL_QUESTIONS,
  builtInPanelQuestion,
  mintFromBuiltIn,
} from "../src/lib/built-in-panel";
import {
  isChartShape,
  normalizePanel,
  panelWidgetId,
  shapesFor,
  type PanelShape,
} from "../src/lib/panel";
import { replaceWidget, type ScreenLayout } from "../src/lib/screen-layout";

// Minting a panel from a built-in, and putting it where the built-in was.
//
// The failure these guard against is the one the feature exists to remove: a
// control that looks like it did something and did not. Two ways that can come
// back after this change, both silent:
//
//   1. A question declared with a key the vocabulary drops. `normalizeQuery` is
//      total by design — it never throws — so `measure: "completions"` becomes
//      `count` and the minted chart answers a different question with a
//      plausible-looking number. Every declared key is asserted to survive.
//   2. A swap that appends instead of replacing. The panel exists, the pick
//      "worked", and it is at the bottom of the screen where the reader is not
//      looking.

describe("what a built-in can be asked", () => {
  it("only claims a question for the built-ins that have one", () => {
    // The three that do not are load-bearing absences, not omissions: `stats`
    // is four questions, `projects` has no source, and `today` is a due filter
    // the vocabulary cannot express (overdue OR today). See built-in-panel.ts.
    expect(Object.keys(HOME_PANEL_QUESTIONS).sort()).toEqual([
      "activity",
      "agents",
      "live",
    ]);
    for (const id of ["stats", "projects", "today", "nope"]) {
      expect(builtInPanelQuestion(id)).toBeNull();
    }
  });

  it("does not answer for inherited object keys", () => {
    // `"toString" in table` is true for every object literal; a lookup written
    // with `in` would hand the studio `Object.prototype.toString` to normalize.
    expect(builtInPanelQuestion("toString")).toBeNull();
    expect(builtInPanelQuestion("constructor")).toBeNull();
  });

  it("states every question in terms the vocabulary keeps", () => {
    for (const [id, raw] of Object.entries(HOME_PANEL_QUESTIONS)) {
      const def = builtInPanelQuestion(id);
      expect(def, id).not.toBeNull();
      const declared = raw as {
        title: string;
        shape: PanelShape;
        fields?: string[];
        query: Record<string, unknown> & { filter?: Record<string, unknown> };
      };

      expect(def!.title, id).toBe(declared.title);
      expect(def!.shape, id).toBe(declared.shape);
      for (const [key, value] of Object.entries(declared.query)) {
        if (key === "filter") continue;
        expect(
          (def!.query as unknown as Record<string, unknown>)[key],
          `${id}.query.${key}`,
        ).toEqual(value);
      }
      for (const [key, value] of Object.entries(declared.query.filter ?? {})) {
        expect(
          (def!.query.filter as unknown as Record<string, unknown>)[key],
          `${id}.query.filter.${key}`,
        ).toEqual(value);
      }
      for (const field of declared.fields ?? []) {
        expect(def!.fields, `${id}.fields`).toContain(field);
      }
    }
  });

  it("declares a shape its own source can actually draw", () => {
    for (const id of Object.keys(HOME_PANEL_QUESTIONS)) {
      const def = builtInPanelQuestion(id)!;
      expect(shapesFor(def.query.from), id).toContain(def.shape);
    }
  });

  it("offers at least one chart shape per question", () => {
    // The chapter this feeds only offers chart shapes. A question whose source
    // draws none of them would render an empty shelf, which is the inert
    // control again wearing a different coat.
    for (const id of Object.keys(HOME_PANEL_QUESTIONS)) {
      const def = builtInPanelQuestion(id)!;
      expect(shapesFor(def.query.from).filter(isChartShape).length, id)
        .toBeGreaterThan(0);
    }
  });
});

describe("minting", () => {
  it("keeps the question and takes the shape", () => {
    const question = builtInPanelQuestion("activity")!;
    for (const shape of shapesFor(question.query.from).filter(isChartShape)) {
      const minted = mintFromBuiltIn(question, shape);
      expect(minted.shape).toBe(shape);
      expect(minted.query.from).toBe(question.query.from);
      expect(minted.query.measure).toBe(question.query.measure);
      expect(minted.query.filter).toEqual(question.query.filter);
      expect(minted.title).toBe(question.title);
    }
  });

  it("never mints something the renderer would redraw", () => {
    // Whatever comes out has to be a fixed point of normalization, or the
    // stored row and the drawn panel disagree the moment it is read back.
    for (const id of Object.keys(HOME_PANEL_QUESTIONS)) {
      const question = builtInPanelQuestion(id)!;
      for (const shape of shapesFor(question.query.from)) {
        const minted = mintFromBuiltIn(question, shape);
        expect(normalizePanel(minted), `${id}/${shape}`).toEqual(minted);
      }
    }
  });

  it("groups a chart that would otherwise be one ring", () => {
    // `coherePanel`'s job, exercised through the mint: a chart shape over a
    // question with no dimension is legal and is a single undifferentiated
    // blob. Every Home question already carries a dimension, so this is about
    // the mint applying coherence at all rather than about these three.
    const flat = normalizePanel({
      title: "Flat",
      query: { from: "tasks", dimension: "none", measure: "count" },
      shape: "list",
    });
    expect(mintFromBuiltIn(flat, "donut").query.dimension).not.toBe("none");
  });
});

describe("swapping the minted panel in", () => {
  const layout: ScreenLayout = {
    widgets: [
      { id: "stats", span: 3 },
      { id: "activity", span: 1, rows: 2 },
      { id: "live", span: 2 },
    ],
  };

  it("lands in the built-in's slot, at the built-in's size", () => {
    const next = replaceWidget(layout, "activity", panelWidgetId("abc123"));
    expect(next.widgets.map((w) => w.id)).toEqual([
      "stats",
      "custom:abc123",
      "live",
    ]);
    // The slot's size, not the panel's: a shape change is not a resize.
    expect(next.widgets[1]).toEqual({ id: "custom:abc123", span: 1, rows: 2 });
  });

  it("leaves everything else exactly as it was", () => {
    const next = replaceWidget(layout, "activity", "custom:abc123");
    expect(next.widgets[0]).toEqual(layout.widgets[0]);
    expect(next.widgets[2]).toEqual(layout.widgets[2]);
    // Pure: the input is not mutated, so an optimistic render holding the old
    // layout still shows the old layout.
    expect(layout.widgets[1].id).toBe("activity");
  });

  it("does nothing when there is nothing to replace", () => {
    expect(replaceWidget(layout, "absent", "custom:abc")).toBe(layout);
    expect(replaceWidget(layout, "activity", "activity")).toBe(layout);
  });

  it("refuses to place a panel that is already on the screen", () => {
    // Otherwise the layout holds one id twice: one tile renders, the other is
    // silently dropped by `normalizeLayout`'s dedupe, and a slot disappears.
    expect(replaceWidget(layout, "activity", "live")).toBe(layout);
  });
});
