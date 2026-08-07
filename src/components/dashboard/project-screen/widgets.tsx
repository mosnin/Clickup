"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { List as ListIcon, Plus } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/dashboard/empty-state";
import { InlineCreate } from "@/components/dashboard/inline-create";
import { AttachedPages } from "@/components/dashboard/attached-pages";
import { AgentStream } from "@/components/dashboard/agent-stream";
import { LiveNumber } from "@/components/dashboard/live-number";
import {
  ProjectNotesCard,
  ProjectOwnerCard,
  ProjectStatusCard,
  ProjectTargetDateCard,
} from "@/components/dashboard/project-meta-cards";
import { Stagger, StaggerItem } from "@/components/motion";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { timeAgo } from "@/lib/time";
import { eventLabel } from "@/lib/event-labels";
import { describePlan, planView, stateLabel } from "@/lib/plan";
import type { WidgetRows, WidgetSpan } from "@/lib/screen-layout";

// The widget registry.
//
// Adding a panel to the project screen is one entry in `PROJECT_WIDGETS`. That
// is the whole point of this file: the layout engine knows ids and spans, the
// screen knows how to arrange them, and only this file knows what any of them
// mean. Nothing else has to change.
//
// Each widget declares the widths it can render at rather than being resizable
// to anything — a two-column table squeezed into one column isn't a narrower
// table, it's a broken one, so `minSpan` is a real constraint and the width
// control skips what a widget can't do.

export type ProjectWidgetContext = {
  project: Doc<"projects">;
  lists: Doc<"lists">[];
  spaceId: Id<"spaces">;
  spaceName: string;
  /**
   * The user or workspace this project ultimately belongs to.
   *
   * User-authored panels are offered per scope rather than per project — a
   * panel you wrote for one project is almost always one you want on the next,
   * and scoping them per project would mean rebuilding the same panel per
   * board.
   */
  scope: { scopeType: "user" | "workspace"; scopeId: string };
};

export type ProjectWidget = {
  id: string;
  title: string;
  /** Shown in the "add a panel" tray — says what it's for, not what it is. */
  description: string;
  defaultSpan: WidgetSpan;
  minSpan: WidgetSpan;
  maxSpan: WidgetSpan;
  /**
   * Height in grid rows. Real sizes are what make the screen look composed.
   *
   * Stated against the 6rem unit, and MEASURED rather than guessed —
   * `.measure-project.mjs` frees each tile's box and reads what its content
   * actually wants, at 1180, 900 and 390. They were 1 and 2 against a 10.5rem
   * unit, which is how the Lists panel came to be a 456px card holding 164px
   * of list. See `WidgetRows` for why the unit changed.
   */
  rows: WidgetRows;
  render: (ctx: ProjectWidgetContext) => React.ReactNode;
};

// ── Individual widgets ──────────────────────────────────────────────────

function AboutWidget({ project }: ProjectWidgetContext) {
  const updateMeta = useMutation(api.projects.updateMeta);
  const { toast } = useToast();
  return (
    <Card className="flex h-full flex-col rounded-2xl p-5">
      <span className="text-tiny font-medium uppercase tracking-wider text-muted-foreground">
        About
      </span>
      {/* A textarea, not an input. A single-line field lays a long
          description out at its full natural width and lets the card crop it,
          so "…without a gap in invoicing" arrived on screen as "…without a
          gap i" with nothing to say it had been cut. A description is a
          sentence; sentences wrap. */}
      <textarea
        rows={3}
        defaultValue={project.description ?? ""}
        placeholder="What is this project about?"
        aria-label="Project description"
        onBlur={(e) => {
          const next = e.currentTarget.value;
          if (next === (project.description ?? "")) return;
          void updateMeta({ projectId: project._id, description: next })
            .then(() => toast("Saved"))
            .catch((err) =>
              toast(errorMessage(err, "Couldn't save description"), {
                kind: "error",
              }),
            );
        }}
        // A form field cannot borrow a hit area: `.tap-target` hangs its halo
        // off an `::after`, and an `<input>` generates no pseudo-elements —
        // and the gate is right to refuse to widen a field onto whatever card
        // encloses it, since pressing the card selects the card rather than
        // putting a caret in the field. So the box itself is the target. A
        // 20px-tall line of text was the whole of it; on touch it is 44.
        className="mt-2 w-full flex-1 resize-none bg-transparent text-sm leading-6 focus:outline-none [@media(pointer:coarse)]:min-h-11"
      />
    </Card>
  );
}

