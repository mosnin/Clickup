import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
// The grid talks to Convex now — a condition that has become true offers its
// panel here, above the canvas, rather than beside each caller. Imported for
// its mocks: the grid is still a pure function of what it is handed.
import { queryResults, resetHarness } from "./harness";

// The editable grid's edit chrome.
//
// These are structural regressions, not behaviour tests: the resize grip was
// invisible in production for a reason a screenshot would show instantly and a
// unit test of the layout maths never would — it was rendered inside the
// tile's scroll container, which clips anything hung off the corners.

vi.mock("@/lib/anime", () => ({
  RELEASE: {},
  createDraggable: () => ({ revert() {}, reset() {}, animateInView() {} }),
  createMagneticField: () => ({ pull() {}, release() {}, revert() {} }),
  inhale: () => {},
  jiggle: () => () => {},
  morphLayout: (_root: unknown, change: () => void) => change(),
  scaled: (n: number) => n,
  settleDeform: () => {},
  tearOut: (_el: unknown, done: () => void) => done(),
  velocityDeform: () => {},
}));

vi.mock("@/components/motion", async () => await import("./motion-mock"));

const { EditableGrid } = await import(
  "@/components/dashboard/screen/editable-grid"
);

const TILES = [
  {
    id: "a",
    span: 1 as const,
    title: "Progress",
    minSpan: 1 as const,
    maxSpan: 3 as const,
    // `rows` is what turns on the fixed-height grid, which is what turns on
    // the scroll container that used to eat the chrome.
    rows: 1 as const,
    content: <div>body</div>,
  },
];

const LAYOUT = { widgets: [{ id: "a", span: 1 as const }] };

beforeEach(() => {
  document.body.innerHTML = "";
  resetHarness();
  // Nothing subscribed: the grid must be exactly the grid that shipped.
  queryResults["situations.forScreen"] = [];
});

describe("edit chrome", () => {
  it("is absent until the screen is being arranged", () => {
    render(
      <EditableGrid
        gridId="g"
        tiles={TILES}
        layout={LAYOUT}
        onChange={() => {}}
        editing={false}
        onEditingChange={() => {}}
      />,
    );
    expect(screen.queryByLabelText(/^Resize Progress/)).toBeNull();
    expect(screen.queryByLabelText("Remove Progress")).toBeNull();
  });

  it("offers a resize grip while arranging", () => {
    render(
      <EditableGrid
        gridId="g"
        tiles={TILES}
        layout={LAYOUT}
        onChange={() => {}}
        editing
        onEditingChange={() => {}}
      />,
    );
    expect(screen.getByLabelText(/^Resize Progress/)).toBeDefined();
  });

  it("hangs the chrome outside the tile's scroll container", () => {
    // The bug: a sized tile scrolls its content, and a scroll container clips
    // its overflowing children. Chrome positioned at -bottom-2.5 -right-2.5
    // inside it is simply not on screen, at any size.
    render(
      <EditableGrid
        gridId="g"
        tiles={TILES}
        layout={LAYOUT}
        onChange={() => {}}
        editing
        onEditingChange={() => {}}
      />,
    );
    const inner = document.querySelector("[data-tile-inner]")!;
    expect(inner.className).toContain("overflow-y-auto");

    for (const label of [/^Resize Progress/, /^Remove Progress$/]) {
      const control = screen.getByLabelText(label);
      expect(inner.contains(control)).toBe(false);
      // Still inside the tile, so it is positioned against the tile's corners.
      expect(
        document.querySelector('[data-tile="a"]')!.contains(control),
      ).toBe(true);
    }
  });

  it("gives the drag a trigger that excludes the chrome", () => {
    // Buttons stop propagation in React handlers, which run at the root —
    // after anime's native listener on the tile has already begun a drag. The
    // trigger has to be the content, or every button press throws the panel.
    render(
      <EditableGrid
        gridId="g"
        tiles={TILES}
        layout={LAYOUT}
        onChange={() => {}}
        editing
        onEditingChange={() => {}}
      />,
    );
    const inner = document.querySelector("[data-tile-inner]");
    expect(inner).not.toBeNull();
    expect(inner!.textContent).toContain("body");
  });

  it("always offers a way out of arranging", () => {
    render(
      <EditableGrid
        gridId="g"
        tiles={TILES}
        layout={LAYOUT}
        onChange={() => {}}
        editing
        onEditingChange={() => {}}
      />,
    );
    // A mode with no exit is a trap, and the exit cannot be at the top of a
    // screen you have scrolled down.
    expect(screen.getByRole("button", { name: "Done" })).toBeDefined();
  });
});

// ── Resize ──────────────────────────────────────────────────────────────
//
// Resizing looked broken in production while the maths underneath was
// correct the whole time: the grip reported every column it crossed, and on
// Home each of those reports is a Convex mutation whose resolution clears the
// optimistic draft. Two racing writes fought the local preview and the tile
// snapped back. One gesture is one intention, so it is one write — and the
// preview in between is local, never persisted.

