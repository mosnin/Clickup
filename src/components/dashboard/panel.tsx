"use client";

import Link from "next/link";
import { useMemo } from "react";
import useMeasure from "react-use-measure";
import { useQuery } from "convex/react";
import {
  brokenClaimFor,
  type Expectation,
  type Outcome,
} from "@/lib/calibration";
import { api } from "@convex/_generated/api";
import { Chart, type ChartKind } from "@/components/charts/operate/chart";
import { LiveNumber } from "@/components/dashboard/live-number";
import {
  PanelDelta,
  usePanelAttention,
} from "@/components/dashboard/panel-memory";
import { useComponentStyle } from "@/components/appearance/use-component-style";
import { StyledSurface } from "@/components/dashboard/styled-surface";
import { Stagger, StaggerItem } from "@/components/motion";
import {
  ProvenanceSheet,
  ProvenanceToggle,
  useProvenance,
} from "@/components/dashboard/provenance-sheet";
import { formatValue } from "@/lib/chart-math";
import {
  describePanel,
  isChartShape,
  isMetricShape,
  isRecordShape,
  normalizePanel,
  type PanelDef,
} from "@/lib/panel";
import { identityFill } from "@/lib/identity-color";
import { timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";

// One renderer, any panel.
//
// This is where everything built so far actually meets a screen. A panel is a
// definition — a question (`lib/data-stream`), a shape (`lib/panel`) and a look
// (`lib/component-style`) — and this turns one into pixels. There is no
// per-shape component to keep in agreement with anything: twenty shapes, one
// function, one query.
//
// The reason that matters is not tidiness. It is that adding a kind of panel
// stops requiring a deploy. Somebody describing "overdue work by assignee as a
// donut" produces a definition this already knows how to draw, which is what
// makes the canvas authorable rather than merely arrangeable.
//
// Three things it does that a chart library would not do for us:
//
//   - **The frame is part of the panel.** Frame, fill, corner, padding and
//     title all come from the resolved style, at four levels of scope, ending
//     with this panel's own override. A chart in a fixed card is a chart in
//     somebody else's design.
//   - **It reads the same envelope whatever it draws.** `rows`, `series` and
//     `scalar` come back together; the shape decides which one it needs. So
//     switching a list to a donut changes one field of a definition, not a
//     code path.
//   - **It remembers what it told you.** See `lib/panel-memory` — the delta
//     lands under the number it explains rather than in an inbox elsewhere.

/**
 * The rows `brokenClaimFor` can actually reason about.
 *
 * `forScope` types `expectation` as unknown — it is stored as `v.any()`,
 * because the claim vocabulary lives in the client library rather than in the
 * schema. Narrowing here keeps that boundary honest: anything without a
 * checked outcome is dropped before it reaches the matcher, so a malformed or
 * half-written row can never be presented as somebody's failed prediction.
 */
function gradedOnly(
  rows: readonly {
    question: string;
    expectation: unknown;
    outcome: { verdict: string; value: number; checkedAt: number } | null;
  }[],
) {
  const out: {
    question: string;
    expectation: Expectation;
    outcome: Outcome;
  }[] = [];
  for (const row of rows) {
    const e = row.expectation as Expectation | undefined;
    if (!row.outcome || !e || typeof e !== "object" || !e.query) continue;
    out.push({
      question: row.question,
      expectation: e,
      outcome: row.outcome as Outcome,
    });
  }
  return out;
}

export function Panel({
  definition,
  scopeType,
  scopeId,
  panelId,
  className,
}: {
  definition: unknown;
  scopeType: "user" | "workspace";
  scopeId: string;
  /** Identity for memory and per-panel style. Absent = neither applies. */
  panelId?: string;
  className?: string;
}) {
  const def = useMemo(() => normalizePanel(definition), [definition]);
  // The definition's own look is a layer, not a decoration: it sits under the
  // reader's override so an authored panel arrives drawn the way its author
  // meant, and still loses to "not on my screen".
  const { style } = useComponentStyle(panelId ?? null, def.style);

  // The reader's own day boundaries. Convex runs in UTC and a person's "today"
  // is not UTC's; without this every daily chart is wrong at the edges.
  const tzOffsetMinutes = useMemo(() => -new Date().getTimezoneOffset(), []);

  const data = useQuery(api.dataStream.resolve, {
    scopeType,
    scopeId,
    query: def.query,
    tzOffsetMinutes,
  });

  // The claim this number broke, if anyone staked one on it.
  //
  // Only for metric shapes: a single number is a thing you can be wrong
  // about, and a grouped chart is not — attaching "you expected at most 10"
  // to a bar chart of ten assignees says it about all of them and about none
  // of them. `forScope` is already access-checked and already returns the
  // graded expectation, so this adds a subscription rather than an endpoint.
  const claims = useQuery(
    api.calibration.forScope,
    isMetricShape(def.shape) ? { scopeType, scopeId } : "skip",
  );
  const broken = useMemo(
    () => (claims ? brokenClaimFor(def.query, gradedOnly(claims)) : null),
    [claims, def.query],
  );

  const scalar = data?.scalar ?? null;
  const { state, attentionClass } = usePanelAttention(
    panelId ?? null,
    isMetricShape(def.shape) ? scalar : null,
  );

  // How much room the body actually got.
  //
  // The packer hands a panel a box; the panel does not get to assume that box
  // is the size it would have liked. Every shape in here used to lay out at a
  // constant — 132px of chart, 34px of sparkline — and let whatever was
  // holding it crop the difference, which is how a metric's spark came out as
  // one black rectangle sliced by the tile's bottom edge and a workload's last
  // two rows were cut with nothing to say they existed. So the box is measured
  // and passed down, and the shapes shrink into it.
  //
  // Measured rather than derived, because "what is left after the header" is a
  // sum of six things this component does not own (padding from the style
  // layer, a claim line, a truncation line, a title that may be hidden).
  const [bodyRef, bodyBox] = useMeasure();
  const room = Math.floor(bodyBox.height);
  const width = Math.floor(bodyBox.width);

  const frame = (
    // The surface is `StyledSurface`, shared with every built-in block on
    // every screen — see that file for what having two of them cost. The
    // resolved style is handed over rather than looked up again: this
    // component needs it anyway (to decide what to DRAW), and it resolves with
    // the definition's own layer underneath, which the surface cannot know
    // about.
    //
    // `overflow` is overridden back to visible. Containment belongs to the
    // body below, and clipping at the root cost more than it bought: a chart's
    // end labels sit a pixel or two outside the frame by design, and clipping
    // here cut "Jun 4" to "Jun " — tests/ui/panel-fit.test.tsx caught exactly
    // that, which is the rule it exists for ("a word ending at a tile's edge
    // reads as a shorter word").
    <StyledSurface
      panelId={panelId ?? null}
      resolved={style}
      className={cn("overflow-visible", attentionClass, className)}
    >
      <Header def={def} style={style} total={data?.total ?? 0} />
      {/* A list of records scrolls inside its own size rather than painting
          over the tile beneath — the actual "everything is overlapping" bug.
          `min-h-0` is what lets a flex child shrink below its content; without
          it the track refuses to shrink and the overflow has nothing to clip.
          The pair is load-bearing together.

          Only RECORD shapes, and that restriction is the whole subtlety.
          Setting `overflow-y` on a box forces its `overflow-x` to compute to
          `auto` as well — so a scroller here also clips horizontally, and a
          chart's end labels ("Jun 4") sit a pixel or two outside the plot by
          design. Worse on the y axis: a radar's top label overflows ABOVE the
          box, and scrollTop cannot go negative, so that text is clipped with
          no way to reach it. tests/ui/panel-fit.test.tsx caught both.
          Charts and metrics do not need containment anyway — they are already
          measured into `room` by `chartHeight`/`spark` and shrink to fit. */}
      <div
        className={cn(
          "mt-2 min-h-0 flex-1",
          isRecordShape(def.shape) && "overflow-y-auto",
        )}
        ref={bodyRef}
      >
        {data === undefined ? (
          <Skeleton />
        ) : (
          <Body
            def={def}
            data={data}
            style={style}
            state={state}
            scopeType={scopeType}
            scopeId={scopeId}
            room={room}
            width={width}
          />
        )}
      </div>
      {broken && (
        // Stated flatly, and never softened: a missed claim is the most
        // valuable thing this product can tell you, and hedging it is how a
        // team quietly stops being wrong about anything.
        <p className="mt-2 text-[11px] text-muted-foreground">
          You expected: {broken.claim}.
        </p>
      )}
      {data?.truncated && (
        // Said out loud rather than silently capped: a number that only counts
        // what the walk reached is a number people will act on.
        <p className="mt-2 text-[10px] text-muted-foreground">
          Showing the first {data.total}. Narrow it to see everything.
        </p>
      )}
    </StyledSurface>
  );

  return frame;
}

function Header({
  def,
  style,
  total,
}: {
  def: PanelDef;
  style: ReturnType<typeof useComponentStyle>["style"];
  total: number;
}) {
  if (style.titleStyle === "hidden") return null;
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-2",
        style.titleAlign === "center" && "justify-center",
      )}
    >
      <span
        className={cn(
          "line-clamp-1 min-w-0 break-words",
          style.titleStyle === "micro" &&
            "text-[11px] font-medium uppercase tracking-wider text-muted-foreground",
          style.titleStyle === "plain" && "text-sm",
          style.titleStyle === "large" && "text-base font-medium",
        )}
      >
        {def.title}
      </span>
      {total > def.query.limit && style.titleAlign !== "center" && (
        <span className="ui-figure flex-shrink-0 text-[11px] text-muted-foreground">
          {def.query.limit} of {total}
        </span>
      )}
    </div>
  );
}

