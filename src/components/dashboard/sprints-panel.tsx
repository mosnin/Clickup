"use client";

import Link from "next/link";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Picker } from "@/components/ui/picker";
import { cn } from "@/lib/utils";
import { fromDateInputValue, toDateInputValue } from "@/lib/dates";
import { useToast } from "@/components/toast";
import { ScrumBoard } from "@/components/dashboard/scrum-board";
import { SprintPlanning } from "@/components/dashboard/sprint-planning";
import {
  AnimatedBar,
  AnimatePresence,
  EASE,
  motion,
  Stagger,
  StaggerItem,
} from "@/components/motion";

// Sprints tab on the workspace page: create timeboxes, watch progress,
// and drill into the per-task rollup. Tasks join a sprint from the task
// detail page (Sprint select) or when an agent sets sprintId over MCP.
// Each sprint's expanded detail carries an Overview / Board / Planning
// sub-nav — Overview keeps the rollup + burndown, Board is the scrum
// board workstream's per-status swimlanes, Planning is the backlog vs.
// committed capacity view (convex/sprintPlanning.ts).

const STATUS_STYLE: Record<string, string> = {
  planned: "bg-muted text-muted-foreground",
  active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400",
  complete: "bg-brand-50 text-brand-700",
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const DETAIL_TABS = [
  { key: "overview", label: "Overview" },
  { key: "board", label: "Board" },
  { key: "planning", label: "Planning" },
] as const;
type DetailTab = (typeof DETAIL_TABS)[number]["key"];

export function SprintsPanel({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const sprints = useQuery(api.sprints.listForWorkspace, { workspaceId });
  // ?new=1 deep-links straight into creation (⌘K "New sprint", task-page
  // "Create the first sprint", etc. land here with the form already open).
  const searchParams = useSearchParams();
  const [creating, setCreating] = useState(searchParams.get("new") === "1");

  if (sprints === undefined) {
    return <Card className="h-40 animate-pulse bg-muted/30" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Timebox work across every list in this workspace. Agents can plan
          and run sprints too (see the &quot;Sprint planner&quot; skill).
        </p>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New sprint
        </Button>
      </div>

      {creating && (
        <CreateSprintForm
          workspaceId={workspaceId}
          onDone={() => setCreating(false)}
        />
      )}

      <VelocityStrip workspaceId={workspaceId} />

      {sprints.length === 0 && !creating && (
        <div className="rounded-2xl panel px-6 py-14 text-center">
          <p className="text-sm font-semibold">Plan work in timeboxes</p>
          <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
            A sprint collects tasks into a start-to-finish window, so humans
            and agents burn down the same list together.
          </p>
          <Button size="sm" className="mt-4" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> New sprint
          </Button>
        </div>
      )}

      <Stagger className="space-y-3">
        {sprints.map((s) => (
          <StaggerItem key={s._id}>
            <SprintCard sprint={s} workspaceId={workspaceId} />
          </StaggerItem>
        ))}
      </Stagger>
    </div>
  );
}

function CreateSprintForm({
  workspaceId,
  onDone,
}: {
  workspaceId: Id<"workspaces">;
  onDone: () => void;
}) {
  const create = useMutation(api.sprints.create);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [start, setStart] = useState(() => toDateInputValue(Date.now()));
  const [end, setEnd] = useState(() =>
    toDateInputValue(Date.now() + 14 * 86_400_000),
  );

  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded-2xl panel p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        await create({
          workspaceId,
          name: name.trim(),
          goal: goal.trim() || undefined,
          startDate: fromDateInputValue(start) ?? Date.now(),
          endDate: fromDateInputValue(end) ?? Date.now(),
        });
        onDone();
      }}
    >
      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Name
        </span>
        <input
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="Sprint 12"
          autoFocus
          className="rounded-full border border-border bg-background px-3 py-1.5 text-sm"
        />
      </label>
      <label className="block min-w-40 flex-1">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Goal (optional)
        </span>
        <input
          value={goal}
          onChange={(e) => setGoal(e.currentTarget.value)}
          placeholder="Ship the onboarding revamp"
          className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Start
        </span>
        <input
          type="date"
          value={start}
          onChange={(e) => setStart(e.currentTarget.value)}
          className="rounded-full border border-border bg-background px-3 py-1.5 text-sm"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          End
        </span>
        <input
          type="date"
          value={end}
          onChange={(e) => setEnd(e.currentTarget.value)}
          className="rounded-full border border-border bg-background px-3 py-1.5 text-sm"
        />
      </label>
      <div className="flex gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!name.trim()}>
          Create
        </Button>
      </div>
    </form>
  );
}

