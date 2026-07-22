"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDroppable,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/toast";
import { Monogram } from "@/components/dashboard/monogram";
import { EmptyState } from "@/components/dashboard/empty-state";
import { PriorityDot, type TaskPriority } from "@/components/dashboard/priority";
import { AnimatePresence, EASE, motion } from "@/components/motion";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// Sprint scrum board: every task committed to one sprint, arranged in the
// four coarse status categories (open/in_progress/complete/closed) as
// columns, with an optional "by assignee" swimlane split. Tasks can come
// from any list in the sprint's workspace, so a card's move is expressed
// as a target *category* — convex/scrumBoard.ts.moveTask resolves that
// onto the card's own list's matching status, keeping cross-list drags
// safe even when lists name their workflows differently.

type BoardResult = FunctionReturnType<typeof api.scrumBoard.board>;
type BoardTask = NonNullable<BoardResult>["tasks"][number];
type BoardMember = NonNullable<BoardResult>["members"][number];
type Category = BoardTask["statusCategory"];
// Task augmented with resolved assignee names (from the workspace member
// roster) so cards never have to render a raw clerk/agent id.
type DisplayTask = BoardTask & {
  assignees: { id: string; name: string }[];
};

const COLUMNS: { key: Category; label: string }[] = [
  { key: "open", label: "To do" },
  { key: "in_progress", label: "In progress" },
  { key: "complete", label: "Done" },
  { key: "closed", label: "Closed" },
];

const UNASSIGNED = "__unassigned__";
const ALL_LANE = "__all__";

function dropId(lane: string, category: Category): string {
  return `${lane}::${category}`;
}

function parseDropId(id: string): { lane: string; category: Category } | null {
  const idx = id.lastIndexOf("::");
  if (idx < 0) return null;
  const category = id.slice(idx + 2);
  if (
    category !== "open" &&
    category !== "in_progress" &&
    category !== "complete" &&
    category !== "closed"
  ) {
    return null;
  }
  return { lane: id.slice(0, idx), category };
}

