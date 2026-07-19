"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { CustomFieldInput } from "@/components/dashboard/custom-field-input";
import { TaskBadges } from "@/components/dashboard/task-badges";
import { EmptyState } from "@/components/dashboard/empty-state";
import { taskPeekHref } from "@/components/dashboard/task-peek";
import {
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  type TaskPriority,
} from "@/components/dashboard/priority";
import { cn } from "@/lib/utils";
import { fromDateInputValue, toDateInputValue } from "@/lib/dates";
import { EASE, motion } from "@/components/motion";
import { useToast } from "@/components/toast";

// Dense spreadsheet-style TABLE view — the power-user surface. Every cell is
// directly editable in place; the header row sorts client-side. This mirrors
// ListView's data flow (same tasks/statuses/fields props, same optimistic
// toggleComplete + inline soft-field editors) but trades ListView's mobile
// affordances for maximum information density.

type SortKey = "title" | "status" | "priority" | "start" | "due" | "points";

export function TableView({
  listId,
  tasks,
  statuses,
  fields,
}: {
  listId: Id<"lists">;
  tasks: Doc<"tasks">[];
  statuses: Doc<"listStatuses">[];
  fields: Doc<"customFields">[];
}) {
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const statusPosition = useMemo(
    () => new Map(statuses.map((s) => [s._id, s.position])),
    [statuses],
  );

  const sorted = useMemo(() => {
    if (!sortKey) return tasks;

    function rank(t: Doc<"tasks">): number | string {
      switch (sortKey) {
        case "title":
          return t.title.toLowerCase();
        case "status":
          return statusPosition.get(t.statusId) ?? Infinity;
        case "priority": {
          const idx = t.priority
            ? PRIORITY_ORDER.indexOf(t.priority as TaskPriority)
            : -1;
          return idx === -1 ? Infinity : idx;
        }
        case "start":
          return t.startDate ?? Infinity;
        case "due":
          return t.dueDate ?? Infinity;
        case "points":
          return t.estimatePoints ?? Infinity;
        default:
          return 0;
      }
    }

    const copy = [...tasks].sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra < rb) return -1;
      if (ra > rb) return 1;
      return 0;
    });
    return sortDir === "asc" ? copy : copy.reverse();
  }, [tasks, sortKey, sortDir, statusPosition]);

  if (tasks.length === 0) {
    return (
      <div className="rounded-2xl bento">
        <EmptyState
          title="Nothing here yet"
          message="Add a task from List or Board view to see it in the table."
        />
      </div>
    );
  }

  return (
    <div className="rounded-2xl bento">
      <div className="overflow-x-auto">
        <table className="sheet-table w-full text-sm">
          <thead className="sticky top-0 z-10 bg-background">
            <tr>
              <th scope="col" className="w-10"></th>
              <SortHeader
                label="Title"
                sortKey="title"
                active={sortKey}
                dir={sortDir}
                onClick={toggleSort}
                className="min-w-[220px]"
              />
              <SortHeader
                label="Status"
                sortKey="status"
                active={sortKey}
                dir={sortDir}
                onClick={toggleSort}
                className="min-w-[140px]"
              />
              <SortHeader
                label="Priority"
                sortKey="priority"
                active={sortKey}
                dir={sortDir}
                onClick={toggleSort}
                className="min-w-[120px]"
              />
              <th scope="col" className="min-w-[160px]">
                Assignees
              </th>
              <SortHeader
                label="Start"
                sortKey="start"
                active={sortKey}
                dir={sortDir}
                onClick={toggleSort}
                className="min-w-[120px]"
              />
              <SortHeader
                label="Due"
                sortKey="due"
                active={sortKey}
                dir={sortDir}
                onClick={toggleSort}
                className="min-w-[120px]"
              />
              <SortHeader
                label="Points"
                sortKey="points"
                active={sortKey}
                dir={sortDir}
                onClick={toggleSort}
                className="min-w-[90px] text-right"
              />
              {fields.map((f) => (
                <th key={f._id} scope="col" className="min-w-[140px]">
                  {f.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((task, i) => (
              <TableRow
                key={task._id}
                task={task}
                listId={listId}
                statuses={statuses}
                fields={fields}
                index={i}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-2 text-xs text-muted-foreground">
        {tasks.length} task{tasks.length === 1 ? "" : "s"}
      </div>
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  active,
  dir,
  onClick,
  className,
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey | null;
  dir: "asc" | "desc";
  onClick: (key: SortKey) => void;
  className?: string;
}) {
  const isActive = active === sortKey;
  return (
    <th scope="col" className={className}>
      <button
        type="button"
        onClick={() => onClick(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 uppercase tracking-wider transition-colors",
          isActive ? "text-foreground" : "hover:text-foreground",
        )}
      >
        {label}
        {isActive &&
          (dir === "asc" ? (
            <ArrowUp className="h-3 w-3" aria-hidden />
          ) : (
            <ArrowDown className="h-3 w-3" aria-hidden />
          ))}
      </button>
    </th>
  );
}

function TableRow({
  task,
  listId,
  statuses,
  fields,
  index,
}: {
  task: Doc<"tasks">;
  listId: Id<"lists">;
  statuses: Doc<"listStatuses">[];
  fields: Doc<"customFields">[];
  index: number;
}) {
  const update = useMutation(api.tasks.update);
  const toggleComplete = useMutation(
    api.tasks.toggleComplete,
  ).withOptimisticUpdate((localStore, args) => {
    const current = localStore.getQuery(api.tasks.listForList, { listId });
    if (!current) return;
    const sorted = [...statuses].sort((a, b) => a.position - b.position);
    localStore.setQuery(
      api.tasks.listForList,
      { listId },
      current.map((t) => {
        if (t._id !== args.taskId) return t;
        const cur = statuses.find((s) => s._id === t.statusId);
        const done =
          cur?.category === "complete" || cur?.category === "closed";
        const next = done
          ? (sorted.find((s) => s.category === "open") ?? sorted[0])
          : (sorted.find((s) => s.category === "complete") ?? sorted[0]);
        return next ? { ...t, statusId: next._id } : t;
      }),
    );
  });
  const setValue = useMutation(api.taskFieldValues.set);
  const clearValue = useMutation(api.taskFieldValues.clear);
  const assignable = useQuery(api.agents.listAssignableForList, { listId });

  const values = useQuery(api.taskFieldValues.listForTask, {
    taskId: task._id,
  });
  const valuesByField = useMemo(() => {
    const map = new Map<string, Doc<"taskFieldValues">>();
    for (const v of values ?? []) map.set(v.fieldId, v);
    return map;
  }, [values]);

  const status = statuses.find((s) => s._id === task.statusId);
  const isDone =
    status?.category === "complete" || status?.category === "closed";

  const byId = useMemo(
    () => new Map((assignable ?? []).map((a) => [a.id, a])),
    [assignable],
  );

  return (
    <motion.tr
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.3,
        ease: EASE,
        delay: Math.min(index * 0.02, 0.24),
      }}
      className="align-middle"
    >
      <td className="py-1.5">
        <motion.button
          type="button"
          aria-label={isDone ? "Mark task open" : "Mark task complete"}
          onClick={() => void toggleComplete({ taskId: task._id })}
          whileTap={{ scale: 0.8 }}
          className="tap-target inline-flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors"
          style={{
            borderColor: status?.color ?? "var(--color-border)",
            backgroundColor: isDone ? status?.color : "transparent",
          }}
        >
          <motion.svg
            viewBox="0 0 16 16"
            className="h-3 w-3 text-white"
            aria-hidden
            initial={false}
            animate={{ scale: isDone ? 1 : 0, opacity: isDone ? 1 : 0 }}
            transition={{ type: "spring", stiffness: 500, damping: 22 }}
          >
            <path
              d="M3 8.5l3 3 7-7"
              stroke="currentColor"
              strokeWidth="2.5"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </motion.svg>
        </motion.button>
      </td>
      <td className="py-1.5">
        <TitleCell task={task} isDone={isDone} />
      </td>
      <td className="py-1.5">
        <select
          aria-label="Status"
          value={task.statusId}
          onChange={(e) =>
            update({
              taskId: task._id,
              statusId: e.currentTarget.value as Id<"listStatuses">,
            })
          }
          className="soft-field px-2 py-1 text-xs"
          style={{
            backgroundColor: status ? `${status.color}33` : undefined,
          }}
        >
          {statuses.map((s) => (
            <option key={s._id} value={s._id}>
              {s.name}
            </option>
          ))}
        </select>
      </td>
      <td className="py-1.5">
        <select
          aria-label="Priority"
          value={task.priority ?? ""}
          onChange={(e) => {
            const value = e.currentTarget.value;
            update({
              taskId: task._id,
              priority: (value || undefined) as TaskPriority | undefined,
            });
          }}
          className="soft-field px-2 py-1 text-xs"
        >
          <option value="">None</option>
          {PRIORITY_ORDER.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </option>
          ))}
        </select>
      </td>
      <td className="py-1.5">
        <AssigneeStack ids={task.assigneeClerkIds} byId={byId} />
      </td>
      <td className="py-1.5">
        <input
          type="date"
          aria-label="Start date"
          value={task.startDate ? toDateInputValue(task.startDate) : ""}
          onChange={(e) =>
            update({
              taskId: task._id,
              startDate: fromDateInputValue(e.currentTarget.value) ?? null,
            })
          }
          className="soft-field px-2 py-1 text-xs"
        />
      </td>
      <td className="py-1.5">
        <input
          type="date"
          aria-label="Due date"
          value={task.dueDate ? toDateInputValue(task.dueDate) : ""}
          onChange={(e) =>
            update({
              taskId: task._id,
              dueDate: fromDateInputValue(e.currentTarget.value) ?? null,
            })
          }
          className="soft-field px-2 py-1 text-xs"
        />
      </td>
      <td className="py-1.5 text-right">
        <PointsCell task={task} />
      </td>
      {fields.map((f) => (
        <td key={f._id} className="py-1.5">
          <CustomFieldInput
            field={f}
            value={valuesByField.get(f._id)}
            onCommit={(value) => {
              if (value === null) {
                clearValue({ taskId: task._id, fieldId: f._id });
              } else {
                setValue({ taskId: task._id, fieldId: f._id, ...value });
              }
            }}
          />
        </td>
      ))}
    </motion.tr>
  );
}

// Single click opens the task peek; double-click swaps to a rename input.
// A single click is deferred behind a short timer so a second click (a
// double-click) can cancel the navigation and enter edit mode instead —
// otherwise the first click of any double-click would already have
// navigated away before the dblclick event fires.
function TitleCell({ task, isDone }: { task: Doc<"tasks">; isDone: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const update = useMutation(api.tasks.update);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setDraft(task.title), [task.title]);
  useEffect(
    () => () => {
      if (clickTimer.current) clearTimeout(clickTimer.current);
    },
    [],
  );

  function commit() {
    const next = draft.trim();
    if (next && next !== task.title) {
      void update({ taskId: task._id, title: next });
    } else {
      setDraft(task.title);
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") {
            setDraft(task.title);
            setEditing(false);
          }
        }}
        aria-label="Task title"
        className="soft-field w-full px-2 py-1 text-sm"
      />
    );
  }

  return (
    <span className="flex items-center">
      {task.milestone && (
        <span
          aria-hidden
          title="Milestone"
          className="mr-1.5 inline-block h-2 w-2 flex-shrink-0 rotate-45 border-[1.5px] border-foreground/70"
        />
      )}
      <a
        href={taskPeekHref(searchParams, task._id)}
        onClick={(e) => {
          e.preventDefault();
          if (clickTimer.current) return;
          clickTimer.current = setTimeout(() => {
            clickTimer.current = null;
            router.push(taskPeekHref(searchParams, task._id), {
              scroll: false,
            });
          }, 220);
        }}
        onDoubleClick={(e) => {
          e.preventDefault();
          if (clickTimer.current) {
            clearTimeout(clickTimer.current);
            clickTimer.current = null;
          }
          setEditing(true);
        }}
        className={cn(
          "cursor-pointer truncate hover:underline",
          isDone && "text-muted-foreground line-through",
        )}
      >
        {task.title}
      </a>
      <TaskBadges task={task} />
    </span>
  );
}

