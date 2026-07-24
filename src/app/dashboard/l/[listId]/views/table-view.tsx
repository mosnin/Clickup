"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { CustomFieldInput } from "@/components/dashboard/custom-field-input";
import { TaskBadges } from "@/components/dashboard/task-badges";
import { taskPeekHref } from "@/components/dashboard/task-peek";
import {
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  type TaskPriority,
} from "@/components/dashboard/priority";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/errors";
import { identityFill } from "@/lib/identity-color";
import { fromDateInputValue, toDateInputValue } from "@/lib/dates";
import { parseQuickAdd } from "@/lib/quick-add";
import { QuickAddChips } from "@/components/dashboard/quick-add-chips";
import { EASE, motion } from "@/components/motion";
import { useToast } from "@/components/toast";
import {
  BUILTIN_FIELDS,
  DEFAULT_BUILTIN_FIELDS,
  DEFAULT_VIEW_SETTINGS,
  isBuiltinFieldKey,
  type ViewSettings,
} from "@/lib/view-settings";

// Dense spreadsheet-style TABLE view — the power-user surface. Every cell is
// directly editable in place; the header row sorts client-side. This mirrors
// ListView's data flow (same tasks/statuses/fields props, same optimistic
// toggleComplete + inline soft-field editors) but trades ListView's mobile
// affordances for maximum information density.
//
// Columns come from the same Customize-view contract ListView reads
// (src/lib/view-settings.ts): the list page resolves `visibleFields` with
// resolveVisibleFields() and this view renders exactly those keys, in that
// order — so turning a column off in the panel turns it off in both views.
// `settings.wrapText` is honored the same way too.
//
// Renders on the vendored Square shell's Table/Card primitives (Phase H);
// the sort/edit logic underneath is unchanged.

type SortKey = "title" | "status" | "priority" | "due" | "points";

// The visible-field keys that can also be sorted on. Assignees and custom
// fields render a plain header — there's no single stable ordering for them.
const SORTABLE: Record<string, SortKey> = {
  status: "status",
  priority: "priority",
  due: "due",
  points: "points",
};

// Per-column widths, so a table with a custom field set still lays out
// predictably instead of collapsing to content width.
const COLUMN_WIDTH: Record<string, string> = {
  status: "min-w-[140px]",
  priority: "min-w-[120px]",
  assignees: "min-w-[160px]",
  due: "min-w-[120px]",
  points: "min-w-[90px]",
};

function columnWidth(key: string): string {
  return COLUMN_WIDTH[key] ?? "min-w-[140px]";
}

// Vendored TableRow's own class string, applied by hand to the body rows
// because those rows are `motion.tr` (framer-motion needs the real DOM
// element for the entrance animation, not the TableRow wrapper component).
const BODY_ROW_CLASS =
  "hover:bg-muted/50 data-[state=selected]:bg-muted border-b transition-colors align-middle";

export function TableView({
  listId,
  tasks,
  statuses,
  fields,
  settings = DEFAULT_VIEW_SETTINGS,
  visibleFields,
}: {
  listId: Id<"lists">;
  tasks: Doc<"tasks">[];
  statuses: Doc<"listStatuses">[];
  fields: Doc<"customFields">[];
  /** Customize-view settings (currently: wrapText). */
  settings?: ViewSettings;
  /** Ordered visible field keys — resolved by the list page. */
  visibleFields?: string[];
}) {
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const columns = useMemo(
    () =>
      (visibleFields ?? [...DEFAULT_BUILTIN_FIELDS]).map((key) => ({
        key,
        label: isBuiltinFieldKey(key)
          ? (BUILTIN_FIELDS.find((f) => f.key === key)?.label ?? key)
          : (fields.find((f) => f._id === key)?.name ?? "Field"),
      })),
    [visibleFields, fields],
  );
  // The two fixed columns every row carries: the completion toggle and the
  // title. Everything after them is customizable.
  const columnCount = columns.length + 2;

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

  return (
    <Card className="gap-0 overflow-hidden rounded-2xl py-0">
      <CardContent className="px-0 py-0">
        <div className="overflow-x-auto overscroll-x-contain">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className="w-10"></TableHead>
                <SortHeader
                  label="Title"
                  sortKey="title"
                  active={sortKey}
                  dir={sortDir}
                  onClick={toggleSort}
                  className="min-w-[220px]"
                />
                {columns.map((c) =>
                  SORTABLE[c.key] ? (
                    <SortHeader
                      key={c.key}
                      label={c.label}
                      sortKey={SORTABLE[c.key]}
                      active={sortKey}
                      dir={sortDir}
                      onClick={toggleSort}
                      className={cn(
                        columnWidth(c.key),
                        c.key === "points" && "text-right",
                      )}
                    />
                  ) : (
                    <TableHead
                      scope="col"
                      key={c.key}
                      className={cn(
                        columnWidth(c.key),
                        "text-xs uppercase tracking-wider text-muted-foreground",
                      )}
                    >
                      {c.label}
                    </TableHead>
                  ),
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={columnCount}
                    className="whitespace-normal py-14 text-center text-sm text-muted-foreground"
                  >
                    Nothing here yet. Add the first task below.
                  </TableCell>
                </TableRow>
              )}
              {sorted.map((task, i) => (
                <TableRowContent
                  key={task._id}
                  task={task}
                  listId={listId}
                  statuses={statuses}
                  fields={fields}
                  columns={columns}
                  wrap={settings.wrapText}
                  index={i}
                />
              ))}
            </TableBody>
          </Table>
        </div>
        <AddTaskRow listId={listId} />
        <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          {tasks.length} task{tasks.length === 1 ? "" : "s"}
        </div>
      </CardContent>
    </Card>
  );
}

