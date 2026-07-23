"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/toast";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/dashboard/empty-state";
import { PriorityDot } from "@/components/dashboard/priority";
import type { TaskPriority } from "@/components/dashboard/priority";
import {
  AnimatedBar,
  AnimatePresence,
  EASE,
  motion,
  Stagger,
  StaggerItem,
} from "@/components/motion";

// Sprint planning: the workspace backlog on the left, this sprint's
// committed tasks on the right, with a story-point capacity bar. Every
// write (commit/uncommit/estimate) goes through convex/sprintPlanning.ts,
// which routes to updateTaskCore — the same core the Board, MCP tools,
// and task page use, so automations/events/notifications stay identical.

const POINT_CHIPS = [1, 2, 3, 5, 8, 13];

type PlanningTask = {
  taskId: Id<"tasks">;
  title: string;
  listId: Id<"lists">;
  listName: string;
  priority: TaskPriority | undefined;
  estimatePoints: number | undefined;
  statusCategory: "open" | "in_progress" | "complete" | "closed";
  assigneeIds: string[];
  sprintId: Id<"sprints"> | undefined;
  sprintName: string | undefined;
};

export function SprintPlanning({
  sprintId,
  workspaceId,
}: {
  sprintId: Id<"sprints">;
  workspaceId: Id<"workspaces">;
}) {
  void workspaceId;
  const data = useQuery(api.sprintPlanning.planning, { sprintId });
  const commit = useMutation(api.sprintPlanning.commit);
  const uncommit = useMutation(api.sprintPlanning.uncommit);
  const setEstimate = useMutation(api.sprintPlanning.setEstimate);
  const updateSprint = useMutation(api.sprints.update);
  const { toast } = useToast();

  if (data === undefined) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="h-56 animate-pulse bg-muted/30" />
        <Card className="h-56 animate-pulse bg-muted/30" />
      </div>
    );
  }
  if (data === null) {
    return (
      <EmptyState
        title="No access"
        message="You don&apos;t have access to plan this sprint."
        compact
      />
    );
  }

  const {
    committed,
    backlog,
    committedPoints,
    committedUnestimated,
    capacityPoints,
  } = data;
  const overCapacity = capacityPoints != null && committedPoints > capacityPoints;
  const pct = capacityPoints ? Math.round((committedPoints / capacityPoints) * 100) : 0;

  async function saveCapacity(raw: string) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      await updateSprint({ sprintId, capacityPoints: null });
      toast("Saved");
      return;
    }
    const value = Number(trimmed);
    if (!Number.isFinite(value) || value < 0) return;
    await updateSprint({ sprintId, capacityPoints: value });
    toast("Saved");
  }

  async function handleEstimate(taskId: Id<"tasks">, points: number | null) {
    await setEstimate({ taskId, points });
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bento-tile p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p
              className={cn(
                "text-sm font-medium",
                overCapacity && "text-danger",
              )}
            >
              {committedPoints} pt{committedPoints === 1 ? "" : "s"}
              {capacityPoints ? ` of ${capacityPoints} committed` : " committed"}
            </p>
            {committedUnestimated > 0 && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {committedUnestimated} unestimated
              </p>
            )}
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Capacity
            <Input
              type="number"
              min={0}
              key={capacityPoints ?? "none"}
              defaultValue={capacityPoints ?? ""}
              placeholder="—"
              onBlur={(e) => saveCapacity(e.currentTarget.value)}
              className="h-8 w-20 text-sm text-foreground"
            />
          </label>
        </div>
        {capacityPoints ? (
          <AnimatedBar
            pct={pct}
            className="mt-3 h-2 overflow-hidden rounded-full bg-muted"
            barClassName={cn(
              "h-full rounded-full",
              overCapacity ? "bg-danger" : "bg-brand-600",
            )}
          />
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            Set a capacity above to track commitment against it.
          </p>
        )}
      </div>

      <Stagger className="grid gap-4 md:grid-cols-2">
        <StaggerItem>
          <Pane
            title="Backlog"
            tasks={backlog}
            emptyMessage="Nothing open outside this sprint."
            direction="commit"
            onMove={(taskId) => commit({ sprintId, taskId })}
            onEstimate={handleEstimate}
          />
        </StaggerItem>
        <StaggerItem>
          <Pane
            title="Committed"
            tasks={committed}
            emptyMessage="Nothing committed yet — move tasks in from the backlog."
            direction="uncommit"
            onMove={(taskId) => uncommit({ taskId })}
            onEstimate={handleEstimate}
          />
        </StaggerItem>
      </Stagger>
    </div>
  );
}