// Blur-committed points editor, same shape as TitleCell's inline rename:
// local draft state so keystrokes don't spam mutations, committed on blur.
function PointsCell({ task }: { task: Doc<"tasks"> }) {
  const update = useMutation(api.tasks.update);
  const { toast } = useToast();
  const [draft, setDraft] = useState(
    task.estimatePoints !== undefined ? String(task.estimatePoints) : "",
  );

  useEffect(
    () =>
      setDraft(
        task.estimatePoints !== undefined ? String(task.estimatePoints) : "",
      ),
    [task.estimatePoints],
  );

  async function commit() {
    const trimmed = draft.trim();
    let next: number | null;
    if (trimmed === "") {
      if (task.estimatePoints === undefined) return;
      next = null;
    } else {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n < 0) {
        setDraft(
          task.estimatePoints !== undefined ? String(task.estimatePoints) : "",
        );
        return;
      }
      if (n === task.estimatePoints) return;
      next = n;
    }
    try {
      await update({ taskId: task._id, estimatePoints: next });
      toast("Saved");
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const msg = raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim();
      toast(msg || "Couldn't update points", { kind: "error" });
    }
  }

  return (
    <input
      type="number"
      inputMode="numeric"
      min={0}
      aria-label="Points"
      placeholder="—"
      value={draft}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
      }}
      className="soft-field w-16 px-2 py-1 text-right text-xs"
    />
  );
}

function AssigneeStack({
  ids,
  byId,
}: {
  ids: string[];
  byId: Map<string, { id: string; name: string; kind: "user" | "agent" }>;
}) {
  if (ids.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const shown = ids.slice(0, 3);
  const extra = ids.length - shown.length;
  return (
    <div className="flex items-center">
      {shown.map((id, i) => {
        const person = byId.get(id);
        const name = person?.name ?? id;
        return (
          <span
            key={id}
            title={person ? `${name}${person.kind === "agent" ? " (agent)" : ""}` : name}
            className={cn(
              "inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-brand-600 text-[10px] font-medium text-white ring-2 ring-background",
              i > 0 && "-ml-2",
            )}
          >
            {name.trim().charAt(0).toUpperCase() || "?"}
          </span>
        );
      })}
      {extra > 0 && (
        <span className="-ml-2 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-2 ring-background">
          +{extra}
        </span>
      )}
    </div>
  );
}
