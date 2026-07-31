"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Chart, type ChartKind } from "@/components/charts/chart";
import { LiveNumber } from "@/components/dashboard/live-number";
import {
  PanelDelta,
  usePanelAttention,
} from "@/components/dashboard/panel-memory";
import { useComponentStyle } from "@/components/appearance/use-component-style";
import {
  cornerCss,
  fillClass,
  frameClass,
  padCss,
} from "@/components/appearance/style-gallery";
import { Stagger, StaggerItem } from "@/components/motion";
import { formatValue } from "@/lib/chart-math";
import {
  describePanel,
  isChartShape,
  isMetricShape,
  normalizePanel,
  type PanelDef,
} from "@/lib/panel";
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

  const scalar = data?.scalar ?? null;
  const { state, attentionClass } = usePanelAttention(
    panelId ?? null,
    isMetricShape(def.shape) ? scalar : null,
  );

  const frame = (
    <div
      className={cn(
        "flex h-full min-w-0 flex-col transition-shadow",
        frameClass(style),
        fillClass(style),
        attentionClass,
        className,
      )}
      style={{ borderRadius: cornerCss(style), padding: padCss(style) }}
    >
      <Header def={def} style={style} total={data?.total ?? 0} />
      <div className="mt-2 min-h-0 flex-1">
        {data === undefined ? (
          <Skeleton />
        ) : (
          <Body def={def} data={data} style={style} state={state} />
        )}
      </div>
      {data?.truncated && (
        // Said out loud rather than silently capped: a number that only counts
        // what the walk reached is a number people will act on.
        <p className="mt-2 text-[10px] text-muted-foreground">
          Showing the first {data.total}. Narrow it to see everything.
        </p>
      )}
    </div>
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
          "min-w-0 truncate",
          style.titleStyle === "micro" &&
            "text-[11px] font-medium uppercase tracking-wider text-muted-foreground",
          style.titleStyle === "plain" && "text-sm",
          style.titleStyle === "large" && "text-base font-medium",
          style.fill === "inverted" && "text-background",
        )}
      >
        {def.title}
      </span>
      {total > def.query.limit && style.titleAlign !== "center" && (
        <span className="flex-shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {def.query.limit} of {total}
        </span>
      )}
    </div>
  );
}

type Envelope = NonNullable<
  ReturnType<typeof useQuery<typeof api.dataStream.resolve>>
>;

function Body({
  def,
  data,
  style,
  state,
}: {
  def: PanelDef;
  data: Envelope;
  style: ReturnType<typeof useComponentStyle>["style"];
  state: ReturnType<typeof usePanelAttention>["state"];
}) {
  if (isMetricShape(def.shape)) {
    return <Metric def={def} data={data} style={style} state={state} />;
  }

  if (isChartShape(def.shape)) {
    if (data.series.length === 0) return <Empty def={def} />;
    return (
      <Chart
        kind={def.shape as ChartKind}
        series={data.series}
        style={style}
        unit={data.meta.unit}
        height={style.padding === "tight" ? 110 : 132}
        label={def.title}
      />
    );
  }

  if (data.rows.length === 0) return <Empty def={def} />;

  if (def.shape === "table") return <Table def={def} rows={data.rows} />;
  if (def.shape === "cards") return <Cards def={def} rows={data.rows} />;
  return <Rows def={def} rows={data.rows} />;
}

function Metric({
  def,
  data,
  style,
  state,
}: {
  def: PanelDef;
  data: Envelope;
  style: ReturnType<typeof useComponentStyle>["style"];
  state: ReturnType<typeof usePanelAttention>["state"];
}) {
  return (
    <div className="flex h-full flex-col justify-between">
      <p
        className={cn(
          "text-4xl tabular-nums",
          style.fill === "inverted" && "text-background",
        )}
      >
        <LiveNumber value={data.scalar} />
        {data.meta.unit === "percent" ? "%" : ""}
      </p>

      {/* What changed since you last looked, under the number it explains. */}
      <PanelDelta state={state} className="mt-1" />

      {def.shape === "metric_spark" && data.series[0]?.points.length > 1 && (
        <div className="mt-2">
          <Chart
            kind="sparkline"
            series={data.series}
            style={style}
            unit={data.meta.unit}
            height={34}
            label={`${def.title} over time`}
          />
        </div>
      )}

      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
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

function RowTitle({ row }: { row: Envelope["rows"][number] }) {
  const text = <span className="block truncate text-sm">{row.title}</span>;
  if (!row.href) return text;
  return (
    <Link href={row.href} className="block min-w-0 hover:underline">
      {text}
    </Link>
  );
}

/** A row's chosen fields, as one line. */
function MetaLine({ def, row }: { def: PanelDef; row: Envelope["rows"][number] }) {
  const bits: string[] = [];
  for (const field of def.fields) {
    const value = row.meta[field];
    if (value === null || value === undefined || value === "") continue;
    if (
      (field === "due" ||
        field === "added" ||
        field === "updated" ||
        field === "when") &&
      typeof value === "number"
    ) {
      bits.push(field === "due" ? `due ${timeAgo(value)}` : timeAgo(value));
    } else if (field === "assignee" && typeof value === "number") {
      if (value > 0) bits.push(`${value} assigned`);
    } else if (field === "blocked" && typeof value === "number") {
      if (value > 0) bits.push(`${value} blocking`);
    } else if (field === "estimate" && typeof value === "number") {
      bits.push(`${value} pts`);
    } else {
      bits.push(String(value));
    }
  }
  if (bits.length === 0) return null;
  return (
    <span className="block truncate text-[11px] text-muted-foreground">
      {bits.join(" · ")}
    </span>
  );
}

function Rows({ def, rows }: { def: PanelDef; rows: Envelope["rows"] }) {
  return (
    <Stagger className="ui-list">
      {rows.map((row) => (
        <StaggerItem key={row.id} className="min-w-0">
          <RowTitle row={row} />
          <MetaLine def={def} row={row} />
        </StaggerItem>
      ))}
    </Stagger>
  );
}

function Cards({ def, rows }: { def: PanelDef; rows: Envelope["rows"] }) {
  return (
    <Stagger className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {rows.map((row) => (
        <StaggerItem key={row.id} className="bento-tile min-w-0 p-3">
          <RowTitle row={row} />
          <MetaLine def={def} row={row} />
        </StaggerItem>
      ))}
    </Stagger>
  );
}

/** Wide content scrolls inside its own panel, never panning the page. */
function Table({ def, rows }: { def: PanelDef; rows: Envelope["rows"] }) {
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[22rem] text-left text-xs">
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
              <td className="max-w-[14rem] truncate py-1.5 pr-3">
                <RowTitle row={row} />
              </td>
              {def.fields.map((f) => {
                const value = row.meta[f];
                return (
                  <td
                    key={f}
                    className="py-1.5 pr-3 tabular-nums text-muted-foreground"
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
