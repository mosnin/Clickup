import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
    docs: [],
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
          docs: [],
          whiteboards: [],
        },
      ],
    },
  ],
};

beforeEach(() => resetHarness());

describe("DashboardSidebar", () => {
  function seed() {
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

  it("survives a tree that hasn't loaded yet", () => {
    // sidebar.tree deliberately unset.
    queryResults["favorites.listForCurrentUser"] = [];
    expect(() =>
      render(<DashboardSidebar />, { wrapper: DashboardShell }),
    ).not.toThrow();
  });
});
