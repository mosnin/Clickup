import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { Doc } from "@convex/_generated/dataModel";
import { ToastProvider } from "@/components/toast";
import { AppearanceProvider } from "@/components/appearance/appearance-provider";
import {
  CustomizeProvider,
  useCustomize,
} from "@/components/appearance/customize-provider";
import { MintablePanelsProvider } from "@/components/appearance/mintable-panels";
import { StyleStudio } from "@/components/appearance/style-studio";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { DashboardSidebar } from "@/components/dashboard/sidebar";
import { ProjectScreen } from "@/components/dashboard/project-screen/project-screen";
import { galleryData } from "./stubs/convex-react";

// The project screen, in the harness.
//
// Home was the only real product surface the harness had ever rendered. The
// project screen is the other one that is a CANVAS rather than a page — the
// one with a tray, a builder, an agent's layout proposal and an agent's panel
// proposal — and every one of those states had been reasoned about and none of
// them photographed. A state that is never opened is a state that ships
// however it ships.
//
// Query-string states, because each is a different screen and each ships:
//
//   (none)             a screen somebody has arranged, with a panel they wrote
//   ?state=blank       never arranged — the defaults, which is where everyone starts
//   ?state=cleared     arranged, then emptied. NOT the same as never arranged,
//                      and the difference is a rule in `normalizeLayout`
//   ?state=layout      an agent proposing a rearrangement — the consent banner
//   ?state=panel       an agent proposing a panel that does not exist yet
//   ?state=arrange     editing mode: the wobble, the handles, the tray
//   ?studio=1          the style studio open over the screen

const params = new URLSearchParams(window.location.search);
const STATE = params.get("state") ?? "arranged";
const STUDIO = params.has("studio");

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

const PROJECT = {
  _id: "p1",
  _creationTime: now - 40 * DAY,
  name: "Billing migration — Stripe to internal ledger",
  spaceId: "s1",
  position: 0,
  createdAt: now - 40 * DAY,
  description:
    "Move invoicing off Stripe Billing and onto the internal ledger without a " +
    "gap in revenue recognition.",
  projectStatus: "at_risk",
  ownerActorId: "u1",
  notes:
    "Finance wants the cutover inside a quarter boundary. Legacy webhooks stay " +
    "live for one billing cycle after.",
  targetDate: now + 12 * DAY,
} as unknown as Doc<"projects">;

const LISTS = [
  { _id: "l1", name: "Backlog", position: 0 },
  { _id: "l3", name: "In review", position: 1 },
  { _id: "l7", name: "Cutover checklist", position: 2 },
] as unknown as Doc<"lists">[];

const SCOPE = { scopeType: "workspace" as const, scopeId: "w1" };

// ── The shell's own queries ─────────────────────────────────────────────
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
              lists: LISTS.map((l) => ({
                _id: l._id,
                name: l.name,
                position: l.position,
              })),
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
galleryData["favorites.listForCurrentUser"] = [];
galleryData["mentions.unreadCountForCurrent"] = 2;
galleryData["notificationCenter.unreadCount"] = 0;
galleryData["chat.scopesForCurrentUser"] = [];
galleryData["chat.channels"] = [];
galleryData["timeEntries.runningForCurrent"] = null;
galleryData["users.current"] = { clerkId: "u1", name: "Ada Lovelace" };
galleryData["admin.me"] = null;
galleryData["appearance.forCurrentUser"] = null;
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

// ── The widgets' own queries ────────────────────────────────────────────
galleryData["projects.rollupsForProject"] = [
  { listId: "l1", total: 31, completed: 18 },
  { listId: "l3", total: 12, completed: 11 },
  { listId: "l7", total: 5, completed: 2 },
];
galleryData["events.forProject"] = [
  {
    eventId: "e1",
    type: "task.completed",
    actorName: "Ledger migration runner",
    entityTitle: "Backfill ledger rows for the 2024 fiscal year",
    createdAt: now - 6 * 60 * 1000,
  },
  {
    eventId: "e2",
    type: "comment.created",
    actorName: "Grace Hopper",
    entityTitle: "Cutover window",
    createdAt: now - 55 * 60 * 1000,
  },
  {
    eventId: "e3",
    type: "task.created",
    actorName: "Ada Lovelace",
    entityTitle: "Write the rollback runbook",
    createdAt: now - 4 * 60 * 60 * 1000,
  },
];
galleryData["events.feed"] = [];
galleryData["plans.forProject"] = [
  {
    id: "q1",
    kind: "question",
    body: "Do we cut over inside the quarter boundary or after it?",
    parentId: null,
    createdAt: now - 3 * DAY,
    authorName: "Ada Lovelace",
    retractedAt: null,
    needsHuman: true,
  },
  {
    id: "o1",
    kind: "option",
    body: "Inside — finance closes the books with one system.",
    parentId: "q1",
    createdAt: now - 3 * DAY,
    authorName: "Grace Hopper",
    retractedAt: null,
  },
  {
    id: "q2",
    kind: "question",
    body: "How long do the legacy webhooks stay live?",
    parentId: null,
    createdAt: now - 2 * DAY,
    authorName: "Ledger migration runner",
    retractedAt: null,
    needsHuman: false,
  },
];
galleryData["pages.forTarget"] = [
  { _id: "pg1", title: "Cutover runbook", pinned: true, updatedAt: now - DAY },
  { _id: "pg2", title: "Reconciliation notes", pinned: false, updatedAt: now - 3 * DAY },
];
galleryData["pages.scopeForTarget"] = { scopeType: "workspace", scopeId: "w1" };

