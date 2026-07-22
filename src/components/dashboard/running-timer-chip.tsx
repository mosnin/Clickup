"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Pause, Timer } from "lucide-react";
import { api } from "@convex/_generated/api";
import { formatDuration } from "@/lib/duration";

export function RunningTimerChip() {
  const running = useQuery(api.timeEntries.runningForCurrent, {});
  const stop = useMutation(api.timeEntries.stop);

  // We need the taskId on the running entry to render a list link, but
  // we'd also need the listId to construct a URL. Phase 6 sends users
  // to the task page via the task's listId; fetching that lazily.
  const task = useQuery(
    api.tasks.get,
    running ? { taskId: running.taskId } : "skip",
  );

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  if (!running) return null;

  const elapsed = now - running.startedAt;
  const href = task
    ? `/dashboard/l/${task.listId}/t/${task._id}`
    : "/dashboard";

  return (
    <div className="mb-3 rounded-2xl border border-red-300/40 bg-red-50/40 p-2 text-xs dark:border-red-800/40 dark:bg-red-950/40">
      <div className="flex items-center gap-2">
        <Timer className="h-3.5 w-3.5 text-red-600 dark:text-red-400" aria-hidden />
        <span className="font-medium text-red-700 dark:text-red-400">
          {formatDuration(elapsed)}
        </span>
        <button
          type="button"
          onClick={() => stop({})}
          aria-label="Stop timer"
          className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-full text-red-700 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-900/40"
        >
          <Pause className="h-3.5 w-3.5" />
        </button>
      </div>
      <Link
        href={href}
        className="mt-1 block truncate text-muted-foreground hover:text-foreground"
      >
        {task?.title ?? "Task"}
      </Link>
    </div>
  );
}
