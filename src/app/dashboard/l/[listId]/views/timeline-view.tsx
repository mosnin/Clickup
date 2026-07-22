"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  addDays,
  differenceInCalendarDays,
  eachDayOfInterval,
  format,
  isSameDay,
  isWeekend,
  startOfDay,
} from "date-fns";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Plus } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Monogram } from "@/components/dashboard/monogram";
import { taskPeekHref } from "@/components/dashboard/task-peek";
import { EmptyState } from "@/components/dashboard/empty-state";
import { useToast } from "@/components/toast";
import {
  PriorityDot,
  type TaskPriority,
} from "@/components/dashboard/priority";

// One horizontal lane per assignee, task bars laid on a shared date axis —
// complements Gantt (one row per task) by answering "who's doing what,
// when" at a glance. Drag mechanics mirror Gantt exactly: drag a bar to
// move it, drag an edge to resize. Bars that overlap in time within the
// same lane stack into sub-rows instead of colliding.

const DAY_PX = 36;
const ROW_PX = 32;
const HEADER_PX = 200;
const UNASSIGNED_ID = "__unassigned__";

type DragState = {
  taskId: Id<"tasks">;
  mode: "move" | "start" | "end";
  originX: number;
  startOffset: number;
  endOffset: number;
  delta: number;
};

type LaneItem = {
  task: Doc<"tasks">;
  offset: number;
  endOffset: number;
  subRow: number;
};

type Lane = {
  id: string;
  name: string;
  kind: "user" | "agent";
  items: LaneItem[];
  subRows: number;
  openCount: number;
};