// One envelope for every panel on the screen. Shaped exactly as the resolver
// emits — the first draft of a fixture like this had rows flat instead of
// under `meta` and crashed the row renderer, which is the harness working.
galleryData["dataStream.resolve"] = {
  rows: [
    {
      id: "t1",
      title: "Reconcile the September ledger export before the cutover window",
      href: "#",
      meta: {
        status: "In progress",
        assigneeName: "Ada Lovelace",
        due: now - 2 * DAY,
        priority: "Urgent",
      },
    },
    {
      id: "t2",
      title: "Write the rollback runbook",
      href: "#",
      meta: { status: "Open", assigneeName: "Triage", priority: "High" },
    },
    {
      id: "t3",
      title: "Delete the legacy webhook handler",
      href: "#",
      meta: { status: "Done", assigneeName: "Ada Lovelace", priority: "Low" },
    },
  ],
  series: [
    {
      key: "all",
      label: "Open",
      points: [
        { key: "ada", label: "Ada Lovelace", value: 12 },
        { key: "grace", label: "Grace Hopper", value: 7 },
        { key: "runner", label: "Ledger migration runner", value: 19 },
      ],
    },
  ],
  scalar: 38,
  total: 38,
  truncated: false,
  meta: { unit: "count", dimensionLabel: "assignee", measureLabel: "Open" },
};
galleryData["calibration.forScope"] = [];
galleryData["panelMemory.forScope"] = [];

// ── A panel this reader authored ────────────────────────────────────────
const AUTHORED = {
  componentId: "uc1",
  definition: {
    title: "Waiting on somebody else",
    query: {
      from: "tasks",
      dimension: "assignee",
      measure: "open",
      filter: { status: "open" },
      limit: 25,
    },
    shape: "bar",
    fields: ["status", "due"],
    style: {},
    caption: "Open work with an open blocker",
  },
  authoredByName: null,
  sharedAt: null,
};
galleryData["uiComponents.listForScope"] =
  STATE === "blank" ? [] : [AUTHORED];
galleryData["uiComponents.get"] = AUTHORED.definition;

// ── The two consent surfaces ────────────────────────────────────────────
//
// An agent AUTHORS, a person PLACES. Both banners are refusable, both say why
// in the reader's language, and neither had ever been photographed.
galleryData["screens.proposalsFor"] =
  STATE === "layout"
    ? [
        {
          proposalId: "sp1",
          agentName: "Ledger migration runner",
          reason:
            "You open this screen most mornings and scroll straight past About " +
            "to Progress. This puts Progress and Open questions at the top.",
          layout: {
            widgets: [
              { id: "progress", span: 2 },
              { id: "plan", span: 1 },
              { id: "lists", span: 2 },
              { id: "activity", span: 1 },
              { id: "about", span: 3 },
            ],
          },
          createdAt: now - 40 * 60 * 1000,
        },
      ]
    : [];

galleryData["uiComponents.proposalsFor"] =
  STATE === "panel"
    ? [
        {
          proposalId: "pp1",
          agentName: "Triage",
          reason:
            "Six of the last ten things I picked up were already blocked. " +
            "Nothing on this screen shows what is stuck.",
          definition: {
            title: "Stuck",
            query: {
              from: "tasks",
              dimension: "list",
              measure: "open",
              filter: { status: "open", due: "overdue" },
              limit: 25,
            },
            shape: "column",
            fields: ["status", "due"],
            style: {},
            caption: "Open and overdue, by list",
          },
          createdAt: now - 12 * 60 * 1000,
        },
      ]
    : [];

// ── The arrangement itself ──────────────────────────────────────────────
//
// `null` means never arranged, which is NOT the same as arranged-then-emptied.
// Somebody who cleared their screen should keep a clear screen rather than get
// the defaults back, and the two cases are one `??` apart in the reader —
// which is exactly the kind of distinction that only shows up in a picture.
galleryData["screens.layoutFor"] =
  STATE === "blank"
    ? null
    : STATE === "cleared"
      ? { layout: { widgets: [] } }
      : {
          layout: {
            widgets: [
              { id: "progress", span: 1 },
              { id: "about", span: 2 },
              { id: "custom:uc1", span: 1 },
              { id: "lists", span: 2 },
              { id: "plan", span: 1 },
              { id: "activity", span: 1 },
              { id: "status", span: 1 },
              { id: "target-date", span: 1 },
            ],
          },
        };

function Editing({ on }: { on: boolean }) {
  const { setActive } = useCustomize();
  useEffect(() => {
    if (on) setActive(true);
  }, [on, setActive]);
  return null;
}

function Page() {
  return (
    <ToastProvider>
      <AppearanceProvider>
        <CustomizeProvider>
          <MintablePanelsProvider>
            <SidebarProvider className="h-svh overflow-hidden">
              <DashboardSidebar />
              <SidebarInset className="h-full min-w-0 overflow-y-auto overflow-x-hidden overscroll-x-contain">
                <div className="w-full px-4 py-6 sm:px-6">
                  <ProjectScreen
                    lists={LISTS}
                    project={PROJECT}
                    scope={SCOPE}
                    spaceId={"s1" as Doc<"spaces">["_id"]}
                    spaceName="HQ"
                  />
                </div>
              </SidebarInset>
            </SidebarProvider>
            <Editing on={STUDIO || STATE === "arrange"} />
            <StyleStudio />
          </MintablePanelsProvider>
        </CustomizeProvider>
      </AppearanceProvider>
    </ToastProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
