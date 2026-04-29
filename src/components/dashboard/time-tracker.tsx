"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Pause, Play, Trash2 } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { formatDuration, formatDurationCoarse } from "@/lib/duration";
import { cn } from "@/lib/utils";

export function TimeTracker({ taskId }: { taskId: Id<"tasks"> }) {
  const entries = useQuery(api.timeEntries.listForTask, { taskId });
  const running = useQuery(api.timeEntries.runningForCurrent, {});
  const start = useMutation(api.timeEntries.start);
  const stop = useMutation(api.timeEntries.stop);

  if (entries === undefined || running === undefined) {
    return <div className="h-12 animate-pulse rounded-3xl bg-muted/40" />;
  }

  const myRunningOnThisTask =
    running && running.taskId === taskId ? running : null;
  const total = entries.reduce((sum, e) => {
    if (e.endedAt && e.durationMs) return sum + e.durationMs;
    if (!e.endedAt) return sum + (Date.now() - e.startedAt);
    return sum;
  }, 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 rounded-3xl border border-border bg-background p-3 sm:flex-row sm:items-center">
        {myRunningOnThisTask ? (
          <RunningPanel
            entry={myRunningOnThisTask}
            onStop={() => stop({})}
          />
        ) : (
          <>
            <span className="text-xs text-muted-foreground">
              Total tracked: {formatDurationCoarse(total)}
            </span>
            <Button
              type="button"
              size="sm"
              className="ml-auto"
              onClick={() => start({ taskId })}
            >
              <Play className="h-3.5 w-3.5" /> Start timer
            </Button>
          </>
        )}
      </div>

      {entries.length > 0 && (
        <ul className="space-y-1">
          {entries.map((entry) => (
            <EntryRow key={entry._id} entry={entry} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RunningPanel({
  entry,
  onStop,
}: {
  entry: Doc<"timeEntries">;
  onStop: () => void;
}) {
  const ms = useElapsed(entry.startedAt);
  return (
    <>
      <span className="inline-flex items-center gap-2 text-sm">
        <span
          aria-hidden
          className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500"
        />
        Running — {formatDuration(ms)}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="ml-auto"
        onClick={onStop}
      >
        <Pause className="h-3.5 w-3.5" /> Stop
      </Button>
    </>
  );
}

function EntryRow({ entry }: { entry: Doc<"timeEntries"> }) {
  const update = useMutation(api.timeEntries.update);
  const remove = useMutation(api.timeEntries.remove);
  const [description, setDescription] = useState(entry.description ?? "");
  const ms = entry.endedAt
    ? entry.durationMs ?? entry.endedAt - entry.startedAt
    : Date.now() - entry.startedAt;

  return (
    <li
      className={cn(
        "flex flex-col gap-2 rounded-2xl border border-border bg-background p-2 sm:flex-row sm:items-center",
        !entry.endedAt && "border-red-300/50",
      )}
    >
      <span className="text-xs text-muted-foreground sm:w-24">
        {formatDuration(ms)}
      </span>
      <input
        type="text"
        value={description}
        placeholder="What were you doing?"
        onChange={(e) => setDescription(e.currentTarget.value)}
        onBlur={() => {
          if (description !== (entry.description ?? "")) {
            update({ entryId: entry._id, description });
          }
        }}
        className="flex-1 rounded-full bg-transparent px-2 py-1 text-sm focus:bg-muted focus:outline-none"
      />
      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={entry.billable}
          onChange={(e) =>
            update({ entryId: entry._id, billable: e.currentTarget.checked })
          }
        />
        Billable
      </label>
      <button
        type="button"
        aria-label="Delete entry"
        onClick={() => {
          if (window.confirm("Delete this entry?")) {
            remove({ entryId: entry._id });
          }
        }}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

function useElapsed(startedAt: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, now - startedAt);
}
