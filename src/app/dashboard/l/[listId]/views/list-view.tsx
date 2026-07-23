"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ChevronRight, Plus, X } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CustomFieldInput } from "@/components/dashboard/custom-field-input";
import { TaskBadges } from "@/components/dashboard/task-badges";
import { ChecklistChip } from "@/components/dashboard/checklist";
import { taskPeekHref } from "@/components/dashboard/task-peek";
import {
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  type TaskPriority,
} from "@/components/dashboard/priority";
import { cn } from "@/lib/utils";
import { fromDateInputValue, toDateInputValue } from "@/lib/dates";
import { parseQuickAdd } from "@/lib/quick-add";
import { QuickAddChips } from "@/components/dashboard/quick-add-chips";
import { useToast } from "@/components/toast";
import { AnimatePresence, EASE, motion } from "@/components/motion";

export function ListView({
  listId,
  tasks,
  statuses,
  fields,
  filtered = false,
}: {
  listId: Id<"lists">;
  tasks: Doc<"tasks">[];
  statuses: Doc<"listStatuses">[];
  fields: Doc<"customFields">[];
  filtered?: boolean;
}) {
  // Multi-select for bulk actions. A Set of task ids; the bulk bar floats in
  // when anything is selected.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Rows hidden while a bulk-delete undo toast is live.
  const [pendingDelete, setPendingDelete] = useState<Set<string>>(new Set());

  // `tasks` here is already filtered to top-level rows by the list page.
  // Subtasks (tasks.parentTaskId) come from the same tasks.listForList
  // subscription queried directly — Convex dedupes it against the list
  // page's identical query, so this doesn't add a second round-trip.
  const allTasks = useQuery(api.tasks.listForList, { listId });
  const childrenByParent = useMemo(() => {
    const map = new Map<string, Doc<"tasks">[]>();
    for (const t of allTasks ?? []) {
      if (!t.parentTaskId) continue;
      const arr = map.get(t.parentTaskId) ?? [];
      arr.push(t);
      map.set(t.parentTaskId, arr);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.position - b.position);
    return map;
  }, [allTasks]);
  const shown = useMemo(
    () => tasks.filter((t) => !pendingDelete.has(t._id)),
    [tasks, pendingDelete],
  );
  const visibleIds = useMemo(
    () => new Set<string>(shown.map((t) => t._id)),
    [shown],
  );
  const selectedVisible = [...selected].filter((id) => visibleIds.has(id));

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(
      selectedVisible.length === shown.length && shown.length > 0
        ? new Set()
        : new Set(shown.map((t) => t._id)),
    );
  }

  return (
    <>
      <Card className="gap-0 overflow-hidden py-0">
        <CardContent className="px-0 py-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className="w-10">
                  <Checkbox
                    aria-label="Select all tasks"
                    checked={
                      shown.length > 0 && selectedVisible.length === shown.length
                    }
                    onCheckedChange={toggleAll}
                  />
                </TableHead>
                <TableHead scope="col" className="w-10" />
                <TableHead scope="col">Title</TableHead>
                <TableHead scope="col" className="hidden sm:table-cell">Status</TableHead>
                <TableHead scope="col" className="hidden sm:table-cell">Priority</TableHead>
                <TableHead scope="col" className="hidden md:table-cell">Due</TableHead>
                {fields.map((f) => (
                  <TableHead scope="col" key={f._id} className="hidden md:table-cell">
                    {f.name}
                  </TableHead>
                ))}
                <TableHead scope="col" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={7 + fields.length}
                    className="whitespace-normal py-14 text-center text-sm text-muted-foreground"
                  >
                    {filtered
                      ? "No tasks match these filters."
                      : "Nothing here yet. Add the first task below."}
                  </TableCell>
                </TableRow>
              )}
              {shown.map((task, i) => (
                <TaskRow
                  key={task._id}
                  task={task}
                  listId={listId}
                  statuses={statuses}
                  fields={fields}
                  index={i}
                  selected={selected.has(task._id)}
                  onToggleSelect={() => toggleSelect(task._id)}
                  subtasks={childrenByParent.get(task._id) ?? []}
                />
              ))}
            </TableBody>
          </Table>
          <NewTaskRow listId={listId} />
        </CardContent>
      </Card>

      <BulkBar
        statuses={statuses}
        selectedIds={selectedVisible as Id<"tasks">[]}
        onClear={() => setSelected(new Set())}
        onHide={(ids) =>
          setPendingDelete((prev) => new Set([...prev, ...ids]))
        }
        onUnhide={(ids) =>
          setPendingDelete((prev) => {
            const next = new Set(prev);
            for (const id of ids) next.delete(id);
            return next;
          })
        }
      />
    </>
  );
}

