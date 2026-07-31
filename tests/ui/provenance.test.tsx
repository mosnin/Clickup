import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DashboardShell, queryResults, resetHarness } from "./harness";

// Why is this number what it is — as a surface.
//
// The newest thing on screen and the one with the strongest claim attached:
// that it can be trusted. So the tests care most about what it must NOT do —
// appear unprompted, claim a clean count when the walk was capped, or attach
// an explanation to a number it does not actually explain.

vi.mock("@/components/motion", async () => await import("./motion-mock"));

const { Panel } = await import("@/components/dashboard/panel");

const DEF = {
  title: "Overdue",
  query: { from: "tasks", filter: { due: "overdue", assignee: "me" } },
  shape: "metric",
};

function show(over: Record<string, unknown> = {}) {
  queryResults["dataStream.resolve"] = {
    rows: [
      { id: "t1", title: "Ship the thing", href: "/dashboard/l/l1/t/t1", meta: {} },
      { id: "t2", title: "Fix the other thing", href: null, meta: {} },
    ],
    series: [],
    scalar: 14,
    total: 14,
    truncated: false,
    meta: { unit: "count", dimensionLabel: "", measureLabel: "How many" },
    ...over,
  };
  render(
    <DashboardShell>
      <Panel definition={DEF} scopeType="workspace" scopeId="w1" />
    </DashboardShell>,
  );
}

beforeEach(() => {
  resetHarness();
  queryResults["appearance.forCurrentUser"] = {};
  queryResults["plans.decisionsInScope"] = [];
});

describe("it stays out of the way until asked", () => {
  it("shows no explanation on a panel nobody has questioned", () => {
    // A dashboard that explains itself unprompted is a dashboard you cannot
    // read.
    show();
    expect(screen.queryByText("Why this number")).toBeNull();
  });

  it("makes the number itself the affordance", () => {
    show();
    const toggle = screen.getByRole("button", { name: "Why this number" });
    expect(toggle.textContent).toContain("14");
  });

  it("opens and closes", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Why this number" }));
    expect(screen.getByText("Why this number")).toBeTruthy();
    fireEvent.click(screen.getByText("Close"));
    // The sheet is inside a real `AnimatePresence` (it comes from
    // motion/react, not the app's wrapper), so it stays mounted through its
    // exit — which is the behaviour, not a delay to paper over.
    await waitFor(() =>
      expect(screen.queryByText("Why this number")).toBeNull(),
    );
  });
});

describe("the chain it shows", () => {
  it("names the question that was asked", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Why this number" }));
    // The title says "Overdue" too, which is the point — the chain restates
    // the question in the vocabulary rather than echoing the name.
    expect(screen.getByText(/Asked for/).textContent).toContain("due overdue");
  });

  it("names the records behind it, linked", () => {
    // "Which fourteen" is the actual question.
    show();
    fireEvent.click(screen.getByRole("button", { name: "Why this number" }));
    const link = screen.getByText("Ship the thing").closest("a");
    expect(link?.getAttribute("href")).toBe("/dashboard/l/l1/t/t1");
  });

  it("refuses to claim a clean count when the walk was capped", () => {
    // A number that only counts what the walk reached is a number people will
    // act on, and the caveat has to be where the acting happens.
    show({ truncated: true, total: 3000 });
    fireEvent.click(screen.getByRole("button", { name: "Why this number" }));
    expect(screen.getByText(/not everything that matches/)).toBeTruthy();
    expect(screen.queryByText(/records matched/)).toBeNull();
  });

  it("surfaces a decision that bears on it, linked to the plan", () => {
    queryResults["plans.decisionsInScope"] = [
      {
        id: "d1",
        question: "What counts as overdue for a task?",
        body: "Past its due date at local midnight.",
        projectId: "p1",
        projectName: "Launch",
        decidedByName: "Ada",
        decidedAt: 1,
        accepted: true,
      },
    ];
    show();
    fireEvent.click(screen.getByRole("button", { name: "Why this number" }));
    const step = screen.getByText(/Ada settled/);
    expect(step.closest("a")?.getAttribute("href")).toBe("/dashboard/p/p1/plan");
  });

  it("attaches no decision when none is about this", () => {
    // Attaching a marginal one reads as the system not knowing either.
    queryResults["plans.decisionsInScope"] = [
      {
        id: "d1",
        question: "Which coffee machine?",
        body: "The one with the grinder.",
        projectId: "p1",
        projectName: "Office",
        decidedByName: "Ada",
        decidedAt: 1,
        accepted: true,
      },
    ];
    show();
    fireEvent.click(screen.getByRole("button", { name: "Why this number" }));
    expect(screen.queryByText(/coffee/)).toBeNull();
  });

  it("says it is still looking rather than claiming there is nothing", () => {
    delete queryResults["plans.decisionsInScope"];
    show();
    fireEvent.click(screen.getByRole("button", { name: "Why this number" }));
    expect(screen.getByText(/Looking for the decision/)).toBeTruthy();
  });
});
