import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DashboardShell, queryResults, resetHarness } from "./harness";

// Render tests for the Project page — the surface the Projects refactor
// created and that nothing had ever exercised. These answer the questions a
// click-through would: does it render at all, does it show the project's
// lists, does it degrade sensibly when the project is missing or empty.

vi.mock("@/components/motion", () => ({
  Stagger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  StaggerItem: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  motion: { div: "div" },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  EASE: [0, 0, 1, 1],
}));

const { ProjectView } = await import(
  "@/app/dashboard/p/[projectId]/project-view"
);

const PROJECT = {
  _id: "p1",
  _creationTime: 0,
  name: "Billing migration",
  spaceId: "s1",
  position: 0,
  createdAt: 1,
  description: "Move billing off the legacy processor",
  projectStatus: "at_risk" as const,
  notes: undefined,
  ownerActorId: undefined,
  targetDate: undefined,
};

beforeEach(() => resetHarness());

describe("ProjectView", () => {
  it("shows the project, its space, and its lists", () => {
    queryResults["projects.get"] = {
      project: PROJECT,
      spaceName: "HQ",
      spaceId: "s1",
      scopeType: "workspace",
      scopeParentId: "w1",
      lists: [
        { _id: "l1", name: "Backlog", description: "Everything queued" },
        { _id: "l2", name: "Milestones", description: undefined },
      ],
    };
    queryResults["favorites.listForCurrentUser"] = [];

    render(<ProjectView projectId="p1" />, { wrapper: DashboardShell });

    // The name appears twice on purpose: once small in the sticky chrome (so
    // it survives scrolling) and once as the page's headline. Assert the
    // heading, which is the one a reader is actually looking at.
    expect(
      screen.getByRole("heading", { name: "Billing migration" }),
    ).toBeDefined();
    expect(screen.getByText("HQ")).toBeDefined();
    expect(screen.getByText("Backlog")).toBeDefined();
    expect(screen.getByText("Milestones")).toBeDefined();
    expect(screen.getByText("Everything queued")).toBeDefined();

    // The list links point at list pages, not back at the project.
    const backlog = screen.getByText("Backlog").closest("a");
    expect(backlog?.getAttribute("href")).toBe("/dashboard/l/l1");
  });

  it("renders the project's own description, not a list's", () => {
    queryResults["projects.get"] = {
      project: PROJECT,
      spaceName: "HQ",
      spaceId: "s1",
      scopeType: "workspace",
      scopeParentId: "w1",
      lists: [],
    };
    queryResults["favorites.listForCurrentUser"] = [];

    render(<ProjectView projectId="p1" />, { wrapper: DashboardShell });
    const about = screen.getByLabelText("Project description") as HTMLInputElement;
    expect(about.value).toBe("Move billing off the legacy processor");
  });

  it("teaches what a list is when the project has none", () => {
    queryResults["projects.get"] = {
      project: PROJECT,
      spaceName: "HQ",
      spaceId: "s1",
      scopeType: "workspace",
      scopeParentId: "w1",
      lists: [],
    };
    queryResults["favorites.listForCurrentUser"] = [];

    render(<ProjectView projectId="p1" />, { wrapper: DashboardShell });
    expect(screen.getByText("No lists yet")).toBeDefined();
    expect(screen.getByText("Add a list")).toBeDefined();
  });

  it("explains a missing project instead of crashing", () => {
    queryResults["projects.get"] = null;
    render(<ProjectView projectId="gone" />, { wrapper: DashboardShell });
    expect(screen.getByText("Project not found")).toBeDefined();
  });

  it("shows a skeleton while the project is loading", () => {
    // `projects.get` deliberately unset — the loading state.
    const { container } = render(<ProjectView projectId="p1" />, { wrapper: DashboardShell });
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(
      0,
    );
  });
});
