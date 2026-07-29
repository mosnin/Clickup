import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  DashboardShell,
  mutationCalls,
  queryResults,
  resetHarness,
} from "./harness";

// Render tests for the Pages surfaces. The backend is covered by
// convex-test; this covers what that cannot see — whether the editor
// actually renders markdown, whether Read/Write show different things, and
// whether the panels degrade to nothing when there is nothing to show.

vi.mock("@/components/motion", () => ({
  Stagger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  StaggerItem: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  motion: { div: "div" },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  EASE: [0, 0, 1, 1],
}));

const { PageEditor } = await import(
  "@/app/dashboard/pages/[pageId]/page-editor"
);
const { PagesIndex } = await import("@/app/dashboard/pages/pages-index");
const { AttachedPages } = await import(
  "@/components/dashboard/attached-pages"
);

const PAGE = {
  _id: "pg1",
  _creationTime: 0,
  title: "Architecture",
  markdown: "# Architecture\n\nWe use **Convex**.\n\n- one\n- two",
  scopeType: "workspace" as const,
  scopeId: "w1",
  position: 0,
  createdByActorId: "u1",
  createdByName: "Ada",
  createdAt: 1,
  updatedAt: 2,
  updatedByName: "Ada",
};

beforeEach(() => resetHarness());

describe("PageEditor", () => {
  function seed(overrides: Record<string, unknown> = {}) {
    queryResults["pages.get"] = {
      page: PAGE,
      backlinks: [],
      outgoing: [],
      attachments: [],
      ancestors: [],
      children: [],
      ...overrides,
    };
    queryResults["pages.titlesForScope"] = [];
    queryResults["pages.viewers"] = [];
  }

  it("opens on the rich editor with the markdown already structured", () => {
    seed();
    const { container } = render(<PageEditor pageId="pg1" />, {
      wrapper: DashboardShell,
    });
    const prose = container.querySelector(".page-prose")!;
    expect(prose).toBeTruthy();
    // Structure, not raw syntax: this is the whole claim of the editor.
    expect(prose.querySelector("h1")?.textContent).toBe("Architecture");
    expect(prose.querySelector("strong")?.textContent).toBe("Convex");
    expect(prose.querySelectorAll("li")).toHaveLength(2);
    expect(prose.textContent).not.toContain("**");
  });

  it("shows the stored markdown byte for byte behind the Markdown tab", () => {
    seed();
    render(<PageEditor pageId="pg1" />, { wrapper: DashboardShell });
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    const editor = screen.getByLabelText("Page markdown") as HTMLTextAreaElement;
    expect(editor.value).toBe(PAGE.markdown);
  });

  it("saves an edit through pages.update", async () => {
    vi.useFakeTimers();
    seed();
    render(<PageEditor pageId="pg1" />, { wrapper: DashboardShell });
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    fireEvent.change(screen.getByLabelText("Page markdown"), {
      target: { value: "# Architecture\n\nrewritten" },
    });
    // Debounced — nothing should have fired yet.
    expect(mutationCalls.filter((c) => c.name === "pages.update")).toHaveLength(
      0,
    );
    await vi.advanceTimersByTimeAsync(1000);
    const saves = mutationCalls.filter((c) => c.name === "pages.update");
    expect(saves).toHaveLength(1);
    expect(saves[0].args).toMatchObject({
      pageId: "pg1",
      markdown: "# Architecture\n\nrewritten",
    });
    vi.useRealTimers();
  });

  it("invites the first sentence when the page is empty", () => {
    seed({ page: { ...PAGE, markdown: "" } });
    const { container } = render(<PageEditor pageId="pg1" />, {
      wrapper: DashboardShell,
    });
    // An empty page teaches its own two shortcuts rather than sitting blank.
    const placeholder = container
      .querySelector(".page-editor-surface [data-placeholder]")
      ?.getAttribute("data-placeholder");
    expect(placeholder).toContain("/");
    expect(placeholder).toContain("@");
  });

  it("lists backlinks and where the page is pinned", () => {
    seed({
      backlinks: [
        { pageId: "pg2", title: "Billing migration", excerpt: "see also" },
      ],
      attachments: [
        {
          attachmentId: "a1",
          targetType: "project",
          targetId: "p1",
          label: "Billing",
          href: "/dashboard/p/p1",
        },
      ],
    });
    render(<PageEditor pageId="pg1" />, { wrapper: DashboardShell });
    expect(screen.getByText("Billing migration")).toBeDefined();
    expect(screen.getByText("Billing").closest("a")?.getAttribute("href")).toBe(
      "/dashboard/p/p1",
    );
  });

  it("shows other viewers but never the reader themselves", () => {
    seed();
    queryResults["pages.viewers"] = [
      { actorId: "u2", name: "Grace Hopper", editing: true },
    ];
    render(<PageEditor pageId="pg1" />, { wrapper: DashboardShell });
    expect(screen.getByTitle("Grace Hopper is editing")).toBeDefined();
    // The server already excludes the caller; nothing should render for Ada.
    expect(screen.queryByTitle(/Ada Lovelace/)).toBeNull();
  });

  it("explains a missing page instead of crashing", () => {
    queryResults["pages.get"] = null;
    render(<PageEditor pageId="gone" />, { wrapper: DashboardShell });
    expect(screen.getByText("Page not found")).toBeDefined();
  });
});