type Envelope = NonNullable<
  ReturnType<typeof useQuery<typeof api.dataStream.resolve>>
>;

/**
 * The height a chart may draw at, given the room the body was measured to have.
 *
 * Two rules. It never exceeds the room, which is the whole point. And it never
 * exceeds the height the shape would have chosen anyway, which is what keeps
 * this stable: a panel in an auto-height container has `room` equal to its own
 * content, so a chart that grew to fill the room would grow the room, and the
 * two would chase each other. Shrinking is monotone and terminates.
 *
 * A room of 0 is "not measured yet", not "no space" — the first paint has no
 * box — so it falls back rather than collapsing the chart to nothing.
 */
function chartHeight(style: { padding: string }, room: number): number {
  const wanted = style.padding === "tight" ? 110 : 132;
  if (room <= 0) return wanted;
  return Math.max(MIN_CHART_PX, Math.min(wanted, room));
}

/** Below this a chart is a smear, and saying so is more use than drawing it. */
const MIN_CHART_PX = 40;

/**
 * The narrowest body a dial can be drawn in.
 *
 * Mirrors the gauge's own `min-width` (`components/charts/gauge.tsx` resolves
 * 300 for the radial form). Stated here rather than imported because it is the
 * *renderer's* decision what to do about it — the chart is entitled to a floor,
 * and the panel is the thing that knows how much room there is.
 */
