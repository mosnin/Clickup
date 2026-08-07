"use client";

import { useEffect, useMemo, useRef } from "react";

import { useChartStable } from "../chart-context";

// One axis, whatever drew the marks.
//
// There used to be two. Category charts got the strip below (ours); temporal
// charts got the vendored `XAxis`. Side by side in a dashboard row that is two
// products: 12px near-black labels portaled *into* the plot on one card, 10px
// muted labels *under* the plot on the next. And the vendored one is not only
// a different look, it is a different place — it is absolutely positioned at
// `bottom: 12` inside the chart container, so on a scatter the dots and the
// dates occupy the same pixels.
//
// So there is now one treatment and one rule, and the rule is the one the band
// strip already stated: **labels live outside the plot**. The chart is given
// the height that is left over and the row underneath is space no mark was
// ever drawn into. Overlap is not avoided here, it is unreachable.
//
// The other half is where a label goes. A label may not be positioned by
// arithmetic that *resembles* the chart's — "index over count" is not "where
// the scale put it", and the difference is a chart that names the wrong bar.
// So the positions come from the scale itself: a reporter mounted inside the
// chart reads `barScale` / `xScale` and hands the pixel positions back out.
// Nothing here recomputes geometry; it only asks.

/** A label and where, in px from the strip's own leading edge, it belongs. */
export type AxisTick = {
  /** Stable across re-measures — the label alone is not unique. */
  key: string;
  label: string;
  /** Centre of the mark this label names. */
  pos: number;
};

/** The one axis-label typography. Every axis in this file renders through it. */
const LABEL_CLASS =
  "absolute truncate text-micro leading-4 text-muted-foreground";

/** Right-aligned against the plot, so the words end where the bars begin. */
const ROW_LABEL_CLASS = `${LABEL_CLASS} left-0 right-2 text-right`;

/** Below this a word cannot say anything, so fewer of them say more. */
const MIN_LABEL_PX = 54;

/**
 * Air between two labels.
 *
 * A label may spread across the room its neighbours are not using, but not
 * across all of it: two words that meet are read as one word, and the reader
 * cannot tell that is what happened. An ellipsis says "there is more here";
 * `In progressNeeds re…` says nothing true at all.
 */
const LABEL_GUTTER_PX = 8;

/** A row of labels is 16px tall; below that they would collide. */
const MIN_ROW_PX = 16;

/**
 * Rough px width of a 10px-label string. There is no canvas measurement in
 * this module, so the estimate errs generous (character count is a lower
 * bound on glyph width for most alphabets at this size) rather than under,
 * which would silently readmit the truncation this exists to prevent.
 */
const CHAR_PX = 6.2;

/** Estimated rendered width of the widest label in a tick list. */
function widestLabelPx(ticks: AxisTick[]): number {
  let max = 0;
  for (const t of ticks) max = Math.max(max, t.label.length * CHAR_PX);
  return max;
}

/**
 * Keep every `stride`-th tick, where stride is the smallest number that gives
 * each survivor `min` px of room.
 *
 * Thinning is by measured distance, never by count: six statuses in a
 * one-column panel and six statuses at 1100px are the same list and want
 * different answers.
 *
 * `room` comes back with the survivors because a thinned label has to inherit
 * the space the skipped marks freed. Without that, dropping three labels in
 * four still leaves the survivor in a 16px cell — which is how a fortnight of
 * days once came out as `J… J… J…`.
 */
function thin(
  ticks: AxisTick[],
  min: number,
): { kept: AxisTick[]; room: number } {
  if (ticks.length <= 1) return { kept: ticks, room: min };

  let gap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < ticks.length; i++) {
    gap = Math.min(gap, Math.abs(ticks[i].pos - ticks[i - 1].pos));
  }
  if (!Number.isFinite(gap) || gap <= 0) return { kept: ticks, room: min };
  if (gap >= min) return { kept: ticks, room: gap };

  const stride = Math.ceil(min / gap);
  const room = gap * stride;
  const kept = ticks.filter((_, i) => i % stride === 0);

  // The final mark always keeps its name. A stride that lands two short of the
  // end silently withholds the answer to "up to when?", which on a date axis
  // is half of what the axis is for. Drop the survivor it would crowd — but
  // never the first, or the axis loses the other end instead.
  const last = ticks.at(-1);
  const tail = kept.at(-1);
  if (last && tail && last !== tail) {
    if (kept.length > 1 && Math.abs(last.pos - tail.pos) < room) kept.pop();
    kept.push(last);
  }
  return { kept, room };
}

/**
 * The labels under a plot.
 *
 * Each one stays over the mark it names. The ends are the only special case: a
 * label centred on the first mark would hang off the panel, so it anchors to
 * the strip's own edge instead — still unambiguously nearest its own mark,
 * because a labelled mark has at least `room` px to itself by construction.
 */
