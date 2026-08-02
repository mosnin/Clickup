"use client";

import { useMemo } from "react";

import { useChartStable } from "../chart-context";

// Zero is a fact, not a gap.
//
// A bar whose value is 0 has no height, and a rect with no height is nothing
// at all — so a fortnight with three quiet days came out as a white hole
// between columns. That reads as a chart that failed to load, not as three
// days when nothing happened, and the reader's next move is to distrust the
// whole panel rather than to learn something from it.
//
// The library already answers this for vertical bars: `<Bar minBarHeight>`
// floors a short or zero bar so it still sits on the baseline. It does not
// answer it for horizontal ones — the floor lives in the vertical branch of
// its geometry only — so this draws the same mark, the same size, in the same
// place, for bars that run across.
//
// It is a *mark*, not a bar: `ZERO_MARK_PX` is smaller than the smallest real
// value can render at, so it says "nothing here" rather than "a little here".
// The alternative — flooring the data — would be a lie the tooltip then
// contradicts.

/** The library's own default gap between grouped bars (`<Bar groupGap>`). */
const GROUP_GAP = 4;

export function HorizontalZeroMarks({
  /** Series columns in the same order they are handed to `<Bar>`. */
  dataKeys,
  /** Parallel to `dataKeys` — each series' fill. */
  fills,
  size,
}: {
  dataKeys: string[];
  fills: string[];
  size: number;
}) {
  const { data, barScale, bandWidth, barXAccessor, stacked } =
    useChartStable();

  const marks = useMemo(() => {
    if (!(barScale && bandWidth && barXAccessor) || dataKeys.length === 0) {
      return [];
    }
    // Mirrors `<Bar>`'s own layout. Duplicated because there is no prop to ask
    // for it; if upstream re-spaces grouped bars this drifts, which is a mark
    // a few pixels off its row rather than a wrong number.
    const count = dataKeys.length;
    const gap = count > 1 ? GROUP_GAP : 0;
    const thickness = stacked
      ? bandWidth
      : (bandWidth - gap * (count - 1)) / count;

    return data.flatMap((row, rowIndex) => {
      const band = barScale(barXAccessor(row));
      if (band == null || !Number.isFinite(band)) return [];
      return dataKeys.flatMap((key, seriesIndex) => {
        const value = row[key];
        if (typeof value !== "number" || value !== 0) return [];
        return [
          {
            key: `${rowIndex}-${key}`,
            y: stacked ? band : band + seriesIndex * (thickness + gap),
            height: thickness,
            fill: fills[seriesIndex] ?? fills[0] ?? "currentColor",
          },
        ];
      });
    });
  }, [data, barScale, bandWidth, barXAccessor, dataKeys, fills, stacked]);

  if (marks.length === 0) return null;

  return (
    <g className="operate-zero-marks">
      {marks.map((mark) => (
        <rect
          fill={mark.fill}
          height={mark.height}
          key={mark.key}
          rx={Math.min(size, mark.height) / 2}
          width={size}
          x={0}
          y={mark.y}
        />
      ))}
    </g>
  );
}