export function TimelineView({
  listId,
  tasks,
  statuses,
}: {
  listId: Id<"lists">;
  tasks: Doc<"tasks">[];
  statuses: Doc<"listStatuses">[];
}) {
  const update = useMutation(api.tasks.update);
  const people = useQuery(api.agents.listAssignableForList, { listId });
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const datedTasks = useMemo(
    () => tasks.filter((t) => t.startDate || t.dueDate),
    [tasks],
  );
  const undated = useMemo(
    () => tasks.filter((t) => !t.startDate && !t.dueDate),
    [tasks],
  );

  const doneStatusIds = useMemo(
    () =>
      new Set(
        statuses
          .filter((s) => s.category === "complete" || s.category === "closed")
          .map((s) => s._id),
      ),
    [statuses],
  );

  // Same 6-week-centered-on-today window as Gantt, extended to fit every
  // dated task so nothing renders off-grid.
  const { start, days } = useMemo(() => {
    const today = startOfDay(new Date());
    let windowStart = addDays(today, -7);
    let windowEnd = addDays(today, 35);
    for (const t of datedTasks) {
      if (t.startDate) {
        const s = startOfDay(new Date(t.startDate));
        if (s < windowStart) windowStart = s;
      }
      if (t.dueDate) {
        const d = startOfDay(new Date(t.dueDate));
        if (d > windowEnd) windowEnd = d;
      }
    }
    return {
      start: windowStart,
      days: eachDayOfInterval({ start: windowStart, end: windowEnd }),
    };
  }, [datedTasks]);

  function taskOffsets(task: Doc<"tasks">): { offset: number; endOffset: number } | null {
    const startDay = task.startDate
      ? startOfDay(new Date(task.startDate))
      : task.dueDate
        ? startOfDay(new Date(task.dueDate))
        : null;
    const endDay = task.dueDate ? startOfDay(new Date(task.dueDate)) : startDay;
    if (!startDay || !endDay) return null;
    return {
      offset: differenceInCalendarDays(startDay, start),
      endOffset: differenceInCalendarDays(endDay, start),
    };
  }

  const lanes = useMemo<Lane[] | null>(() => {
    if (people === undefined) return null;
    const nameById = new Map(people.map((p) => [p.id, p]));
    const byLane = new Map<string, { name: string; kind: "user" | "agent"; tasks: Doc<"tasks">[] }>();
    const unassignedTasks: Doc<"tasks">[] = [];

    for (const t of datedTasks) {
      if (t.assigneeClerkIds.length === 0) {
        unassignedTasks.push(t);
        continue;
      }
      for (const id of t.assigneeClerkIds) {
        let bucket = byLane.get(id);
        if (!bucket) {
          const p = nameById.get(id);
          bucket = { name: p?.name ?? id, kind: p?.kind ?? "user", tasks: [] };
          byLane.set(id, bucket);
        }
        bucket.tasks.push(t);
      }
    }

    function pack(tasksArr: Doc<"tasks">[]): { items: LaneItem[]; subRows: number } {
      const items = tasksArr
        .map((task) => {
          const off = taskOffsets(task);
          return off ? { task, offset: off.offset, endOffset: off.endOffset } : null;
        })
        .filter((x): x is { task: Doc<"tasks">; offset: number; endOffset: number } => x !== null)
        .sort((a, b) => a.offset - b.offset || a.endOffset - b.endOffset);

      const rowEnds: number[] = [];
      const placed: LaneItem[] = items.map((it) => {
        let row = rowEnds.findIndex((end) => end < it.offset);
        if (row === -1) {
          row = rowEnds.length;
          rowEnds.push(it.endOffset);
        } else {
          rowEnds[row] = it.endOffset;
        }
        return { ...it, subRow: row };
      });
      return { items: placed, subRows: Math.max(rowEnds.length, 1) };
    }

    const rows: Lane[] = [...byLane.entries()]
      .map(([id, bucket]) => {
        const { items, subRows } = pack(bucket.tasks);
        return {
          id,
          name: bucket.name,
          kind: bucket.kind,
          items,
          subRows,
          openCount: bucket.tasks.filter((t) => !doneStatusIds.has(t.statusId))
            .length,
        };
      })
      .sort((a, b) => b.items.length - a.items.length);

    if (unassignedTasks.length > 0) {
      const { items, subRows } = pack(unassignedTasks);
      rows.push({
        id: UNASSIGNED_ID,
        name: "Unassigned",
        kind: "user",
        items,
        subRows,
        openCount: unassignedTasks.filter((t) => !doneStatusIds.has(t.statusId))
          .length,
      });
    }

    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people, datedTasks, start, doneStatusIds]);

  const totalWidth = days.length * DAY_PX;
  const today = startOfDay(new Date());

  function beginDrag(
    e: React.PointerEvent,
    task: Doc<"tasks">,
    mode: DragState["mode"],
    startOffset: number,
    endOffset: number,
  ) {
    e.preventDefault();
    e.stopPropagation();
    const state: DragState = {
      taskId: task._id,
      mode,
      originX: e.clientX,
      startOffset,
      endOffset,
      delta: 0,
    };
    dragRef.current = state;
    setDrag(state);

    function onMove(ev: PointerEvent) {
      const cur = dragRef.current;
      if (!cur) return;
      const delta = Math.round((ev.clientX - cur.originX) / DAY_PX);
      if (delta !== cur.delta) {
        const next = { ...cur, delta };
        dragRef.current = next;
        setDrag(next);
      }
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const cur = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!cur || cur.delta === 0) return;

      let newStart = cur.startOffset;
      let newEnd = cur.endOffset;
      if (cur.mode === "move") {
        newStart += cur.delta;
        newEnd += cur.delta;
      } else if (cur.mode === "start") {
        newStart = Math.min(cur.startOffset + cur.delta, newEnd);
      } else {
        newEnd = Math.max(cur.endOffset + cur.delta, newStart);
      }
      const toTs = (offset: number) => addDays(start, offset).getTime();
      const patch: {
        taskId: Id<"tasks">;
        startDate?: number;
        dueDate?: number;
      } = { taskId: cur.taskId };
      const task = datedTasks.find((t) => t._id === cur.taskId);
      if (!task) return;
      if (task.startDate !== undefined || cur.mode === "start") {
        patch.startDate = toTs(newStart);
      }
      if (task.dueDate !== undefined || cur.mode === "end") {
        patch.dueDate = toTs(newEnd);
      }
      void update(patch);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  if (datedTasks.length === 0) {
    return (
      <EmptyState
        title="Nothing on the timeline yet"
        message="Give a task a start or due date and an assignee, and it appears here as a bar in their lane."
        action={<AddTaskButton listId={listId} />}
      />
    );
  }

  if (lanes === null) {
    return (
      <div className="space-y-2 rounded-2xl panel p-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-8 animate-pulse rounded-full bg-muted/50" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <AddTaskButton listId={listId} />
      </div>
      <div className="overflow-x-auto rounded-2xl panel">
        <div style={{ minWidth: HEADER_PX + totalWidth }}>
          <div className="flex">
            <div
              className="sticky left-0 z-10 flex-shrink-0 bg-background px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
              style={{ width: HEADER_PX }}
            >
              Assignee
            </div>
            <div className="flex-1">
              <div className="flex">
                {days.map((d) => (
                  <div
                    key={d.getTime()}
                    className={cn(
                      "flex h-10 flex-col items-center justify-center text-[10px] uppercase tracking-wider text-muted-foreground",
                      isWeekend(d) && "bg-muted/40",
                      isSameDay(d, today) &&
                        "bg-muted font-semibold text-foreground",
                    )}
                    style={{ width: DAY_PX }}
                  >
                    <span>{format(d, "EEEEEE")}</span>
                    <span className="text-foreground">{d.getDate()}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {lanes.map((lane) => {
            const laneHeight = lane.subRows * ROW_PX;
            return (
              <div key={lane.id} className="flex">
                <div
                  className="sticky left-0 z-10 flex flex-shrink-0 items-center gap-2 bg-background px-4"
                  style={{ width: HEADER_PX, height: laneHeight }}
                >
                  <Monogram name={lane.name} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-sm font-medium">
                        {lane.name}
                      </p>
                      {lane.kind === "agent" && (
                        <Badge
                          variant="secondary"
                          className="flex-shrink-0 gap-0 border-transparent bg-muted px-1.5 py-0.5 text-[9px] tracking-wider text-muted-foreground uppercase"
                        >
                          Agent
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {lane.openCount} open
                    </p>
                  </div>
                </div>
                <div
                  className="relative flex-1"
                  style={{
                    height: laneHeight,
                    background: `repeating-linear-gradient(to right, transparent 0, transparent ${
                      DAY_PX - 1
                    }px, color-mix(in srgb, var(--color-border) 45%, transparent) ${DAY_PX - 1}px, color-mix(in srgb, var(--color-border) 45%, transparent) ${DAY_PX}px)`,
                  }}
                >
                  {lane.items.map(({ task, subRow, ...base }) => {
                    const status = statuses.find((s) => s._id === task.statusId);
                    let offset = base.offset;
                    let endOffset = base.endOffset;
                    if (drag?.taskId === task._id) {
                      if (drag.mode === "move") {
                        offset = base.offset + drag.delta;
                        endOffset = base.endOffset + drag.delta;
                      } else if (drag.mode === "start") {
                        offset = Math.min(base.offset + drag.delta, endOffset);
                      } else {
                        endOffset = Math.max(
                          base.endOffset + drag.delta,
                          offset,
                        );
                      }
                    }
                    const span = endOffset - offset + 1;
                    return (
                      <div
                        key={`${lane.id}-${task._id}`}
                        className={cn(
                          "group absolute flex cursor-grab items-center rounded-full px-2 text-xs font-medium text-foreground/80 shadow-sm transition-shadow",
                          drag?.taskId === task._id
                            ? "cursor-grabbing shadow-md"
                            : "hover:shadow-md",
                        )}
                        style={{
                          left: offset * DAY_PX + 2,
                          top: subRow * ROW_PX + (ROW_PX - 26) / 2,
                          width: Math.max(span * DAY_PX - 4, 24),
                          height: 26,
                          backgroundColor: status?.color ?? "#a9c6f2",
                        }}
                        title={`${task.title} · ${format(addDays(start, base.offset), "MMM d")} to ${format(addDays(start, base.endOffset), "MMM d")} · drag to move, edges to resize`}
                        onPointerDown={(e) =>
                          beginDrag(e, task, "move", base.offset, base.endOffset)
                        }
                      >
                        <span
                          role="presentation"
                          className="absolute inset-y-0 left-0 w-2 cursor-ew-resize rounded-l-full"
                          onPointerDown={(e) =>
                            beginDrag(e, task, "start", base.offset, base.endOffset)
                          }
                        />
                        <span className="pointer-events-none block truncate">
                          {task.title}
                        </span>
                        <span
                          role="presentation"
                          className="absolute inset-y-0 right-0 w-2 cursor-ew-resize rounded-r-full"
                          onPointerDown={(e) =>
                            beginDrag(e, task, "end", base.offset, base.endOffset)
                          }
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {undated.length > 0 && (
        <div className="rounded-2xl panel p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            No dates · give a task a start or due date to place it here
          </p>
          <ul className="mt-2.5 flex flex-wrap gap-2">
            {undated.map((t) => (
              <li key={t._id}>
                <UndatedChip task={t} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Small in-place create affordance — Timeline had no way to add a task at
// all before this. A brand-new task has no dates, so it lands in the
// "No dates" tray below rather than on the axis; give it one from there or
// drag its chip onto a day.
function AddTaskButton({ listId }: { listId: Id<"lists"> }) {
  const create = useMutation(api.tasks.create);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <Plus className="h-4 w-4" /> Add task
      </Button>
    );
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const t = title.trim();
        if (!t) {
          setOpen(false);
          return;
        }
        setPending(true);
        try {
          await create({ listId, title: t });
          setTitle("");
          setOpen(false);
        } catch (err) {
          const raw = err instanceof Error ? err.message : String(err);
          const msg = raw
            .split("Uncaught Error:")
            .pop()
            ?.split("\n")[0]
            ?.trim();
          toast(msg || "Couldn't add task", { kind: "error" });
        } finally {
          setPending(false);
        }
      }}
      className="flex items-center gap-2"
    >
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
        aria-label="New task title"
        disabled={pending}
        className="soft-field w-56 px-2.5 py-1.5 text-sm"
      />
    </form>
  );
}

function UndatedChip({ task }: { task: Doc<"tasks"> }) {
  const searchParams = useSearchParams();
  return (
    <Link
      href={taskPeekHref(searchParams, task._id)}
      scroll={false}
      className="flex items-center gap-1 truncate rounded-full bg-muted px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-brand-100 hover:text-brand-700"
    >
      {task.priority && (
        <PriorityDot
          priority={task.priority as TaskPriority}
          className="h-1.5 w-1.5"
        />
      )}
      <span className="truncate">{task.title}</span>
    </Link>
  );
}
