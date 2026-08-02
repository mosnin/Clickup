import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  DashboardShell,
  calls,
  mutationCalls,
  queryResults,
  resetHarness,
} from "./harness";
import { panelWidgetId } from "@/lib/panel";

// A panel that arrives because something became true.
//
// The pure half — whether to interrupt somebody at all — is proven in
// `tests/situation-arrival.test.ts`. What can only be proven here is the wiring
// the predicate assumes and cannot check:
//
//   - that a screen with no subscriptions is byte-for-byte the screen that
//     shipped before this existed;
//   - that Preview puts the panel in the REAL grid and writes nothing, so
//     looking is not consenting;
//   - that Keep writes the acceptor's own layout, from the client, because the
//     server cannot tell "never arranged this screen" from "arranged it empty";
//   - and that a kept panel does not vanish when its condition stops holding.
//
// What it cannot answer, stated plainly: jsdom has no layout, so nothing here
// says the arriving panel lands somewhere that does not overlap its
// neighbours. That is `scripts/verify-situation.mjs`.

vi.mock("@/components/motion", async () => await import("./motion-mock"));

// anime's draggable builds a `DOMPoint`, which jsdom does not have — so a grid
// rendered in edit mode throws before any assertion runs. Stubbed to the same
// shape `editable-grid.test.tsx` uses: `morphLayout` still applies its change
// synchronously, which is all these tests read.
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
  wake: () => {},
}));

const { ProjectScreen } = await import(
  "@/components/dashboard/project-screen/project-screen"
);
const { EditableGrid } = await import(
  "@/components/dashboard/screen/editable-grid"
);

const PROJECT = {
  _id: "p1",
  _creationTime: 0,
  name: "Billing migration",
  spaceId: "s1",
  position: 0,
  createdAt: 1,
  description: undefined,
  projectStatus: undefined,
  notes: undefined,
  ownerActorId: undefined,
  targetDate: undefined,
};

const SCOPE = { scopeType: "workspace" as const, scopeId: "w1" };
const PANEL_ID = "blocked-now";
const WIDGET_ID = panelWidgetId(PANEL_ID);
const CONDITION = "Blocked tasks reached 3";

/** A panel definition the screen can actually resolve and draw. */
const PANEL_ROW = {
  componentId: PANEL_ID,
  definition: {
    title: "Blocked right now",
    shape: "list",
    query: { from: "tasks", filter: { status: "open", blocked: true } },
  },
  authoredByName: undefined,
};

function situation(over: Record<string, unknown> = {}) {
  return {
    subscriptionId: "sub1",
    panelId: WIDGET_ID,
    scopeType: "workspace",
    scopeId: "w1",
    situation: {
      id: "blocked",
      label: "Blocked tasks",
      query: {},
      compare: "at_least",
      threshold: 3,
    },
    description: CONDITION,
    isTrue: true,
    value: 3,
    becameTrueAt: 1_000,
    becameFalseAt: null,
    acknowledgedAt: null,
    resolution: null,
    lastCheckedAt: 1_000,
    ...over,
  };
}

function renderScreen() {
  return render(
    <ProjectScreen
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the
      // fixture is the shape `projects.get` returns, minus the columns this
      // screen never reads.
      project={PROJECT as any}
      lists={[]}
      spaceId={"s1" as never}
      spaceName="HQ"
      scope={SCOPE}
    />,
    { wrapper: DashboardShell },
  );
}

/** The ids the grid actually drew, in order. */
function tileIds(): string[] {
  return Array.from(document.querySelectorAll("[data-tile]")).map(
    (el) => (el as HTMLElement).dataset.tile ?? "",
  );
}

/**
 * Press a button and let every resulting state change flush.
 *
 * Async because answering an announcement awaits the acknowledgement before it
 * places anything — the other order puts a panel on somebody's screen and then
 * discovers it could not remember being told to.
 */
async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

function savedLayoutIds(): string[] {
  const saved = calls("screens.saveLayout").at(-1) as
    | { layout: { widgets: { id: string }[] } }
    | undefined;
  return (saved?.layout.widgets ?? []).map((w) => w.id);
}

