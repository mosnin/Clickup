import { describe, expect, it } from "vitest";
import {
  addWidget,
  cycleSpan,
  isDefaultLayout,
  moveWidget,
  moveWidgetById,
  normalizeLayout,
  removeWidget,
  screenKey,
  unusedWidgets,
  type ScreenLayout,
  slotForPointer,
  insertWidget,
  describeLayoutChange,
  hoveredIndex,
  migrateStoredRows,
  migrateStoredLayout,
  stampLayout,
  LAYOUT_ROWS_VERSION,
} from "../src/lib/screen-layout";

// The layout engine. The property that shapes all of it:
//
//   **An empty layout is legitimate.**
//
// Someone who removes every panel wants a blank screen, not the defaults back.
// So normalization drops what it can't render and clamps what it can, but never
// helpfully re-adds anything — the only thing that produces the default layout
// is never having customised at all, and that's a null row, not an empty one.

const AVAILABLE = ["about", "lists", "pages", "status", "notes"];
const layout = (...ids: [string, number][]): ScreenLayout => ({
  widgets: ids.map(([id, span]) => ({ id, span: span as 1 | 2 | 3 })),
});

describe("normalizeLayout", () => {
  it("returns an empty layout for anything unusable", () => {
    for (const input of [null, undefined, 42, "x", {}, { widgets: "nope" }]) {
      expect(normalizeLayout(input, AVAILABLE)).toEqual({ widgets: [] });
    }
  });

  it("keeps an empty layout empty", () => {
    // The load-bearing case: this must not become the defaults.
    expect(normalizeLayout({ widgets: [] }, AVAILABLE)).toEqual({ widgets: [] });
  });

  it("drops a widget this build can't render", () => {
    const next = normalizeLayout(
      { widgets: [{ id: "about", span: 1 }, { id: "timeMachine", span: 2 }] },
      AVAILABLE,
    );
    // A layout saved by a newer build renders the panels we understand rather
    // than leaving a hole or throwing.
    expect(next.widgets.map((w) => w.id)).toEqual(["about"]);
  });

  it("drops a duplicate rather than rendering the same panel twice", () => {
    const next = normalizeLayout(
      { widgets: [{ id: "about", span: 1 }, { id: "about", span: 3 }] },
      AVAILABLE,
    );
    expect(next.widgets).toHaveLength(1);
    expect(next.widgets[0].span).toBe(1);
  });

  it("clamps a span that isn't a legal column count", () => {
    const next = normalizeLayout(
      {
        widgets: [
          { id: "about", span: 0 },
          { id: "lists", span: 9 },
          { id: "pages", span: 2.4 },
          { id: "status", span: "wide" },
          { id: "notes" },
        ],
      },
      AVAILABLE,
    );
    expect(next.widgets.map((w) => w.span)).toEqual([1, 1, 2, 1, 1]);
  });

  it("ignores entries that aren't shaped like a widget", () => {
    const next = normalizeLayout(
      { widgets: [null, "about", { span: 2 }, { id: "lists", span: 2 }] },
      AVAILABLE,
    );
    expect(next.widgets).toEqual([{ id: "lists", span: 2 }]);
  });
});

describe("reordering", () => {
  const start = layout(["about", 2], ["lists", 2], ["pages", 1]);

  it("moves a widget to a new index", () => {
    expect(moveWidget(start, 0, 2).widgets.map((w) => w.id)).toEqual([
      "lists",
      "pages",
      "about",
    ]);
  });

  it("clamps an out-of-range destination instead of dropping the widget", () => {
    expect(moveWidget(start, 0, 99).widgets).toHaveLength(3);
    expect(moveWidget(start, 0, 99).widgets.at(-1)!.id).toBe("about");
  });

  it("is a no-op for an unknown source or an unchanged position", () => {
    expect(moveWidget(start, 9, 0)).toBe(start);
    expect(moveWidget(start, 1, 1)).toBe(start);
  });

  it("moves by id, the way a drag hands it over", () => {
    expect(moveWidgetById(start, "pages", "about").widgets.map((w) => w.id)).toEqual([
      "pages",
      "about",
      "lists",
    ]);
  });

  it("is a no-op when either id isn't on the screen", () => {
    expect(moveWidgetById(start, "pages", "ghost")).toBe(start);
    expect(moveWidgetById(start, "ghost", "pages")).toBe(start);
  });

  it("never changes the number of widgets", () => {
    for (let from = 0; from < 3; from += 1) {
      for (let to = -2; to < 5; to += 1) {
        expect(moveWidget(start, from, to).widgets).toHaveLength(3);
      }
    }
  });
});