function SprintCard({
  sprint,
  workspaceId,
}: {
  sprint: {
    _id: Id<"sprints">;
    name: string;
    goal?: string;
    startDate: number;
    endDate: number;
    status: "planned" | "active" | "complete";
    taskCount: number;
    doneCount: number;
    retrospective?: string;
  };
  workspaceId: Id<"workspaces">;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<DetailTab>("overview");
  const [deleting, setDeleting] = useState(false);
  const update = useMutation(api.sprints.update);
  const remove = useMutation(api.sprints.remove);
  const updateTask = useMutation(api.tasks.update);
  const { toast } = useToast();
  const summary = useQuery(
    api.sprints.summary,
    open ? { sprintId: sprint._id } : "skip",
  );
  const addable = useQuery(
    api.sprints.addableTasks,
    open && sprint.status !== "complete" ? { sprintId: sprint._id } : "skip",
  );

  // Hidden while its undo toast is live — delete commits on expiry.
  if (deleting) return null;

  const pct =
    sprint.taskCount === 0
      ? 0
      : Math.round((sprint.doneCount / sprint.taskCount) * 100);
  const fmt = (ts: number) =>
    new Date(ts).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });

  return (
    <Card className="gap-0 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Collapse" : "Expand"}
          className="tap-target inline-flex h-5 w-5 items-center justify-center text-muted-foreground"
        >
          <motion.span
            animate={{ rotate: open ? 90 : 0 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="inline-flex"
          >
            <ChevronRight className="h-4 w-4" />
          </motion.span>
        </button>
        <span className="font-medium">{sprint.name}</span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider",
            STATUS_STYLE[sprint.status],
          )}
        >
          {sprint.status}
        </span>
        <span className="text-xs text-muted-foreground">
          {fmt(sprint.startDate)} – {fmt(sprint.endDate)}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {sprint.doneCount}/{sprint.taskCount} done
        </span>
        {sprint.status !== "complete" && (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              const nextStatus =
                sprint.status === "planned" ? "active" : "complete";
              await update({ sprintId: sprint._id, status: nextStatus });
              if (nextStatus === "complete") {
                setOpen(true);
                setTab("overview");
                toast("Sprint completed — add a retrospective");
              }
            }}
          >
            {sprint.status === "planned" ? "Start" : "Complete"}
          </Button>
        )}
        <button
          type="button"
          title="Delete sprint (tasks are kept)"
          onClick={() => {
            setDeleting(true);
            toast(`${sprint.name} deleted, tasks are kept`, {
              action: { label: "Undo", onClick: () => setDeleting(false) },
              onExpire: () => remove({ sprintId: sprint._id }),
            });
          }}
          className="tap-target inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-red-600"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {sprint.goal && (
        <p className="mt-1 pl-7 text-xs text-muted-foreground">{sprint.goal}</p>
      )}

      <AnimatedBar
        pct={pct}
        className="mt-3 h-2 overflow-hidden rounded-full bg-muted"
        barClassName="h-full rounded-full bg-brand-600"
      />

      <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="expanded"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.4, ease: EASE }}
          className="mt-3 space-y-3 overflow-hidden pl-7">
          <nav
            aria-label="Sprint detail sections"
            className="flex w-fit items-center gap-1 text-xs"
          >
            {DETAIL_TABS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                aria-current={tab === key ? "page" : undefined}
                className={cn(
                  "rounded-md px-3 py-1.5 transition-colors",
                  tab === key
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </nav>

          {tab === "overview" &&
            (summary ? (
              <div className="space-y-3">
                {sprint.status !== "planned" && (
                  <BurndownCard
                    sprintId={sprint._id}
                    endDate={sprint.endDate}
                    status={sprint.status}
                  />
                )}
                <ul className="space-y-1">
                  {summary.tasks.length === 0 && (
                    <li className="text-xs text-muted-foreground">
                      No tasks in this sprint yet. Add them from a task&apos;s
                      Sprint field.
                    </li>
                  )}
                  {sprint.status !== "complete" && (
                    <li>
                      <Picker
                        label="+ Add task to sprint…"
                        dashed
                        options={(addable ?? []).map((t) => ({
                          id: t.taskId,
                          label: t.title,
                        }))}
                        onSelect={(id) =>
                          updateTask({
                            taskId: id as Id<"tasks">,
                            sprintId: sprint._id,
                          })
                        }
                      />
                    </li>
                  )}
                  {summary.tasks.map((t) => (
                    <li key={t._id} className="flex items-center gap-2 text-sm">
                      <span
                        aria-hidden
                        className={cn(
                          "h-1.5 w-1.5 flex-shrink-0 rounded-full",
                          t.statusCategory === "complete" ||
                            t.statusCategory === "closed"
                            ? "bg-emerald-500"
                            : t.statusCategory === "in_progress"
                              ? "bg-blue-500"
                              : "bg-muted-foreground",
                        )}
                      />
                      <Link
                        href={`/dashboard/l/${t.listId}/t/${t._id}`}
                        className="min-w-0 flex-1 truncate hover:underline"
                      >
                        {t.title}
                      </Link>
                      <span className="text-xs text-muted-foreground">
                        {t.statusName}
                      </span>
                    </li>
                  ))}
                </ul>
                {sprint.status === "complete" && (
                  <RetrospectiveField sprint={sprint} />
                )}
              </div>
            ) : (
              <Card className="h-24 animate-pulse bg-muted/30" />
            ))}

          {tab === "board" && (
            <ScrumBoard sprintId={sprint._id} workspaceId={workspaceId} />
          )}

          {tab === "planning" && (
            <SprintPlanning sprintId={sprint._id} workspaceId={workspaceId} />
          )}
        </motion.div>
      )}
      </AnimatePresence>
    </Card>
  );
}

