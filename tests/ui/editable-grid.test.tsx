import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

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

vi.mock("@/components/motion", () => ({
  SPRING: { duration: 0 },
}));

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
    stubGridWidth(900); // one column = 300px

    const grip = screen.getByLabelText(/Resize Progress/i);
    grip.dispatchEvent(pointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
    // Cross two column boundaries on the way out: 1 -> 2 -> 3.
    window.dispatchEvent(pointerEvent("pointermove", { clientX: 300, clientY: 0 }));
    window.dispatchEvent(pointerEvent("pointermove", { clientX: 620, clientY: 0 }));
    expect(
      onChange,
      "nothing may be written while the gesture is still in flight",
    ).not.toHaveBeenCalled();

    window.dispatchEvent(pointerEvent("pointerup", { clientX: 620, clientY: 0 }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual({
      widgets: [{ id: "a", span: 3 }],
    });
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
    stubGridWidth(900);
    const tile = document.querySelector<HTMLElement>('[data-tile="a"]')!;
    expect(tile.className).toContain("lg:col-span-1");

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
    expect(live.className).toContain("lg:col-span-2");
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
    stubGridWidth(900);
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
    expect(tile.className).toContain("lg:col-span-1");
  });

  it("still resizes from the keyboard-reachable buttons", () => {
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
    screen.getByLabelText(/wider/i).click();
    expect(onChange).toHaveBeenCalledWith(
      { widgets: [{ id: "a", span: 2 }] },
      undefined,
    );
  });
});