function pointerEvent(type: string, init: Record<string, unknown>) {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  }) as unknown as PointerEvent;
  Object.defineProperty(e, "pointerId", { value: 1 });
  return e;
}

/** Pin the grid's width so a column is a known number of pixels. */
function stubGridWidth(width: number) {
  const grid = document.getElementById("g")!;
  Object.defineProperty(grid, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      width,
      height: 400,
      left: 0,
      top: 0,
      right: width,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON() {},
    }),
  });
}

/** Is this tile laid out exactly one column wide? */
function oneColumn(el: HTMLElement): boolean {
  return el.dataset.w === "1";
}

describe("resizing", () => {
  it("writes once for a whole drag, not once per column crossed", () => {
    const onChange = vi.fn();
    render(
      <EditableGrid
        gridId="g"
        tiles={TILES}
        layout={LAYOUT}
        onChange={onChange}
        editing
        onEditingChange={() => {}}
      />,
    );
    // Wide enough for three columns (48rem = 768px), so one column is 400px.
    // The number matters: the drag divides by the columns actually drawn, not
    // by the maximum, or the pointer and the panel disagree at every width but
    // the widest.
    stubGridWidth(1200);

    const grip = screen.getByLabelText(/Resize Progress/i);
    grip.dispatchEvent(pointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    // Cross two column boundaries on the way out: 1 -> 2 -> 3. Every event is
    // flushed (act) before the next, because a browser renders between frames
    // of a drag. Dispatching them back-to-back let the preview stay unflushed
    // until release, which hid a release-guard bug that killed every real
    // height drag while every test stayed green.
    act(() => {
      window.dispatchEvent(pointerEvent("pointermove", { clientX: 300, clientY: 0 }));
    });
    act(() => {
      window.dispatchEvent(pointerEvent("pointermove", { clientX: 620, clientY: 0 }));
    });
    expect(
      onChange,
      "nothing may be written while the gesture is still in flight",
    ).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(pointerEvent("pointerup", { clientX: 620, clientY: 0 }));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    // No `rows`. A purely horizontal drag must not claim a height — writing
    // rows: 1 here is what used to flip every natural-height panel on the
    // screen into a fixed 10.5rem box the first time anyone widened one card.
    expect(onChange.mock.calls[0][0]).toEqual({
      widgets: [{ id: "a", span: 3 }],
    });
  });

  it("writes a height when the drag actually moves vertically", () => {
    const onChange = vi.fn();
    render(
      <EditableGrid
        gridId="g"
        tiles={TILES}
        layout={LAYOUT}
        onChange={onChange}
        editing
        onEditingChange={() => {}}
      />,
    );
    stubGridWidth(1200);

    const grip = screen.getByLabelText(/Resize Progress/i);
    grip.dispatchEvent(pointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    // Down two row units (unit + gap = 192px each on a natural screen),
    // flushed before release like a real drag — see the note above.
    act(() => {
      window.dispatchEvent(
        pointerEvent("pointermove", { clientX: 0, clientY: 400 }),
      );
    });
    act(() => {
      window.dispatchEvent(pointerEvent("pointerup", { clientX: 0, clientY: 400 }));
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    const widget = (
      onChange.mock.calls[0][0] as { widgets: { id: string; rows?: number }[] }
    ).widgets[0];
    expect(widget.rows, "the chosen height is stored").toBeGreaterThan(1);
  });

  it("gives the dragged panel an explicit height on a natural screen", () => {
    // The feedback half of the same bug: with the row classes gated on a
    // "sized" screen, a vertical drag on Home changed nothing under the
    // finger — the preview had nowhere to land. Natural fixtures on purpose:
    // no tile declares rows, exactly like Home.
    const natural = [
      { id: "a", span: 1 as const, title: "Progress", minSpan: 1 as const, maxSpan: 3 as const, content: <div>body</div> },
      { id: "b", span: 1 as const, title: "Notes", minSpan: 1 as const, maxSpan: 3 as const, content: <div>notes</div> },
    ];
    const onChange = vi.fn();
    const { container } = render(
      <EditableGrid
        gridId="g"
        tiles={natural}
        layout={{ widgets: [{ id: "a", span: 1 as const }, { id: "b", span: 1 as const }] }}
        onChange={onChange}
        editing
        onEditingChange={() => {}}
      />,
    );
    stubGridWidth(1200);

    const grip = screen.getByLabelText(/^Resize Progress/);
    grip.dispatchEvent(pointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    // Raw dispatch bypasses React's event system, so the preview state lands
    // on the next flush — act() is what makes the DOM assertable after it.
    act(() => {
      window.dispatchEvent(
        pointerEvent("pointermove", { clientX: 0, clientY: 400 }),
      );
    });
    const tile = container.querySelector('[data-tile="a"]') as HTMLElement;
    expect(
      tile.style.height,
      "the tile is its dragged height while the pointer is down",
    ).not.toBe("");
    // And its neighbours are unmoved. Every tile now carries an explicit box
    // because `pack` decides all of them, so the question is no longer "does
    // the neighbour have a height" but "did the neighbour's box change" — and
    // it must not. One panel's resize is not a mode switch for the screen.
    const other = container.querySelector('[data-tile="b"]') as HTMLElement;
    // Its neighbour is unmoved: same column, same row, same size. Every tile
    // now carries an explicit box because `pack` decides all of them, so the
    // question is no longer "does the neighbour have a height" but "did the
    // neighbour's box change" — and it must not.
    if (other) {
      expect(other.dataset.h).toBe("1");
      expect(other.dataset.col).toBe("1");
    }
    window.dispatchEvent(pointerEvent("pointerup", { clientX: 0, clientY: 400 }));
  });

  it("shows the width under the finger before it is saved", () => {
    const onChange = vi.fn();
    render(
      <EditableGrid
        gridId="g"
        tiles={TILES}
        layout={LAYOUT}
        onChange={onChange}
        editing
        onEditingChange={() => {}}
      />,
    );
    stubGridWidth(1200);
    const tile = document.querySelector<HTMLElement>('[data-tile="a"]')!;
    // Geometry, not a class name. The span classes were the OLD placement
    // model — CSS Grid computing tracks while tiles carried their own heights,
    // which is the disagreement that produced overlapping panels. Asserting a
    // class asserted the implementation; this asserts what is drawn.
    expect(oneColumn(tile)).toBe(true);

    const grip = screen.getByLabelText(/Resize Progress/i);
    act(() => {
      grip.dispatchEvent(pointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
      window.dispatchEvent(
        pointerEvent("pointermove", { clientX: 310, clientY: 0 }),
      );
    });

    // The tile moved without anything being saved: that is the whole point of
    // a preview, and it is what makes a resize feel like resizing.
    const live = document.querySelector<HTMLElement>('[data-tile="a"]')!;
    expect(live.dataset.w).toBe("2");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("returns to the saved width when a drag ends where it started", () => {
    const onChange = vi.fn();
    render(
      <EditableGrid
        gridId="g"
        tiles={TILES}
        layout={LAYOUT}
        onChange={onChange}
        editing
        onEditingChange={() => {}}
      />,
    );
    stubGridWidth(1200);
    const grip = screen.getByLabelText(/Resize Progress/i);
    act(() => {
      grip.dispatchEvent(pointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
      window.dispatchEvent(
        pointerEvent("pointermove", { clientX: 310, clientY: 0 }),
      );
      window.dispatchEvent(
        pointerEvent("pointermove", { clientX: 10, clientY: 0 }),
      );
      window.dispatchEvent(pointerEvent("pointerup", { clientX: 10, clientY: 0 }));
    });

    expect(onChange).not.toHaveBeenCalled();
    const tile = document.querySelector<HTMLElement>('[data-tile="a"]')!;
    expect(oneColumn(tile)).toBe(true);
  });

  it("is still reachable without a pointer", () => {
    // The number stepper is gone — it was a second way to do what the corner
    // already does, and a number is what you reach for when you cannot see
    // the result. The keyboard path moved onto the tile itself, which is one
    // place to learn rather than a control per axis.
    const onChange = vi.fn();
    render(
      <EditableGrid
        gridId="g"
        tiles={TILES}
        layout={LAYOUT}
        onChange={onChange}
        editing
        onEditingChange={() => {}}
      />,
    );
    expect(screen.queryByLabelText(/wider/i)).toBeNull();

    const tile = document.querySelector<HTMLElement>('[data-tile="a"]')!;
    fireEvent.keyDown(tile, { key: "+" });
    expect(onChange).toHaveBeenCalledWith(
      { widgets: [{ id: "a", span: 2 }] },
      undefined,
    );
  });
});

describe("the grid measures itself, not the window", () => {
  it("never sizes a panel off a viewport breakpoint", () => {
    // This is the resizer bug in its purest form. The maths was correct, the
    // write landed, the layout row updated — and below 1024px the CSS ignored
    // all of it, because span and row classes were `lg:` viewport variants and
    // the grid was still one column. Nothing about the write path was wrong,
    // which is why fixing the write path did not fix the resizer.
    //
    // It is also wrong at every width: the grid sits inside a shell whose
    // sidebar can be collapsed, floated or docked, so a panel's size has to
    // follow the space the grid actually has.
    const { container } = render(
      <EditableGrid
        gridId="g"
        tiles={TILES}
        layout={LAYOUT}
        onChange={() => {}}
        editing
        onEditingChange={() => {}}
      />,
    );
    const grid = container.querySelector("#g")!;
    expect(grid.className).toContain("@container");

    const html = container.innerHTML;
    for (const viewportSized of [
      "lg:col-span-",
      "lg:row-span-",
      "lg:grid-cols-",
      "lg:auto-rows-",
    ]) {
      expect(html, viewportSized).not.toContain(viewportSized);
    }
  });
});