const RADIAL_MIN_PX = 300;

function Body({
  def,
  data,
  style,
  state,
  scopeType,
  scopeId,
  room,
  width,
}: {
  def: PanelDef;
  data: Envelope;
  style: ReturnType<typeof useComponentStyle>["style"];
  state: ReturnType<typeof usePanelAttention>["state"];
  scopeType: "user" | "workspace";
  scopeId: string;
  /** Measured height of the body box, or 0 before the first measure. */
  room: number;
  /** Measured width of the body box, or 0 before the first measure. */
  width: number;
}) {
  if (isMetricShape(def.shape)) {
    return (
      <Metric
        def={def}
        data={data}
        style={style}
        state={state}
        scopeType={scopeType}
        scopeId={scopeId}
        room={room}
      />
    );
  }

  if (isChartShape(def.shape)) {
    if (data.series.length === 0) return <Empty def={def} />;
    // A dial below the width it can be drawn at reads its own number instead.
    //
    // The gauge declares a hard `min-width: 300px` (charts/gauge.tsx) — an arc
    // has a radius and there is no honest way to draw one in less room. What it
    // did with less was overflow: 31px of the dial hung outside a studio
    // specimen that clips, and 14px of it hung off the right edge of the panels
    // sheet at 1280. Neither was reachable; a reader simply lost the right-hand
    // slice of a circle and nothing said so.
    //
    // So the same rule the table follows one screen down: when the box cannot
    // hold the drawing, draw the same answer a way that fits. A dial is one
    // number against its maximum, and that number is `scalar` — the identical
    // quantity, read plainly, rather than a circle sliced by its container.
    if (def.shape === "radial" && width > 0 && width < RADIAL_MIN_PX) {
      return (
        <Metric
          def={def}
          data={data}
          style={style}
          state={state}
          scopeType={scopeType}
          scopeId={scopeId}
          room={room}
        />
      );
    }
    return (
      <Chart
        kind={def.shape as ChartKind}
        series={data.series}
        style={style}
        unit={data.meta.unit}
        height={chartHeight(style, room)}
        label={def.title}
      />
    );
  }

  if (data.rows.length === 0) return <Empty def={def} />;

  if (def.shape === "table") {
    return <Table def={def} rows={data.rows} width={width} />;
  }
  if (def.shape === "cards") return <Cards def={def} rows={data.rows} />;
  return <Rows def={def} rows={data.rows} />;
}

