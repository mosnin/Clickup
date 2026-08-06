import { cn } from "@/lib/utils";

// One stacked lozenge in a column. `color` is a CSS color string — callers pass
// token references (var(--color-signal-lime) etc.) so the chart renders
// identically in both themes without this file knowing which palette is live.
export type StackSegment = { value: number; color: string };

// Segments below this height stop reading as lozenges and start reading as
// rendering artifacts; a present-but-small value must never vanish.
const MIN_SEGMENT_PX = 4;

export function StackedColumns({
  items,
  height = 128,
  className,
}: {
  items: { label: string; segments: StackSegment[] }[];
  height?: number;
  className?: string;
}) {
  // Every column scales against the LARGEST column total, not its own — a
  // per-column scale would make every stack full-height and the comparison
  // between columns (the whole point of the chart) would be gone.
  const maxTotal = Math.max(
    0,
    ...items.map((item) =>
      item.segments.reduce((sum, s) => sum + Math.max(0, s.value), 0),
    ),
  );

  return (
    <div className={cn("flex min-w-0 items-end justify-between gap-2", className)}>
      {items.map((item, i) => {
        const segments = item.segments.filter((s) => s.value > 0);
        const total = segments.reduce((sum, s) => sum + s.value, 0);
        // maxTotal === 0 covers the all-zero dataset: every column takes the
        // empty state rather than dividing by zero.
        const empty = total <= 0 || maxTotal <= 0;

        return (
          <div key={i} className="flex min-w-0 flex-1 flex-col items-center">
            <div
              className="flex w-3.5 flex-col-reverse justify-start gap-[3px]"
              style={{ height }}
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
            <div className="mt-2 max-w-full truncate text-[10px] text-muted-foreground">
              {item.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}
