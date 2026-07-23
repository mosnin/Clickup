"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { TaskBadges } from "@/components/dashboard/task-badges";
import { ChecklistChip } from "@/components/dashboard/checklist";
import { Monogram } from "@/components/dashboard/monogram";
import { useToast } from "@/components/toast";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CalendarDays, Ellipsis, GripVertical } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { parseQuickAdd } from "@/lib/quick-add";
import { taskPeekHref } from "@/components/dashboard/task-peek";
import { EASE, motion } from "@/components/motion";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import {
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  PriorityChip,
  PriorityDot,
  type TaskPriority,
} from "@/components/dashboard/priority";

// Swimlanes: group the same status columns into horizontal bands. "none" is
// the original single-row board — its layout and DnD wiring stay byte-for-
// byte the same as before this feature; lane modes reuse the exact same
// `columns` (grouped by status across the WHOLE list) for drag math, and
// only filter what's rendered per band. Cross-lane drops therefore always
// resolve to a status-only change, never a silent reassignment.
type LaneMode = "none" | "assignee" | "priority" | "sprint";

function parseLaneMode(value: string | null): LaneMode {
  return value === "assignee" || value === "priority" || value === "sprint"
    ? value
    : "none";
}

function laneKeyFor(task: Doc<"tasks">, mode: LaneMode): string {
  if (mode === "assignee") return task.assigneeClerkIds[0] ?? "__unassigned";
  if (mode === "priority") return task.priority ?? "__none";
  if (mode === "sprint") return task.sprintId ?? "__none";
  return "__all";
}

// Empty-column droppable ids are namespaced by lane so @dnd-kit sees a
// distinct target per (lane, status) pair; task ids never need namespacing
// since a task belongs to exactly one lane already.
function columnDomId(laneKey: string | null, statusId: Id<"listStatuses">): string {
  return laneKey === null ? statusId : `${laneKey}::${statusId}`;
}

type LaneDescriptor = {
  key: string;
  label: string;
  priority?: TaskPriority | null;
  kind?: "user" | "agent";
};