/**
 * Room the metric's own furniture needs before a sparkline is worth drawing:
 * the number, the delta line under it and the caption. Below this the spark is
 * the thing that gets cut, so it is the thing that is not drawn — an absent
 * chart says less than a clipped one, but it does not say something false.
 */
const METRIC_FURNITURE_PX = 76;
/** A sparkline shorter than this is a line, not a trend. */
const MIN_SPARK_PX = 18;
const SPARK_PX = 34;

function Metric({
  def,
  data,
  style,
  state,
  scopeType,
  scopeId,
  room,
}: {
  def: PanelDef;
  data: Envelope;
  style: ReturnType<typeof useComponentStyle>["style"];
  state: ReturnType<typeof usePanelAttention>["state"];
  scopeType: "user" | "workspace";
  scopeId: string;
  room: number;
}) {
  // A big number is where "why is that what it is" actually gets asked, so
  // this is where the chain hangs. The number itself is the affordance —
  // anything else would be chrome competing with the thing it is about.
  const provenance = useProvenance();

  // What is left for the spark once the number, the delta and the caption have
  // taken theirs. Unmeasured (0) keeps the shape it has always had.
  const spark =
    room <= 0
      ? SPARK_PX
      : Math.min(SPARK_PX, room - METRIC_FURNITURE_PX);

  return (
    <div className="flex h-full min-h-0 flex-col justify-between">
      <ProvenanceToggle
        open={provenance.open}
        onToggle={provenance.toggle}
        className="ui-figure text-4xl"
      >
        <LiveNumber value={data.scalar} />
        {data.meta.unit === "percent" ? "%" : ""}
      </ProvenanceToggle>

      <provenance.Presence>
        {provenance.open && (
          <ProvenanceSheet
            def={def}
            total={data.total}
            truncated={data.truncated}
            rows={data.rows.map((r) => ({
              id: r.id,
              title: r.title,
              href: r.href,
            }))}
            scopeType={scopeType}
            scopeId={scopeId}
            onClose={provenance.close}
          />
        )}
      </provenance.Presence>

      {/* What changed since you last looked, under the number it explains. */}
      <PanelDelta state={state} className="mt-1" />

      {def.shape === "metric_spark" &&
        data.series[0]?.points.length > 1 &&
        spark >= MIN_SPARK_PX && (
          <div className="mt-2 min-h-0">
            <Chart
              kind="sparkline"
              series={data.series}
              style={style}
              unit={data.meta.unit}
              height={spark}
              label={`${def.title} over time`}
            />
          </div>
        )}

      <p className="mt-1 line-clamp-1 break-words text-[11px] leading-relaxed text-muted-foreground">
        {def.caption || describePanel(def)}
      </p>
    </div>
  );
}

