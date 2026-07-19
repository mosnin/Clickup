"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useId, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  addDays,
  differenceInCalendarDays,
  eachDayOfInterval,
  format,
  getISOWeek,
  isSameDay,
  isWeekend,
  startOfDay,
} from "date-fns";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { taskPeekHref } from "@/components/dashboard/task-peek";
import { EmptyState } from "@/components/dashboard/empty-state";

// A Gantt you can actually plan on: drag a bar to move the whole task in
// time, drag either edge to change its start or due date. Changes commit on
// release; the bar follows the pointer optimistically while dragging.
//
// v2 layers four things on top, all URL-driven so a configured view is
// shareable and survives reload:
//   - zoom (?zoom=day|week|month) rescales the day column and swaps the
//     header for coarser labels.
//   - group (?group=status|assignee) splits rows into labeled sections.
//   - dependency arrows (?deps=1, default on) connect a blocker's end to
//     its blocked task's start.
//   - a milestone diamond marker (task.milestone) plus a milestones-only
//     filter chip (?ms=1).
// A near-black "today" line spans the full chart at every zoom level.

const ROW_PX = 44;
const GROUP_HEADER_PX = 32;
const HEADER_COL_PX = 240; // matches the w-60 task-name column
const DAY_HEADER_PX = 40; // day zoom's two-line header cell (h-10)
const GROUP_ROW_HEADER_PX = 32; // week/month zoom's single-line header cell (h-8)
const UNASSIGNED_ID = "__unassigned__";

type Zoom = "day" | "week" | "month";
const ZOOM_PX: Record<Zoom, number> = { day: 36, week: 12, month: 4 };
const ZOOMS: { key: Zoom; label: string }[] = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
];

type GroupMode = "status" | "assignee" | null;
const GROUPS: { key: GroupMode; label: string }[] = [
  { key: null, label: "Flat" },
  { key: "status", label: "By status" },
  { key: "assignee", label: "By assignee" },
];

type DragState = {
  taskId: Id<"tasks">;
  mode: "move" | "start" | "end";
  originX: number;
  /** Day offsets at drag start. */
  startOffset: number;
  endOffset: number;
  /** Live day delta while dragging. */
  delta: number;
};

type TaskRow = {
  kind: "task";
  task: Doc<"tasks">;
  offset: number;
  endOffset: number;
  isMilestone: boolean;
  y: number;
};
type HeaderRow = {
  kind: "header";
  key: string;
  label: string;
  count: number;
  y: number;
};
type Row = TaskRow | HeaderRow;

type DayGroup = { key: string; label: string; count: number; startIndex: number };

function groupConsecutiveDays(
  days: Date[],
  keyFn: (d: Date) => string,
  labelFn: (d: Date) => string,
): DayGroup[] {
  const groups: DayGroup[] = [];
  days.forEach((d, i) => {
    const key = keyFn(d);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.count += 1;
    else groups.push({ key, label: labelFn(d), count: 1, startIndex: i });
  });
  return groups;
}

function gridBackground(dayPx: number) {
  return `repeating-linear-gradient(to right, transparent 0, transparent ${
    dayPx - 1
  }px, color-mix(in srgb, var(--color-border) 45%, transparent) ${
    dayPx - 1
  }px, color-mix(in srgb, var(--color-border) 45%, transparent) ${dayPx}px)`;
}

