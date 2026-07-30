"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { useSetPanelWatch } from "@/components/dashboard/panel-memory";
import {
  DEFAULT_WATCH,
  WATCH_VOCABULARY,
  describeWatchIntent,
  isMovementOp,
  normalizeWatch,
  type Watch,
  type WatchOp,
} from "@/lib/panel-memory";
import { cn } from "@/lib/utils";

// Ask a panel to keep an eye on itself.
//
// The alternative everywhere else is an alerts system: a separate place where
// you configure conditions, and a separate place where they arrive, neither of
// which is the panel that would have explained it. Here the condition belongs
// to the panel and fires on the panel — you set it while looking at the number
// it is about, and when it trips, it trips where you already look.
//
// Deliberately six operators and one threshold. A condition language rich
// enough to express anything is a condition language nobody writes; these six
// cover what people actually ask for, and each reads as a sentence rather than
// as a predicate.

const LABELS: Record<WatchOp, string> = {
  above: "goes over",
  below: "drops under",
  equals: "hits",
  changes: "moves at all",
  rises: "goes up",
  falls: "goes down",
};

export function WatchControl({ panelId }: { panelId: string }) {
  const remote = useQuery(api.appearance.forCurrentUser, {});
  const setWatch = useSetPanelWatch();

  const watch = useMemo<Watch | null>(() => {
    if (!remote) return null;
    return normalizeWatch((remote.panelWatches ?? {})[panelId]);
  }, [remote, panelId]);

  const update = (next: Watch | null) => setWatch(panelId, next);

  return (
    <section>
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Keep an eye on it
        </span>
        {watch && (
          <button
            type="button"
            onClick={() => update(null)}
            className="text-[10px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            Stop
          </button>
        )}
      </span>

      <div className="mt-2 grid grid-cols-2 gap-1.5">
        {WATCH_VOCABULARY.ops.map((op) => {
          const selected = watch?.op === op;
          return (
            <button
              key={op}
              type="button"
              aria-pressed={selected}
              onClick={() =>
                update(
                  selected
                    ? null
                    : { ...(watch ?? DEFAULT_WATCH), op },
                )
              }
              className={cn(
                "rounded-lg px-2 py-1.5 text-left text-[11px] transition-all",
                selected
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              {LABELS[op]}
            </button>
          );
        })}
      </div>

      {/* The threshold only exists for the operators that compare against one.
          Showing a number field beside "moves at all" is offering a control
          that does nothing. */}
      {watch && !isMovementOp(watch.op) && (
        <label className="mt-2 flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">Number</span>
          <input
            type="number"
            value={watch.threshold}
            onChange={(e) =>
              update({
                ...watch,
                threshold: Number.parseFloat(e.currentTarget.value) || 0,
              })
            }
            className="soft-field w-20 px-2 py-1 text-xs tabular-nums"
          />
        </label>
      )}

      {watch && (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {describeWatchIntent(watch)}.{" "}
          {isMovementOp(watch.op)
            ? "Measured against what it showed you last time."
            : "Checked every time the panel is drawn."}
        </p>
      )}
    </section>
  );
}