// Floating bulk-action bar: appears when tasks are selected. Complete, set
// status, set priority, and delete (undo-able) act on the whole selection.
function BulkBar({
  statuses,
  selectedIds,
  onClear,
  onHide,
  onUnhide,
}: {
  statuses: Doc<"listStatuses">[];
  selectedIds: Id<"tasks">[];
  onClear: () => void;
  onHide: (ids: string[]) => void;
  onUnhide: (ids: string[]) => void;
}) {
  const update = useMutation(api.tasks.update);
  const remove = useMutation(api.tasks.remove);
  const { toast } = useToast();
  const count = selectedIds.length;

  const completeStatus = statuses.find((s) => s.category === "complete");

  async function bulk(patch: {
    statusId?: Id<"listStatuses">;
    priority?: TaskPriority;
  }) {
    const ids = [...selectedIds];
    onClear();
    let failed = 0;
    for (const taskId of ids) {
      try {
        await update({ taskId, ...patch });
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) {
      toast(
        `${failed} task${failed === 1 ? "" : "s"} couldn't be updated (blocked or awaiting approval)`,
        { kind: "error" },
      );
    } else {
      toast(`${ids.length} task${ids.length === 1 ? "" : "s"} updated`);
    }
  }

  function bulkDelete() {
    const ids = [...selectedIds];
    onClear();
    onHide(ids);
    toast(`${ids.length} task${ids.length === 1 ? "" : "s"} deleted`, {
      action: { label: "Undo", onClick: () => onUnhide(ids) },
      onExpire: () => {
        for (const taskId of ids) void remove({ taskId });
      },
    });
  }

  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.25, ease: EASE }}
          className="fixed inset-x-0 bottom-6 z-40 flex justify-center px-4"
        >
          <Card className="flex-row flex-wrap items-center gap-2 rounded-full py-2 pl-4 pr-2 shadow-lg">
            <span className="text-sm font-medium tabular-nums">
              {count} selected
            </span>
            <span aria-hidden className="h-4 w-px bg-border" />
            {completeStatus && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void bulk({ statusId: completeStatus._id })}
              >
                Complete
              </Button>
            )}
            <BulkMenu label="Status">
              {statuses
                .slice()
                .sort((a, b) => a.position - b.position)
                .map((s) => (
                  <BulkMenuItem
                    key={s._id}
                    label={s.name}
                    swatch={s.color}
                    onClick={() => void bulk({ statusId: s._id })}
                  />
                ))}
            </BulkMenu>
            <BulkMenu label="Priority">
              {PRIORITY_ORDER.map((p) => (
                <BulkMenuItem
                  key={p}
                  label={PRIORITY_LABEL[p]}
                  onClick={() => void bulk({ priority: p })}
                />
              ))}
            </BulkMenu>
            <Button size="sm" variant="ghost" onClick={bulkDelete}>
              Delete
            </Button>
            <Button size="sm" variant="outline" onClick={onClear}>
              Done
            </Button>
          </Card>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function BulkMenu({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
        {label}
      </Button>
      <AnimatePresence>
        {open && (
          <>
            <div
              aria-hidden
              className="fixed inset-0 z-40"
              onClick={() => setOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0, y: 4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.98 }}
              transition={{ duration: 0.15 }}
              className="absolute bottom-full left-0 z-50 mb-2 w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
              onClick={() => setOpen(false)}
            >
              {children}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function BulkMenuItem({
  label,
  swatch,
  onClick,
}: {
  label: string;
  swatch?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-muted"
    >
      {swatch && (
        <span
          aria-hidden
          className="h-2 w-2 rounded-full"
          style={{ backgroundColor: swatch }}
        />
      )}
      {label}
    </button>
  );
}

function TaskRow({
  task,
  listId,
  statuses,
  fields,
  index,
  selected,
  onToggleSelect,
  subtasks,
}: {
  task: Doc<"tasks">;
  listId: Id<"lists">;
  statuses: Doc<"listStatuses">[];
  fields: Doc<"customFields">[];
  index: number;
  selected: boolean;
  onToggleSelect: () => void;
  subtasks: Doc<"tasks">[];
}) {
  const searchParams = useSearchParams();
  const [expanded, setExpanded] = useState(false);
  const update = useMutation(api.tasks.update);
  // Optimistic: the check fills instantly, before the server round-trip.
  // The server result reconciles it (and reverts if a blocker/approval
  // gate refuses the completion).
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
  const remove = useMutation(api.tasks.remove);
  const setValue = useMutation(api.taskFieldValues.set);
  const clearValue = useMutation(api.taskFieldValues.clear);
  const { toast } = useToast();
  const [deleting, setDeleting] = useState(false);

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

  // Hidden while its undo toast is live — delete commits on expiry.
  if (deleting) return null;

  return (
    <>
      <motion.tr
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          duration: 0.4,
          ease: EASE,
          delay: Math.min(index * 0.03, 0.3),
        }}
        data-slot="table-row"
        className={cn(
          "border-b align-middle transition-colors hover:bg-muted/50",
          selected && "bg-accent hover:bg-accent",
        )}
      >
      <TableCell>
        <Checkbox
          aria-label={`Select ${task.title}`}
          checked={selected}
          onCheckedChange={onToggleSelect}
        />
      </TableCell>
      <TableCell>
        <motion.button
          type="button"
          aria-label={isDone ? "Mark task open" : "Mark task complete"}
          onClick={async () => {
            try {
              await toggleComplete({ taskId: task._id });
            } catch (err) {
              const raw = err instanceof Error ? err.message : String(err);
              const msg = raw
                .split("Uncaught Error:")
                .pop()
                ?.split("\n")[0]
                ?.trim();
              toast(msg || "Couldn't complete this task", { kind: "error" });
            }
          }}
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
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-1">
          {subtasks.length > 0 && (
            <button
              type="button"
              aria-label={expanded ? "Collapse subtasks" : "Expand subtasks"}
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
              className="tap-target inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ChevronRight
                className={cn(
                  "h-3.5 w-3.5 transition-transform",
                  expanded && "rotate-90",
                )}
              />
            </button>
          )}
          {task.milestone && (
            <span
              aria-hidden
              title="Milestone"
              className="h-2 w-2 flex-shrink-0 rotate-45 border border-foreground/60"
            />
          )}
          <Link
            href={taskPeekHref(searchParams, task._id)}
            scroll={false}
            className={cn(
              "truncate hover:underline",
              isDone && "text-muted-foreground line-through",
            )}
          >
            {task.title}
          </Link>
          <TaskBadges task={task} />
          <ChecklistChip checklist={task.checklist} />
          {task.estimatePoints != null && (
            <span className="flex-shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {task.estimatePoints} pts
            </span>
          )}
          {subtasks.length > 0 && (
            <span className="flex-shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {subtasks.length}
            </span>
          )}
        </span>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <select
          aria-label="Status"
          value={task.statusId}
          onChange={async (e) => {
            const nextStatusId = e.currentTarget.value as Id<"listStatuses">;
            try {
              await update({ taskId: task._id, statusId: nextStatusId });
            } catch (err) {
              const raw = err instanceof Error ? err.message : String(err);
              const msg = raw
                .split("Uncaught Error:")
                .pop()
                ?.split("\n")[0]
                ?.trim();
              toast(msg || "Couldn't update status", { kind: "error" });
            }
          }}
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
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <select
          aria-label="Priority"
          value={task.priority ?? ""}
          onChange={(e) => {
            const value = e.currentTarget.value;
            // Explicit null clears the priority — undefined would be
            // dropped from the wire and the clear silently ignored.
            update({
              taskId: task._id,
              priority: (value || null) as TaskPriority | null,
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
      </TableCell>
      <TableCell className="hidden md:table-cell">
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
      </TableCell>
      {fields.map((f) => (
        <TableCell key={f._id} className="hidden md:table-cell">
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
        </TableCell>
      ))}
      <TableCell className="text-right">
        <button
          type="button"
          aria-label="Delete task"
          onClick={() => {
            setDeleting(true);
            toast(`"${task.title}" deleted`, {
              action: { label: "Undo", onClick: () => setDeleting(false) },
              onExpire: () => remove({ taskId: task._id }),
            });
          }}
          className="tap-target inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </TableCell>
      </motion.tr>
      <AnimatePresence initial={false}>
        {expanded &&
          subtasks.map((child) => (
            <ChildTaskRow
              key={child._id}
              task={child}
              listId={listId}
              statuses={statuses}
              colSpan={5 + fields.length}
            />
          ))}
      </AnimatePresence>
    </>
  );
}

// A subtask, indented beneath its parent row. Deliberately minimal — just
// enough to see progress and jump to the subtask's own page; full editing
// (status, priority, fields, delete) happens on the task page or in the
// Subtasks section there.
function ChildTaskRow({
  task,
  listId,
  statuses,
  colSpan,
}: {
  task: Doc<"tasks">;
  listId: Id<"lists">;
  statuses: Doc<"listStatuses">[];
  colSpan: number;
}) {
  const searchParams = useSearchParams();
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
  const { toast } = useToast();

  const status = statuses.find((s) => s._id === task.statusId);
  const isDone =
    status?.category === "complete" || status?.category === "closed";

  return (
    <motion.tr
      layout
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.25, ease: EASE }}
      data-slot="table-row"
      className="border-b bg-muted/20 align-middle"
    >
      <TableCell />
      <TableCell>
        <motion.button
          type="button"
          aria-label={isDone ? "Mark subtask open" : "Mark subtask complete"}
          onClick={async () => {
            try {
              await toggleComplete({ taskId: task._id });
            } catch (err) {
              const raw = err instanceof Error ? err.message : String(err);
              const msg = raw
                .split("Uncaught Error:")
                .pop()
                ?.split("\n")[0]
                ?.trim();
              toast(msg || "Couldn't complete this subtask", {
                kind: "error",
              });
            }
          }}
          whileTap={{ scale: 0.8 }}
          className="tap-target inline-flex h-4 w-4 items-center justify-center rounded-full border-2 transition-colors"
          style={{
            borderColor: status?.color ?? "var(--color-border)",
            backgroundColor: isDone ? status?.color : "transparent",
          }}
        >
          <motion.svg
            viewBox="0 0 16 16"
            className="h-2.5 w-2.5 text-white"
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
      </TableCell>
      <TableCell colSpan={colSpan} className="whitespace-normal">
        <span className="flex items-center gap-2 pl-4">
          <Link
            href={taskPeekHref(searchParams, task._id)}
            scroll={false}
            className={cn(
              "truncate text-xs hover:underline",
              isDone && "text-muted-foreground line-through",
            )}
          >
            {task.title}
          </Link>
          {task.dueDate && (
            <span className="flex-shrink-0 text-[11px] text-muted-foreground">
              {toDateInputValue(task.dueDate)}
            </span>
          )}
        </span>
      </TableCell>
    </motion.tr>
  );
}

function NewTaskRow({ listId }: { listId: Id<"lists"> }) {
  const [title, setTitle] = useState("");
  const create = useMutation(api.tasks.create);
  const { toast } = useToast();
  const [pending, setPending] = useState(false);
  // Natural-language grammar: "tomorrow", "friday", "!high" parse into
  // real fields; chips preview what was understood.
  const parsed = useMemo(() => parseQuickAdd(title), [title]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!parsed.title) return;
    setPending(true);
    try {
      await create({
        listId,
        title: parsed.title,
        dueDate: parsed.dueDate,
        priority: parsed.priority,
      });
      setTitle("");
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const msg = raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim();
      toast(msg || "Couldn't create task", { kind: "error" });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="border-t border-border px-4 py-3">
      <div className="flex items-center gap-2">
        <Plus className="h-4 w-4 text-muted-foreground" aria-hidden />
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add a task… try “ship the deck tomorrow !high”"
          disabled={pending}
          className="flex-1 bg-transparent text-sm focus:outline-none disabled:opacity-50"
        />
        <Button
          type="submit"
          size="sm"
          variant="ghost"
          disabled={!parsed.title || pending}
        >
          Add
        </Button>
      </div>
      <div className="pl-6">
        <QuickAddChips parsed={parsed} />
      </div>
    </form>
  );
}