// Blur-saved retro notes, shown on the Overview tab once a sprint
// completes — the nudge toast on Complete points people back here.
function RetrospectiveField({
  sprint,
}: {
  sprint: { _id: Id<"sprints">; retrospective?: string };
}) {
  const update = useMutation(api.sprints.update);
  const { toast } = useToast();

  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Retrospective
      </p>
      <textarea
        key={sprint._id}
        defaultValue={sprint.retrospective ?? ""}
        placeholder="What went well? What would you change next sprint?"
        rows={3}
        onBlur={(e) => {
          const value = e.currentTarget.value;
          if (value === (sprint.retrospective ?? "")) return;
          update({ sprintId: sprint._id, retrospective: value });
          toast("Saved");
        }}
        className="mt-2 w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
    </div>
  );
}

// ── Burndown ────────────────────────────────────────────────────────────

function xAt(i: number, n: number, padX: number, w: number) {
  return n <= 1 ? padX : padX + (i / (n - 1)) * (w - 2 * padX);
}

function yAt(remaining: number, total: number, padY: number, h: number) {
  if (total <= 0) return h - padY;
  return padY + (1 - remaining / total) * (h - 2 * padY);
}

function toPath(points: ({ x: number; y: number } | null)[]) {
  let d = "";
  let drawing = false;
  for (const p of points) {
    if (!p) {
      drawing = false;
      continue;
    }
    d += `${drawing ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)} `;
    drawing = true;
  }
  return d.trim();
}

type BurndownData = {
  totalTasks: number;
  doneTasks: number;
  startAt: number;
  endAt: number;
  days: { dayStart: number; remaining: number | null }[];
  ideal: { dayStart: number; remaining: number }[];
};

function BurndownSvg({ burndown }: { burndown: BurndownData }) {
  const { totalTasks, days, ideal } = burndown;
  const w = 320;
  const h = 96;
  const padX = 6;
  const padY = 10;
  const n = days.length;

  const idealPts = ideal.map((d, i) => ({
    x: xAt(i, n, padX, w),
    y: yAt(d.remaining, totalTasks, padY, h),
  }));
  const actualPts = days.map((d, i) =>
    d.remaining === null
      ? null
      : { x: xAt(i, n, padX, w), y: yAt(d.remaining, totalTasks, padY, h) },
  );
  const idealPath = toPath(idealPts);
  const actualPath = toPath(actualPts);
  const gridEvery = n <= 21 ? 1 : Math.ceil(n / 20);

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      height={h}
      className="block"
      role="img"
      aria-label={`Burndown chart: ${burndown.doneTasks} of ${totalTasks} tasks done, tracked against an ideal pace over ${n} day${n === 1 ? "" : "s"}.`}
    >
      {days.map(
        (_, i) =>
          i % gridEvery === 0 && (
            <line
              key={i}
              x1={xAt(i, n, padX, w)}
              x2={xAt(i, n, padX, w)}
              y1={padY}
              y2={h - padY}
              stroke="var(--color-border)"
              strokeWidth={1}
            />
          ),
      )}
      <path
        d={idealPath}
        fill="none"
        stroke="var(--color-muted-foreground)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.7}
      />
      <path
        d={actualPath}
        fill="none"
        stroke="var(--color-foreground)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {actualPts.map(
        (p, i) =>
          p && (
            <circle key={i} cx={p.x} cy={p.y} r={2.5} fill="var(--color-foreground)" />
          ),
      )}
    </svg>
  );
}

