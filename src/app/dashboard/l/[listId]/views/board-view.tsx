"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { TaskBadges } from "@/components/dashboard/task-badges";
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
import { CalendarDays, GripVertical } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";

const PRIORITY_COLOR: Record<string, string> = {
  urgent: "#ef4444",
  high: "#f97316",
  normal: "#3b82f6",
  low: "#a1a1aa",
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
  const [activeId, setActiveId] = useState<Id<"tasks"> | null>(null);
  useEffect(() => setOrderedTasks(tasks), [tasks]);

  const reorder = useMutation(api.tasks.reorder);

  const sortedStatuses = useMemo(
    () => [...statuses].sort((a, b) => a.position - b.position),
    [statuses],
  );

  // Group tasks by statusId, sorted by position.
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
    if (sortedStatuses.some((s) => s._id === overId)) {
      overColumn = overId as Id<"listStatuses">;
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

    if (sortedStatuses.some((s) => s._id === overId)) {
      // Dropped on an empty column — append.
      targetStatus = overId as Id<"listStatuses">;
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

    await reorder({
      listId,
      orderedIds: newBucket.map((t) => t._id),
      statusId: targetStatus,
    });
  }

  const activeTask = activeId
    ? orderedTasks.find((t) => t._id === activeId) ?? null
    : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
    >
      <div className="flex gap-3 overflow-x-auto pb-2">
        {sortedStatuses.map((status) => {
          const columnTasks = columns.get(status._id) ?? [];
          return (
            <Column
              key={status._id}
              listId={listId}
              status={status}
              tasks={columnTasks}
            />
          );
        })}
      </div>
      <DragOverlay>
        {activeTask && <CardChrome task={activeTask} dragging />}
      </DragOverlay>
    </DndContext>
  );
}

function Column({
  listId,
  status,
  tasks,
}: {
  listId: Id<"lists">;
  status: Doc<"listStatuses">;
  tasks: Doc<"tasks">[];
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status._id });

  return (
    <section
      ref={setNodeRef}
      aria-label={status.name}
      className={cn(
        "flex w-72 flex-shrink-0 flex-col rounded-3xl border border-border bg-muted/30",
        isOver && "border-brand-500",
      )}
    >
      <header className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: status.color }}
          />
          {status.name}
        </span>
        <span className="text-xs text-muted-foreground">{tasks.length}</span>
      </header>
      <SortableContext
        items={tasks.map((t) => t._id)}
        strategy={verticalListSortingStrategy}
      >
        <ul className="flex-1 space-y-2 px-2 pb-3">
          {tasks.length === 0 && (
            <li className="rounded-2xl border border-dashed border-border bg-background/50 px-3 py-6 text-center text-xs text-muted-foreground">
              Drop tasks here
            </li>
          )}
          {tasks.map((task) => (
            <Card key={task._id} task={task} listId={listId} />
          ))}
        </ul>
      </SortableContext>
    </section>
  );
}

function Card({
  task,
  listId,
}: {
  task: Doc<"tasks">;
  listId: Id<"lists">;
}) {
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
      className={cn(
        "rounded-2xl border border-border bg-background shadow-sm",
        isDragging && "opacity-30",
      )}
    >
      <div className="flex items-start gap-1 p-3">
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
          href={`/dashboard/l/${listId}/t/${task._id}`}
          className="block flex-1 text-sm font-medium hover:underline"
        >
          {task.title}
          <TaskBadges task={task} />
        </Link>
      </div>
      <CardMeta task={task} />
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
    <div
      className={cn(
        "rounded-2xl border border-border bg-background p-3 shadow-md",
        dragging && "rotate-2",
      )}
    >
      <p className="text-sm font-medium">
        {task.title}
        <TaskBadges task={task} />
      </p>
      <CardMeta task={task} />
    </div>
  );
}

function CardMeta({ task }: { task: Doc<"tasks"> }) {
  const showFooter = task.priority || task.dueDate;
  if (!showFooter) return null;
  return (
    <div className="flex items-center gap-2 px-3 pb-3 text-xs text-muted-foreground">
      {task.priority && (
        <span className="inline-flex items-center gap-1">
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: PRIORITY_COLOR[task.priority] }}
          />
          {task.priority}
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
    </div>
  );
}
