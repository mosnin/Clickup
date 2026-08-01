import { describe, expect, it } from "vitest";
import {
  anyOverlap,
  orderAfterMove,
  pack,
  packedRows,
  type PackItem,
} from "../src/lib/pack";

// The properties, not the examples.
//
// The overlapping-panels bug survived eight fixes and two sessions because
// every test asked "does this case look right" about a fixture of four
// identically sized cards. The conflict only appears when tiles have DIFFERENT
// heights, which that fixture could not express, so the suite was green the
// entire time the product was broken.
//
// So these are properties over generated inputs, including the mixed-size ones
// that actually occur on a real screen. A property test cannot be satisfied by
// the one arrangement somebody happened to think of.

/** Deterministic pseudo-random, so a failure is reproducible from its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function generate(seed: number, count: number, maxW = 3, maxH = 3): PackItem[] {
  const r = rng(seed);
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    w: 1 + Math.floor(r() * maxW),
    h: 1 + Math.floor(r() * maxH),
  }));
}

const CASES = Array.from({ length: 60 }, (_, i) => i + 1);

describe("no two tiles can ever share a cell", () => {
  it("holds for every generated arrangement, at every column count", () => {
    // The bug, stated as a property. It is impossible for `pack` to emit an
    // overlap — the occupancy grid is consulted before placing and marked
    // after — and this is the assertion that keeps it that way.
    for (const seed of CASES) {
      for (const columns of [1, 2, 3, 4]) {
        const items = generate(seed, 12);
        const rects = pack(items, columns);
        expect(anyOverlap(rects), `seed ${seed} @ ${columns} cols`).toBe(false);
      }
    }
  });

  it("holds when every tile is a different size", () => {
    // The exact shape the old fixture could not express: a short stat tile
    // beside a tall table is where the two layout models disagreed.
    const items: PackItem[] = [
      { id: "stat", w: 1, h: 1 },
      { id: "table", w: 2, h: 3 },
      { id: "feed", w: 1, h: 2 },
      { id: "wide", w: 3, h: 1 },
      { id: "square", w: 2, h: 2 },
    ];
    for (const columns of [1, 2, 3]) {
      expect(anyOverlap(pack(items, columns))).toBe(false);
    }
  });
});

describe("everything stays inside the grid", () => {
  it("never places a tile past the last column", () => {
    for (const seed of CASES) {
      for (const columns of [1, 2, 3]) {
        for (const r of pack(generate(seed, 10), columns)) {
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w).toBeLessThanOrEqual(columns);
        }
      }
    }
  });

  it("clamps a tile too wide for the grid instead of dropping it", () => {
    // A three-column tile on a phone is somebody asking for as much width as
    // there is. Dropping it would make a panel disappear on a narrow screen.
    const rects = pack([{ id: "wide", w: 3, h: 1 }], 1);
    expect(rects).toHaveLength(1);
    expect(rects[0]!.w).toBe(1);
  });

  it("keeps every tile at least one cell", () => {
    for (const r of pack([{ id: "a", w: 0, h: 0 }, { id: "b", w: -5, h: -5 }], 3)) {
      expect(r.w).toBeGreaterThanOrEqual(1);
      expect(r.h).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("the sheet is compact and stable", () => {
  it("leaves no tile that could sit a row higher", () => {
    // A gap under a tile is the other half of the reported problem, and it is
    // the same root cause: nothing owned placement, so nothing closed a hole.
    for (const seed of CASES) {
      const items = generate(seed, 10);
      const rects = pack(items, 3);
      for (const r of rects) {
        if (r.y === 0) continue;
        const others = rects.filter((o) => o.id !== r.id);
        const blocked = others.some(
          (o) =>
            o.x < r.x + r.w &&
            r.x < o.x + o.w &&
            o.y < r.y &&
            o.y + o.h >= r.y,
        );
        expect(blocked, `${r.id} @ seed ${seed} could float up`).toBe(true);
      }
    }
  });

  it("gives the same answer for the same input", () => {
    // Without this a drag jitters: two identical renders disagreeing about
    // geometry is a tile that moves when nothing moved it.
    for (const seed of CASES) {
      const items = generate(seed, 9);
      expect(pack(items, 3)).toEqual(pack(items, 3));
    }
  });

  it("lays tiles out in the order they are given", () => {
    // The order you can see is the order it packs, so the consequence of a
    // drag is predictable before you let go.
    const rects = pack(
      [
        { id: "a", w: 1, h: 1 },
        { id: "b", w: 1, h: 1 },
        { id: "c", w: 1, h: 1 },
      ],
      3,
    );
    expect(rects.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(rects.map((r) => r.x)).toEqual([0, 1, 2]);
    expect(rects.every((r) => r.y === 0)).toBe(true);
  });

  it("reports the height the sheet needs", () => {
    expect(packedRows(pack([{ id: "a", w: 3, h: 2 }], 3))).toBe(2);
    expect(packedRows([])).toBe(0);
  });

  it("survives an empty screen, which is a legitimate screen", () => {
    expect(pack([], 3)).toEqual([]);
  });
});

describe("moving a tile", () => {
  const items: PackItem[] = [
    { id: "a", w: 1, h: 1 },
    { id: "b", w: 1, h: 1 },
    { id: "c", w: 1, h: 1 },
  ];

  it("puts it where it was dropped", () => {
    // Dropped on c's cell (x=2), so it takes c's place in the order.
    expect(orderAfterMove(items, 3, "a", { x: 2, y: 0 })).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("returns an order, never geometry", () => {
    // Two representations of one arrangement is the mistake this file undoes.
    const next = orderAfterMove(items, 3, "a", { x: 1, y: 0 });
    expect(next).toEqual(["b", "a", "c"]);
    expect(anyOverlap(pack(next.map((id) => items.find((i) => i.id === id)!), 3))).toBe(
      false,
    );
  });

  it("lands somewhere when dropped into a gap rather than being ignored", () => {
    const next = orderAfterMove(items, 3, "a", { x: 9, y: 9 });
    expect(next).toHaveLength(3);
    expect(next).toContain("a");
  });

  it("is a no-op for a tile that is not there", () => {
    expect(orderAfterMove(items, 3, "nope", { x: 0, y: 0 })).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("never loses or duplicates a tile", () => {
    for (const seed of CASES) {
      const many = generate(seed, 8);
      const next = orderAfterMove(many, 3, "t3", { x: 1, y: 1 });
      expect(new Set(next).size).toBe(many.length);
      expect(next.length).toBe(many.length);
    }
  });
});