function Pane({
  title,
  tasks,
  emptyMessage,
  direction,
  onMove,
  onEstimate,
}: {
  title: string;
  tasks: PlanningTask[];
  emptyMessage: string;
  direction: "commit" | "uncommit";
  onMove: (taskId: Id<"tasks">) => void;
  onEstimate: (taskId: Id<"tasks">, points: number | null) => void;
}) {
  return (
    <Card className="gap-0 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">{title}</p>
        <span className="text-xs text-muted-foreground">{tasks.length}</span>
      </div>
      {tasks.length === 0 ? (
        <EmptyState title="Nothing here" message={emptyMessage} compact />
      ) : (
        <ul className="mt-3 space-y-1.5">
          <AnimatePresence initial={false}>
            {tasks.map((task) => (
              <Row
                key={task.taskId}
                task={task}
                direction={direction}
                onMove={onMove}
                onEstimate={onEstimate}
              />
            ))}
          </AnimatePresence>
        </ul>
      )}
    </Card>
  );
}

function Row({
  task,
  direction,
  onMove,
  onEstimate,
}: {
  task: PlanningTask;
  direction: "commit" | "uncommit";
  onMove: (taskId: Id<"tasks">) => void;
  onEstimate: (taskId: Id<"tasks">, points: number | null) => void;
}) {
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{
        opacity: 0,
        x: direction === "commit" ? 24 : -24,
        height: 0,
        marginBottom: 0,
      }}
      transition={{ duration: 0.3, ease: EASE }}
      className="flex items-center gap-2 overflow-hidden rounded-xl bento-tile px-3 py-2"
    >
      <button
        type="button"
        onClick={() => onMove(task.taskId)}
        aria-label={
          direction === "commit"
            ? `Commit ${task.title} to sprint`
            : `Move ${task.title} back to backlog`
        }
        title={direction === "commit" ? "Commit to sprint" : "Move to backlog"}
        className="tap-target inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {direction === "commit" ? (
          <ArrowRight className="h-3.5 w-3.5" />
        ) : (
          <ArrowLeft className="h-3.5 w-3.5" />
        )}
      </button>
      {task.priority && <PriorityDot priority={task.priority} />}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{task.title}</p>
        <p className="truncate text-[11px] text-muted-foreground">
          {task.listName}
          {task.sprintName ? ` · in ${task.sprintName}` : ""}
        </p>
      </div>
      <EstimateChip
        taskId={task.taskId}
        points={task.estimatePoints}
        onSet={onEstimate}
      />
    </motion.li>
  );
}

function EstimateChip({
  taskId,
  points,
  onSet,
}: {
  taskId: Id<"tasks">;
  points: number | undefined;
  onSet: (taskId: Id<"tasks">, points: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) setCustom(points != null ? String(points) : "");
  }, [open, points]);

  function choose(value: number | null) {
    onSet(taskId, value);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        className={cn(
          "inline-flex h-6 min-w-6 flex-shrink-0 items-center justify-center rounded-full px-2 text-xs font-medium transition-colors",
          points != null
            ? "bg-pastel-blue text-foreground/80 dark:text-black/80"
            : "bg-muted text-muted-foreground hover:text-foreground",
        )}
      >
        {points != null ? `${points} pt${points === 1 ? "" : "s"}` : "–"}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={{ duration: 0.18, ease: EASE }}
            className="absolute right-0 top-full z-30 mt-1.5 w-48 rounded-2xl border border-border bg-popover p-2.5 text-popover-foreground shadow-lg"
          >
            <div className="flex flex-wrap gap-1.5">
              {POINT_CHIPS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => choose(p)}
                  className={cn(
                    "inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium transition-colors",
                    points === p
                      ? "bg-foreground text-background"
                      : "bg-muted hover:bg-border",
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-1.5">
              <input
                type="number"
                min={0}
                value={custom}
                onChange={(e) => setCustom(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const n = Number(custom);
                    if (custom.trim() !== "" && Number.isFinite(n) && n >= 0) {
                      choose(n);
                    }
                  }
                }}
                placeholder="Custom"
                className="soft-field h-7 w-full px-2 text-xs"
              />
              <button
                type="button"
                onClick={() => choose(null)}
                className="flex-shrink-0 text-xs text-muted-foreground hover:text-foreground"
              >
                Clear
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
