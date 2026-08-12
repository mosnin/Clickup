import { createRoot } from "react-dom/client";
import { ToastProvider } from "@/components/toast";
import { AppearanceProvider } from "@/components/appearance/appearance-provider";
import { TaskBanners } from "@/components/dashboard/task-collab";
import { TaskBadges } from "@/components/dashboard/task-badges";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { galleryData } from "./stubs/convex-react";

// The four states a fleet puts a task into, drawn.
//
// Iterations 13 to 16 added banners and badges for a completion waiting on a
// human, a task held after repeated failure, an approval gate and a claim —
// and every one of them was verified by a test that READS SOURCE. Those tests
// prove the wiring exists. They are silent on the only questions a person
// actually has about a banner: does it fit, is the text readable on the plate
// it sits on, and does the stack of them still look like one page.
//
// This is the fixture that can answer those, and there was none. Four rounds
// of "I have not watched this in a browser" is a debt, not a caveat.
//
// The states are shown TOGETHER on purpose. Each was designed on its own, and
// the failure they can only have in combination is the one worth looking for:
// four coloured cards in a column, three of which are some flavour of alarm,
// is a page that reads as broken even when every individual card is right.

const NOW = Date.now();

/**
 * A task in whatever state the caption says.
 *
 * `_id` is a parameter and not a constant because the badge row is drawn from
 * `pendingEffects.forList`, which is a LIST of task ids — four rows sharing one
 * id meant every row matched, so all four wore the "finished" mark and the row
 * proved nothing about whether the marks are tellable apart. The fixture was
 * agreeing with itself.
 */
function task(over: Partial<Doc<"tasks">> = {}): Doc<"tasks"> {
  return {
    _id: "task_1" as Id<"tasks">,
    _creationTime: NOW,
    listId: "list_1" as Id<"lists">,
    title: "Migrate the billing tables",
    statusId: "status_open" as Id<"listStatuses">,
    assigneeClerkIds: [],
    createdByClerkId: "user_1",
    position: 0,
    createdAt: NOW,
    ...over,
  } as Doc<"tasks">;
}

// One agent, so the claim banner can name somebody rather than "someone".
galleryData["agents.listAssignableForList"] = [
  { id: "agent_scout", name: "Scout", kind: "agent" },
];
galleryData["listStatuses.listForList"] = [
  { _id: "status_open", name: "To Do", category: "open", listId: "list_1" },
];
galleryData["tasks.listForList"] = [];

const HANDBACK = {
  id: "eff_1",
  agentName: "Scout",
  reason:
    "Migrated the four billing tables, backfilled 12,400 rows and ran the smoke suite — all green. Left the old columns in place so this is reversible.",
  createdAt: NOW - 1000 * 60 * 90,
  stale: false,
};

/**
 * Each case renders the REAL component with only the wire stubbed.
 *
 * The fixtures are set immediately before the subtree that reads them, because
 * the stub reads `galleryData` during render — so a case that wants a handback
 * and a case that does not cannot both be on the page unless the table is
 * rewritten between them.
 */
function Case({
  title,
  note,
  handback,
  finished = [],
  children,
}: {
  title: string;
  note: string;
  handback: unknown;
  /** Task ids whose completion is waiting — what `forList` answers. */
  finished?: string[];
  children: React.ReactNode;
}) {
  galleryData["pendingEffects.forTask"] = handback;
  galleryData["pendingEffects.forList"] = finished;
  return (
    <section className="case">
      <p className="cap">{title}</p>
      <p className="note">{note}</p>
      {children}
    </section>
  );
}

function Row({ t }: { t: Doc<"tasks"> }) {
  return (
    <div className="row">
      <span className="row-title">{t.title}</span>
      <TaskBadges task={t} />
    </div>
  );
}

function Gallery() {
  return (
    <>
      <h1>What a fleet does to a task</h1>
      <p className="note">
        Real banners and real badges, one stub between them and Convex.
      </p>

      <h2>Banners</h2>

      <Case
        title="Finished, waiting on a human"
        note="The state the whole deferred-approval design exists for. The agent's own account of what it did has to be readable here, or the reviewer re-does the work to find out what they are approving."
        handback={HANDBACK}
        finished={["task_1"]}
      >
        <TaskBanners
          task={task({ requiresApproval: true })}
          listId={"list_1" as Id<"lists">}
        />
      </Case>

      <Case
        title="Gate, nothing waiting"
        note="No Approve button in the handback case above — this is the one that carries it."
        handback={null}
      >
        <TaskBanners
          task={task({ requiresApproval: true })}
          listId={"list_1" as Id<"lists">}
        />
      </Case>

      <Case
        title="Held after failing"
        note="Withheld from the dispatcher. On its own page this used to look like ordinary open work nobody happened to pick up."
        handback={null}
      >
        <TaskBanners
          task={task({
            thrashHeldAt: NOW - 1000 * 60 * 60 * 5,
            thrashFailures: 4,
            holdReason: "thrash",
          })}
          listId={"list_1" as Id<"lists">}
        />
      </Case>

      <Case
        title="Everything at once"
        note="Handed back, held, gated and claimed. This is the composition nobody looked at: four full cards, three of them alarm. One card for the thing that needs deciding, one line for the rest."
        handback={HANDBACK}
        finished={["task_1"]}
      >
        <TaskBanners
          task={task({
            requiresApproval: true,
            claimedByActorId: "agent_scout",
            claimedAt: NOW - 1000 * 60 * 20,
            thrashHeldAt: NOW - 1000 * 60 * 60 * 5,
            thrashFailures: 4,
            holdReason: "attempts_exhausted",
          })}
          listId={"list_1" as Id<"lists">}
        />
      </Case>

      <h2>Badges, in a row</h2>

      <Case
        title="A board with every state on it"
        note="Three pixels each. They have to be tellable apart at this size or they are decoration — and the last row has to stay bare, or none of them mean anything."
        handback={null}
        finished={["task_finished"]}
      >
        <div className="rows">
          <Row
            t={task({
              _id: "task_finished" as Id<"tasks">,
              title: "Finished, waiting on you",
            })}
          />
          <Row
            t={task({
              _id: "task_claimed" as Id<"tasks">,
              title: "Claimed right now",
              claimedByActorId: "agent_scout",
              claimedAt: NOW,
            })}
          />
          <Row
            t={task({
              _id: "task_held" as Id<"tasks">,
              title: "Held after repeated failure",
              thrashHeldAt: NOW,
              holdReason: "thrash",
            })}
          />
          <Row
            t={task({
              _id: "task_gated" as Id<"tasks">,
              title: "Gated, nothing waiting yet",
              requiresApproval: true,
            })}
          />
          <Row
            t={task({
              _id: "task_plain" as Id<"tasks">,
              title: "Ordinary open work",
            })}
          />
        </div>
      </Case>
    </>
  );
}

// ToastProvider OUTSIDE AppearanceProvider: the appearance provider reaches
// for the toast context itself, so nesting it the other way throws before
// anything renders. Same order the other gallery fixtures use.
createRoot(document.getElementById("root")!).render(
  <ToastProvider>
    <AppearanceProvider>
      <Gallery />
    </AppearanceProvider>
  </ToastProvider>,
);