describe("adding and removing", () => {
  const start = layout(["about", 2]);

  it("appends at the widget's natural width", () => {
    expect(addWidget(start, "lists", 2).widgets).toEqual([
      { id: "about", span: 2 },
      { id: "lists", span: 2 },
    ]);
  });

  it("ignores a widget that is already placed", () => {
    expect(addWidget(start, "about", 3)).toBe(start);
  });

  it("removes by id and leaves the rest alone", () => {
    const two = addWidget(start, "lists", 1);
    expect(removeWidget(two, "about").widgets).toEqual([
      { id: "lists", span: 1 },
    ]);
  });

  it("removing the last widget gives an empty screen, not the defaults", () => {
    expect(removeWidget(start, "about")).toEqual({ widgets: [] });
  });

  it("reports what hasn't been placed, in registry order", () => {
    expect(unusedWidgets(start, AVAILABLE)).toEqual([
      "lists",
      "pages",
      "status",
      "notes",
    ]);
  });
});

describe("cycleSpan", () => {
  it("cycles through the widths a widget can render at", () => {
    let l = layout(["about", 1]);
    const bounds = { min: 1 as const, max: 3 as const };
    l = cycleSpan(l, "about", bounds);
    expect(l.widgets[0].span).toBe(2);
    l = cycleSpan(l, "about", bounds);
    expect(l.widgets[0].span).toBe(3);
    l = cycleSpan(l, "about", bounds);
    expect(l.widgets[0].span).toBe(1);
  });

  it("skips a width the widget can't render at", () => {
    // A grid of cards below two columns is a single file of cards.
    let l = layout(["lists", 2]);
    const bounds = { min: 2 as const, max: 3 as const };
    l = cycleSpan(l, "lists", bounds);
    expect(l.widgets[0].span).toBe(3);
    l = cycleSpan(l, "lists", bounds);
    expect(l.widgets[0].span).toBe(2);
  });

  it("lands on a legal width even when the current one is out of bounds", () => {
    const l = cycleSpan(layout(["lists", 1]), "lists", { min: 2, max: 3 });
    expect(l.widgets[0].span).toBe(2);
  });

  it("leaves other widgets untouched", () => {
    const l = cycleSpan(layout(["about", 1], ["lists", 2]), "about", {
      min: 1,
      max: 3,
    });
    expect(l.widgets[1]).toEqual({ id: "lists", span: 2 });
  });
});

describe("isDefaultLayout", () => {
  const fallback = layout(["about", 2], ["lists", 2]);

  it("recognises the fallback itself", () => {
    expect(isDefaultLayout(fallback, fallback)).toBe(true);
  });

  it("notices a reorder, a resize and a removal", () => {
    expect(isDefaultLayout(layout(["lists", 2], ["about", 2]), fallback)).toBe(false);
    expect(isDefaultLayout(layout(["about", 3], ["lists", 2]), fallback)).toBe(false);
    expect(isDefaultLayout(layout(["about", 2]), fallback)).toBe(false);
  });
});

describe("screenKey", () => {
  it("namespaces by kind so this generalises past projects", () => {
    expect(screenKey("project", "p1")).toBe("project:p1");
    expect(screenKey("space", "p1")).toBe("space:p1");
    // Two different screens, never the same row.
    expect(screenKey("project", "x")).not.toBe(screenKey("home", "x"));
  });
});

