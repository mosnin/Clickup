import { createRoot } from "react-dom/client";
import { SidebarProvider } from "@/components/ui/sidebar";
import { ToastProvider } from "@/components/toast";
import { AppearanceProvider } from "@/components/appearance/appearance-provider";
import { CustomizeProvider } from "@/components/appearance/customize-provider";
import { DashboardSidebar } from "@/components/dashboard/sidebar";
import { SidebarDock } from "@/components/appearance/sidebar-dock";
import { FileTree } from "@/components/ui/file-tree";
import { galleryData } from "./stubs/convex-react";
import { StyleStudio } from "@/components/appearance/style-studio";
import { useCustomize } from "@/components/appearance/customize-provider";
import { useEffect } from "react";

// The sidebar, on a page I can look at.
//
// The real component, not a lookalike — Convex, Clerk and the router are
// stubbed at the module boundary (see `scripts/build-gallery.mjs`) and the
// tree is a fixture. That matters here more than anywhere else: the
// travelling highlight is positioned against a scroll container, and whether
// it lands on the right row is a question only a browser can answer. A
// hand-built mock of the sidebar would have shown me a highlight that worked
// in the mock.

galleryData["sidebar.tree"] = {
  currentClerkId: "u1",
  personal: {
    _id: "sp_personal",
    name: "Personal",
    projects: [],
    lists: [{ _id: "lp1", name: "Someday", position: 0 }],
    pages: [],
    scopeType: "user" as const,
    scopeId: "u1",
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
          color: undefined,
          private: false,
          projects: [
            {
              _id: "p1",
              name: "Billing migration",
              position: 0,
              color: undefined,
              projectStatus: "on_track",
              roadmapId: undefined,
              lists: [
                { _id: "l1", name: "Backlog", position: 0 },
                { _id: "l3", name: "In review", position: 1 },
              ],
            },
            {
              _id: "p2",
              name: "Onboarding revamp",
              position: 1,
              color: undefined,
              projectStatus: "at_risk",
              roadmapId: undefined,
              lists: [{ _id: "l4", name: "Research", position: 0 }],
            },
          ],
          lists: [{ _id: "l2", name: "Loose ends", position: 0 }],
          pages: [{ _id: "pg1", title: "How we ship", pinned: true }],
          scopeType: "workspace" as const,
          scopeId: "w1",
          whiteboards: [{ _id: "wb1", title: "Architecture" }],
        },
        {
          _id: "s2",
          name: "Design",
          color: undefined,
          private: true,
          projects: [],
          lists: [{ _id: "l5", name: "Explorations", position: 0 }],
          pages: [],
          scopeType: "workspace" as const,
          scopeId: "w1",
          whiteboards: [],
        },
      ],
    },
  ],
};
galleryData["favorites.listForCurrentUser"] = [];
galleryData["mentions.unreadCount"] = 3;
galleryData["notifications.unreadCount"] = 1;
galleryData["timeEntries.runningForCurrent"] = null;
galleryData["users.current"] = { clerkId: "u1", name: "Ada Lovelace" };
galleryData["admin.isPlatformAdmin"] = false;
// The studio's builder chapter: the scope resolver and one envelope, so the
// live-panel shelves render with data instead of skeletons.
galleryData["appearance.spaceContext"] = {
  spaceId: "s1",
  name: "HQ",
  color: null,
  theme: null,
  componentStyle: null,
  mayTheme: true,
  scopeType: "workspace",
  scopeId: "w1",
};
galleryData["dataStream.resolve"] = {
  // Rows carry their fields under `meta`, exactly as the resolver emits them
  // — the first draft of this fixture had them flat and crashed MetaLine,
  // which is the harness working: a lookalike shape is a lookalike test.
  rows: [
    { id: "t1", title: "Ship the migration", href: "#", meta: { status: "In progress", assigneeName: "Ada", due: Date.UTC(2025, 5, 16), priority: "High" } },
    { id: "t2", title: "Review the audit", href: "#", meta: { status: "Open", assigneeName: "Grace", due: Date.UTC(2025, 5, 18), priority: "Normal" } },
    { id: "t3", title: "Fix the resize", href: "#", meta: { status: "Done", assigneeName: "Ada", priority: "High" } },
  ],
  series: [
    {
      key: "all",
      label: "Open",
      points: Array.from({ length: 14 }, (_, i) => ({
        key: String(Date.UTC(2025, 5, 2) + i * 86_400_000),
        label: "",
        value: 4 + Math.round(6 * Math.sin(i / 2.1) + i / 2),
      })),
    },
  ],
  scalar: 23,
  total: 23,
  truncated: false,
  meta: { unit: "tasks", dimensionLabel: "day", measureLabel: "Open" },
};

const TREE = [
  {
    id: "src",
    name: "src",
    type: "folder" as const,
    defaultOpen: true,
    children: [
      {
        id: "components",
        name: "components",
        type: "folder" as const,
        defaultOpen: true,
        children: [
          { id: "chart", name: "chart.tsx" },
          { id: "sidebar", name: "sidebar.tsx", highlight: true },
        ],
      },
      { id: "utils", name: "utils.ts" },
      { id: "readme", name: "README.md" },
    ],
  },
  { id: "pkg", name: "package.json" },
  { id: "env", name: ".env" },
];

function Page() {
  return (
    <>
      <h1>Sidebar</h1>
      <p className="note">
        Hover the rows — the highlight is one element that springs between them.
        Press a disclosure and the branch grows rather than appearing.
      </p>
      <div className="split">
        {/* The same providers the dashboard layout wraps it in, in the same
            order — the sidebar reads appearance tokens and raises toasts, and
            a version of it running without them is a version nobody ships. */}
        <ToastProvider>
          <AppearanceProvider>
            <CustomizeProvider>
              <SidebarProvider>
                <DashboardSidebar />
                {/* The drag-to-move gesture, which the dashboard layout
                    mounts beside the sidebar. It was absent here, so the
                    gesture that decides whether the nav can be picked up —
                    and whether it can be picked up BY ACCIDENT — had no
                    harness at all. scripts/verify-nav-grab.mjs drives it. */}
                <SidebarDock />
              </SidebarProvider>
              {/* The studio, opened by its own switch so what renders is the
                  real component in its real providers. */}
              <StudioOpen />
              <StyleStudio />
            </CustomizeProvider>
          </AppearanceProvider>
        </ToastProvider>
        <div>
          <h2>The primitive on its own</h2>
          <FileTree defaultOpenIds={["src"]} elements={TREE} />
        </div>
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);

function StudioOpen() {
  const { setActive } = useCustomize();
  useEffect(() => setActive(true), [setActive]);
  return null;
}
