import { createRoot } from "react-dom/client";
import { SidebarProvider } from "@/components/ui/sidebar";
import { ToastProvider } from "@/components/toast";
import { AppearanceProvider } from "@/components/appearance/appearance-provider";
import { CustomizeProvider } from "@/components/appearance/customize-provider";
import { DashboardSidebar } from "@/components/dashboard/sidebar";
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