export function AxisStrip({
  ticks,
  width,
}: {
  ticks: AxisTick[];
  width: number;
}) {
  // Wordy category axes ("In progress", "Needs review") pass the plain
  // tick-to-tick distance gate un-thinned and then truncate at every width —
  // widening never helps, because the gate never looked at the words. Folding
  // the widest label's estimated px into the threshold makes a 6-category
  // axis thin exactly the way the 14-day date axis already does; short date
  // labels never clear MIN_LABEL_PX on their own, so this is a no-op there.
  const min = useMemo(
    () => Math.max(MIN_LABEL_PX, widestLabelPx(ticks) + LABEL_GUTTER_PX),
    [ticks],
  );
  const { kept, room } = useMemo(() => thin(ticks, min), [ticks, min]);
  const cap = Math.max(24, room - LABEL_GUTTER_PX);

  // The row keeps its height whether or not the ticks have arrived, so the
  // plot above it does not resize on the frame the scale first reports.
  return (
    <div className="relative mt-1 h-4 w-full shrink-0">
      {width > 0 &&
        kept.map((tick) => {
          const atStart = tick.pos - room / 2 < 0;
          const atEnd = !atStart && tick.pos + room / 2 > width;
          return (
            <span
              className={LABEL_CLASS}
              key={tick.key}
              style={{
                top: 0,
                left: atEnd ? undefined : atStart ? 0 : tick.pos,
                right: atEnd ? 0 : undefined,
                transform: atStart || atEnd ? undefined : "translateX(-50%)",
                maxWidth: cap,
              }}
              title={tick.label}
            >
              {tick.label}
            </span>
          );
        })}
    </div>
  );
}

/**
 * The same labels down the side, for a horizontal bar chart.
 *
 * The hidden stack is what gives the column its width: absolutely positioned
 * labels cannot size their own parent, and the alternative — a flex column
 * with `justify-around` — spaces labels evenly while the bars are spaced by a
 * band scale with padding inside a top margin. Those two agree in the middle
 * and drift by most of a bar's height at the ends, which is a name pointing at
 * somebody else's row.
 */
export function AxisColumn({ ticks }: { ticks: AxisTick[] }) {
  const { kept } = useMemo(() => thin(ticks, MIN_ROW_PX), [ticks]);

  return (
    <div className="relative max-w-[38%] shrink-0 pr-2">
      {/* `h-0` because this stack is here for its WIDTH and nothing else. Left
          in flow it laid out at 16px a row whatever height the column had, so
          eleven rows in a 110px box was 66px of invisible content pushing the
          column's scroll height past its box — the same "lay out at natural
          size and let the box crop it" the charts themselves were doing. Its
          width contribution survives being zero-height; its height no longer
          claims room the panel does not have. */}
      <div aria-hidden className="invisible flex h-0 flex-col overflow-hidden">
        {ticks.map((tick) => (
          <span className="truncate text-micro leading-4" key={tick.key}>
            {tick.label}
          </span>
        ))}
      </div>
      {kept.map((tick) => (
        <span
          className={ROW_LABEL_CLASS}
          key={tick.key}
          style={{ top: tick.pos, transform: "translateY(-50%)" }}
          title={tick.label}
        >
          {tick.label}
        </span>
      ))}
    </div>
  );
}

/** Report only when the answer actually changed, rounded to whole pixels. */
function useReport(ticks: AxisTick[], onTicks: (t: AxisTick[]) => void) {
  const last = useRef<string>("");
  useEffect(() => {
    const signature = ticks
      .map((t) => `${t.key} ${t.label}@${Math.round(t.pos)}`)
      .join("|");
    if (signature === last.current) return;
    last.current = signature;
    onTicks(ticks);
  }, [ticks, onTicks]);
}

/**
 * Where the band scale put each category. Mounted inside a `<BarChart>`.
 *
 * Renders nothing — it exists so the labels can be drawn outside the plot
 * while still being placed by the scale that drew the bars.
 */
export function BandTicks({
  labels,
  onTicks,
}: {
  /** Parallel to the chart's rows. */
  labels: string[];
  onTicks: (ticks: AxisTick[]) => void;
}) {
  const { data, barScale, bandWidth, barXAccessor, margin, orientation } =
    useChartStable();
  // The band scale runs down the plot on a horizontal chart and across it on a
  // vertical one, so the margin it is offset by is a different one.
  const origin = orientation === "horizontal" ? margin.top : margin.left;

  const ticks = useMemo<AxisTick[]>(() => {
    if (!(barScale && bandWidth && barXAccessor)) return [];
    return data.flatMap((row, i) => {
      const band = barScale(barXAccessor(row));
      if (band == null || !Number.isFinite(band)) return [];
      return [
        {
          key: `${i}`,
          label: labels[i] ?? "",
          pos: origin + band + bandWidth / 2,
        },
      ];
    });
  }, [data, barScale, bandWidth, barXAccessor, labels, origin]);

  useReport(ticks, onTicks);
  return null;
}

/**
 * Where the time scale put each point. Mounted inside a line / area / scatter
 * chart.
 *
 * `labels` rather than the dates themselves, because half of these charts are
 * categories riding synthetic instants — the geometry is temporal, the words
 * are not, and reading the words off the x value would print a date under
 * "In progress".
 */
export function PointTicks({
  labels,
  onTicks,
}: {
  labels: string[];
  onTicks: (ticks: AxisTick[]) => void;
}) {
  const { data, xScale, xAccessor, margin } = useChartStable();

  const ticks = useMemo<AxisTick[]>(
    () =>
      data.flatMap((row, i) => {
        const x = xScale(xAccessor(row));
        if (x == null || !Number.isFinite(x)) return [];
        return [{ key: `${i}`, label: labels[i] ?? "", pos: margin.left + x }];
      }),
    [data, xScale, xAccessor, labels, margin.left],
  );

  useReport(ticks, onTicks);
  return null;
}
