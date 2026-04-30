"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/dashboard/toast";
import { cn } from "@/lib/utils";

// Weekly timesheet. The week is Mon→Sun in local time; Monday-of-week
// is encoded as `?week=YYYY-MM-DD` so URLs are bookmarkable. Empty
// param defaults to the current week.

type Entry = Doc<"timeEntries"> & {
  taskTitle: string;
  listId: Id<"lists"> | null;
  taskDeleted: boolean;
};

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function startOfWeek(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  // Monday = 1, Sunday = 0. Shift back to Mon.
  const day = out.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  out.setDate(out.getDate() + diff);
  return out;
}

function parseWeekParam(week: string | undefined): Date {
  if (week && /^\d{4}-\d{2}-\d{2}$/.test(week)) {
    const [y, m, d] = week.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    if (!isNaN(dt.getTime())) return startOfWeek(dt);
  }
  return startOfWeek(new Date());
}

function formatWeekParam(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}

function fmtMs(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalMinutes = Math.round(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

function fmtHours(ms: number): string {
  if (ms <= 0) return "0h";
  const hours = ms / 3600000;
  return `${hours.toFixed(1)}h`;
}

function fmtDateTimeLocal(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${mo}-${da}T${h}:${mi}`;
}

export function Timesheet({ initialWeek }: { initialWeek?: string }) {
  const router = useRouter();
  const monday = parseWeekParam(initialWeek);
  const sundayEnd = endOfDay(addDays(monday, 6));
  const from = monday.getTime();
  const to = sundayEnd.getTime() + 1; // exclusive

  const entries = useQuery(api.timeEntries.listForUserInRange, { from, to });

  const days = useMemo(() => {
    const arr: { date: Date; entries: Entry[] }[] = [];
    for (let i = 0; i < 7; i++) {
      arr.push({ date: addDays(monday, i), entries: [] });
    }
    for (const e of (entries ?? []) as Entry[]) {
      const startedAtDay = new Date(e.startedAt);
      const idx = Math.floor(
        (startedAtDay.getTime() - monday.getTime()) / 86400000,
      );
      if (idx >= 0 && idx < 7) arr[idx].entries.push(e);
    }
    return arr;
    // monday is reconstructed each render but its time is stable for
    // the same `initialWeek` — depend on initialWeek, not the Date.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, initialWeek]);

  const totals = useMemo(() => {
    const byDay = days.map((d) =>
      d.entries.reduce((acc, e) => acc + (e.durationMs ?? 0), 0),
    );
    const week = byDay.reduce((a, b) => a + b, 0);
    const billable = (entries ?? []).reduce(
      (acc, e) => acc + (e.billable ? e.durationMs ?? 0 : 0),
      0,
    );
    return { byDay, week, billable };
  }, [days, entries]);

  const [adding, setAdding] = useState(false);

  function navWeek(deltaDays: number) {
    const next = addDays(monday, deltaDays);
    router.push(`/dashboard/time?week=${formatWeekParam(next)}`);
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Time
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Week of {monday.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous week"
            onClick={() => navWeek(-7)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background hover:bg-muted"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => router.push("/dashboard/time")}
            className="rounded-full border border-border bg-background px-3 py-1 text-xs hover:bg-muted"
          >
            This week
          </button>
          <button
            type="button"
            aria-label="Next week"
            onClick={() => navWeek(7)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background hover:bg-muted"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <Button
            type="button"
            size="sm"
            onClick={() => setAdding(true)}
          >
            <Plus className="h-4 w-4" />
            Add entry
          </Button>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-9">
        {days.map((d, i) => (
          <DayTotal key={i} label={DAY_LABELS[i]} date={d.date} ms={totals.byDay[i]} />
        ))}
        <SummaryTotal label="Week" ms={totals.week} highlight />
        <SummaryTotal label="Billable" ms={totals.billable} />
      </section>

      {adding && (
        <AddEntryForm
          weekStart={monday}
          onClose={() => setAdding(false)}
        />
      )}

      <section className="space-y-4">
        {entries === undefined ? (
          <div className="h-32 animate-pulse rounded-3xl bg-muted/40" />
        ) : entries.length === 0 ? (
          <div className="rounded-3xl border border-border bg-muted/30 p-10 text-center text-sm text-muted-foreground">
            No time logged this week. Start a timer on a task or add an entry above.
          </div>
        ) : (
          days.map((d, i) =>
            d.entries.length === 0 ? null : (
              <DaySection
                key={i}
                label={DAY_LABELS[i]}
                date={d.date}
                entries={d.entries}
              />
            ),
          )
        )}
      </section>
    </div>
  );
}

function DayTotal({
  label,
  date,
  ms,
}: {
  label: string;
  date: Date;
  ms: number;
}) {
  const empty = ms === 0;
  return (
    <div
      className={cn(
        "rounded-2xl border p-3 text-sm",
        empty ? "border-border bg-muted/20" : "border-brand-200 bg-brand-50",
      )}
    >
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label} {date.getDate()}
      </p>
      <p
        className={cn(
          "mt-1 text-base font-semibold",
          empty ? "text-muted-foreground" : "text-brand-700",
        )}
      >
        {fmtHours(ms)}
      </p>
    </div>
  );
}

function SummaryTotal({
  label,
  ms,
  highlight,
}: {
  label: string;
  ms: number;
  highlight?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border p-3 text-sm",
        highlight
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-background",
      )}
    >
      <p
        className={cn(
          "text-[10px] font-semibold uppercase tracking-wider",
          highlight ? "text-background/70" : "text-muted-foreground",
        )}
      >
        {label}
      </p>
      <p className="mt-1 text-base font-semibold">{fmtHours(ms)}</p>
    </div>
  );
}

function DaySection({
  label,
  date,
  entries,
}: {
  label: string;
  date: Date;
  entries: Entry[];
}) {
  const total = entries.reduce((a, e) => a + (e.durationMs ?? 0), 0);
  return (
    <div className="rounded-3xl border border-border bg-background">
      <header className="flex items-center justify-between border-b border-border px-4 py-2.5 text-sm">
        <span className="font-medium">
          {label}{" "}
          <span className="text-muted-foreground">
            ·{" "}
            {date.toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
          </span>
        </span>
        <span className="text-xs text-muted-foreground">
          {fmtHours(total)}
        </span>
      </header>
      <ul className="divide-y divide-border">
        {entries.map((e) => (
          <EntryRow key={e._id} entry={e} />
        ))}
      </ul>
    </div>
  );
}

function EntryRow({ entry }: { entry: Entry }) {
  const update = useMutation(api.timeEntries.update);
  const remove = useMutation(api.timeEntries.remove);
  const toast = useToast();

  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState(fmtDateTimeLocal(entry.startedAt));
  const [end, setEnd] = useState(
    entry.endedAt ? fmtDateTimeLocal(entry.endedAt) : "",
  );
  const [description, setDescription] = useState(entry.description ?? "");
  const [billable, setBillable] = useState(entry.billable);
  const [pending, setPending] = useState(false);

  const isRunning = entry.endedAt === undefined;
  const duration = entry.durationMs ?? Date.now() - entry.startedAt;

  async function save() {
    setPending(true);
    try {
      const startedAt = new Date(start).getTime();
      const endedAt = end ? new Date(end).getTime() : undefined;
      await update({
        entryId: entry._id,
        startedAt,
        ...(endedAt !== undefined ? { endedAt } : {}),
        description: description.trim(),
        billable,
      });
      setEditing(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to save entry");
    } finally {
      setPending(false);
    }
  }

  async function del() {
    if (!confirm("Delete this entry?")) return;
    await remove({ entryId: entry._id });
    toast.show({ label: "Entry deleted" });
  }

  if (editing) {
    return (
      <li className="space-y-2 px-4 py-3 text-sm">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs">
            <span className="text-muted-foreground">Start</span>
            <input
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.currentTarget.value)}
              className="mt-1 w-full rounded-full border border-border bg-background px-3 py-1.5"
            />
          </label>
          <label className="text-xs">
            <span className="text-muted-foreground">End</span>
            <input
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.currentTarget.value)}
              className="mt-1 w-full rounded-full border border-border bg-background px-3 py-1.5"
              disabled={isRunning}
              placeholder={isRunning ? "Still running" : ""}
            />
          </label>
        </div>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          placeholder="What did you work on?"
          className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
        />
        <div className="flex items-center justify-between gap-2">
          <label className="inline-flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={billable}
              onChange={(e) => setBillable(e.currentTarget.checked)}
              className="h-3.5 w-3.5 accent-brand-600"
            />
            Billable
          </label>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setEditing(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={save}
              disabled={pending}
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-center gap-3 px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="block w-full truncate text-left font-medium hover:underline"
        >
          {entry.taskTitle}
          {entry.taskDeleted && (
            <span className="ml-2 text-xs text-muted-foreground">
              (deleted)
            </span>
          )}
        </button>
        {entry.description ? (
          <p className="truncate text-xs text-muted-foreground">
            {entry.description}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {new Date(entry.startedAt).toLocaleTimeString(undefined, {
            hour: "numeric",
            minute: "2-digit",
          })}
          {" – "}
          {entry.endedAt
            ? new Date(entry.endedAt).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })
            : "running"}
          {entry.billable && (
            <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 px-1.5 text-[10px] font-medium text-amber-800">
              billable
            </span>
          )}
        </p>
      </div>
      {entry.listId && !entry.taskDeleted && (
        <Link
          href={`/dashboard/l/${entry.listId}/t/${entry.taskId}`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Open
        </Link>
      )}
      <span
        className={cn(
          "rounded-full px-2 py-0.5 font-mono text-xs tabular-nums",
          isRunning
            ? "bg-emerald-100 text-emerald-700"
            : "bg-muted text-foreground",
        )}
      >
        {fmtMs(duration)}
      </span>
      <button
        type="button"
        aria-label="Delete entry"
        onClick={del}
        className="text-muted-foreground hover:text-foreground"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

function AddEntryForm({
  weekStart,
  onClose,
}: {
  weekStart: Date;
  onClose: () => void;
}) {
  const manualCreate = useMutation(api.timeEntries.manualCreate);
  const [taskQuery, setTaskQuery] = useState("");
  const [pickedTask, setPickedTask] = useState<{
    id: Id<"tasks">;
    title: string;
  } | null>(null);
  // Default to today (or the week's Friday if today is outside the
  // displayed week — keeps the form useful on history pages).
  const defaultDate = useMemo(() => {
    const today = new Date();
    if (today >= weekStart && today.getTime() - weekStart.getTime() < 7 * 86400000) {
      return today;
    }
    return new Date(weekStart.getTime() + 4 * 86400000); // Friday
  }, [weekStart]);
  const [start, setStart] = useState(() => {
    const d = new Date(defaultDate);
    d.setHours(9, 0, 0, 0);
    return fmtDateTimeLocal(d.getTime());
  });
  const [end, setEnd] = useState(() => {
    const d = new Date(defaultDate);
    d.setHours(10, 0, 0, 0);
    return fmtDateTimeLocal(d.getTime());
  });
  const [description, setDescription] = useState("");
  const [billable, setBillable] = useState(false);
  const [pending, setPending] = useState(false);

  const palette = useQuery(
    api.search.palette,
    taskQuery.trim().length >= 2 ? { q: taskQuery, limit: 8 } : "skip",
  );
  const taskHits =
    palette?.filter((h): h is Extract<typeof h, { kind: "task" }> => h.kind === "task") ?? [];

  async function submit() {
    if (!pickedTask || pending) return;
    setPending(true);
    try {
      const startedAt = new Date(start).getTime();
      const endedAt = new Date(end).getTime();
      await manualCreate({
        taskId: pickedTask.id,
        startedAt,
        endedAt,
        description: description.trim() || undefined,
        billable,
      });
      onClose();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to add entry");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-3xl border border-border bg-background p-4">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Log time</h2>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </header>
      <div className="space-y-3">
        {pickedTask ? (
          <div className="flex items-center justify-between rounded-2xl border border-border bg-muted/30 px-3 py-2 text-sm">
            <span className="truncate">{pickedTask.title}</span>
            <button
              type="button"
              onClick={() => {
                setPickedTask(null);
                setTaskQuery("");
              }}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Change
            </button>
          </div>
        ) : (
          <div>
            <label className="flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                value={taskQuery}
                onChange={(e) => setTaskQuery(e.currentTarget.value)}
                placeholder="Search a task to log time on…"
                className="flex-1 bg-transparent text-sm focus:outline-none"
              />
            </label>
            {taskHits.length > 0 && (
              <ul className="mt-2 max-h-48 overflow-y-auto rounded-2xl border border-border bg-background">
                {taskHits.map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      onClick={() =>
                        setPickedTask({ id: h.id, title: h.title })
                      }
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-muted"
                    >
                      {h.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs">
            <span className="text-muted-foreground">Start</span>
            <input
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.currentTarget.value)}
              className="mt-1 w-full rounded-full border border-border bg-background px-3 py-1.5"
            />
          </label>
          <label className="text-xs">
            <span className="text-muted-foreground">End</span>
            <input
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.currentTarget.value)}
              className="mt-1 w-full rounded-full border border-border bg-background px-3 py-1.5"
            />
          </label>
        </div>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          placeholder="What did you work on? (optional)"
          className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
        />
        <div className="flex items-center justify-between">
          <label className="inline-flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={billable}
              onChange={(e) => setBillable(e.currentTarget.checked)}
              className="h-3.5 w-3.5 accent-brand-600"
            />
            Billable
          </label>
          <Button
            type="button"
            size="sm"
            onClick={submit}
            disabled={!pickedTask || pending}
          >
            {pending ? "Saving…" : "Add entry"}
          </Button>
        </div>
      </div>
    </section>
  );
}
