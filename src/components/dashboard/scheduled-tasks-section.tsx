"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { CalendarClock, Plus, Trash2 } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// List-settings section for time-based recurring tasks ("every Monday
// 09:00 UTC create X"). The cron in convex/crons.ts materializes them.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function describeSchedule(st: Doc<"scheduledTasks">): string {
  const at = `${String(st.hourUtc).padStart(2, "0")}:00 UTC`;
  if (st.cadence === "daily") return `Daily at ${at}`;
  if (st.cadence === "weekly") {
    return `Every ${WEEKDAYS[(st.dayOfWeek ?? 1) % 7]} at ${at}`;
  }
  return `Monthly on day ${st.dayOfMonth ?? 1} at ${at}`;
}

export function ScheduledTasksSection({ listId }: { listId: Id<"lists"> }) {
  const schedules = useQuery(api.scheduledTasks.listForList, { listId });
  const update = useMutation(api.scheduledTasks.update);
  const remove = useMutation(api.scheduledTasks.remove);
  const [creating, setCreating] = useState(false);

  return (
    <section>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Recurring schedules
        </h2>
        <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
          <Plus className="h-3.5 w-3.5" /> New schedule
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Time-based recurring tasks — created on a clock, unlike a task&apos;s
        Recurrence field which repeats on completion.
      </p>

      {creating && (
        <CreateScheduleForm listId={listId} onDone={() => setCreating(false)} />
      )}

      <ul className="mt-3 space-y-2">
        {(schedules ?? []).map((st) => (
          <li
            key={st._id}
            className="flex flex-wrap items-center gap-2 rounded-3xl border border-border bg-background px-4 py-2.5 text-sm"
          >
            <CalendarClock
              className="h-4 w-4 flex-shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate font-medium">
              {st.title}
            </span>
            <span className="text-xs text-muted-foreground">
              {describeSchedule(st)}
              {st.dueInDays !== undefined && ` · due in ${st.dueInDays}d`}
            </span>
            <button
              type="button"
              onClick={() => update({ scheduledTaskId: st._id, enabled: !st.enabled })}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-xs",
                st.enabled
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {st.enabled ? "Active" : "Paused"}
            </button>
            <button
              type="button"
              aria-label="Delete schedule"
              onClick={() => remove({ scheduledTaskId: st._id })}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-red-600"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
        {schedules !== undefined && schedules.length === 0 && !creating && (
          <li className="rounded-3xl border border-dashed border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
            No schedules yet.
          </li>
        )}
      </ul>
    </section>
  );
}

function CreateScheduleForm({
  listId,
  onDone,
}: {
  listId: Id<"lists">;
  onDone: () => void;
}) {
  const create = useMutation(api.scheduledTasks.create);
  const [title, setTitle] = useState("");
  const [cadence, setCadence] = useState<"daily" | "weekly" | "monthly">(
    "weekly",
  );
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [hourUtc, setHourUtc] = useState(9);
  const [dueInDays, setDueInDays] = useState("");

  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-3 rounded-3xl border border-border bg-background p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        await create({
          listId,
          title: title.trim(),
          cadence,
          dayOfWeek: cadence === "weekly" ? dayOfWeek : undefined,
          dayOfMonth: cadence === "monthly" ? dayOfMonth : undefined,
          hourUtc,
          dueInDays: dueInDays ? parseInt(dueInDays, 10) : undefined,
        });
        onDone();
      }}
    >
      <label className="block min-w-44 flex-1">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Task title
        </span>
        <input
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          placeholder="Weekly standup notes"
          autoFocus
          className="w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Repeats
        </span>
        <select
          value={cadence}
          onChange={(e) =>
            setCadence(e.currentTarget.value as typeof cadence)
          }
          className="rounded-full border border-border bg-background px-3 py-1.5 text-sm"
        >
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </select>
      </label>
      {cadence === "weekly" && (
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            On
          </span>
          <select
            value={dayOfWeek}
            onChange={(e) => setDayOfWeek(Number(e.currentTarget.value))}
            className="rounded-full border border-border bg-background px-3 py-1.5 text-sm"
          >
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        </label>
      )}
      {cadence === "monthly" && (
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Day of month
          </span>
          <input
            type="number"
            min={1}
            max={28}
            value={dayOfMonth}
            onChange={(e) => setDayOfMonth(Number(e.currentTarget.value))}
            className="w-20 rounded-full border border-border bg-background px-3 py-1.5 text-sm"
          />
        </label>
      )}
      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Hour (UTC)
        </span>
        <input
          type="number"
          min={0}
          max={23}
          value={hourUtc}
          onChange={(e) => setHourUtc(Number(e.currentTarget.value))}
          className="w-20 rounded-full border border-border bg-background px-3 py-1.5 text-sm"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Due in (days)
        </span>
        <input
          type="number"
          min={0}
          value={dueInDays}
          onChange={(e) => setDueInDays(e.currentTarget.value)}
          placeholder="—"
          className="w-20 rounded-full border border-border bg-background px-3 py-1.5 text-sm"
        />
      </label>
      <div className="flex gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!title.trim()}>
          Create
        </Button>
      </div>
    </form>
  );
}