describe("PagesIndex", () => {
  it("lists pages with their excerpts", () => {
    queryResults["pages.scopesForCurrentUser"] = [
      { scopeType: "workspace", scopeId: "w1", name: "Acme" },
    ];
    queryResults["pages.listForScope"] = [
      {
        pageId: "pg1",
        title: "Architecture",
        excerpt: "We use Convex",
        updatedAt: Date.now(),
        updatedByName: "Ada",
        attachmentCount: 2,
      },
    ];
    render(<PagesIndex />, { wrapper: DashboardShell });
    expect(screen.getByText("Architecture")).toBeDefined();
    expect(screen.getByText("We use Convex")).toBeDefined();
    expect(screen.getByText("pinned to 2")).toBeDefined();
  });

  it("teaches what a page is for when there are none", () => {
    queryResults["pages.scopesForCurrentUser"] = [
      { scopeType: "workspace", scopeId: "w1", name: "Acme" },
    ];
    queryResults["pages.listForScope"] = [];
    render(<PagesIndex />, { wrapper: DashboardShell });
    expect(screen.getByText("No pages yet")).toBeDefined();
    expect(screen.getByText("Write the first one")).toBeDefined();
  });
});

describe("AttachedPages", () => {
  it("stays out of the way when nothing is pinned", () => {
    queryResults["pages.forTarget"] = [];
    queryResults["pages.scopeForTarget"] = {
      scopeType: "workspace",
      scopeId: "w1",
    };
    render(<AttachedPages targetType="task" targetId="t1" />);
    // One quiet affordance, no card, no heading.
    expect(screen.getByText("Add a page")).toBeDefined();
    expect(screen.queryByText("Pages")).toBeNull();
  });

  it("renders nothing at all when the viewer can't reach the target", () => {
    queryResults["pages.forTarget"] = [];
    queryResults["pages.scopeForTarget"] = null;
    const { container } = render(
      <AttachedPages targetType="task" targetId="t1" />,
    );
    expect(container.textContent).toBe("");
  });

  it("links pinned pages to the editor", () => {
    queryResults["pages.forTarget"] = [
      {
        pageId: "pg1",
        title: "The brief",
        excerpt: "what we agreed",
        updatedAt: Date.now(),
        attachmentCount: 0,
      },
    ];
    queryResults["pages.scopeForTarget"] = {
      scopeType: "workspace",
      scopeId: "w1",
    };
    render(<AttachedPages targetType="project" targetId="p1" />);
    expect(
      screen.getByText("The brief").closest("a")?.getAttribute("href"),
    ).toBe("/dashboard/pages/pg1");
  });
});