export function BoardView({
  listId,
  tasks,
  statuses,
}: {
  listId: Id<"lists">;
  tasks: Doc<"tasks">[];
  statuses: Doc<"listStatuses">[];
}) {
  // Optimistic local copy so drag-drop feels instant. Server is the source
  // of truth and reconciles back via the live query whenever it returns.
  const [orderedTasks, setOrderedTasks] = useState<Doc<"tasks">[]>(tasks);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<Id<"tasks"> | null>(null);
  useEffect(() => setOrderedTasks(tasks), [tasks]);

  const reorder = useMutation(api.tasks.reorder);

  const searchParams = useSearchParams();
  const laneMode = parseLaneMode(searchParams.get("lane"));

  const sortedStatuses = useMemo(
    () => [...statuses].sort((a, b) => a.position - b.position),
    [statuses],
  );

  // Group tasks by statusId, sorted by position — across the whole list,
  // regardless of lane. This is the single source of truth for drag math;
  // lane bands just filter what subset of each bucket they render.
  const columns = useMemo(() => {
    const map = new Map<Id<"listStatuses">, Doc<"tasks">[]>();
    for (const status of sortedStatuses) map.set(status._id, []);
    for (const task of orderedTasks) {
      const bucket = map.get(task.statusId);
      if (bucket) bucket.push(task);
      else map.set(task.statusId, [task]);
    }
    for (const bucket of map.values())
      bucket.sort((a, b) => a.position - b.position);
    return map;
  }, [orderedTasks, sortedStatuses]);

  // Resolve display names for assignee lanes — humans AND agents, so an
  // agent-assigned task gets its real name/badge instead of falling back to
  // a generic "Teammate" (users.listByClerkIds can't see agents at all).
  // Only fetched in assignee mode; matches gantt/timeline/workload views.
  const assignable = useQuery(
    api.agents.listAssignableForList,
    laneMode === "assignee" ? { listId } : "skip",
  );

  // Sprints for the "By sprint" lane mode. Only fetched in sprint mode;
  // personal-space lists have no sprints, so this comes back empty there.
  const sprints = useQuery(
    api.sprints.listForList,
    laneMode === "sprint" ? { listId } : "skip",
  );

  const lanes = useMemo<LaneDescriptor[] | null>(() => {
    if (laneMode === "none") return null;
    if (laneMode === "priority") {
      const withCounts = [...PRIORITY_ORDER, null].map((p) => ({
        key: p ?? "__none",
        label: p ? PRIORITY_LABEL[p] : "No priority",
        priority: p,
      }));
      return withCounts.filter((lane) =>
        orderedTasks.some((t) => laneKeyFor(t, laneMode) === lane.key),
      );
    }
    if (laneMode === "sprint") {
      const nameFor = (sprintId: string) =>
        sprints?.find((s) => s._id === sprintId)?.name ?? "Sprint";
      const keys = new Set<string>();
      for (const t of orderedTasks) keys.add(laneKeyFor(t, laneMode));
      const withSprint = [...keys]
        .filter((k) => k !== "__none")
        .map((k) => ({ key: k, label: nameFor(k) }))
        .sort((a, b) => a.label.localeCompare(b.label));
      const result: LaneDescriptor[] = [...withSprint];
      if (keys.has("__none")) {
        result.push({ key: "__none", label: "No sprint" });
      }
      return result;
    }
    // assignee
    const nameFor = (id: string) => {
      const p = assignable?.find((a) => a.id === id);
      return p?.name ?? "Teammate";
    };
    const kindFor = (id: string) =>
      assignable?.find((a) => a.id === id)?.kind;
    const keys = new Set<string>();
    for (const t of orderedTasks) keys.add(laneKeyFor(t, laneMode));
    const people = [...keys]
      .filter((k) => k !== "__unassigned")
      .map((k) => ({
        key: k,
        label: nameFor(k),
        kind: kindFor(k),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const result: LaneDescriptor[] = [...people];
    if (keys.has("__unassigned")) {
      result.push({ key: "__unassigned", label: "Unassigned" });
    }
    return result;
  }, [laneMode, orderedTasks, assignable, sprints]);

  // Maps every rendered droppable column id (namespaced by lane) back to its
  // real status id, so dropping on an empty column resolves correctly in
  // both plain and lane modes.
  const emptyColumnIds = useMemo(() => {
    const map = new Map<string, Id<"listStatuses">>();
    if (laneMode === "none") {
      for (const s of sortedStatuses) map.set(columnDomId(null, s._id), s._id);
    } else {
      for (const lane of lanes ?? []) {
        for (const s of sortedStatuses) {
          map.set(columnDomId(lane.key, s._id), s._id);
        }
      }
    }
    return map;
  }, [laneMode, lanes, sortedStatuses]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const findColumnFor = (id: Id<"tasks">): Id<"listStatuses"> | null => {
    const t = orderedTasks.find((task) => task._id === id);
    return t ? t.statusId : null;
  };

  function onDragStart(e: DragStartEvent) {
    setActiveId(e.active.id as Id<"tasks">);
  }

  // Cross-column move while dragging — keeps the task in the new column
  // visually even before the drop, matching the @dnd-kit kanban pattern.
  function onDragOver(e: DragOverEvent) {
    const activeId = e.active.id as Id<"tasks">;
    const overId = e.over?.id;
    if (!overId) return;

    const activeColumn = findColumnFor(activeId);
    let overColumn: Id<"listStatuses"> | null = null;
    const mapped = emptyColumnIds.get(overId as string);
    if (mapped) {
      overColumn = mapped;
    } else {
      overColumn = findColumnFor(overId as Id<"tasks">);
    }
    if (!activeColumn || !overColumn || activeColumn === overColumn) return;

    setOrderedTasks((prev) =>
      prev.map((t) =>
        t._id === activeId ? { ...t, statusId: overColumn! } : t,
      ),
    );
  }

  async function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const activeId = e.active.id as Id<"tasks">;
    const overId = e.over?.id;
    if (!overId) return;

    const activeTask = orderedTasks.find((t) => t._id === activeId);
    if (!activeTask) return;

    let targetStatus: Id<"listStatuses"> = activeTask.statusId;
    let insertIndex = -1;

    const mapped = emptyColumnIds.get(overId as string);
    if (mapped) {
      // Dropped on an empty column — append.
      targetStatus = mapped;
      const bucket = columns.get(targetStatus) ?? [];
      insertIndex = bucket.length;
    } else {
      const overTask = orderedTasks.find(
        (t) => t._id === (overId as Id<"tasks">),
      );
      if (!overTask) return;
      targetStatus = overTask.statusId;
      const bucket = columns.get(targetStatus) ?? [];
      insertIndex = bucket.findIndex((t) => t._id === overTask._id);
    }

    // Build the new order for the target column locally.
    const sourceBucket = columns.get(targetStatus) ?? [];
    const fromIndex = sourceBucket.findIndex((t) => t._id === activeId);
    const newBucket =
      fromIndex >= 0
        ? arrayMove(sourceBucket, fromIndex, insertIndex)
        : [
            ...sourceBucket.slice(0, insertIndex),
            { ...activeTask, statusId: targetStatus },
            ...sourceBucket.slice(insertIndex),
          ];

    // Optimistically reflect new ordering.
    setOrderedTasks((prev) => {
      const others = prev.filter((t) => t.statusId !== targetStatus);
      return [...others, ...newBucket];
    });

    try {
      await reorder({
        listId,
        orderedIds: newBucket.map((t) => t._id),
        statusId: targetStatus,
      });
      setMoveError(null);
    } catch (err) {
      // The server refused the status change (blocked by a dependency or
      // awaiting human approval). The live query snaps the card back;
      // tell the user why instead of failing silently.
      setOrderedTasks(tasks);
      const raw = err instanceof Error ? err.message : String(err);
      // Convex prefixes application errors; keep the readable tail.
      const msg = raw.split("Uncaught Error:").pop()?.trim() ?? raw;
      setMoveError(msg.slice(0, 300));
    }
  }

  const activeTask = activeId
    ? orderedTasks.find((t) => t._id === activeId) ?? null
    : null;

  return (
    <>
      {moveError && (
        <Card className="mb-3 flex-row items-start gap-2 rounded-lg border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <span className="min-w-0 flex-1">{moveError}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Dismiss"
            onClick={() => setMoveError(null)}
            className="h-auto flex-shrink-0 px-2 py-1 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            Dismiss
          </Button>
        </Card>
      )}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <LaneToggle mode={laneMode} />
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
      >
        {laneMode === "none" ? (
          <div className="flex gap-3 overflow-x-auto pb-2">
            {sortedStatuses.map((status, i) => {
              const columnTasks = columns.get(status._id) ?? [];
              return (
                <motion.div
                  key={status._id}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.45, ease: EASE, delay: i * 0.06 }}
                >
                  <Column
                    listId={listId}
                    status={status}
                    tasks={columnTasks}
                    domId={columnDomId(null, status._id)}
                  />
                </motion.div>
              );
            })}
          </div>
        ) : (
          <div className="space-y-4">
            {(lanes ?? []).map((lane, li) => (
              <motion.section
                key={lane.key}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: EASE, delay: li * 0.05 }}
                aria-label={lane.label}
                className="bento-tile p-3"
              >
                <LaneHeader lane={lane} laneMode={laneMode} />
                <div className="flex gap-3 overflow-x-auto pb-1 pt-2">
                  {sortedStatuses.map((status) => {
                    const bucket = (columns.get(status._id) ?? []).filter(
                      (t) => laneKeyFor(t, laneMode) === lane.key,
                    );
                    return (
                      <Column
                        key={status._id}
                        listId={listId}
                        status={status}
                        tasks={bucket}
                        domId={columnDomId(lane.key, status._id)}
                        totalInStatus={(columns.get(status._id) ?? []).length}
                      />
                    );
                  })}
                </div>
              </motion.section>
            ))}
            {(lanes ?? []).length === 0 && (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                No tasks yet.
              </p>
            )}
          </div>
        )}
        <DragOverlay>
          {activeTask && <CardChrome task={activeTask} dragging />}
        </DragOverlay>
      </DndContext>
    </>
  );
}

