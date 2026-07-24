"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Fragment, useMemo, useState } from "react";
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
import { Monogram } from "@/components/dashboard/monogram";
import { taskPeekHref } from "@/components/dashboard/task-peek";
import {
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  type TaskPriority,
} from "@/components/dashboard/priority";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/errors";
import { fromDateInputValue, toDateInputValue } from "@/lib/dates";
import { parseQuickAdd } from "@/lib/quick-add";
import { QuickAddChips } from "@/components/dashboard/quick-add-chips";
import { useToast } from "@/components/toast";
import { AnimatePresence, EASE, motion } from "@/components/motion";
import {
  BUILTIN_FIELDS,
  DEFAULT_VIEW_SETTINGS,
  isBuiltinFieldKey,
  type GroupBy,
  type ViewSettings,
} from "@/lib/view-settings";

export function ListView({
  listId,
  tasks,
  statuses,
  fields,
  filtered = false,
  settings = DEFAULT_VIEW_SETTINGS,
  visibleFields,
  parentTitles,
  locationLabel,
}: {
  listId: Id<"lists">;
  tasks: Doc<"tasks">[];
  statuses: Doc<"listStatuses">[];
  fields: Doc<"customFields">[];
  filtered?: boolean;
  /** Customize-view settings (display toggles, grouping, subtask mode). */
  settings?: ViewSettings;
  /** Ordered visible field keys — resolved by the list page. */
  visibleFields?: string[];
  /** taskId → title, for the "show subtask parent names" chip. */
  parentTitles?: Map<string, string>;
  /** Space › Folder › List breadcrumb; undefined when the toggle is off. */
  locationLabel?: string;
}) {
  // Multi-select for bulk actions. A Set of task ids; the bulk bar floats in
  // when anything is selected.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Rows hidden while a bulk-delete undo toast is live.
  const [pendingDelete, setPendingDelete] = useState<Set<string>>(new Set());

  const columns = useMemo(
    () =>
      (visibleFields ?? ["status", "priority", "due"]).map((key) => ({
        key,
        label: isBuiltinFieldKey(key)
          ? (BUILTIN_FIELDS.find((f) => f.key === key)?.label ?? key)
          : (fields.find((f) => f._id === key)?.name ?? "Field"),
      })),
    [visibleFields, fields],
  );
  // Total column count: select + complete + title, the metadata columns, and
  // the trailing action cell.
  const columnCount = columns.length + 4;

  // Assignee names (humans AND agents) are needed for the Assignees column
  // and for assignee grouping — fetched only when one of those is on.
  const needsPeople =
    columns.some((c) => c.key === "assignees") || settings.group === "assignee";
  const assignable = useQuery(
    api.agents.listAssignableForList,
    needsPeople ? { listId } : "skip",
  );

  // `tasks` here is already filtered to top-level rows by the list page.
  // Subtasks (tasks.parentTaskId) come from the same tasks.listForList
  // subscription queried directly — Convex dedupes it against the list
  // page's identical query, so this doesn't add a second round-trip.
  const allTasks = useQuery(api.tasks.listForList, { listId });
  const childrenByParent = useMemo(() => {
    const map = new Map<string, Doc<"tasks">[]>();
    // In flat mode every subtask is already a row of its own, so nesting is
    // switched off entirely rather than showing each subtask twice.
    if (settings.subtasks === "flat") return map;
    for (const t of allTasks ?? []) {
      if (!t.parentTaskId) continue;
      const arr = map.get(t.parentTaskId) ?? [];
      arr.push(t);
      map.set(t.parentTaskId, arr);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.position - b.position);
    return map;
  }, [allTasks, settings.subtasks]);
  const shown = useMemo(
    () => tasks.filter((t) => !pendingDelete.has(t._id)),
    [tasks, pendingDelete],
  );
  const visibleIds = useMemo(
    () => new Set<string>(shown.map((t) => t._id)),
    [shown],
  );
  const selectedVisible = [...selected].filter((id) => visibleIds.has(id));

  const groups = useMemo(
    () =>
      buildGroups(shown, settings, statuses, (id) =>
        assignable?.find((a) => a.id === id)?.name,
      ),
    [shown, settings, statuses, assignable],
  );

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

  function renderRow(task: Doc<"tasks">, index: number) {
    return (
      <TaskRow
        // Remounting on a subtask-mode change resets each row's expansion
        // to the mode's default (collapsed vs expanded) without a sync effect.
        key={`${task._id}:${settings.subtasks}`}
        task={task}
        listId={listId}
        statuses={statuses}
        fields={fields}
        columns={columns}
        columnCount={columnCount}
        index={index}
        selected={selected.has(task._id)}
        onToggleSelect={() => toggleSelect(task._id)}
        subtasks={childrenByParent.get(task._id) ?? []}
        settings={settings}
        parentTitle={
          task.parentTaskId
            ? parentTitles?.get(task.parentTaskId as string)
            : undefined
        }
        locationLabel={locationLabel}
        people={assignable}
        defaultExpanded={settings.subtasks === "expanded"}
      />
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
                {columns.map((c, i) => (
                  <TableHead
                    scope="col"
                    key={c.key}
                    className={cn(
                      "truncate",
                      i < 2 ? "hidden sm:table-cell" : "hidden md:table-cell",
                    )}
                  >
                    {c.label}
                  </TableHead>
                ))}
                <TableHead scope="col" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={columnCount}
                    className="whitespace-normal py-14 text-center text-sm text-muted-foreground"
                  >
                    {filtered
                      ? "No tasks match these filters."
                      : "Nothing here yet. Add the first task below."}
                  </TableCell>
                </TableRow>
              )}
              {shown.length > 0 &&
                (groups === null
                  ? shown.map((task, i) => renderRow(task, i))
                  : groups.map((group) => {
                    let cursor = 0;
                    return (
                      <Fragment key={group.key}>
                        <GroupHeaderRow
                          label={group.label}
                          count={group.tasks.length}
                          color={group.color}
                          columnCount={columnCount}
                        />
                        {group.tasks.length === 0 ? (
                          <TableRow className="hover:bg-transparent">
                            <TableCell
                              colSpan={columnCount}
                              className="whitespace-normal py-3 pl-10 text-xs text-muted-foreground"
                            >
                              Nothing in {group.label.toLowerCase()}.
                            </TableCell>
                          </TableRow>
                        ) : (
                          group.tasks.map((task) => renderRow(task, cursor++))
                        )}
                      </Fragment>
                    );
                    }))}
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

// ── Grouping ─────────────────────────────────────────────────────────────
// Group by status / assignee / priority / due date / milestone. Only status
// can produce a group with nothing in it, and that group is dropped unless
// "Show empty statuses" is on — every other dimension is derived from the
// tasks themselves, so an empty bucket never exists.

type TaskGroup = {
  key: string;
  label: string;
  color?: string;
  tasks: Doc<"tasks">[];
};

function buildGroups(
  tasks: Doc<"tasks">[],
  settings: ViewSettings,
  statuses: Doc<"listStatuses">[],
  nameFor: (id: string) => string | undefined,
): TaskGroup[] | null {
  const group: GroupBy = settings.group;
  if (group === "none") return null;

  if (group === "status") {
    const sorted = [...statuses].sort((a, b) => a.position - b.position);
    const groups: TaskGroup[] = sorted.map((s) => ({
      key: s._id as string,
      label: s.name,
      color: s.color,
      tasks: tasks.filter((t) => t.statusId === s._id),
    }));
    // A task whose status was deleted mid-session still deserves a home.
    const orphans = tasks.filter(
      (t) => !sorted.some((s) => s._id === t.statusId),
    );
    if (orphans.length) {
      groups.push({ key: "__no_status", label: "No status", tasks: orphans });
    }
    return settings.emptyStatuses
      ? groups
      : groups.filter((g) => g.tasks.length > 0);
  }

  if (group === "priority") {
    const buckets = PRIORITY_ORDER.map((p) => ({
      key: p as string,
      label: PRIORITY_LABEL[p],
      tasks: tasks.filter((t) => t.priority === p),
    }));
    buckets.push({
      key: "__none",
      label: "No priority",
      tasks: tasks.filter((t) => !t.priority),
    });
    return buckets.filter((b) => b.tasks.length > 0);
  }

  if (group === "milestone") {
    return [
      {
        key: "__milestone",
        label: "Milestones",
        tasks: tasks.filter((t) => t.milestone),
      },
      {
        key: "__tasks",
        label: "Tasks",
        tasks: tasks.filter((t) => !t.milestone),
      },
    ].filter((b) => b.tasks.length > 0);
  }

  if (group === "due") {
    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
    const endOfToday = startOfToday + 24 * 60 * 60 * 1000;
    const endOfWeek = startOfToday + 7 * 24 * 60 * 60 * 1000;
    const bucketOf = (t: Doc<"tasks">) => {
      if (t.dueDate === undefined) return "none";
      if (t.dueDate < startOfToday) return "overdue";
      if (t.dueDate < endOfToday) return "today";
      if (t.dueDate < endOfWeek) return "week";
      return "later";
    };
    const labels: { key: string; label: string }[] = [
      { key: "overdue", label: "Overdue" },
      { key: "today", label: "Today" },
      { key: "week", label: "Next 7 days" },
      { key: "later", label: "Later" },
      { key: "none", label: "No due date" },
    ];
    return labels
      .map((l) => ({
        key: l.key,
        label: l.label,
        tasks: tasks.filter((t) => bucketOf(t) === l.key),
      }))
      .filter((b) => b.tasks.length > 0);
  }

  // assignee — one group per first assignee, then the unassigned pile.
  const keys = new Set<string>();
  for (const t of tasks) keys.add(t.assigneeClerkIds[0] ?? "__unassigned");
  const people = [...keys]
    .filter((k) => k !== "__unassigned")
    .map((k) => ({
      key: k,
      label: nameFor(k) ?? "Teammate",
      tasks: tasks.filter((t) => (t.assigneeClerkIds[0] ?? "") === k),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const groups: TaskGroup[] = [...people];
  if (keys.has("__unassigned")) {
    groups.push({
      key: "__unassigned",
      label: "Unassigned",
      tasks: tasks.filter((t) => t.assigneeClerkIds.length === 0),
    });
  }
  return groups;
}

function GroupHeaderRow({
  label,
  count,
  color,
  columnCount,
}: {
  label: string;
  count: number;
  color?: string;
  columnCount: number;
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell
        colSpan={columnCount}
        className="whitespace-normal bg-muted/40 py-2"
      >
        <span className="flex min-w-0 items-center gap-2">
          {color && (
            <span
              aria-hidden
              className="h-2 w-2 flex-shrink-0 rounded-full"
              style={{ backgroundColor: color }}
            />
          )}
          <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {label}
          </span>
          <span className="flex-shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {count}
          </span>
        </span>
      </TableCell>
    </TableRow>
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

type Person = { id: string; name: string; kind: "user" | "agent" };

function TaskRow({
  task,
  listId,
  statuses,
  fields,
  columns,
  columnCount,
  index,
  selected,
  onToggleSelect,
  subtasks,
  settings,
  parentTitle,
  locationLabel,
  people,
  defaultExpanded,
}: {
  task: Doc<"tasks">;
  listId: Id<"lists">;
  statuses: Doc<"listStatuses">[];
  fields: Doc<"customFields">[];
  columns: { key: string; label: string }[];
  columnCount: number;
  index: number;
  selected: boolean;
  onToggleSelect: () => void;
  subtasks: Doc<"tasks">[];
  settings: ViewSettings;
  parentTitle?: string;
  locationLabel?: string;
  people?: Person[];
  defaultExpanded: boolean;
}) {
  const searchParams = useSearchParams();
  const [expanded, setExpanded] = useState(defaultExpanded);
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
  // Rollup/formula results and vote counts have no stored row — they're
  // derived per read. One query per row (not per cell), and only when this
  // list actually defines a derived type; Convex dedupes the subscription
  // against the identical query the task page/Table view would make.
  const computed = useQuery(
    api.taskFieldValues.computedForTask,
    fields.some(
      (f) => f.type === "rollup" || f.type === "formula" || f.type === "voting",
    )
      ? { taskId: task._id }
      : "skip",
  );
  // The signed-in principal, so a voting cell knows whether you voted.
  const currentUser = useQuery(api.users.current, {});
  const valuesByField = useMemo(() => {
    const map = new Map<string, Doc<"taskFieldValues">>();
    for (const v of values ?? []) map.set(v.fieldId, v);
    return map;
  }, [values]);
  const computedByField = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const c of computed ?? []) map.set(c.fieldId, c.value);
    return map;
  }, [computed]);

  const status = statuses.find((s) => s._id === task.statusId);
  const isDone =
    status?.category === "complete" || status?.category === "closed";
  const wrap = settings.wrapText;

  // Hidden while its undo toast is live — delete commits on expiry.
  if (deleting) return null;

  function renderCell(key: string) {
    if (key === "status") {
      return (
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
      );
    }
    if (key === "priority") {
      return (
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
      );
    }
    if (key === "start") {
      return (
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
      );
    }
    if (key === "due") {
      return (
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
      );
    }
    if (key === "assignees") {
      if (task.assigneeClerkIds.length === 0) {
        return <span className="text-xs text-muted-foreground">—</span>;
      }
      return (
        <span className="flex items-center -space-x-1.5">
          {task.assigneeClerkIds.slice(0, 3).map((id) => {
            const name = people?.find((p) => p.id === id)?.name ?? "Teammate";
            return (
              <Monogram key={id} name={name} seed={id} size="sm" />
            );
          })}
          {task.assigneeClerkIds.length > 3 && (
            <span className="pl-2.5 text-[11px] text-muted-foreground">
              +{task.assigneeClerkIds.length - 3}
            </span>
          )}
        </span>
      );
    }
    if (key === "points") {
      return (
        <span className="text-xs tabular-nums text-muted-foreground">
          {task.estimatePoints ?? "—"}
        </span>
      );
    }
    const field = fields.find((f) => f._id === key);
    if (!field) return null;
    return (
      <CustomFieldInput
        field={field}
        value={valuesByField.get(field._id)}
        taskId={task._id}
        computed={computedByField.get(field._id)}
        currentActorId={currentUser?.clerkId}
        onCommit={(value) => {
          // Every write is validated server-side; a refusal carries a
          // message the user can act on, so surface it rather than
          // dropping the rejection on the floor.
          const op =
            value === null
              ? clearValue({ taskId: task._id, fieldId: field._id })
              : setValue({ taskId: task._id, fieldId: field._id, ...value });
          op.catch((e) =>
            toast(errorMessage(e, "Couldn't update that field"), {
              kind: "error",
            }),
          );
        }}
      />
    );
  }

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
      <TableCell className={cn("min-w-0", wrap && "whitespace-normal")}>
        <span
          className={cn(
            "flex min-w-0 gap-1",
            wrap ? "flex-wrap items-start" : "items-center",
          )}
        >
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
              "min-w-0 hover:underline",
              wrap ? "break-words" : "truncate",
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
        <RowContext
          location={locationLabel}
          parentTitle={settings.showSubtaskParents ? parentTitle : undefined}
        />
      </TableCell>
      {columns.map((c, i) => (
        <TableCell
          key={c.key}
          className={cn(
            i < 2 ? "hidden sm:table-cell" : "hidden md:table-cell",
          )}
        >
          {renderCell(c.key)}
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
              colSpan={columnCount - 2}
              settings={settings}
              parentTitle={settings.showSubtaskParents ? task.title : undefined}
              locationLabel={locationLabel}
            />
          ))}
      </AnimatePresence>
    </>
  );
}

// The quiet second line under a task title: where the task lives, and which
// task it belongs to. Both are opt-in from the Customize view panel, so the
// row stays a single line unless you asked for more.
function RowContext({
  location,
  parentTitle,
}: {
  location?: string;
  parentTitle?: string;
}) {
  if (!location && !parentTitle) return null;
  return (
    <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
      {parentTitle && (
        <span className="min-w-0 max-w-full truncate">↳ {parentTitle}</span>
      )}
      {location && (
        <span className="min-w-0 max-w-full truncate">{location}</span>
      )}
    </span>
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
  settings,
  parentTitle,
  locationLabel,
}: {
  task: Doc<"tasks">;
  listId: Id<"lists">;
  statuses: Doc<"listStatuses">[];
  colSpan: number;
  settings: ViewSettings;
  parentTitle?: string;
  locationLabel?: string;
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
        <span className="flex min-w-0 flex-col pl-4">
          <span
            className={cn(
              "flex min-w-0 gap-2",
              settings.wrapText ? "flex-wrap items-start" : "items-center",
            )}
          >
            <Link
              href={taskPeekHref(searchParams, task._id)}
              scroll={false}
              className={cn(
                "min-w-0 text-xs hover:underline",
                settings.wrapText ? "break-words" : "truncate",
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
          <RowContext location={locationLabel} parentTitle={parentTitle} />
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