describe("dragging a tile to a slot", () => {
  // A flat 3-wide row of 120x80 tiles at y=100.
  const centers = [
    { x: 60, y: 100 },
    { x: 180, y: 100 },
    { x: 300, y: 100 },
  ];

  it("picks the slot the pointer is actually over", () => {
    expect(slotForPointer(centers, { x: 300, y: 100 }, 0)).toBe(2);
    expect(slotForPointer(centers, { x: 175, y: 105 }, 0)).toBe(1);
  });

  it("stays put when no other slot is meaningfully closer", () => {
    // Dead on the boundary between slots 0 and 1. Without hysteresis this flips
    // on sub-pixel movement, reordering the grid under the finger every frame.
    expect(slotForPointer(centers, { x: 120, y: 100 }, 0)).toBe(0);
    expect(slotForPointer(centers, { x: 120, y: 100 }, 1)).toBe(1);
    // A pointer barely past the midpoint hasn't earned the swap either.
    expect(slotForPointer(centers, { x: 126, y: 100 }, 0)).toBe(0);
  });

  it("swaps once the pointer is properly over the neighbour", () => {
    expect(slotForPointer(centers, { x: 150, y: 100 }, 0)).toBe(1);
  });

  it("is stable when the pointer hasn't moved", () => {
    // The property that matters during a drag: same input, same answer, so a
    // frame with no movement never produces a reorder.
    for (const current of [0, 1, 2]) {
      const first = slotForPointer(centers, { x: 190, y: 90 }, current);
      expect(slotForPointer(centers, { x: 190, y: 90 }, first)).toBe(first);
    }
  });

  it("survives an empty grid and an out-of-range current slot", () => {
    expect(slotForPointer([], { x: 0, y: 0 }, 3)).toBe(3);
    // A stale index (the tile was removed mid-drag) must not pin the answer.
    expect(slotForPointer(centers, { x: 300, y: 100 }, 99)).toBe(2);
  });
});