// Bottom in-place create row, mirroring ListView's NewTaskRow so Table is as
// writable as List instead of sending users elsewhere to add a task.
function AddTaskRow({ listId }: { listId: Id<"lists"> }) {
  const [title, setTitle] = useState("");
  const create = useMutation(api.tasks.create);
  const { toast } = useToast();
  const [pending, setPending] = useState(false);
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
      toast(msg || "Couldn't add task", { kind: "error" });
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
    <TableHead scope="col" className={className}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => onClick(sortKey)}
        className={cn(
          "h-auto gap-1 px-2 py-1 text-xs uppercase tracking-wider hover:bg-accent/60",
          isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {label}
        {isActive &&
          (dir === "asc" ? (
            <ArrowUp className="h-3 w-3" aria-hidden />
          ) : (
            <ArrowDown className="h-3 w-3" aria-hidden />
          ))}
      </Button>
    </TableHead>
  );
}

function TableRowContent({
  task,
  listId,
  statuses,
  fields,
  columns,
  wrap,
  index,
}: {
  task: Doc<"tasks">;
  listId: Id<"lists">;
  statuses: Doc<"listStatuses">[];
  fields: Doc<"customFields">[];
  columns: { key: string; label: string }[];
  wrap: boolean;
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
  const currentUser = useQuery(api.users.current, {});
  const { toast } = useToast();

  const values = useQuery(api.taskFieldValues.listForTask, {
    taskId: task._id,
  });
  // Rollup/formula results and vote counts are derived per read; only
  // fetched when the list actually defines one of those types.
  const computed = useQuery(
    api.taskFieldValues.computedForTask,
    fields.some(
      (f) => f.type === "rollup" || f.type === "formula" || f.type === "voting",
    )
      ? { taskId: task._id }
      : "skip",
  );
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

  const byId = useMemo(
    () => new Map((assignable ?? []).map((a) => [a.id, a])),
    [assignable],
  );

  // One cell per visible field key, in the order the Customize panel asked
  // for. Same key vocabulary ListView renders, same editors Table always had.
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
              toast(errorMessage(err, "Couldn't update status"), {
                kind: "error",
              });
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
    if (key === "assignees") {
      return <AssigneeStack ids={task.assigneeClerkIds} byId={byId} />;
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
    if (key === "points") {
      return <PointsCell task={task} />;
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
    <motion.tr
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.3,
        ease: EASE,
        delay: Math.min(index * 0.02, 0.24),
      }}
      className={BODY_ROW_CLASS}
    >
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
        <TitleCell task={task} isDone={isDone} wrap={wrap} />
      </TableCell>
      {columns.map((c) => (
        <TableCell
          key={c.key}
          className={cn(
            wrap && "whitespace-normal",
            c.key === "points" && "text-right",
          )}
        >
          {renderCell(c.key)}
        </TableCell>
      ))}
    </motion.tr>
  );
}

// Single click opens the task peek; double-click swaps to a rename input.
// A single click is deferred behind a short timer so a second click (a
// double-click) can cancel the navigation and enter edit mode instead —
// otherwise the first click of any double-click would already have
// navigated away before the dblclick event fires.
function TitleCell({
  task,
  isDone,
  wrap,
}: {
  task: Doc<"tasks">;
  isDone: boolean;
  wrap: boolean;
}) {
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
      <Input
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
        className="h-8 w-full text-sm"
      />
    );
  }

  return (
    <span
      className={cn(
        "flex min-w-0",
        wrap ? "flex-wrap items-start" : "items-center",
      )}
    >
      {task.milestone && (
        <span
          aria-hidden
          title="Milestone"
          className="mr-1.5 inline-block h-2 w-2 flex-shrink-0 rotate-45 border border-foreground/60"
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
          "min-w-0 cursor-pointer hover:underline",
          wrap ? "break-words" : "truncate",
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
    <Input
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
      className="h-8 w-16 text-right text-xs"
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
            style={identityFill(id)}
            className={cn(
              "inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-medium text-white ring-2 ring-background",
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