function ListsWidget({ project, lists }: ProjectWidgetContext) {
  const createList = useMutation(api.lists.create);
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);

  return (
    // A Card like every other panel on this screen. It was a bare <section>,
    // so on a sheet of framed panels the Lists block read as a hole rather
    // than as a deliberate choice — and its own heading was a different size
    // and weight from the six micro-labels around it.
    <Card className="flex h-full flex-col overflow-hidden rounded-2xl p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-tiny font-medium uppercase tracking-wider text-muted-foreground">
          Lists
        </h2>
        {!creating && (
          <Button
            variant="outline"
            size="sm"
            className="tap-target"
            onClick={() => setCreating(true)}
          >
            <Plus className="h-3.5 w-3.5" />
            Add list
          </Button>
        )}
      </div>

      {creating && (
        <div className="mt-3">
          <InlineCreate
            placeholder="List name…"
            onCancel={() => setCreating(false)}
            onSubmit={async (name) => {
              try {
                await createList({
                  parentType: "project",
                  parentId: project._id,
                  name,
                });
                setCreating(false);
              } catch (e) {
                toast(errorMessage(e, "Couldn't create the list"), {
                  kind: "error",
                });
              }
            }}
          />
        </div>
      )}

      {lists.length === 0 && !creating ? (
        <div className="mt-3">
          <EmptyState
            compact
            title="No lists yet"
            message="A list is one board of tasks inside this project — Backlog, Milestones, whatever the work needs."
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCreating(true)}
              >
                Add a list
              </Button>
            }
          />
        </div>
      ) : (
        <Stagger className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {lists.map((l) => (
            <StaggerItem key={l._id}>
              <Link
                href={`/dashboard/l/${l._id}`}
                // `bento-tile` rather than `Card`: a card inside a card is two
                // shadows arguing. The brand system's answer for a nested
                // surface is a well.
                className="lift bento-tile block rounded-xl p-3.5"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <ListIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    <span className="truncate text-sm font-medium">{l.name}</span>
                  </div>
                  {l.description && (
                    <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">
                      {l.description}
                    </p>
                  )}
                </div>
              </Link>
            </StaggerItem>
          ))}
        </Stagger>
      )}
    </Card>
  );
}

/**
 * How much of the project is done, rolled up across its lists.
 *
 * The one widget that answers the question people actually open a project page
 * to ask. Reads the existing per-list rollup rather than counting tasks here —
 * a panel that walks every task is a panel that stops loading.
 */
function ProgressWidget({ project, lists }: ProjectWidgetContext) {
  const rollups = useQuery(api.projects.rollupsForProject, {
    projectId: project._id,
  });

  if (rollups === undefined) {
    return <div className="h-28 animate-pulse rounded-2xl bg-muted" />;
  }
  const total = rollups.reduce((sum, r) => sum + r.total, 0);
  const done = rollups.reduce((sum, r) => sum + r.completed, 0);
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <Card className="h-full rounded-2xl p-5">
      <span className="text-tiny font-medium uppercase tracking-wider text-muted-foreground">
        Progress
      </span>
      {total === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No tasks yet across {lists.length === 1 ? "this list" : "these lists"}.
        </p>
      ) : (
        <>
          <p className="mt-2 flex items-baseline gap-2">
            <span className="text-3xl tabular-nums">
              {/* When an agent completes work this number changes under you —
                  digits resolving is how a change you didn't make gets seen. */}
              <LiveNumber value={pct} />%
            </span>
            <span className="text-xs text-muted-foreground">
              {done} of {total} done
            </span>
          </p>
          <div
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-foreground transition-[width] duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
        </>
      )}
    </Card>
  );
}