export function GanttView({
  listId,
  tasks,
  statuses,
}: {
  listId: Id<"lists">;
  tasks: Doc<"tasks">[];
  statuses: Doc<"listStatuses">[];
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const update = useMutation(api.tasks.update);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const rawArrowId = useId();
  const arrowMarkerId = `gantt-arrow-${rawArrowId.replace(/:/g, "")}`;

  const zoomParam = searchParams.get("zoom");
  const zoom: Zoom =
    zoomParam === "week" || zoomParam === "month" ? zoomParam : "day";
  const groupParam = searchParams.get("group");
  const group: GroupMode =
    groupParam === "status" || groupParam === "assignee" ? groupParam : null;
  const depsOn = searchParams.get("deps") !== "0";
  const msOnly = searchParams.get("ms") === "1";
  // The milestones filter collapses to a flat list — grouping a handful of
  // diamonds doesn't earn its keep, and it lets the filter skip the
  // assignee-name lookup entirely.
  const effectiveGroup: GroupMode = msOnly ? null : group;

  const DAY_PX = ZOOM_PX[zoom];

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams.toString());
    if (value === null) next.delete(key);
    else next.set(key, value);
    const qs = next.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  }

  const people = useQuery(
    api.agents.listAssignableForList,
    effectiveGroup === "assignee" ? { listId } : "skip",
  );

  const datedTasks = useMemo(
    () =>
      tasks
        .filter((t) => t.startDate || t.dueDate)
        .slice()
        .sort((a, b) => {
          const aStart = a.startDate ?? a.dueDate ?? 0;
          const bStart = b.startDate ?? b.dueDate ?? 0;
          return aStart - bStart;
        }),
    [tasks],
  );

  // Pick a 6-week window centered around today, but extend to fit any
  // task's range so nothing renders off-grid.
  const { start, days } = useMemo(() => {
    const today = startOfDay(new Date());
    let start = addDays(today, -7);
    let end = addDays(today, 35);
    for (const t of datedTasks) {
      if (t.startDate) {
        const s = startOfDay(new Date(t.startDate));
        if (s < start) start = s;
      }
      if (t.dueDate) {
        const d = startOfDay(new Date(t.dueDate));
        if (d > end) end = d;
      }
    }
    const days = eachDayOfInterval({ start, end });
    return { start, days };
  }, [datedTasks]);

  const totalWidth = days.length * DAY_PX;
  const today = startOfDay(new Date());
  const todayOffset = differenceInCalendarDays(today, start);

  function anchorForTask(
    task: Doc<"tasks">,
  ): { offset: number; endOffset: number; isMilestone: boolean } | null {
    const isMilestone = task.milestone === true;
    if (isMilestone) {
      const anchorDate = task.dueDate ?? task.startDate;
      if (anchorDate === undefined) return null;
      const offset = differenceInCalendarDays(
        startOfDay(new Date(anchorDate)),
        start,
      );
      return { offset, endOffset: offset, isMilestone: true };
    }
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
      isMilestone: false,
    };
  }

  // The flat/grouped row list, each carrying its own top offset so the
  // dependency-arrow and today-line overlay can line up with what's
  // actually rendered below, without a second layout pass.
  const { rows, bodyHeight } = useMemo(() => {
    const source = msOnly
      ? datedTasks.filter((t) => t.milestone === true)
      : datedTasks;
    const out: Row[] = [];
    let y = 0;

    function pushTask(task: Doc<"tasks">) {
      const anchor = anchorForTask(task);
      if (!anchor) return;
      out.push({
        kind: "task",
        task,
        offset: anchor.offset,
        endOffset: anchor.endOffset,
        isMilestone: anchor.isMilestone,
        y,
      });
      y += ROW_PX;
    }
    function pushHeader(key: string, label: string, count: number) {
      out.push({ kind: "header", key, label, count, y });
      y += GROUP_HEADER_PX;
    }

    if (effectiveGroup === "status") {
      const ordered = [...statuses].sort((a, b) => a.position - b.position);
      for (const s of ordered) {
        const items = source.filter((t) => t.statusId === s._id);
        if (items.length === 0) continue;
        pushHeader(s._id, s.name, items.length);
        for (const t of items) pushTask(t);
      }
    } else if (effectiveGroup === "assignee") {
      if (people === undefined) return { rows: [], bodyHeight: 0 };
      const nameById = new Map(people.map((p) => [p.id, p.name]));
      const buckets = new Map<string, Doc<"tasks">[]>();
      const unassigned: Doc<"tasks">[] = [];
      for (const t of source) {
        if (t.assigneeClerkIds.length === 0) {
          unassigned.push(t);
          continue;
        }
        for (const id of t.assigneeClerkIds) {
          const arr = buckets.get(id) ?? [];
          arr.push(t);
          buckets.set(id, arr);
        }
      }
      const orderedIds = [...buckets.keys()].sort((a, b) =>
        (nameById.get(a) ?? a).localeCompare(nameById.get(b) ?? b),
      );
      for (const id of orderedIds) {
        const items = buckets.get(id)!;
        pushHeader(id, nameById.get(id) ?? id, items.length);
        for (const t of items) pushTask(t);
      }
      if (unassigned.length > 0) {
        pushHeader(UNASSIGNED_ID, "Unassigned", unassigned.length);
        for (const t of unassigned) pushTask(t);
      }
    } else {
      for (const t of source) pushTask(t);
    }

    return { rows: out, bodyHeight: y };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveGroup, statuses, people, datedTasks, msOnly, start]);

  // Live (drag-adjusted) day offsets for a row — shared by the bar/diamond
  // render and the dependency-arrow anchors so they never disagree while a
  // drag is in flight.
  function resolveOffsets(row: TaskRow): { offset: number; endOffset: number } {
    if (drag?.taskId !== row.task._id) {
      return { offset: row.offset, endOffset: row.endOffset };
    }
    if (row.isMilestone) {
      const offset = row.offset + drag.delta;
      return { offset, endOffset: offset };
    }
    if (drag.mode === "move") {
      return { offset: row.offset + drag.delta, endOffset: row.endOffset + drag.delta };
    }
    if (drag.mode === "start") {
      return {
        offset: Math.min(row.offset + drag.delta, row.endOffset),
        endOffset: row.endOffset,
      };
    }
    return {
      offset: row.offset,
      endOffset: Math.max(row.endOffset + drag.delta, row.offset),
    };
  }

  const anchorByTask = useMemo(() => {
    const map = new Map<string, { xStart: number; xEnd: number; y: number }>();
    for (const row of rows) {
      if (row.kind !== "task") continue;
      if (map.has(row.task._id)) continue; // first lane wins for multi-assignee dupes
      const { offset, endOffset } = resolveOffsets(row);
      const yCenter = row.y + ROW_PX / 2;
      if (row.isMilestone) {
        const cx = offset * DAY_PX + DAY_PX / 2;
        map.set(row.task._id, { xStart: cx, xEnd: cx, y: yCenter });
      } else {
        map.set(row.task._id, {
          xStart: offset * DAY_PX,
          xEnd: (endOffset + 1) * DAY_PX,
          y: yCenter,
        });
      }
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, DAY_PX, drag]);

  const arrows = useMemo(() => {
    if (!depsOn) return [];
    const list: { key: string; d: string }[] = [];
    for (const row of rows) {
      if (row.kind !== "task") continue;
      const blockers = row.task.blockedByTaskIds;
      if (!blockers || blockers.length === 0) continue;
      const to = anchorByTask.get(row.task._id);
      if (!to) continue;
      for (const blockerId of blockers) {
        const from = anchorByTask.get(blockerId);
        if (!from) continue;
        const x1 = from.xEnd;
        const y1 = from.y;
        const x2 = to.xStart;
        const y2 = to.y;
        const bend = Math.max(Math.abs(x2 - x1) / 2, 24);
        const d = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
        list.push({ key: `${blockerId}-${row.task._id}`, d });
      }
    }
    return list;
  }, [rows, anchorByTask, depsOn]);

  const weekMonthGroups = useMemo(
    () =>
      zoom === "week"
        ? groupConsecutiveDays(
            days,
            (d) => format(d, "yyyy-MM"),
            (d) => format(d, "MMMM yyyy"),
          )
        : [],
    [days, zoom],
  );
  const weekGroups = useMemo(
    () =>
      zoom === "week"
        ? groupConsecutiveDays(
            days,
            (d) => `${d.getFullYear()}-${getISOWeek(d)}`,
            (d) => `Week ${getISOWeek(d)}`,
          )
        : [],
    [days, zoom],
  );
  const monthGroups = useMemo(
    () =>
      zoom === "month"
        ? groupConsecutiveDays(
            days,
            (d) => format(d, "yyyy-MM"),
            (d) => format(d, "MMMM yyyy"),
          )
        : [],
    [days, zoom],
  );

  const headerHeight =
    zoom === "week" ? GROUP_ROW_HEADER_PX * 2 : zoom === "month" ? GROUP_ROW_HEADER_PX : DAY_HEADER_PX;

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

      const task = datedTasks.find((t) => t._id === cur.taskId);
      if (!task) return;

      // A milestone is a single point in time, not a range — dragging it
      // (move only, no edge handles exist) always writes the one date it's
      // anchored on.
      if (task.milestone) {
        const newAnchor = cur.startOffset + cur.delta;
        void update({
          taskId: cur.taskId,
          dueDate: addDays(start, newAnchor).getTime(),
        });
        return;
      }

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
      // Only write fields the task actually uses: a due-only task dragged
      // around stays due-only.
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
      <div className="rounded-2xl bento">
        <EmptyState
          title="Nothing on the timeline yet"
          message="Give a task a start or due date and it appears here as a bar you can drag to plan."
        />
      </div>
    );
  }

  const loadingAssigneeLanes =
    effectiveGroup === "assignee" && people === undefined;

  return (
    <div className="space-y-3">
      <GanttToolbar
        zoom={zoom}
        group={group}
        depsOn={depsOn}
        msOnly={msOnly}
        setParam={setParam}
      />

      {loadingAssigneeLanes ? (
        <div className="space-y-2 rounded-2xl bento p-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded-full bg-muted/50" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl bento">
          <EmptyState
            compact
            title="No milestones yet"
            message="Mark a task as a milestone to see it here."
          />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl bento">
          <div
            className="relative"
            style={{ minWidth: HEADER_COL_PX + totalWidth }}
          >
            <div className="flex">
              <div
                className="flex flex-shrink-0 items-center px-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                style={{ width: HEADER_COL_PX, height: headerHeight }}
              >
                Task
              </div>
              <div className="flex-1">
                {zoom === "day" && (
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
                )}
                {zoom === "week" && (
                  <div>
                    <div className="flex">
                      {weekMonthGroups.map((g) => (
                        <div
                          key={g.key}
                          className="flex h-8 items-center justify-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
                          style={{ width: g.count * DAY_PX }}
                        >
                          {g.label}
                        </div>
                      ))}
                    </div>
                    <div className="flex">
                      {weekGroups.map((g) => {
                        const hasToday =
                          todayOffset >= g.startIndex &&
                          todayOffset < g.startIndex + g.count;
                        return (
                          <div
                            key={g.key}
                            className={cn(
                              "flex h-8 items-center justify-center text-[10px] uppercase tracking-wider text-muted-foreground",
                              hasToday && "bg-muted font-semibold text-foreground",
                            )}
                            style={{ width: g.count * DAY_PX }}
                          >
                            {g.label}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {zoom === "month" && (
                  <div className="flex">
                    {monthGroups.map((g) => {
                      const hasToday =
                        todayOffset >= g.startIndex &&
                        todayOffset < g.startIndex + g.count;
                      return (
                        <div
                          key={g.key}
                          className={cn(
                            "flex h-8 items-center justify-center text-[10px] uppercase tracking-wider text-muted-foreground",
                            hasToday && "bg-muted font-semibold text-foreground",
                          )}
                          style={{ width: g.count * DAY_PX }}
                        >
                          {g.label}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {rows.map((row) => {
              if (row.kind === "header") {
                return (
                  <div
                    key={row.key}
                    className="flex items-center bg-muted/40 px-4"
                    style={{ height: GROUP_HEADER_PX }}
                  >
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {row.label}
                    </span>
                    <span className="ml-1.5 text-[11px] normal-case tracking-normal text-muted-foreground/70">
                      {row.count}
                    </span>
                  </div>
                );
              }

              const task = row.task;
              const status = statuses.find((s) => s._id === task.statusId);
              const { offset, endOffset } = resolveOffsets(row);
              const isDragging = drag?.taskId === task._id;

              return (
                <div
                  key={task._id}
                  className="group flex"
                  style={{ height: ROW_PX }}
                >
                  <Link
                    href={taskPeekHref(searchParams, task._id)}
                    scroll={false}
                    className="flex-shrink-0 truncate px-4 py-2.5 text-sm transition-colors hover:bg-muted"
                    style={{ width: HEADER_COL_PX }}
                    title={task.title}
                  >
                    {task.title}
                  </Link>
                  <div
                    className="relative flex-1"
                    style={{ background: gridBackground(DAY_PX) }}
                  >
                    {row.isMilestone ? (
                      <div
                        className={cn(
                          "absolute top-1/2 flex -translate-y-1/2 cursor-grab items-center gap-1.5",
                          isDragging ? "cursor-grabbing" : "",
                        )}
                        style={{ left: offset * DAY_PX + DAY_PX / 2 - 6 }}
                        title={`${format(addDays(start, offset), "MMM d")} · milestone · drag to move`}
                        onPointerDown={(e) =>
                          beginDrag(e, task, "move", row.offset, row.offset)
                        }
                      >
                        <span
                          aria-hidden
                          className="h-3 w-3 flex-shrink-0 rotate-45 shadow-sm"
                          style={{ backgroundColor: status?.color ?? "#a9c6f2" }}
                        />
                        <span className="pointer-events-none whitespace-nowrap text-xs font-medium text-foreground/80">
                          {task.title}
                        </span>
                      </div>
                    ) : (
                      <div
                        className={cn(
                          "absolute top-1/2 flex -translate-y-1/2 cursor-grab items-center rounded-full px-2 text-xs font-medium text-foreground/80 shadow-sm transition-shadow",
                          isDragging ? "cursor-grabbing shadow-md" : "hover:shadow-md",
                        )}
                        style={{
                          left: offset * DAY_PX + 2,
                          width: Math.max((endOffset - offset + 1) * DAY_PX - 4, 24),
                          height: 26,
                          backgroundColor: status?.color ?? "#a9c6f2",
                        }}
                        title={`${format(addDays(start, offset), "MMM d")} to ${format(addDays(start, endOffset), "MMM d")} · drag to move, edges to resize`}
                        onPointerDown={(e) =>
                          beginDrag(e, task, "move", row.offset, row.endOffset)
                        }
                      >
                        <span
                          role="presentation"
                          className="absolute inset-y-0 left-0 w-2 cursor-ew-resize rounded-l-full"
                          onPointerDown={(e) =>
                            beginDrag(e, task, "start", row.offset, row.endOffset)
                          }
                        />
                        <span className="pointer-events-none block truncate">
                          {task.title}
                        </span>
                        <span
                          role="presentation"
                          className="absolute inset-y-0 right-0 w-2 cursor-ew-resize rounded-r-full"
                          onPointerDown={(e) =>
                            beginDrag(e, task, "end", row.offset, row.endOffset)
                          }
                        />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Today line + dependency arrows: a non-interactive overlay
                sized from the same header/row math the grid above renders
                with, so it never drifts out of alignment. */}
            <div
              className="pointer-events-none absolute left-0 top-0"
              style={{
                left: HEADER_COL_PX,
                top: 0,
                width: totalWidth,
                height: headerHeight + bodyHeight,
              }}
            >
              {todayOffset >= 0 && todayOffset < days.length && (
                <>
                  <div
                    aria-hidden
                    className="absolute inset-y-0 w-px bg-foreground/20"
                    style={{ left: todayOffset * DAY_PX }}
                  />
                  <span
                    aria-hidden
                    className="absolute -translate-y-1/2 whitespace-nowrap rounded-full bg-foreground px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-background"
                    style={{ left: todayOffset * DAY_PX + 4, top: headerHeight }}
                  >
                    Today
                  </span>
                </>
              )}
              {depsOn && arrows.length > 0 && (
                <svg
                  className="absolute left-0"
                  style={{ top: headerHeight, width: totalWidth, height: bodyHeight }}
                  width={totalWidth}
                  height={bodyHeight}
                >
                  <defs>
                    <marker
                      id={arrowMarkerId}
                      viewBox="0 0 8 8"
                      refX="7"
                      refY="4"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto-start-reverse"
                    >
                      <path
                        d="M0,0 L8,4 L0,8 Z"
                        fill="color-mix(in srgb, var(--color-muted-foreground) 70%, transparent)"
                      />
                    </marker>
                  </defs>
                  {arrows.map((a) => (
                    <path
                      key={a.key}
                      d={a.d}
                      fill="none"
                      stroke="color-mix(in srgb, var(--color-muted-foreground) 55%, transparent)"
                      strokeWidth={1.5}
                      markerEnd={`url(#${arrowMarkerId})`}
                    />
                  ))}
                </svg>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function GanttToolbar({
  zoom,
  group,
  depsOn,
  msOnly,
  setParam,
}: {
  zoom: Zoom;
  group: GroupMode;
  depsOn: boolean;
  msOnly: boolean;
  setParam: (key: string, value: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="segmented text-xs">
        {ZOOMS.map((z) => (
          <button
            key={z.key}
            type="button"
            onClick={() => setParam("zoom", z.key === "day" ? null : z.key)}
            aria-pressed={zoom === z.key}
            className={cn(
              "rounded-full px-3 py-1.5 font-medium transition-colors",
              zoom === z.key
                ? "segmented-on text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {z.label}
          </button>
        ))}
      </div>
      <div className="segmented text-xs">
        {GROUPS.map((g) => (
          <button
            key={g.label}
            type="button"
            onClick={() => setParam("group", g.key)}
            aria-pressed={group === g.key}
            className={cn(
              "rounded-full px-3 py-1.5 font-medium transition-colors",
              group === g.key
                ? "segmented-on text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {g.label}
          </button>
        ))}
      </div>
      <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
      <button
        type="button"
        onClick={() => setParam("deps", depsOn ? "0" : null)}
        aria-pressed={depsOn}
        className={cn(
          "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
          depsOn
            ? "border-transparent bg-foreground text-background"
            : "border-border bg-background text-muted-foreground hover:text-foreground",
        )}
      >
        Dependencies
      </button>
      <button
        type="button"
        onClick={() => setParam("ms", msOnly ? null : "1")}
        aria-pressed={msOnly}
        className={cn(
          "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
          msOnly
            ? "border-transparent bg-foreground text-background"
            : "border-border bg-background text-muted-foreground hover:text-foreground",
        )}
      >
        Milestones
      </button>
    </div>
  );
}