function Empty({ def }: { def: PanelDef }) {
  return (
    <p className="text-xs text-muted-foreground">
      {def.caption || "Nothing matches this yet."}
    </p>
  );
}

/**
 * How a line of text that is longer than its box ends.
 *
 * `line-clamp-*` rather than `truncate`, and the difference is not cosmetic.
 * `truncate` is `white-space: nowrap` — the text is laid out at its full
 * natural length and the box crops it, so a 60-character title inside a 274px
 * card is really 467px of text with 193px of it existing outside the viewport.
 * It LOOKS right, and everything measuring the page finds content nobody can
 * reach. `line-clamp` wraps first and clips by line, so the text never extends
 * past its own box; one line reads the same as `truncate` did, except the
 * ellipsis lands after a whole word instead of through the middle of one.
 *
 * `break-words` at every call site is the pathological case: one unbroken
 * 90-character token cannot wrap, and would put us back where we started.
 */
const CLAMP = { 1: "line-clamp-1", 2: "line-clamp-2" } as const;

/**
 * A record's title, as much of it as the box can hold.
 *
 * Two lines in a list or a card, one in a table.
 *
 * One line was the same rule everywhere, and on a phone it cost the sentence:
 * a 274px card turned "Reconcile the September ledger export before the
 * cutover window" into "Reconcile the September ledger …", which names a month
 * and a ledger and no longer says what is being done to them. Two lines is the
 * width a phone actually has, spent downward — where a panel has room — and it
 * is identical for every title that already fitted, so nothing on a desktop
 * moves. A table keeps one line because a column with a variable row height
 * stops being a column.
 */
/**
 * The row's mark: a small filled circle carrying the record's first letter.
 *
 * Its colour comes from `identityFill`, the same ramp every teammate avatar in
 * the product already uses, seeded on the row id — so a record keeps its
 * colour wherever it appears and two records never collide by having similar
 * names. It is NOT semantic and does not try to be: a colour that encoded
 * status would be a second status indicator disagreeing with the chip that
 * already says so.
 *
 * What it is for is scanning. A column of text rows is uniform grey; a column
 * with a mark in front of each one has a rhythm, and returning to a list you
 * half-remember, you find the row by its colour before you have read a word.
 */
function RowGlyph({ row }: { row: Envelope["rows"][number] }) {
  const initial = (Array.from(row.title.trim())[0] ?? "?").toUpperCase();
  return (
    <span
      aria-hidden
      className="ui-row-glyph mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
      style={identityFill(row.id)}
    >
      {initial}
    </span>
  );
}

function RowTitle({
  row,
  lines = 2,
}: {
  row: Envelope["rows"][number];
  lines?: 1 | 2;
}) {
  return (
    <span
      className={cn(
        // `ui-row-title` is the hook the row-emphasis rules hang off. A class
        // rather than a prop for the same reason the attributes are on the
        // panel root: this component is rendered from four places and none of
        // them should have to know how heavy the reader likes their titles.
        "ui-row-title block break-words text-sm group-hover:underline",
        CLAMP[lines],
      )}
    >
      {row.title}
    </span>
  );
}

/**
 * A whole row — title and its meta line — as one target.
 *
 * The link used to wrap the TITLE alone, which made a 20px band inside a ~40px
 * row the only place a press counted; the words directly under it, in the same
 * row, about the same record, did nothing. On a phone that is a target you have
 * to aim at vertically, and the two-thirds of the row that look pressable are
 * not. Wrapping both is also simply what everybody expects a list row to do.
 *
 * The underline moves to `group-hover`, so hovering the row still marks the
 * TITLE as the link rather than underlining the metadata along with it.
 */
