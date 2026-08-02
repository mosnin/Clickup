import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { act } from "react";
import { DashboardShell, calls, queryResults, resetHarness } from "./harness";
import {
  MintablePanelsProvider,
  useMintableBuiltIn,
} from "@/components/appearance/mintable-panels";
import { panelWidgetId } from "@/lib/panel";

// Is the project screen's chart control actually live?
//
// The pure half of this is a table lookup and a normalizer, and both were green
// on Home for a week while the control did nothing at all — because the wiring
// between the screen and the studio is where it breaks. It broke once already
// in a way no unit test could see: claiming a grid changed the context value
// the registering effect depended on, so the screen registered and unregistered
// on a loop and the studio, mounting in one of the gaps, read nothing.
//
// So this renders the real ProjectScreen inside the real registry and asks the
// studio's own hook the question the studio asks: is there something to mint
// for the selected tile, and does choosing it put the panel where the built-in
// was standing.
//
// What it cannot answer, stated plainly: jsdom has no layout, so nothing here
// says the shelf is on screen or reachable. That is what
// `scripts/design-shots.mjs` is for.

vi.mock("@/components/motion", async () => await import("./motion-mock"));

const { ProjectScreen } = await import(
  "@/components/dashboard/project-screen/project-screen"
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
const GRID = "project-screen-grid";

/** The studio's own view of the selection, exposed to the test. */
let seen: ReturnType<typeof useMintableBuiltIn> = null;
function Studio({ selectionId }: { selectionId: string }) {
  seen = useMintableBuiltIn(selectionId);
  return null;
}

function renderScreen(selectionId: string) {
  seen = null;
  return render(
    <MintablePanelsProvider>
      <ProjectScreen
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the
        // fixture is the shape `projects.get` returns, minus the columns this
        // screen never reads.
        project={PROJECT as any}
        lists={[]}
        spaceId={"s1" as never}
        spaceName="HQ"
        scope={SCOPE}
      />
      {/* A sibling, exactly as the studio sits beside the page in the
          dashboard layout — a provider rendered by the screen could never
          reach it, which is why the registry exists at all. */}
      <Studio selectionId={selectionId} />
    </MintablePanelsProvider>,
    { wrapper: DashboardShell },
  );
}

beforeEach(() => {
  resetHarness();
  queryResults["screens.layoutFor"] = null;
  queryResults["screens.proposalsFor"] = [];
  queryResults["uiComponents.listForScope"] = [];
  queryResults["projects.rollupsForProject"] = [];
  queryResults["plans.forProject"] = [];
  queryResults["events.forProject"] = [];
  queryResults["appearance.forCurrentUser"] = {};
});

describe("the project screen offers its built-ins", () => {
  it("has a question for progress, narrowed to this project", () => {
    renderScreen(`${GRID}:progress`);
    expect(seen).not.toBeNull();
    expect(seen!.scope).toEqual(SCOPE);
    const q = seen!.question.query;
    expect(q.from).toBe("tasks");
    // The narrowing is the whole reason the question is honest: without it the
    // panel answers about the entire workspace under a project's heading.
    expect(q.filter.scopeToKind).toBe("project");
    expect(q.filter.scopeToId).toBe("p1");
    expect(q.filter.status).toBe("any");
    expect(q.dimension).toBe("status");
  });

  it("has nothing to mint for the widgets that ask no question", () => {
    for (const id of ["about", "lists", "plan", "activity", "pages"]) {
      renderScreen(`${GRID}:${id}`).unmount();
      expect(seen, id).toBeNull();
    }
  });

  it("ignores a selection belonging to another screen", () => {
    renderScreen("home-grid:progress");
    expect(seen).toBeNull();
  });

  it("puts the minted panel in the built-in's slot", () => {
    renderScreen(`${GRID}:progress`);
    act(() => {
      seen!.replace("abc123");
    });
    const saved = calls("screens.saveLayout").at(-1) as {
      screenKey: string;
      layout: { widgets: { id: string; span: number }[] };
    };
    expect(saved.screenKey).toBe("project:p1");
    const ids = saved.layout.widgets.map((w) => w.id);
    expect(ids).toContain(panelWidgetId("abc123"));
    expect(ids).not.toContain("progress");
    // The slot, not the end of the screen: a swap that appends looks like it
    // worked and leaves the new panel where nobody is looking.
    expect(ids.indexOf(panelWidgetId("abc123"))).toBe(1);
  });
});
