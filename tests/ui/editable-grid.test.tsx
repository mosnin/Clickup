import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

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
