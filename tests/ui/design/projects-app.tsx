import { createRoot } from "react-dom/client";
import { ToastProvider } from "@/components/toast";
import { AppearanceProvider } from "@/components/appearance/appearance-provider";
import { CustomizeProvider } from "@/components/appearance/customize-provider";
import { MintablePanelsProvider } from "@/components/appearance/mintable-panels";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { SHELL_INSET, SHELL_PAGE, SHELL_PROVIDER } from "@/lib/shell";
import { DashboardSidebar } from "@/components/dashboard/sidebar";
import ProjectsPage from "@/app/dashboard/projects/page";
import { galleryData } from "./stubs/convex-react";

// The projects directory, in the harness — the REAL page inside the real
// shell, same contract as home-app.tsx.
//
// This fixture exists for two reasons. One: the directory had never been
// rendered by the harness, so its states (status chips, favourites, the
// grouped grid) were unphotographed. Two: it is the source of the marketing
// site's showcase screenshot (scripts/marketing-screens.mjs) — the audit
// found production shipping a scratch-account capture ("Test — 0 of 1
// task") as the homepage centerpiece, and the fix is a scripted, seeded
// workspace that can be re-captured from the current design at any time.
// The data below is that script: a believable company mid-flight, no
// zeros-everywhere, no "Test".

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const todayStart = (() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
})();

// ── Shell queries (sidebar, capsule) ─────────────────────────────────────
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
      name: "Northwind",
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
              projectStatus: "at_risk",
              roadmapId: undefined,
              lists: [{ _id: "l1", name: "Backlog", position: 0 }],
            },
          ],
          lists: [],
          pages: [{ _id: "pg1", title: "How we ship", pinned: true }],
          scopeType: "workspace" as const,
          scopeId: "w1",
          whiteboards: [],
        },
      ],
    },
  ],
};
galleryData["favorites.listForCurrentUser"] = [
  { kind: "project", id: "pr1" },
];
galleryData["mentions.unreadCountForCurrent"] = 2;
galleryData["notificationCenter.unreadCount"] = 1;
galleryData["chat.scopesForCurrentUser"] = [
  { scopeType: "user", scopeId: "u1", name: "Personal" },
];
galleryData["chat.channels"] = [];
galleryData["timeEntries.runningForCurrent"] = null;
galleryData["users.current"] = { clerkId: "u1", name: "Ada Lovelace" };
galleryData["admin.me"] = null;
galleryData["userSettings.current"] = null;
galleryData["appearance.forCurrentUser"] = {
  personal: null,
  patchVersion: 2,
  spaceOverrides: {},
  componentStyle: null,
  componentStyleBySpace: {},
  panelStyles: {},
  panelMemory: {},
  panelWatches: {},
};
galleryData["appearance.spaceContext"] = null;
galleryData["situations.forScreen"] = [];
galleryData["uiComponents.listForScope"] = [];

// ── The directory itself: a company mid-flight ───────────────────────────
const rows = [
  {
    projectId: "pr1",
    name: "Billing migration — Stripe to internal ledger",
    place: "Northwind · HQ",
    description: "Move revenue off Stripe before the contract lapses.",
    projectStatus: "at_risk" as const,
    targetDate: todayStart + 9 * DAY,
    listCount: 3,
    total: 48,
    done: 31,
    inProgress: 6,
    position: 0,
    activityAt: now - 4 * 60 * 1000,
    workspaceName: "Northwind",
    spaceName: "HQ",
  },
  {
    projectId: "pr2",
    name: "Onboarding revamp",
    place: "Northwind · HQ",
    description: "Two questions, one ceremony, agent online by minute five.",
    projectStatus: "on_track" as const,
    targetDate: todayStart + 12 * DAY,
    listCount: 2,
    total: 23,
    done: 17,
    inProgress: 3,
    position: 1,
    activityAt: now - 51 * 60 * 1000,
    workspaceName: "Northwind",
    spaceName: "HQ",
  },
  {
    projectId: "pr3",
    name: "Q3 pricing experiment",
    place: "Northwind · Growth",
    projectStatus: "off_track" as const,
    targetDate: todayStart + 2 * DAY,
    listCount: 1,
    total: 14,
    done: 2,
    inProgress: 1,
    position: 2,
    activityAt: now - 3 * 60 * 60 * 1000,
    workspaceName: "Northwind",
    spaceName: "Growth",
  },
  {
    projectId: "pr4",
    name: "Agent governance rollout",
    place: "Northwind · Platform",
    description: "Budgets, approval gates and audit trails for the fleet.",
    projectStatus: "on_track" as const,
    targetDate: todayStart + 30 * DAY,
    listCount: 2,
    total: 31,
    done: 12,
    inProgress: 4,
    position: 3,
    activityAt: now - 26 * 60 * 1000,
    workspaceName: "Northwind",
    spaceName: "Platform",
  },
  {
    projectId: "pr5",
    name: "Support automation",
    place: "Northwind · Ops",
    projectStatus: "on_track" as const,
    targetDate: undefined,
    listCount: 1,
    total: 52,
    done: 44,
    inProgress: 5,
    position: 4,
    activityAt: now - 12 * 60 * 1000,
    workspaceName: "Northwind",
    spaceName: "Ops",
  },
  {
    projectId: "pr6",
    name: "SOC2 evidence — Q3",
    place: "Northwind · HQ",
    projectStatus: "paused" as const,
    targetDate: todayStart + 45 * DAY,
    listCount: 1,
    total: 18,
    done: 9,
    inProgress: 0,
    position: 5,
    activityAt: now - 2 * DAY,
    workspaceName: "Northwind",
    spaceName: "HQ",
  },
] as const;

galleryData["projectsDirectory.list"] = {
  rows,
  totalCount: rows.length,
};

function Page() {
  return (
    <ToastProvider>
      <AppearanceProvider>
        <CustomizeProvider>
          <MintablePanelsProvider>
            <SidebarProvider className={SHELL_PROVIDER}>
              <DashboardSidebar />
              <SidebarInset className={SHELL_INSET}>
                <div className={SHELL_PAGE}>
                  <ProjectsPage />
                </div>
              </SidebarInset>
            </SidebarProvider>
          </MintablePanelsProvider>
        </CustomizeProvider>
      </AppearanceProvider>
    </ToastProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
