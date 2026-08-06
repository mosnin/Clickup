import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  DashboardShell,
  navState,
  queryResults,
  resetHarness,
} from "./harness";

// The sidebar tree is the surface the Projects refactor most visibly
// changed, and the one every user looks at constantly: Space → Project →
// List. A regression here is the whole app looking broken.

vi.mock("@/components/motion", () => ({
  Stagger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  StaggerItem: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  motion: { div: "div" },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  EASE: [0, 0, 1, 1],
}));

const { DashboardSidebar } = await import("@/components/dashboard/sidebar");

const TREE = {
  currentClerkId: "u1",
  personal: {
    _id: "sp_personal",
    name: "Personal",
    projects: [],
    lists: [],
    pages: [],
    scopeType: "workspace" as const,
    scopeId: "w1",
    whiteboards: [],
  },
  workspaces: [
    {
      _id: "w1",
      name: "Acme",
      spaces: [
        {
          _id: "s1",
          name: "HQ",
          projects: [
            {
              _id: "p1",
              name: "Billing migration",
              position: 0,
              color: undefined,
              projectStatus: "on_track",
              roadmapId: undefined,
              lists: [{ _id: "l1", name: "Backlog", position: 0 }],
            },
          ],
          // A list living straight in the Space, which the model still
          // allows — it must not disappear now that projects exist.
          lists: [{ _id: "l2", name: "Loose ends", position: 0 }],
          pages: [],
          scopeType: "workspace" as const,
          scopeId: "w1",
          whiteboards: [],
        },
      ],
    },
  ],
};

beforeEach(() => resetHarness());

describe("DashboardSidebar", () => {
  function seed() {
    // The tree ships behind the "Your spaces" disclosure now — the rail opens
    // sparse, per the design references — and the press is remembered per
    // machine in localStorage. These tests are ABOUT the tree, so they run as
    // the machine of someone who opened it: flag set before render, exactly
    // what the disclosure's effect reads.
    localStorage.setItem("sidebar_spaces_open", "true");
    // The sidebar renders the tree of whichever workspace the current URL
    // belongs to, so say we are looking at one of Acme's lists.
    navState.pathname = "/dashboard/l/l1";
    queryResults["sidebar.tree"] = TREE;
    queryResults["favorites.listForCurrentUser"] = [];
    queryResults["mentions.unreadCount"] = 0;
    queryResults["notifications.unreadCount"] = 0;
    queryResults["timeEntries.runningForCurrent"] = null;
    queryResults["users.current"] = { clerkId: "u1", name: "Ada" };
    queryResults["admin.isPlatformAdmin"] = false;
  }

  it("renders Space → Project → List, and space-direct lists too", () => {
    seed();
    render(<DashboardSidebar />, { wrapper: DashboardShell });

    expect(screen.getByText("HQ")).toBeDefined();
    expect(screen.getByText("Billing migration")).toBeDefined();
    expect(screen.getByText("Backlog")).toBeDefined();
    // The list nobody promoted to a project is still reachable.
    expect(screen.getByText("Loose ends")).toBeDefined();
  });

  it("links a project to its own page", () => {
    seed();
    render(<DashboardSidebar />, { wrapper: DashboardShell });
    const link = screen.getByText("Billing migration").closest("a");
    expect(link?.getAttribute("href")).toBe("/dashboard/p/p1");
  });

  it("offers both Projects and Pages in the nav", () => {
    seed();
    render(<DashboardSidebar />, { wrapper: DashboardShell });
    expect(
      screen.getByText("Projects").closest("a")?.getAttribute("href"),
    ).toBe("/dashboard/projects");
    expect(screen.getByText("Pages").closest("a")?.getAttribute("href")).toBe(
      "/dashboard/pages",
    );
  });

  it("collapses and reopens a branch from its disclosure", async () => {
    // The branch is an animated container now rather than a bare `&&`, which
    // is exactly the kind of change that renders fine and stops toggling.
    // Awaited because closing is an exit animation — the row is still in the
    // DOM for a frame, so a synchronous assertion here passes either way.
    seed();
    render(<DashboardSidebar />, { wrapper: DashboardShell });

    expect(screen.getByText("Backlog")).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: /Collapse Billing migration/ }),
    );
    await waitFor(() => expect(screen.queryByText("Backlog")).toBeNull());

    // Reopened, both because it is half the behaviour and because a project's
    // collapsed state is a cookie shared by every row in the process — a test
    // that closes one and walks away decides the next test's starting state.
    fireEvent.click(
      screen.getByRole("button", { name: /Expand Billing migration/ }),
    );
    await waitFor(() => expect(screen.getByText("Backlog")).toBeDefined());
  });

  it("names each disclosure after the branch it opens", () => {
    // Several unlabelled "Expand" buttons in a tree are several identical
    // stops for anyone navigating by name. Direction-agnostic so this does
    // not depend on what the previous test left in the cookie.
    seed();
    render(<DashboardSidebar />, { wrapper: DashboardShell });
    const labels = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? "");
    expect(labels.some((l) => /^(Collapse|Expand) HQ$/.test(l))).toBe(true);
    expect(
      labels.some((l) => /^(Collapse|Expand) Billing migration$/.test(l)),
    ).toBe(true);
  });

  it("survives a tree that hasn't loaded yet", () => {
    // sidebar.tree deliberately unset.
    queryResults["favorites.listForCurrentUser"] = [];
    expect(() =>
      render(<DashboardSidebar />, { wrapper: DashboardShell }),
    ).not.toThrow();
  });
});
