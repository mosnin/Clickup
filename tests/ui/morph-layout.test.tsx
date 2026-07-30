import { beforeEach, describe, expect, it, vi } from "vitest";

// morphLayout's lifecycle contract.
//
// The bug this pins down is invisible to types, lint and the build, and it is
// the one that produces the screenshots people report: panels overlapping, the
// shell offset by a sidebar's width, tiles left mid-flight.
//
// `AutoLayout` stamps a `data-layout-id` attribute on every element it records
// and holds those elements in a Map keyed by that id. `revert()` is what
// removes the attributes, completes the timeline and un-mutes the CSS
// transitions it silenced while measuring. We never called it — so every morph
// leaked an instance, and two overlapping morphs (a sidebar drop while the
// grid reflows, a scope switch mid-resize) each read ids written by the other
// and looked them up in their own map, where they do not exist.

type FakeLayout = {
  record: ReturnType<typeof vi.fn>;
  animate: ReturnType<typeof vi.fn>;
  revert: ReturnType<typeof vi.fn>;
  /** Fire the animation's completion, as anime.js would. */
  complete: () => void;
};

const created: FakeLayout[] = [];

vi.mock("animejs", () => {
  const makeLayout = (): FakeLayout => {
    let onComplete: (() => void) | undefined;
    const layout: FakeLayout = {
      record: vi.fn(),
      animate: vi.fn((params?: { onComplete?: () => void }) => {
        onComplete = params?.onComplete;
      }),
      revert: vi.fn(),
      complete: () => onComplete?.(),
    };
    return layout;
  };
  return {
    animate: vi.fn(),
    createAnimatable: vi.fn(() => ({ revert() {} })),
    createDraggable: vi.fn(() => ({ revert() {} })),
    createLayout: vi.fn(() => {
      const layout = makeLayout();
      created.push(layout);
      return layout;
    }),
    createScope: vi.fn(() => ({ revert() {} })),
    createSpring: vi.fn(() => ({})),
    stagger: vi.fn(() => 0),
    svg: { createDrawable: vi.fn(() => []) },
    text: { scrambleText: vi.fn(() => () => "") },
    utils: {
      set: vi.fn(),
      clamp: (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi),
      get: vi.fn(() => "0"),
      remove: vi.fn(),
      $: vi.fn(() => []),
    },
  };
});

const { morphLayout } = await import("@/lib/anime");

/** Run the rAF callback morphLayout schedules. */
function flushFrame() {
  const raf = globalThis.requestAnimationFrame as unknown as {
    mock?: { calls: [FrameRequestCallback][] };
  };
  const calls = raf.mock?.calls ?? [];
  const last = calls[calls.length - 1];
  if (last) last[0](0);
}

beforeEach(() => {
  created.length = 0;
  document.body.innerHTML = '<main id="root"><div id="a"></div></main>';
  document.documentElement.style.setProperty("--ui-motion-scale", "1");
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
});

describe("morphLayout", () => {
  it("reverts the layout when its animation completes", () => {
    morphLayout("#root", () => {});
    flushFrame();
    const [layout] = created;
    expect(layout.record).toHaveBeenCalled();
    expect(layout.animate).toHaveBeenCalled();
    // Not yet: the animation is still running.
    expect(layout.revert).not.toHaveBeenCalled();

    layout.complete();
    expect(
      layout.revert,
      "an un-reverted layout leaves data-layout-id on every element it touched",
    ).toHaveBeenCalledTimes(1);
  });

  it("reverts the previous layout before starting a new one on the same root", () => {
    morphLayout("#root", () => {});
    flushFrame();
    // A second change arrives before the first has finished animating — a
    // sidebar drop while the grid is still reflowing, say.
    morphLayout("#root", () => {});
    flushFrame();

    expect(created).toHaveLength(2);
    expect(
      created[0].revert,
      "the abandoned layout must give its ids and transitions back",
    ).toHaveBeenCalled();
    expect(created[1].animate).toHaveBeenCalled();
  });

  it("does not let a superseded layout animate or clean up after its replacement", () => {
    morphLayout("#root", () => {});
    const stale = created[0];
    // Replaced before its frame ever ran.
    morphLayout("#root", () => {});
    flushFrame();

    expect(stale.animate).not.toHaveBeenCalled();
    expect(created[1].animate).toHaveBeenCalled();

    // And when the stale one's completion fires late, it must not evict the
    // live layout from the registry.
    stale.complete();
    morphLayout("#root", () => {});
    flushFrame();
    expect(created[1].revert).toHaveBeenCalled();
  });

  it("still runs the change when the root is not in the document", () => {
    const change = vi.fn();
    morphLayout("#nope", change);
    expect(change).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(0);
  });

  it("runs the change exactly once, animated or not", () => {
    const change = vi.fn();
    morphLayout("#root", change);
    flushFrame();
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("skips anime entirely when motion is off", () => {
    document.documentElement.style.setProperty("--ui-motion-scale", "0");
    const change = vi.fn();
    morphLayout("#root", change);
    expect(change).toHaveBeenCalledTimes(1);
    expect(
      created,
      "a motion scale of zero means instant, not a zero-length animation",
    ).toHaveLength(0);
  });
});