function RowBody({
  def,
  row,
}: {
  def: PanelDef;
  row: Envelope["rows"][number];
}) {
  // Glyph · title · tags, on one line.
  //
  // The old row was a two-line block — title above, grey middot sentence below
  // — which is the shape of a search result rather than of a list you work
  // from. One line with the facts pushed right is what makes a column of rows
  // scannable: the eye runs down the titles, and each kind of fact is always
  // in the same place.
  const inner = (
    // `items-start`, not `items-center`: in a narrow tile the tags wrap under
    // the title, and centring hung the glyph beside the TAGS rather than
    // beside the thing it marks. A mark that does not line up with its title
    // is not a mark.
    <span className="flex min-w-0 items-start gap-2.5">
      <RowGlyph row={row} />
      <span className="min-w-0 flex-1">
        {/* Two lines. One was right when the tags lived under the title and
            the row was already two lines tall; now the tags sit to the RIGHT
            wherever there is room, so the title has the row to itself and
            clipping it at one line would cut sentences that fit. */}
        <RowTitle lines={2} row={row} />
        <RowTagsStacked def={def} row={row} />
      </span>
      <RowTags def={def} row={row} />
    </span>
  );
  if (!row.href) return inner;
  // Wrapping both lines made the row ONE target; `.tap-row` makes it a target
  // a thumb can hit. A title and a meta line come to 31px, which is under the
  // floor however correctly the anchor is drawn around them — and the fix has
  // to be the row's own height rather than a halo, because a halo here would
  // overlap the record above and the record below.
  return (
    <Link className="tap-row group block min-w-0" href={row.href}>
      {inner}
    </Link>
  );
}

/**
 * A row's chosen fields, as separate tags rather than one grey sentence.
 *
 * They used to be joined with middots into a single muted line — "due 3d · 2
 * assigned · High" — which is four facts rendered as one unreadable one: you
 * cannot scan a column of them, you cannot tell which part is a date and which
 * is a priority, and the whole line reads as an afterthought under the title.
 * Discrete tags scan down the column, because the same kind of fact lands in
 * the same place on every row.
 *
 * Outlined, not filled (see `.ui-chip`): three coloured lozenges on a row
 * compete with the title they are about, and meaning already lives in the
 * index and the glyph.
 */
function fieldLabel(field: string, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (
    (field === "due" ||
      field === "added" ||
      field === "updated" ||
      field === "when") &&
    typeof value === "number"
  ) {
    return field === "due" ? `due ${timeAgo(value)}` : timeAgo(value);
  }
  if (field === "assignee" && typeof value === "number") {
    return value > 0 ? `${value} assigned` : null;
  }
  if (field === "blocked" && typeof value === "number") {
    return value > 0 ? `${value} blocking` : null;
  }
  if (field === "estimate" && typeof value === "number") return `${value} pts`;
  return String(value);
}

/**
 * How many tags a row shows before it stops.
 *
 * Four is where a row stops being scannable and starts being a paragraph of
 * lozenges, and it is also roughly where they stop fitting beside a title on
 * anything narrower than a desktop. The ones dropped are the ones the panel's
 * own field order put last, which is the order somebody chose.
 */
const MAX_ROW_TAGS = 3;

function RowTags({ def, row }: { def: PanelDef; row: Envelope["rows"][number] }) {
  const tags: string[] = [];
  for (const field of def.fields) {
    const label = fieldLabel(field, row.meta[field]);
    if (label) tags.push(label);
  }
  if (tags.length === 0) return null;
  return (
    <span className="hidden shrink-0 items-center gap-1.5 @sm:flex">
      {tags.slice(0, MAX_ROW_TAGS).map((tag) => (
        <span
          key={tag}
          className="ui-chip whitespace-nowrap px-2 py-0.5 text-[11px] text-muted-foreground"
        >
          {tag}
        </span>
      ))}
    </span>
  );
}

/**
 * The same fields, stacked, for a row too narrow to hold them beside the title.
 *
 * A phone cannot fit a title and three tags on one line, and hiding them
 * outright would mean the same panel says less on the device most of it is
 * read on. So below `@sm` they go back under the title — as tags, not as a
 * middot sentence, so the register is the same one.
 */