function BurndownCard({
  sprintId,
  endDate,
  status,
}: {
  sprintId: Id<"sprints">;
  endDate: number;
  status: "planned" | "active" | "complete";
}) {
  const burndown = useQuery(api.sprints.burndown, { sprintId });

  if (burndown === undefined) {
    return <Card className="h-28 animate-pulse bg-muted/30" />;
  }
  if (!burndown || burndown.totalTasks === 0) {
    return (
      <Card className="gap-0 px-4 py-6 text-center">
        <p className="text-xs text-muted-foreground">
          No tasks in this sprint yet — the burndown fills in once work
          joins.
        </p>
      </Card>
    );
  }

  const { totalTasks, doneTasks, days, ideal } = burndown;
  const lastKnown = [...days].reverse().find((d) => d.remaining !== null);
  const idealAtSame = lastKnown
    ? ideal.find((i) => i.dayStart === lastKnown.dayStart)
    : undefined;
  const behind =
    !!lastKnown &&
    !!idealAtSame &&
    totalTasks > 0 &&
    (lastKnown.remaining! - idealAtSame.remaining) / totalTasks > 0.2;
  const ended = status === "complete" || Date.now() > endDate;
  const daysLeft = Math.max(0, Math.ceil((endDate - Date.now()) / ONE_DAY_MS));

  return (
    <Card className="gap-0 p-4">
      <BurndownSvg burndown={burndown} />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-3 text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-0.5 w-3 rounded-full bg-foreground" />
            Actual
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="h-0.5 w-3 rounded-full bg-muted-foreground"
            />
            Ideal
          </span>
        </span>
        <span
          className={cn(
            "font-medium",
            behind ? "text-danger" : "text-muted-foreground",
          )}
        >
          {doneTasks} of {totalTasks} done ·{" "}
          {ended
            ? "sprint ended"
            : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`}
        </span>
      </div>
    </Card>
  );
}

// Points-based velocity: how many story points the last completed sprints
// actually closed out, so planning can lean on a real trend instead of a
// guess. Falls back to nothing until there are at least two completed
// sprints to compare.
function VelocityStrip({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const velocity = useQuery(api.sprintPlanning.velocityPoints, { workspaceId });
  if (!velocity || velocity.length < 2) return null;

  const max = Math.max(1, ...velocity.map((v) => v.completedPoints));
  const totalPoints = velocity.reduce((sum, v) => sum + v.completedPoints, 0);
  const totalTasks = velocity.reduce((sum, v) => sum + v.completedCount, 0);
  const avgPoints = Math.round(totalPoints / velocity.length);

  return (
    <Card className="gap-0 p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Velocity
      </p>
      <div className="mt-3 space-y-2">
        {velocity.map((v) => (
          <div key={v.sprintId} className="flex items-center gap-3">
            <span
              title={v.name}
              className="w-24 flex-shrink-0 truncate text-xs text-muted-foreground"
            >
              {v.name}
            </span>
            <AnimatedBar
              pct={(v.completedPoints / max) * 100}
              className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
              barClassName="h-full rounded-full bg-brand-200"
            />
            <span className="w-14 flex-shrink-0 text-right text-xs text-muted-foreground">
              {v.completedPoints} pt{v.completedPoints === 1 ? "" : "s"}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        avg {avgPoints} pt{avgPoints === 1 ? "" : "s"} per sprint · {totalTasks}{" "}
        task{totalTasks === 1 ? "" : "s"} completed
      </p>
    </Card>
  );
}
