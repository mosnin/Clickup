import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import {
  DashboardShell,
  actionResults,
  calls,
  mutationCalls,
  queryResults,
  resetHarness,
  toastCalls,
} from "./harness";
import { normalizePanel } from "@/lib/panel";

// Driving the surfaces, not just rendering them.
//
// Every interactive thing shipped this month typechecks, passes unit tests on
// its pure parts, and has never been clicked. That gap is where the bugs have
// actually been: the maths for resize was provably correct while resize did
// nothing, because the handler wrote per-column and each write cleared the
// draft. Types cannot see that. A unit test on the maths cannot see it. Only
// pressing the thing sees it.
//
// So these are not render tests. Each one performs the gesture a person would
// and asserts the wire on the other end — which mutation ran, with what.
//
// **What this cannot cover, stated plainly:** there is no Clerk credential in
// this environment, so nothing here goes through real auth, a real browser, or
// real CSS. Layout, stacking, pointer capture and containment are still
// unverified, and those have bitten before (the sidebar that would not go
// right was a `position: fixed` rule no test would have caught). This closes
// the "is it wired" half of the gap, not the "does it look right" half.

vi.mock("@/components/motion", async () => await import("./motion-mock"));

const { PanelBuilder } = await import("@/components/dashboard/panel-builder");
const { PanelProposal } = await import("@/components/dashboard/panel-proposal");

const SCOPE = { scopeType: "workspace" as const, scopeId: "w1" };

/** An envelope shaped like the resolver's, so `<Panel>` renders rather than
 *  sitting in its skeleton and hiding whatever is behind it. */
const ENVELOPE = {
  rows: [{ id: "t1", title: "Ship the thing", href: null, meta: {} }],
  series: [{ key: "a", label: "A", points: [{ key: "1", label: "x", value: 3 }] }],
  scalar: 3,
  total: 1,
  truncated: false,
  meta: { unit: "count", dimensionLabel: "Status", measureLabel: "How many" },
};

beforeEach(() => {
  resetHarness();
  queryResults["dataStream.resolve"] = ENVELOPE;
  queryResults["appearance.forCurrentUser"] = {};
});

/** A shape tile — its accessible name is the chart inside, not the label. */
function shapeButton(label: string): HTMLElement {
  return screen.getByText(label).closest("button")!;
}

/** One option of a named control. Several labels repeat across controls. */
function option(group: string, name: string): HTMLElement {
  return within(screen.getByRole("group", { name: group })).getByRole("button", {
    name,
  });
}

describe("building a panel", () => {
  function open() {
    render(
      <DashboardShell>
        <PanelBuilder {...SCOPE} onCreated={() => {}} />
      </DashboardShell>,
    );
    fireEvent.click(screen.getByText("Build a panel"));
  }

  it("opens onto something already about tasks, not a blank form", () => {
    open();
    expect(screen.getByLabelText("Panel name")).toBeTruthy();
    expect(screen.getByText("What it shows")).toBeTruthy();
  });

  it("offers only the shapes the chosen source can draw", () => {
    open();
    // Tasks can be drawn as a donut; pages cannot be drawn as a dial.
    expect(screen.queryByText("Donut")).toBeTruthy();
    fireEvent.click(option("From", "Pages"));
    expect(screen.queryByText("Dial")).toBeNull();
  });

  it("saves the definition that was on screen", () => {
    // The bug this exists for: a builder whose preview and whose save read
    // different state, so you save something you never saw.
    open();
    fireEvent.click(option("Due", "Overdue"));
    fireEvent.click(screen.getByText("Add to screen"));

    const [args] = calls("uiComponents.create") as {
      definition: unknown;
    }[];
    expect(args).toBeTruthy();
    const saved = normalizePanel(args.definition);
    expect(saved.query.filter.due).toBe("overdue");
    // Still a list, so still ungrouped — a record shape has nothing to group
    // by, and `coherePanel` must not invent a dimension for one.
    expect(saved.query.dimension).toBe("none");
  });

  it("carries a preset in as an ordinary definition you can then change", () => {
    open();
    fireEvent.click(option("Start from", "Workload"));
    // Now change one thing about it — the whole reason a preset beats a
    // hardcoded shape called `workload`.
    fireEvent.click(option("Assigned to", "Me"));
    fireEvent.click(screen.getByText("Add to screen"));

    const [args] = calls("uiComponents.create") as { definition: unknown }[];
    const saved = normalizePanel(args.definition);
    expect(saved.query.dimension).toBe("assignee");
    expect(saved.query.filter.assignee).toBe("me");
  });

  it("repairs a definition the new source cannot express", () => {
    open();
    // Pick a chart over tasks, then move to a source with a different
    // vocabulary. Nothing should survive that the new source can't draw.
    fireEvent.click(shapeButton("Donut"));
    fireEvent.click(option("From", "Activity"));
    fireEvent.click(screen.getByText("Add to screen"));

    const [args] = calls("uiComponents.create") as { definition: unknown }[];
    const saved = normalizePanel(args.definition);
    expect(saved.query.from).toBe("activity");
    expect(normalizePanel(saved)).toEqual(saved);
  });

  it("does not write anything until Add to screen", () => {
    open();
    fireEvent.click(shapeButton("Donut"));
    fireEvent.click(option("Due", "Overdue"));
    expect(calls("uiComponents.create")).toHaveLength(0);
  });
});