beforeEach(() => {
  resetHarness();
  queryResults["screens.layoutFor"] = null;
  queryResults["screens.proposalsFor"] = [];
  queryResults["uiComponents.proposalsFor"] = [];
  queryResults["uiComponents.listForScope"] = [PANEL_ROW];
  queryResults["projects.rollupsForProject"] = [];
  queryResults["plans.forProject"] = [];
  queryResults["events.forProject"] = [];
  queryResults["appearance.forCurrentUser"] = {};
  queryResults["situations.forScreen"] = [];
});

describe("absence means always-on", () => {
  it("draws exactly the screen that shipped when nothing is subscribed", () => {
    // The rule this codebase has already paid for twice. Someone who never
    // opted in must not be able to tell this feature was added.
    renderScreen();
    const withoutSituations = tileIds();
    expect(screen.queryByText(CONDITION)).toBeNull();
    expect(screen.queryByRole("button", { name: "Keep" })).toBeNull();
    expect(withoutSituations).not.toContain(WIDGET_ID);
    // And nothing was written. A feature that "does nothing" while saving a
    // layout has still changed the product for somebody who never asked.
    expect(mutationCalls).toEqual([]);
  });

  it("draws the same screen while the subscriptions are still loading", () => {
    renderScreen();
    const settled = tileIds();
    resetHarness();
    queryResults["screens.layoutFor"] = null;
    queryResults["screens.proposalsFor"] = [];
    queryResults["uiComponents.proposalsFor"] = [];
    queryResults["uiComponents.listForScope"] = [PANEL_ROW];
    queryResults["appearance.forCurrentUser"] = {};
    // `situations.forScreen` deliberately unset — the loading state.
    document.body.innerHTML = "";
    renderScreen();
    expect(tileIds()).toEqual(settled);
    expect(screen.queryByRole("button", { name: "Keep" })).toBeNull();
  });

  it("says nothing about a condition that is false", () => {
    queryResults["situations.forScreen"] = [situation({ isTrue: false })];
    renderScreen();
    expect(screen.queryByText(CONDITION)).toBeNull();
  });
});