function RowTagsStacked({
  def,
  row,
}: {
  def: PanelDef;
  row: Envelope["rows"][number];
}) {
  const tags: string[] = [];
  for (const field of def.fields) {
    const label = fieldLabel(field, row.meta[field]);
    if (label) tags.push(label);
  }
  if (tags.length === 0) return null;
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1 @sm:hidden">
      {tags.slice(0, MAX_ROW_TAGS).map((tag) => (
        <span
          key={tag}
          className="ui-chip px-1.5 py-0.5 text-[10px] text-muted-foreground"
        >
          {tag}
        </span>
      ))}
    </span>
  );
}

function Rows({ def, rows }: { def: PanelDef; rows: Envelope["rows"] }) {
  return (
    <Stagger className="ui-list">
      {rows.map((row) => (
        <StaggerItem key={row.id} className="min-w-0">
          <RowBody def={def} row={row} />
        </StaggerItem>
      ))}
    </Stagger>
  );
}

function Cards({ def, rows }: { def: PanelDef; rows: Envelope["rows"] }) {
  return (
    <Stagger className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {rows.map((row) => (
        // `@container` on the CELL, not just on the panel. A row asks "have I
        // room for tags beside the title" and in this shape the answer is
        // about the card it sits in, which is half the panel's width — asking
        // the panel meant a two-column grid showed the wide layout in narrow
        // cards and clipped both the title and every tag. Caught by
        // tests/ui/panel-fit.test.tsx, twenty-seven cuts across two themes.
        <StaggerItem key={row.id} className="@container bento-tile min-w-0 p-3">
          <RowBody def={def} row={row} />
        </StaggerItem>
      ))}
    </Stagger>
  );
}

/**
 * The narrowest a table can be and still be a table.
 *
 * Below this the columns stop being columns: a title and a status chip in
 * 320px is a chip sliced by the panel's own edge, which is what shipped. The
 * old answer was a horizontal scroller inside the tile, and a horizontal
 * scrollbar inside a card on a phone is a control most people never find — so
 * the rows stack instead, which is the same records read down instead of
 * across. Measured from the body's own box rather than from the viewport,
 * because a table in a one-column tile on a 1280px screen is just as narrow as
 * one on a phone; the panel does not know or care which it is in.
 */
const TABLE_MIN_PX = 360;

function Table({
  def,
  rows,
  width,
}: {
  def: PanelDef;
  rows: Envelope["rows"];
  width: number;
}) {
  if (width > 0 && width < TABLE_MIN_PX) {
    return <Rows def={def} rows={rows} />;
  }
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="pb-1 pr-3 font-medium">Title</th>
            {def.fields.map((f) => (
              <th key={f} className="pb-1 pr-3 font-medium capitalize">
                {f}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-border/60">
              {/* The cell no longer carries `truncate` itself: `nowrap` on the
                  cell would stop the title inside it from wrapping, and
                  `line-clamp` clips a wrapped line rather than an unwrapped
                  one. The title owns its own ending. */}
              <td className="max-w-[14rem] py-1.5 pr-3">
                {row.href ? (
                  <Link
                    className="tap-row group flex min-w-0 items-center"
                    href={row.href}
                  >
                    <RowTitle lines={1} row={row} />
                  </Link>
                ) : (
                  <RowTitle lines={1} row={row} />
                )}
              </td>
              {def.fields.map((f) => {
                const value = row.meta[f];
                return (
                  <td
                    key={f}
                    className="ui-figure py-1.5 pr-3 text-muted-foreground"
                  >
                    {value === null || value === undefined
                      ? "—"
                      : typeof value === "number" &&
                          (f === "due" ||
                            f === "added" ||
                            f === "updated" ||
                            f === "when")
                        ? timeAgo(value)
                        : typeof value === "number" && f === "value"
                          ? formatValue(value, "count")
                          : String(value)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2">
      <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
      <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
      <div className="h-3 w-3/5 animate-pulse rounded bg-muted" />
    </div>
  );
}