describe("inserting from the tray", () => {
  const base = {
    widgets: [
      { id: "a", span: 1 as const },
      { id: "b", span: 2 as const },
    ],
  };

  it("lands the widget at the slot the drag ended on", () => {
    expect(insertWidget(base, "c", 1, 1).widgets.map((w) => w.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("clamps an out-of-range slot instead of dropping the widget", () => {
    expect(insertWidget(base, "c", 1, 99).widgets.map((w) => w.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(insertWidget(base, "c", 1, -5).widgets.map((w) => w.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("ignores a duplicate, because a panel exists once", () => {
    expect(insertWidget(base, "a", 1, 0)).toBe(base);
  });
});


describe("describing a proposed change", () => {
  const current = {
    widgets: [
      { id: "about", span: 2 as const },
      { id: "lists", span: 2 as const },
      { id: "notes", span: 1 as const },
    ],
  };

  it("names what appears, what goes, and what changes size", () => {
    const d = describeLayoutChange(current, {
      widgets: [
        { id: "progress", span: 1 },
        { id: "lists", span: 3 },
        { id: "about", span: 2 },
      ],
    });
    expect(d.added).toEqual(["progress"]);
    expect(d.removed).toEqual(["notes"]);
    expect(d.resized).toEqual(["lists"]);
    expect(d.reordered).toBe(true);
  });

  it("reports nothing for an identical layout", () => {
    expect(describeLayoutChange(current, current)).toEqual({
      added: [],
      removed: [],
      resized: [],
      reordered: false,
    });
  });

  it("doesn't call an addition a reorder", () => {
    // Shared panels kept their relative order; only something new arrived.
    const d = describeLayoutChange(current, {
      widgets: [...current.widgets, { id: "activity", span: 1 }],
    });
    expect(d.reordered).toBe(false);
    expect(d.added).toEqual(["activity"]);
  });
});


describe("which tile a drag is over", () => {
  // Two rows of two 100x100 tiles with a 20px gap.
  const boxes = [
    { left: 0, top: 0, right: 100, bottom: 100 },
    { left: 120, top: 0, right: 220, bottom: 100 },
    { left: 0, top: 120, right: 100, bottom: 220 },
    { left: 120, top: 120, right: 220, bottom: 220 },
  ];

  it("finds the tile containing the pointer", () => {
    expect(hoveredIndex(boxes, { x: 150, y: 50 }, 0)).toBe(1);
    expect(hoveredIndex(boxes, { x: 50, y: 150 }, 0)).toBe(2);
  });

  it("never answers with the dragged tile itself", () => {
    // The bug this test pins down: the dragged tile's box follows the pointer,
    // so including it means it is always its own nearest target and the grid
    // never reorders.
    expect(hoveredIndex(boxes, { x: 50, y: 50 }, 0)).toBe(-1);
    expect(hoveredIndex(boxes, { x: 150, y: 50 }, 1)).toBe(-1);
  });

  it("answers nobody in the gaps between tiles", () => {
    expect(hoveredIndex(boxes, { x: 110, y: 50 }, 0)).toBe(-1);
    expect(hoveredIndex(boxes, { x: 50, y: 110 }, 3)).toBe(-1);
  });

  it("skips holes left by unmeasurable tiles", () => {
    expect(
      hoveredIndex([boxes[0], null, boxes[2]], { x: 50, y: 150 }, 0),
    ).toBe(2);
  });
});

describe("legacy row-unit migration", () => {
  // The 6rem row unit halved what a stored number means. Rows written before
  // it (no version marker) are in 10.5rem units — a "2" meant ~360px, which
  // the new unit renders at 216px. Migration converts, never clamps blindly:
  // old 1 → 2, 2 → 3, 3 → 5 (nearest new rows by pixel height).

  it("rescales an unversioned Home rows record", () => {
    expect(migrateStoredRows({ a: 1, b: 2, c: 3 })).toEqual({
      a: 2,
      b: 3,
      c: 5,
    });
  });

  it("leaves a versioned rows record alone and strips the marker", () => {
    expect(migrateStoredRows({ __v: 2, a: 1, b: 6 })).toEqual({ a: 1, b: 6 });
  });

  it("degrades hostile rows input to nothing", () => {
    for (const input of [null, undefined, 42, "x", [1, 2]]) {
      expect(migrateStoredRows(input)).toEqual({});
    }
    // Junk values are dropped, not repaired into a height nobody chose.
    expect(migrateStoredRows({ a: "tall", b: Number.NaN, c: 99 })).toEqual({});
  });

  it("rescales an unversioned stored layout's rows", () => {
    const migrated = migrateStoredLayout({
      widgets: [
        { id: "about", span: 1, rows: 2 },
        { id: "lists", span: 2 },
      ],
    }) as { v: number; widgets: { id: string; rows?: number }[] };
    expect(migrated.v).toBe(LAYOUT_ROWS_VERSION);
    expect(migrated.widgets[0].rows).toBe(3);
    // A widget that never declared a height still doesn't have one.
    expect(migrated.widgets[1].rows).toBeUndefined();
  });

  it("leaves a stamped layout untouched", () => {
    const stamped = { v: 2, widgets: [{ id: "about", span: 1, rows: 2 }] };
    expect(migrateStoredLayout(stamped)).toBe(stamped);
  });

  it("round-trips: what save stamps, the read migration trusts", () => {
    const saved = stampLayout({ widgets: [{ id: "about", span: 1, rows: 4 }] });
    const back = normalizeLayout(migrateStoredLayout(saved), AVAILABLE);
    expect(back.widgets).toEqual([{ id: "about", span: 1, rows: 4 }]);
  });

  it("migrated legacy rows survive normalizeLayout's clamp", () => {
    const back = normalizeLayout(
      migrateStoredLayout({ widgets: [{ id: "about", span: 1, rows: 3 }] }),
      AVAILABLE,
    );
    // Old 3 (the old maximum, ~552px) lands at 5 (~576px), inside 1–6.
    expect(back.widgets[0].rows).toBe(5);
  });
});