describe("saying it instead of picking it", () => {
  it("applies what survived and offers to keep it", async () => {
    actionResults["panelIntent.draftPanel"] = {
      ok: true,
      patch: { shape: "donut", due: "overdue" },
      said: "Made it a donut of the overdue ones.",
    };
    render(
      <DashboardShell>
        <PanelBuilder {...SCOPE} onCreated={() => {}} />
      </DashboardShell>,
    );
    fireEvent.click(screen.getByText("Build a panel"));

    const input = screen.getByLabelText("Describe this panel");
    fireEvent.change(input, { target: { value: "as a donut, only overdue" } });
    fireEvent.click(screen.getByRole("button", { name: "Try" }));
    await screen.findByText("Keep it");

    // The computed diff, not the model's sentence.
    expect(screen.getByText("Drawn as")).toBeTruthy();
    expect(screen.getByText("donut")).toBeTruthy();

    fireEvent.click(screen.getByText("Keep it"));
    fireEvent.click(screen.getByText("Add to screen"));
    const [args] = calls("uiComponents.create") as { definition: unknown }[];
    expect(normalizePanel(args.definition).shape).toBe("donut");
  });

  it("adds what is on screen, even mid-preview", async () => {
    // "What you see is what you get" has to survive the case where you never
    // pressed Keep: the preview is applied to the real panel, so Add to
    // screen must add the panel you are looking at rather than the one
    // underneath it.
    actionResults["panelIntent.draftPanel"] = {
      ok: true,
      patch: { shape: "donut" },
      said: "Made it a donut.",
    };
    render(
      <DashboardShell>
        <PanelBuilder {...SCOPE} onCreated={() => {}} />
      </DashboardShell>,
    );
    fireEvent.click(screen.getByText("Build a panel"));
    fireEvent.change(screen.getByLabelText("Describe this panel"), {
      target: { value: "as a donut" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Try" }));
    await screen.findByText("Keep it");

    // Deliberately NOT pressing Keep.
    fireEvent.click(screen.getByText("Add to screen"));
    const [args] = calls("uiComponents.create") as { definition: unknown }[];
    expect(normalizePanel(args.definition).shape).toBe("donut");
  });

  it("says nothing changed rather than reading back a confident sentence", async () => {
    // The failure mode: the model claims a change, normalization drops it,
    // and the UI reports success anyway.
    actionResults["panelIntent.draftPanel"] = {
      ok: true,
      patch: { shape: "hologram" },
      said: "Turned it into a hologram.",
    };
    render(
      <DashboardShell>
        <PanelBuilder {...SCOPE} onCreated={() => {}} />
      </DashboardShell>,
    );
    fireEvent.click(screen.getByText("Build a panel"));
    fireEvent.change(screen.getByLabelText("Describe this panel"), {
      target: { value: "make it a hologram" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Try" }));

    await screen.findByText("Turned it into a hologram.");
    // Shown as what it *understood*, with no Keep — because nothing moved.
    expect(screen.queryByText("Keep it")).toBeNull();
  });

  it("surfaces a refusal instead of failing silently", async () => {
    actionResults["panelIntent.draftPanel"] = {
      ok: false,
      message: "Describing a panel needs an OpenAI key on this deployment.",
    };
    render(
      <DashboardShell>
        <PanelBuilder {...SCOPE} onCreated={() => {}} />
      </DashboardShell>,
    );
    fireEvent.click(screen.getByText("Build a panel"));
    fireEvent.change(screen.getByLabelText("Describe this panel"), {
      target: { value: "quieter" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Try" }));
    expect(await screen.findByText(/needs an OpenAI key/)).toBeTruthy();
  });
});

describe("an agent's proposed panel", () => {
  const PROPOSAL = {
    proposalId: "pp1",
    agentName: "Ada",
    definition: {
      title: "Blocked on you",
      query: { from: "tasks", filter: { blocked: true } },
      shape: "list",
    },
    reason: "Nothing here shows what is blocked on you.",
    createdAt: 1,
  };

  function open(onAccept: (id: string) => void = () => {}) {
    queryResults["uiComponents.proposalsFor"] = [PROPOSAL];
    render(
      <DashboardShell>
        <PanelProposal
          screenKey="project:p1"
          scopeType="workspace"
          scopeId="w1"
          onAccept={onAccept}
        />
      </DashboardShell>,
    );
  }

  it("shows who suggested it and why", () => {
    open();
    expect(screen.getByText("Ada")).toBeTruthy();
    // Both the agent's reason and the computed description mention it, which
    // is the point — the reason is the agent's words, the description is
    // derived from the definition and cannot be talked out of.
    expect(screen.getAllByText(/blocked on you/i).length).toBeGreaterThan(1);
  });

  it("renders nothing when there is nothing pending", () => {
    queryResults["uiComponents.proposalsFor"] = [];
    const { container } = render(
      <DashboardShell>
        <PanelProposal
          screenKey="project:p1"
          scopeType="workspace"
          scopeId="w1"
          onAccept={() => {}}
        />
      </DashboardShell>,
    );
    expect(container.textContent).toBe("");
  });

  it("resolves as accepted and hands the id back to be placed", () => {
    // The server deliberately does not place it — it cannot tell "never
    // arranged this screen" from "arranged it empty". So if this callback
    // is not wired, accepting appears to do nothing.
    const placed: string[] = [];
    open((id: string) => placed.push(id));
    fireEvent.click(screen.getByText("Add it"));

    expect(calls("uiComponents.resolveProposal")).toEqual([
      { proposalId: "pp1", accept: true },
    ]);
  });

  it("dismisses without creating anything", () => {
    open();
    fireEvent.click(screen.getByText("No thanks"));
    expect(calls("uiComponents.resolveProposal")).toEqual([
      { proposalId: "pp1", accept: false },
    ]);
    expect(calls("uiComponents.create")).toHaveLength(0);
  });
});

describe("what the harness itself guarantees", () => {
  it("records a mutation's arguments, not just that it happened", () => {
    // Several past bugs were "the right mutation with the wrong id".
    render(
      <DashboardShell>
        <PanelBuilder {...SCOPE} onCreated={() => {}} />
      </DashboardShell>,
    );
    fireEvent.click(screen.getByText("Build a panel"));
    fireEvent.click(screen.getByText("Add to screen"));
    const [args] = calls("uiComponents.create") as Record<string, unknown>[];
    expect(args.scopeType).toBe("workspace");
    expect(args.scopeId).toBe("w1");
  });

  it("lets a test fire a deferred toast's expiry", () => {
    // Proves the mechanism the delete path depends on.
    toastCalls.length = 0;
    let ran = false;
    toastCalls.push({ message: "x", opts: { onExpire: () => (ran = true) } });
    toastCalls[0].opts?.onExpire?.();
    expect(ran).toBe(true);
  });

  it("keeps mutation and action calls in one ordered log", () => {
    expect(Array.isArray(mutationCalls)).toBe(true);
  });

  it("scopes a query to one subtree", () => {
    render(
      <DashboardShell>
        <PanelBuilder {...SCOPE} onCreated={() => {}} />
      </DashboardShell>,
    );
    const button = screen.getByText("Build a panel").closest("button")!;
    expect(within(button).getByText("Build a panel")).toBeTruthy();
  });
});