/** What has happened here lately — the project's own slice of the event log. */
function ActivityWidget({ project }: ProjectWidgetContext) {
  const events = useQuery(api.events.forProject, {
    projectId: project._id,
    limit: 12,
  });

  if (events === undefined) {
    return <div className="h-40 animate-pulse rounded-2xl bg-muted" />;
  }

  return (
    <Card className="h-full rounded-2xl p-5">
      <span className="text-tiny font-medium uppercase tracking-wider text-muted-foreground">
        Activity
      </span>
      {events.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Nothing yet. This fills in as people and agents work.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {events.map((e) => (
            <li key={e.eventId} className="text-xs">
              <span className="text-foreground">{e.actorName}</span>{" "}
              <span className="text-muted-foreground">
                {eventLabel(e.type)}
                {e.entityTitle ? ` ${e.entityTitle}` : ""}
              </span>{" "}
              {/* `text-muted-foreground`, not `/70`. An opacity modifier on an
                  already-muted token is a third tier of quiet that nothing
                  designed: it composited to 2.9:1 here, below AA, and it is
                  invisible to the contrast preference — the slider moves
                  `--color-muted-foreground` and then this multiplied it back
                  down again. Muted is the quietest register the product has;
                  a timestamp is not quieter than muted. */}
              <span className="text-muted-foreground">
                {timeAgo(e.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function PagesWidget({ project }: ProjectWidgetContext) {
  return <AttachedPages targetType="project" targetId={project._id} />;
}

// ── The registry ────────────────────────────────────────────────────────


/**
 * What the project has not decided.
 *
 * The plan lives at its own route, but its headline belongs where people are
 * already standing: "two decisions are waiting on you" is not something anyone
 * should have to go and look for. What is shown is what is *open* — the settled
 * questions are the plan's bulk and the least urgent thing on any screen.
 */
function PlanWidget({ project }: ProjectWidgetContext) {
  const rows = useQuery(api.plans.forProject, { projectId: project._id });
  const view = planView(rows ?? []);

  if (rows === undefined) {
    return (
      <Card className="h-full p-4">
        <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
      </Card>
    );
  }

  return (
    <Card className="flex h-full flex-col p-4">
      <span className="text-tiny font-medium uppercase tracking-wider text-muted-foreground">
        Open questions
      </span>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {describePlan(view)}
      </p>

      {view.open.length > 0 && (
        <ul className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto">
          {view.open.slice(0, 6).map((q) => (
            <li key={q.node.id} className="min-w-0">
              <Link
                href={`/dashboard/p/${project._id}/plan`}
                className="block text-xs leading-relaxed hover:underline"
              >
                {q.node.body}
              </Link>
              <span className="text-micro text-muted-foreground">
                {stateLabel(q.state).toLowerCase()}
              </span>
            </li>
          ))}
        </ul>
      )}

      <Link
        href={`/dashboard/p/${project._id}/plan`}
        className="mt-3 text-tiny text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
      >
        {view.questions.length === 0 ? "Raise the first one" : "Open the plan"}
      </Link>
    </Card>
  );
}

export const PROJECT_WIDGETS: ProjectWidget[] = [
  {
    id: "about",
    title: "About",
    description: "One line on what this project is for.",
    defaultSpan: 2,
    minSpan: 1,
    maxSpan: 3,
    rows: 2,
    render: (ctx) => <AboutWidget {...ctx} />,
  },
  {
    id: "progress",
    title: "Progress",
    description: "How much is done, across every list in the project.",
    defaultSpan: 1,
    minSpan: 1,
    maxSpan: 3,
    rows: 2,
    render: (ctx) => <ProgressWidget {...ctx} />,
  },
  {
    id: "lists",
    title: "Lists",
    description: "The boards of tasks inside this project.",
    defaultSpan: 2,
    // A grid of list cards below two columns is a single file of cards, which
    // is a worse list than a list.
    minSpan: 2,
    maxSpan: 3,
    rows: 3,
    render: (ctx) => <ListsWidget {...ctx} />,
  },
  {
    id: "status",
    title: "Status",
    description: "On track, at risk, blocked, done.",
    defaultSpan: 1,
    minSpan: 1,
    maxSpan: 2,
    rows: 2,
    render: ({ project }) => <ProjectStatusCard project={project} />,
  },
  {
    id: "owner",
    title: "Owner",
    description: "Who is accountable — a person or an agent.",
    defaultSpan: 1,
    minSpan: 1,
    maxSpan: 2,
    rows: 2,
    render: ({ project, lists }) => (
      <ProjectOwnerCard project={project} anyListId={lists[0]?._id} />
    ),
  },
  {
    id: "target-date",
    title: "Target date",
    description: "When this is meant to land.",
    defaultSpan: 1,
    minSpan: 1,
    maxSpan: 2,
    rows: 2,
    render: ({ project }) => <ProjectTargetDateCard project={project} />,
  },
  {
    id: "pages",
    title: "Pages",
    description: "The brief, the decisions, the runbook.",
    defaultSpan: 1,
    minSpan: 1,
    maxSpan: 3,
    rows: 3,
    render: (ctx) => <PagesWidget {...ctx} />,
  },
  {
    id: "notes",
    title: "Notes",
    description: "A scratchpad that lives with the project.",
    defaultSpan: 1,
    minSpan: 1,
    maxSpan: 3,
    rows: 2,
    render: ({ project }) => <ProjectNotesCard project={project} />,
  },
  {
    id: "activity",
    title: "Activity",
    description: "What people and agents have done here lately.",
    defaultSpan: 1,
    minSpan: 1,
    maxSpan: 3,
    rows: 3,
    render: (ctx) => <ActivityWidget {...ctx} />,
  },
  {
    id: "agent-stream",
    title: "Agents, live",
    description: "What the machines are doing right now, as it lands.",
    defaultSpan: 1,
    minSpan: 1,
    maxSpan: 2,
    rows: 3,
    render: ({ scope }) => (
      <Card className="h-full rounded-2xl p-5">
        <AgentStream scope={scope} />
      </Card>
    ),
  },
  {
    id: "plan",
    title: "Open questions",
    description: "What this project hasn't decided, and what's waiting on you.",
    defaultSpan: 1,
    minSpan: 1,
    maxSpan: 2,
    rows: 3,
    render: (ctx) => <PlanWidget {...ctx} />,
  },
];

export const PROJECT_WIDGET_IDS = PROJECT_WIDGETS.map((w) => w.id);

export function widgetById(id: string): ProjectWidget | undefined {
  return PROJECT_WIDGETS.find((w) => w.id === id);
}

/**
 * The screen someone gets before they have customised anything.
 *
 * Chosen to match what the project page shipped as, so turning this feature on
 * changes nothing for anyone who never opens the customiser.
 */
export const DEFAULT_PROJECT_LAYOUT = {
  widgets: [
    { id: "about", span: 2 as WidgetSpan },
    { id: "progress", span: 1 as WidgetSpan },
    { id: "lists", span: 2 as WidgetSpan },
    // The plan ships in the default arrangement rather than waiting in the
    // tray. A surface nobody can find is a surface that does not exist, and
    // "open questions" is the one thing on this screen that is about what
    // has not happened yet — which is the part people forget.
    { id: "plan", span: 1 as WidgetSpan },
    { id: "pages", span: 1 as WidgetSpan },
    { id: "status", span: 1 as WidgetSpan },
    { id: "owner", span: 1 as WidgetSpan },
    { id: "target-date", span: 1 as WidgetSpan },
    { id: "notes", span: 1 as WidgetSpan },
  ],
};