describe("an arrival announces the condition, not the panel", () => {
  beforeEach(() => {
    queryResults["situations.forScreen"] = [situation()];
  });

  it("says what became true, in the words of the condition", () => {
    renderScreen();
    // "Blocked tasks reached 3" tells a reader what changed in their work.
    // "Blocked right now is available" — the panel's own title — does not,
    // which is why the panel's name is deliberately absent from the sentence.
    expect(screen.getByText(CONDITION, { exact: false })).toBeTruthy();
    expect(screen.queryByText(/Blocked right now/)).toBeNull();
  });

  it("offers the same three answers a screen proposal does", () => {
    renderScreen();
    for (const label of ["Preview", "Not now", "Keep"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("says nothing about a panel already on the screen", () => {
    queryResults["screens.layoutFor"] = {
      layout: { widgets: [{ id: WIDGET_ID, span: 2 }] },
    };
    renderScreen();
    expect(screen.queryByText(CONDITION)).toBeNull();
  });

  it("says nothing about a panel that no longer resolves", () => {
    // A subscription can outlive the panel it points at. Consenting to
    // something and getting an empty tile is worse than never being asked.
    queryResults["uiComponents.listForScope"] = [];
    renderScreen();
    expect(screen.queryByText(CONDITION)).toBeNull();
  });

  it("stays quiet once the occurrence has been answered", () => {
    // The durability, through the real component rather than the predicate:
    // the sweep keeps re-measuring the same true condition, and a dismissal
    // that only lived in state would put this banner back on every one.
    queryResults["situations.forScreen"] = [
      situation({ acknowledgedAt: 1_000, resolution: "dismissed" }),
    ];
    renderScreen();
    expect(screen.queryByText(CONDITION)).toBeNull();
  });

  it("speaks again once the condition has cleared and returned", () => {
    queryResults["situations.forScreen"] = [
      situation({
        acknowledgedAt: 1_000,
        resolution: "dismissed",
        becameFalseAt: 2_000,
        becameTrueAt: 3_000,
      }),
    ];
    renderScreen();
    expect(screen.getByText(CONDITION, { exact: false })).toBeTruthy();
  });
});

describe("previewing is looking, not consenting", () => {
  beforeEach(() => {
    queryResults["situations.forScreen"] = [situation()];
  });

  it("puts the panel in the real grid", async () => {
    // Not a mockup beside the screen: the panel goes on the canvas, at the
    // size it would really occupy, drawing this scope's real data. A suggested
    // panel is exactly as good as what it says about your own work.
    renderScreen();
    expect(tileIds()).not.toContain(WIDGET_ID);
    await click("Preview");
    expect(tileIds()).toContain(WIDGET_ID);
  });

  it("writes nothing", async () => {
    renderScreen();
    await click("Preview");
    expect(calls("screens.saveLayout")).toEqual([]);
    expect(calls("situations.acknowledge")).toEqual([]);
  });

  it("takes it back off again", async () => {
    renderScreen();
    await click("Preview");
    await click("Show mine");
    expect(tileIds()).not.toContain(WIDGET_ID);
    expect(calls("screens.saveLayout")).toEqual([]);
  });
});

describe("keeping it is the acceptor's own layout, written by the client", () => {
  beforeEach(() => {
    queryResults["situations.forScreen"] = [situation()];
  });

  it("records the answer and places the panel", async () => {
    renderScreen();
    await click("Keep");
    expect(calls("situations.acknowledge")).toEqual([
      { subscriptionId: "sub1", resolution: "kept" },
    ]);
    // The client places it. The server cannot tell "never arranged this
    // screen" from "arranged it empty", so a server that helpfully wrote a
    // layout row holding the one new panel would wipe a screen down to it.
    expect(savedLayoutIds()).toContain(WIDGET_ID);
    // …onto the arrangement that was already there, not instead of it.
    expect(savedLayoutIds().length).toBeGreaterThan(1);
  });

  it("dismisses without touching the layout", async () => {
    renderScreen();
    await click("Not now");
    expect(calls("situations.acknowledge")).toEqual([
      { subscriptionId: "sub1", resolution: "dismissed" },
    ]);
    expect(calls("screens.saveLayout")).toEqual([]);
  });
});

describe("a kept panel does not leave by itself", () => {
  const departed = situation({
    isTrue: false,
    becameFalseAt: 2_000,
    acknowledgedAt: 1_000,
    resolution: "kept",
  });

  beforeEach(() => {
    queryResults["situations.forScreen"] = [departed];
    queryResults["screens.layoutFor"] = {
      layout: { widgets: [{ id: "about", span: 1 }, { id: WIDGET_ID, span: 2 }] },
    };
  });

  it("leaves the panel exactly where the reader put it", () => {
    // The decision, stated as a test: the panel is in their layout, written by
    // their own consent, indistinguishable from one they added from the tray.
    // A layout that edits itself is the adaptive UI this codebase rejects, and
    // it is no less adaptive for being a removal.
    renderScreen();
    expect(tileIds()).toContain(WIDGET_ID);
    expect(calls("screens.saveLayout")).toEqual([]);
  });

  it("tells the reader the reason has expired", () => {
    renderScreen();
    expect(screen.getByText(CONDITION, { exact: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove it" })).toBeTruthy();
  });

  it("removes it only when asked, and records having said so", async () => {
    renderScreen();
    await click("Remove it");
    expect(savedLayoutIds()).not.toContain(WIDGET_ID);
    expect(savedLayoutIds()).toContain("about");
    expect(calls("situations.acknowledge")).toEqual([{ subscriptionId: "sub1" }]);
  });

  it("keeps quiet once the note has been acknowledged", () => {
    queryResults["situations.forScreen"] = [
      situation({
        isTrue: false,
        becameFalseAt: 2_000,
        acknowledgedAt: 2_000,
        resolution: "kept",
      }),
    ];
    renderScreen();
    expect(screen.queryByText(CONDITION)).toBeNull();
    expect(tileIds()).toContain(WIDGET_ID);
  });

  it("says nothing about a panel that was only ever previewed", () => {
    // Nothing was written, so there is nothing standing on the screen for a
    // departure note to be about.
    queryResults["situations.forScreen"] = [
      situation({ isTrue: false, becameFalseAt: 2_000, resolution: null }),
    ];
    renderScreen();
    expect(screen.queryByText(CONDITION)).toBeNull();
  });
});

describe("a preview withdraws when its condition stops holding", () => {
  it("steps back off the canvas and says why, saving nothing", async () => {
    // A preview is only honest while the thing it previews is still on offer.
    // Nothing is written because nothing ever was — the panel was never theirs.
    queryResults["situations.forScreen"] = [situation()];
    const view = renderScreen();
    await click("Preview");
    expect(tileIds()).toContain(WIDGET_ID);

    queryResults["situations.forScreen"] = [
      situation({ isTrue: false, becameFalseAt: 2_000 }),
    ];
    // Rerendered WITHOUT re-wrapping: passing the wrapper again would put a
    // second shell at that position, which React reconciles as a different
    // element and remounts the screen — losing the very preview state this is
    // about, and passing for the wrong reason.
    await act(async () => {
      view.rerender(
        <ProjectScreen
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          project={PROJECT as any}
          lists={[]}
          spaceId={"s1" as never}
          spaceName="HQ"
          scope={SCOPE}
        />,
      );
    });

    expect(tileIds()).not.toContain(WIDGET_ID);
    expect(screen.getByText(/the preview stepped back/i)).toBeTruthy();
    expect(calls("screens.saveLayout")).toEqual([]);
  });
});


describe("any grid announces — that is the whole mechanism", () => {
  // The claim that makes a third surface free, and the gap this closed: the
  // banner was wired into the project screen only, so Home — where a person can
  // AUTHOR a condition — could never hear one fire. Half a loop, and exactly
  // the failure "a feature that can only be configured from one special screen
  // has not been built dynamically" names.
  //
  // Rendered here with nothing but a grid: no screen component, no hook call,
  // no wiring. If this passes, every surface that draws an `EditableGrid` has
  // arrivals, and the next one costs a `screenKey`.

  const GRID_TILES = [
    {
      id: "a",
      span: 1 as const,
      title: "Placed",
      minSpan: 1 as const,
      maxSpan: 3 as const,
      rows: 1 as const,
      content: <div>placed body</div>,
    },
    {
      id: "offered",
      span: 2 as const,
      title: "Offered",
      minSpan: 1 as const,
      maxSpan: 3 as const,
      rows: 1 as const,
      content: <div>offered body</div>,
    },
  ];
  const GRID_LAYOUT = { widgets: [{ id: "a", span: 1 as const }] };

  function renderGrid(
    onChange: (next: { widgets: { id: string }[] }) => void = () => {},
    over: Record<string, unknown> = {},
  ) {
    return render(
      <EditableGrid
        gridId="g"
        screenKey="anywhere"
        tiles={GRID_TILES}
        layout={GRID_LAYOUT}
        onChange={onChange}
        {...over}
      />,
      { wrapper: DashboardShell },
    );
  }

  beforeEach(() => {
    queryResults["situations.forScreen"] = [
      situation({ panelId: "offered" }),
    ];
  });

  it("offers the panel with no help from its caller", () => {
    renderGrid();
    expect(screen.getByText(CONDITION, { exact: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep" })).toBeTruthy();
  });

  it("previews it into its own canvas", async () => {
    renderGrid();
    expect(tileIds()).toEqual(["a"]);
    await click("Preview");
    expect(tileIds()).toContain("offered");
  });

  it("refuses every other edit while an offer is on the canvas", async () => {
    // The guard used to be restated in each caller, which is the shape that
    // guarantees the next surface forgets it. The grid is the only thing that
    // knows a panel has been offered and not accepted, so it owns the refusal —
    // otherwise a drag or a resize saves the offered panel as part of the
    // reader's screen.
    const saves: { widgets: { id: string }[] }[] = [];
    renderGrid((next) => saves.push(next), { editing: true });
    await click("Preview");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /^Remove Placed/ }));
    });
    expect(saves).toEqual([]);
  });

  it("hands the placement back out through onChange", async () => {
    const saves: { widgets: { id: string }[] }[] = [];
    renderGrid((next) => saves.push(next));
    await click("Keep");
    expect(saves).toHaveLength(1);
    expect(saves[0].widgets.map((w) => w.id)).toEqual(["a", "offered"]);
  });

  it("stays quiet while the layout it is drawing is not the reader's", () => {
    // An agent's proposal on the canvas. Offering a panel would place it into
    // that proposal, and the surface would refuse the write — leaving somebody
    // having answered a question whose answer went nowhere.
    renderGrid(() => {}, { layoutIsProvisional: true });
    expect(screen.queryByText(CONDITION)).toBeNull();
  });

  it("draws exactly the grid that shipped when nothing is subscribed", () => {
    queryResults["situations.forScreen"] = [];
    renderGrid();
    expect(tileIds()).toEqual(["a"]);
    expect(screen.queryByRole("button", { name: "Keep" })).toBeNull();
  });
});