export function ScrumBoard({
  sprintId,
}: {
  sprintId: Id<"sprints">;
  workspaceId: Id<"workspaces">;
}) {
  const data = useQuery(api.scrumBoard.board, { sprintId });
  const moveTask = useMutation(api.scrumBoard.moveTask);
  const { toast } = useToast();

  const [laneMode, setLaneMode] = useState<"none" | "assignee">("none");
  const [closedOpen, setClosedOpen] = useState<boolean | null>(null);
  const [activeId, setActiveId] = useState<Id<"tasks"> | null>(null);
  const [overrides, setOverrides] = useState<Record<string, Category>>({});

  const membersById = useMemo(() => {
    const map = new Map<string, BoardMember>();
    for (const m of data?.members ?? []) map.set(m.id, m);
    return map;
  }, [data]);

  const tasks = useMemo<DisplayTask[]>(() => {
    if (!data) return [];
    return data.tasks.map((t) => ({
      ...t,
      statusCategory: overrides[t._id] ?? t.statusCategory,
      assignees: t.assigneeClerkIds.map((id) => ({
        id,
        name: membersById.get(id)?.name ?? "Someone",
      })),
    }));
  }, [data, overrides, membersById]);

  // Drop an override once the live query confirms the server landed on the
  // same category — keeps optimistic moves from drifting from reality.
  useEffect(() => {
    if (!data) return;
    setOverrides((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const t of data.tasks) {
        if (next[t._id] === t.statusCategory) {
          delete next[t._id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [data]);

  const tasksById = useMemo(() => {
    const map = new Map<Id<"tasks">, DisplayTask>();
    for (const t of tasks) map.set(t._id, t);
    return map;
  }, [tasks]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

  function onDragStart(e: DragStartEvent) {
    setActiveId(e.active.id as Id<"tasks">);
  }

  async function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const overId = e.over?.id;
    if (!overId) return;
    const target = parseDropId(String(overId));
    if (!target) return;
    const taskId = e.active.id as Id<"tasks">;
    const task = tasksById.get(taskId);
    if (!task || task.statusCategory === target.category) return;

    setOverrides((prev) => ({ ...prev, [taskId]: target.category }));
    try {
      await moveTask({ taskId, category: target.category });
    } catch (err) {
      setOverrides((prev) => {
        const next = { ...prev };
        delete next[taskId];
        return next;
      });
      const raw = err instanceof Error ? err.message : String(err);
      const msg = raw.split("Uncaught Error:").pop()?.trim() ?? raw;
      toast(msg.slice(0, 300), { kind: "error" });
    }
  }

  if (data === undefined) return <BoardSkeleton />;
  if (data === null) {
    return (
      <EmptyState
        title="Sprint unavailable"
        message="You don't have access to this sprint, or it no longer exists."
      />
    );
  }
  if (data.tasks.length === 0) {
    return (
      <EmptyState
        title="Nothing committed yet"
        message="Commit tasks from Planning — they'll show up here as a board."
      />
    );
  }

  const closedCount = tasks.filter((t) => t.statusCategory === "closed").length;
  const closedExpanded = closedOpen ?? closedCount > 0;

  const lanes: { key: string; label: string | null; tasks: DisplayTask[] }[] =
    laneMode === "none"
      ? [{ key: ALL_LANE, label: null, tasks }]
      : buildAssigneeLanes(tasks);

  const activeTask = activeId ? tasksById.get(activeId) ?? null : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setLaneMode("none")}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              laneMode === "none"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            No lanes
          </button>
          <button
            type="button"
            onClick={() => setLaneMode("assignee")}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              laneMode === "assignee"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            By assignee
          </button>
        </div>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <div className="space-y-6">
          {lanes.map((lane) => (
            <div key={lane.key}>
              {lane.label !== null && (
                <div className="mb-2 flex items-center gap-2">
                  {lane.key !== UNASSIGNED && (
                    <Monogram name={lane.label} size="sm" />
                  )}
                  <span className="text-sm font-medium">{lane.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {lane.tasks.length}
                  </span>
                </div>
              )}
              <div className="flex gap-3 overflow-x-auto pb-2">
                {COLUMNS.map((col) => {
                  const columnTasks = lane.tasks.filter(
                    (t) => t.statusCategory === col.key,
                  );
                  if (col.key === "closed" && !closedExpanded) {
                    return (
                      <ClosedCollapsed
                        key={col.key}
                        lane={lane.key}
                        count={columnTasks.length}
                        onExpand={() => setClosedOpen(true)}
                      />
                    );
                  }
                  return (
                    <Column
                      key={col.key}
                      lane={lane.key}
                      category={col.key}
                      label={col.label}
                      tasks={columnTasks}
                      collapsible={col.key === "closed"}
                      onCollapse={
                        col.key === "closed"
                          ? () => setClosedOpen(false)
                          : undefined
                      }
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <DragOverlay>
          {activeTask && <TaskCardBody task={activeTask} dragging />}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function buildAssigneeLanes(
  tasks: DisplayTask[],
): { key: string; label: string | null; tasks: DisplayTask[] }[] {
  const map = new Map<string, { name: string; tasks: DisplayTask[] }>();
  for (const t of tasks) {
    const assignees = t.assignees.length > 0 ? t.assignees : [{ id: UNASSIGNED, name: "Unassigned" }];
    for (const a of assignees) {
      if (!map.has(a.id)) map.set(a.id, { name: a.name, tasks: [] });
      map.get(a.id)!.tasks.push(t);
    }
  }
  const unassigned = map.get(UNASSIGNED);
  map.delete(UNASSIGNED);
  const lanes = Array.from(map.entries())
    .map(([id, lane]) => ({ key: id, label: lane.name, tasks: lane.tasks }))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (unassigned && unassigned.tasks.length > 0) {
    lanes.push({ key: UNASSIGNED, label: "Unassigned", tasks: unassigned.tasks });
  }
  return lanes;
}

function Column({
  lane,
  category,
  label,
  tasks,
  collapsible,
  onCollapse,
}: {
  lane: string;
  category: Category;
  label: string;
  tasks: DisplayTask[];
  collapsible?: boolean;
  onCollapse?: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId(lane, category) });
  const points = tasks.reduce((sum, t) => sum + (t.estimatePoints ?? 0), 0);

  return (
    <section
      ref={setNodeRef}
      aria-label={label}
      className={cn(
        "flex w-72 flex-shrink-0 flex-col rounded-lg bg-muted/50 transition-shadow",
        isOver && "ring-2 ring-foreground/20",
      )}
    >
      <header className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{tasks.length}</span>
          {points > 0 && <span>{points} pts</span>}
          {collapsible && onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              className="tap-target rounded-full px-1 text-muted-foreground hover:text-foreground"
            >
              Hide
            </button>
          )}
        </span>
      </header>
      <div className="flex-1 space-y-2 px-2 pb-2">
        <AnimatePresence initial={false}>
          {tasks.length === 0 && (
            <p
              key="empty"
              className="px-3 py-6 text-center text-xs text-muted-foreground"
            >
              Drop a task here.
            </p>
          )}
          {tasks.map((task, i) => (
            <DraggableCard key={task._id} task={task} index={i} />
          ))}
        </AnimatePresence>
      </div>
    </section>
  );
}

function ClosedCollapsed({
  lane,
  count,
  onExpand,
}: {
  lane: string;
  count: number;
  onExpand: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: dropId(lane, "closed"),
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={onExpand}
      className={cn(
        "flex w-10 flex-shrink-0 flex-col items-center gap-1.5 rounded-lg bg-muted/50 py-3 text-xs text-muted-foreground transition-shadow hover:text-foreground",
        isOver && "ring-2 ring-foreground/20",
      )}
      aria-label={`Show Closed column (${count})`}
    >
      <span className="[writing-mode:vertical-rl] font-semibold uppercase tracking-wider">
        Closed
      </span>
      <span>{count}</span>
    </button>
  );
}

function DraggableCard({ task, index }: { task: DisplayTask; index: number }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: task._id });

  return (
    <motion.div
      ref={setNodeRef}
      layout
      initial={{ opacity: 0, y: 12, filter: "blur(3px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{
        duration: 0.35,
        ease: EASE,
        delay: Math.min(index, 8) * 0.04,
      }}
      style={
        transform
          ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
          : undefined
      }
      {...attributes}
      {...listeners}
      className={cn("touch-none", isDragging && "opacity-30")}
    >
      <TaskCardBody task={task} />
    </motion.div>
  );
}

function TaskCardBody({
  task,
  dragging,
}: {
  task: DisplayTask;
  dragging?: boolean;
}) {
  return (
    <Card
      className={cn(
        "cursor-grab gap-2 rounded-xl p-3 active:cursor-grabbing",
        dragging && "rotate-1 shadow-lg",
      )}
    >
      <div className="flex items-start gap-1.5">
        {task.priority && (
          <PriorityDot
            priority={task.priority as TaskPriority}
            className="mt-1"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug">{task.title}</p>
          <p className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {task.listName}
          </p>
        </div>
        {task.milestone && (
          <span
            aria-label="Milestone"
            title="Milestone"
            className="mt-1 h-2 w-2 flex-shrink-0 rotate-45 border border-foreground/60"
          />
        )}
      </div>

      {task.assignees.length > 0 && (
        <div className="flex -space-x-1.5">
          {task.assignees.slice(0, 4).map((a) => (
            <Monogram
              key={a.id}
              name={a.name}
              size="sm"
              className="ring-2 ring-background"
            />
          ))}
          {task.assignees.length > 4 && (
            <span className="ml-1 text-[10px] text-muted-foreground">
              +{task.assignees.length - 4}
            </span>
          )}
        </div>
      )}

      {(task.estimatePoints !== undefined ||
        task.checklistTotal > 0 ||
        task.blockedOpenCount > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {task.estimatePoints !== undefined && (
            <Badge variant="secondary" className="text-[11px] font-medium">
              {task.estimatePoints} pts
            </Badge>
          )}
          {task.checklistTotal > 0 && (
            <Badge variant="secondary" className="text-[11px] font-medium">
              {task.checklistDone}/{task.checklistTotal}
            </Badge>
          )}
          {task.blockedOpenCount > 0 && (
            <Badge variant="destructive" className="text-[11px] font-medium">
              Blocked
            </Badge>
          )}
        </div>
      )}
    </Card>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {COLUMNS.map((c) => (
        <div
          key={c.key}
          className="w-72 flex-shrink-0 space-y-2 rounded-lg bg-muted/50 p-3"
        >
          <div className="h-4 w-20 animate-pulse rounded-full bg-muted" />
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-xl bg-muted"
            />
          ))}
        </div>
      ))}
    </div>
  );
}