// Segmented "No lanes / Assignee / Priority / Sprint" control, persisted in
// the URL (?lane=assignee|priority|sprint, absent = none) so the grouping is
// shareable and survives reload, matching the rest of the board/list's
// URL-driven state.
function LaneToggle({ mode }: { mode: LaneMode }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function setLane(next: LaneMode) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "none") params.delete("lane");
    else params.set("lane", next);
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  }

  const options: { key: LaneMode; label: string }[] = [
    { key: "none", label: "No lanes" },
    { key: "assignee", label: "Assignee" },
    { key: "priority", label: "Priority" },
    { key: "sprint", label: "Sprint" },
  ];

  return (
    <div
      role="tablist"
      aria-label="Swimlanes"
      className="flex items-center gap-1 text-sm"
    >
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="tab"
          aria-selected={mode === o.key}
          onClick={() => setLane(o.key)}
          className={cn(
            "rounded-md px-3 py-1.5 transition-colors",
            mode === o.key
              ? "bg-accent font-medium text-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function LaneHeader({
  lane,
  laneMode,
}: {
  lane: LaneDescriptor;
  laneMode: LaneMode;
}) {
  if (laneMode === "assignee") {
    if (lane.key === "__unassigned") {
      return (
        <div className="flex items-center gap-2 px-1">
          <span className="text-sm font-semibold text-muted-foreground">
            Unassigned
          </span>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2 px-1">
        <Monogram name={lane.label} size="sm" />
        <span className="text-sm font-semibold">{lane.label}</span>
        {lane.kind === "agent" && (
          <Badge
            variant="secondary"
            className="gap-0 border-transparent bg-muted px-1.5 py-0.5 text-[9px] tracking-wider text-muted-foreground uppercase"
          >
            Agent
          </Badge>
        )}
      </div>
    );
  }
  if (laneMode === "sprint") {
    return (
      <div className="flex items-center gap-2 px-1">
        <span
          className={cn(
            "text-sm font-semibold",
            lane.key === "__none" && "text-muted-foreground",
          )}
        >
          {lane.label}
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 px-1">
      {lane.priority ? (
        <PriorityChip priority={lane.priority} />
      ) : (
        <span className="text-sm font-semibold text-muted-foreground">
          No priority
        </span>
      )}
    </div>
  );
}

function Column({
  listId,
  status,
  tasks,
  domId,
  totalInStatus,
}: {
  listId: Id<"lists">;
  status: Doc<"listStatuses">;
  tasks: Doc<"tasks">[];
  domId: string;
  // Full column size across ALL lanes. WIP is a property of the status
  // column, not of one swimlane's slice — without this, switching into
  // lane mode would silently change (and usually hide) what "over WIP"
  // means.
  totalInStatus?: number;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: domId });

  const wipLimit = status.wipLimit;
  const wipCount = totalInStatus ?? tasks.length;
  const overLimit = typeof wipLimit === "number" && wipCount > wipLimit;
  const pointsTotal = tasks.reduce(
    (sum, t) => sum + (t.estimatePoints ?? 0),
    0,
  );

  return (
    <section
      ref={setNodeRef}
      aria-label={status.name}
      className={cn(
        "flex w-72 flex-shrink-0 flex-col rounded-lg bg-muted/50 transition-shadow",
        isOver && "ring-2 ring-foreground/20",
      )}
    >
      <header className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="inline-flex min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <span
            aria-hidden
            className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
            style={{ backgroundColor: status.color }}
          />
          <span className="truncate">{status.name}</span>
        </span>
        <span className="flex flex-shrink-0 items-center gap-1.5">
          {pointsTotal > 0 && (
            <span className="text-[11px] font-normal normal-case text-muted-foreground">
              {pointsTotal} pts
            </span>
          )}
          {overLimit && (
            <Badge
              variant="destructive"
              className="px-1.5 py-0.5 text-[10px] normal-case"
            >
              Over WIP
            </Badge>
          )}
          <span
            className={cn(
              "text-xs font-normal normal-case",
              overLimit
                ? "font-semibold text-destructive"
                : "text-muted-foreground",
            )}
            title={
              typeof wipLimit === "number" && totalInStatus !== undefined
                ? `${wipCount} in this column across all lanes (limit ${wipLimit})`
                : undefined
            }
          >
            {typeof wipLimit === "number"
              ? `${wipCount}/${wipLimit}`
              : tasks.length}
          </span>
          <ColumnMenu status={status} />
        </span>
      </header>
      <SortableContext
        items={tasks.map((t) => t._id)}
        strategy={verticalListSortingStrategy}
      >
        <ul className="flex-1 space-y-2 px-2 pb-1">
          {tasks.length === 0 && (
            <li className="px-3 py-6 text-center text-xs text-muted-foreground">
              Drop a task here, or add one below.
            </li>
          )}
          {tasks.map((task) => (
            <TaskCard key={task._id} task={task} listId={listId} />
          ))}
        </ul>
      </SortableContext>
      <ColumnAdd listId={listId} statusId={status._id} />
    </section>
  );
}

// Per-column WIP limit menu. Advisory only — never blocks drops, just flags
// the column header when a limit is set and exceeded.
function ColumnMenu({ status }: { status: Doc<"listStatuses"> }) {
  const update = useMutation(api.listStatuses.update);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(
    status.wipLimit ? String(status.wipLimit) : "",
  );

  useEffect(() => {
    if (open) setValue(status.wipLimit ? String(status.wipLimit) : "");
  }, [open, status.wipLimit]);

  async function save(next: number | null) {
    try {
      await update({ statusId: status._id, wipLimit: next });
      toast(next ? `WIP limit set to ${next}` : "WIP limit cleared");
      setOpen(false);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const msg =
        raw.split("Uncaught Error:").pop()?.trim().slice(0, 200) ||
        "Couldn't update the limit";
      toast(msg, { kind: "error" });
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${status.name} column options`}
          className="tap-target inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
        >
          <Ellipsis className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52 p-3 normal-case">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          WIP limit
        </p>
        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(value);
            save(Number.isFinite(n) && n > 0 ? Math.floor(n) : null);
          }}
        >
          <input
            type="number"
            min={1}
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            placeholder="None"
            aria-label={`WIP limit for ${status.name}`}
            className="soft-field w-full px-2.5 py-1.5 text-sm"
          />
          <Button
            type="submit"
            size="sm"
            className="flex-shrink-0 rounded-full"
          >
            Save
          </Button>
        </form>
        {status.wipLimit !== undefined && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => save(null)}
            className="mt-2 h-auto px-0 font-normal text-muted-foreground hover:bg-transparent hover:text-destructive"
          >
            Clear limit
          </Button>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Per-column quick add: every column can create a task directly into its
// status, so Board is as writable as List.
function ColumnAdd({
  listId,
  statusId,
}: {
  listId: Id<"lists">;
  statusId: Id<"listStatuses">;
}) {
  const create = useMutation(api.tasks.create);
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [open, setOpen] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = parseQuickAdd(title);
    if (!parsed.title) return;
    try {
      await create({
        listId,
        title: parsed.title,
        statusId,
        dueDate: parsed.dueDate,
        priority: parsed.priority,
      });
      setTitle("");
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const msg = raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim();
      toast(msg || "Couldn't create task", { kind: "error" });
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mx-2 mb-2 flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
      >
        + Add task
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="px-2 pb-2">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        onBlur={() => {
          if (!title.trim()) setOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setTitle("");
            setOpen(false);
          }
        }}
        placeholder="Task title, then Enter"
        className="soft-field w-full px-2.5 py-1.5 text-sm"
        aria-label="New task title"
      />
    </form>
  );
}

function TaskCard({
  task,
}: {
  task: Doc<"tasks">;
  listId: Id<"lists">;
}) {
  const searchParams = useSearchParams();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task._id });

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      <Card
        className={cn(
          "gap-2 rounded-xl p-3 shadow-sm",
          isDragging && "opacity-30",
        )}
      >
        <div className="flex items-start gap-1">
          <button
            type="button"
            aria-label="Drag handle"
            className="cursor-grab touch-none p-0.5 text-muted-foreground"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>
          <Link
            href={taskPeekHref(searchParams, task._id)}
            scroll={false}
            className="flex flex-1 items-start gap-1.5 text-sm font-medium hover:underline"
          >
            {task.milestone && (
              <span
                aria-hidden
                title="Milestone"
                className="mt-1 h-2 w-2 flex-shrink-0 rotate-45 border border-foreground/60"
              />
            )}
            <span className="min-w-0">
              {task.title}
              <TaskBadges task={task} />
            </span>
          </Link>
        </div>
        <CardMeta task={task} />
      </Card>
    </li>
  );
}

function CardChrome({
  task,
  dragging = false,
}: {
  task: Doc<"tasks">;
  dragging?: boolean;
}) {
  return (
    <Card
      className={cn(
        "gap-2 rounded-xl p-3 shadow-md",
        dragging && "rotate-2",
      )}
    >
      <p className="flex items-start gap-1.5 text-sm font-medium">
        {task.milestone && (
          <span
            aria-hidden
            title="Milestone"
            className="mt-1 h-2 w-2 flex-shrink-0 rotate-45 border border-foreground/60"
          />
        )}
        <span className="min-w-0">
          {task.title}
          <TaskBadges task={task} />
        </span>
      </p>
      <CardMeta task={task} />
    </Card>
  );
}

function CardMeta({ task }: { task: Doc<"tasks"> }) {
  const hasChecklist = (task.checklist?.length ?? 0) > 0;
  const hasEstimate =
    typeof task.estimatePoints === "number" && task.estimatePoints > 0;
  const showFooter = task.priority || task.dueDate || hasEstimate || hasChecklist;
  if (!showFooter) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {task.priority && (
        <span className="inline-flex items-center gap-1">
          <PriorityDot priority={task.priority as TaskPriority} className="h-1.5 w-1.5" />
          {PRIORITY_LABEL[task.priority as TaskPriority]}
        </span>
      )}
      {task.dueDate && (
        <span className="inline-flex items-center gap-1">
          <CalendarDays className="h-3 w-3" aria-hidden />
          {new Date(task.dueDate).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          })}
        </span>
      )}
      {hasEstimate && (
        <Badge variant="secondary" className="px-1.5 py-0.5 text-[11px] font-medium">
          {task.estimatePoints} pts
        </Badge>
      )}
      <ChecklistChip checklist={task.checklist} />
    </div>
  );
}
