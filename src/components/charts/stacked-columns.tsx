"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// One stacked lozenge in a column. `color` is a CSS color string — callers pass
// token references (var(--color-signal-lime) etc.) so the chart renders
// identically in both themes without this file knowing which palette is live.
export type StackSegment = { value: number; color: string };

// Segments below this height stop reading as lozenges and start reading as
// rendering artifacts; a present-but-small value must never vanish.
const MIN_SEGMENT_PX = 4;

// `gap-2`, stated in px rather than read off the DOM — the fit math below
// runs before layout, from a single measured container width.
const GAP_PX = 8;

// Below this a column's label cannot say six characters ("Onb..." was the
// abbreviation the caller already commits to), so rather than let flex keep
// dividing the row evenly into ever-thinner slivers, the column itself drops
// out.
const MIN_COLUMN_PX = 40;

// Fixed width reserved for the trailing "+N more" text when some columns are
// dropped — it is not a column and does not compete for the per-column
// minimum the way a real one does.
const TAIL_PX = 48;

/**
 * How many of `count` equal-width flex columns fit `width` px without any
 * one of them going below `MIN_COLUMN_PX`. `reserveTail` carves out room for
 * the "+N more" text first, since dropping columns only helps if there is
 * still somewhere to say how many were dropped.
 */
function maxColumnsFor(
  width: number,
  count: number,
  reserveTail: boolean,
): number {
  if (width <= 0 || count <= 0) return count;
  const budget = reserveTail ? width - TAIL_PX - GAP_PX : width;
  if (budget <= 0) return 1;
  const fit = Math.floor((budget + GAP_PX) / (MIN_COLUMN_PX + GAP_PX));
  return Math.max(1, Math.min(count, fit));
}

export function StackedColumns({
  items,
  height = 128,
  className,
}: {
  items: { label: string; segments: StackSegment[] }[];
  height?: number;
  className?: string;
}) {
  // Columns grow out of the baseline on arrival, left to right — the
  // `.grow-col` transition in globals, staggered per column through the
  // `--grow-delay` var, cut entirely under reduced motion.
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Every column scales against the LARGEST column total, not its own — a
  // per-column scale would make every stack full-height and the comparison
  // between columns (the whole point of the chart) would be gone. This reads
  // over every item, including any that end up hidden below, so the bars that
  // do render never rescale just because the box got narrower.
  const maxTotal = Math.max(
    0,
    ...items.map((item) =>
      item.segments.reduce((sum, s) => sum + Math.max(0, s.value), 0),
    ),
  );

  // Cap the column count before flex gets a chance to squeeze every label
  // into a fragment. Dropping the smallest-total columns first keeps the
  // columns that matter most to the comparison the chart exists to make.
  const fitsAll = maxColumnsFor(width, items.length, false) >= items.length;
  const allowed = fitsAll
    ? items.length
    : maxColumnsFor(width, items.length, true);
  const hiddenCount = items.length - allowed;

  const indexed = items.map((item, i) => ({
    item,
    i,
    total: item.segments.reduce((sum, s) => sum + Math.max(0, s.value), 0),
  }));
  const kept =
    hiddenCount > 0
      ? [...indexed].sort((a, b) => b.total - a.total).slice(0, allowed)
      : indexed;
  kept.sort((a, b) => a.i - b.i);

  return (
    <div
      ref={rootRef}
      className={cn("flex min-w-0 items-end justify-between gap-2", className)}
    >
      {kept.map(({ item, i }) => {
        const segments = item.segments.filter((s) => s.value > 0);
        const total = segments.reduce((sum, s) => sum + s.value, 0);
        // maxTotal === 0 covers the all-zero dataset: every column takes the
        // empty state rather than dividing by zero.
        const empty = total <= 0 || maxTotal <= 0;

        return (
          <div key={i} className="flex min-w-0 flex-1 flex-col items-center">
            <div
              className={cn(
                "grow-col flex w-3.5 flex-col-reverse justify-start gap-[3px]",
                grown && "grow-col-on",
              )}
              style={{ height, "--grow-delay": `${i * 55}ms` } as React.CSSProperties}
            >
              {empty ? (
                // A measured-and-empty slot gets a muted dot; an absent bar
                // would read as missing data, which is a different claim.
                <div
                  className="w-full rounded-full"
                  style={{
                    height: MIN_SEGMENT_PX,
                    backgroundColor: "var(--color-muted)",
                  }}
                />
              ) : (
                segments.map((s, j) => (
                  <div
                    key={j}
                    className="w-full rounded-full"
                    style={{
                      height: Math.max(
                        MIN_SEGMENT_PX,
                        (s.value / maxTotal) * height,
                      ),
                      backgroundColor: s.color,
                    }}
                  />
                ))
              )}
            </div>
            <div
              className="mt-2 max-w-full truncate text-[10px] text-muted-foreground"
              title={item.label}
            >
              {item.label}
            </div>
          </div>
        );
      })}
      {hiddenCount > 0 && (
        <div
          className="flex shrink-0 flex-col items-center justify-end"
          style={{ height }}
        >
          <div
            className="mt-2 shrink-0 whitespace-nowrap text-[10px] text-muted-foreground"
            title={`${hiddenCount} more`}
          >
            +{hiddenCount} more
          </div>
        </div>
      )}
    </div>
  );
}
