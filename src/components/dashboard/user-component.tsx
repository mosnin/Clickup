"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Card } from "@/components/ui/card";
import { LiveNumber } from "@/components/dashboard/live-number";
import { Stagger, StaggerItem } from "@/components/motion";
import { timeAgo } from "@/lib/time";
import {
  describeComponent,
  normalizeComponent,
  type UiComponentDef,
} from "@/lib/ui-components";
import { cn } from "@/lib/utils";
import {
  PanelDelta,
  usePanelAttention,
} from "@/components/dashboard/panel-memory";

// One renderer, any definition.
//
// This is what makes panels data instead of code. Every user-authored panel in
// the app is this component with a different definition, which is why adding a
// kind of panel needs no deploy — and why two people in one workspace can be
// looking at screens with nothing in common.
//
// The shapes are deliberately few and each does one job well. A shape nobody
// can tell apart from another shape is a choice that only adds decisions.

export function UserComponent({
  definition,
  scopeType,
  scopeId,
  panelId,
}: {
  definition: unknown;
  scopeType: "user" | "workspace";
  scopeId: string;
  /**
   * Identity for this panel on this screen — what its memory is keyed by.
   * Without it the panel still renders; it just cannot tell you what changed.
   */
  panelId?: string;
}) {
  const def = normalizeComponent(definition);
  const data = useQuery(api.uiComponents.resolve, {
    scopeType,
    scopeId,
    definition: def,
  });

  if (data === undefined) {
    return (
      <Card className="h-full rounded-2xl p-5">
        <div className="h-4 w-24 animate-pulse rounded bg-muted" />
        <div className="mt-3 h-16 animate-pulse rounded bg-muted" />
      </Card>
    );
  }

  if (def.shape === "metric") {
    return (
      <MetricPanel def={def} value={data.metric ?? 0} panelId={panelId ?? null} />
    );
  }

  return (
    <Card className="h-full rounded-2xl p-5">
      <Header def={def} total={data.total} />
      {data.rows.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Nothing matches this yet.
        </p>
      ) : def.shape === "table" ? (
        <TableRows def={def} rows={data.rows} />
      ) : def.shape === "cards" ? (
        <CardRows def={def} rows={data.rows} />
      ) : (
        <ListRows def={def} rows={data.rows} />
      )}
    </Card>
  );
}

type Row = {
  id: string;
  title: string;
  href: string | null;
  meta: Record<string, unknown>;
};

function Header({ def, total }: { def: UiComponentDef; total: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="min-w-0 truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {def.title}
      </span>
      {total > def.limit && (
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {def.limit} of {total}
        </span>
      )}
    </div>
  );
}

/**
 * The one-number panel.
 *
 * Big, and nothing else — a metric competing with a list of rows is a metric
 * nobody reads. The digits resolve when the value moves, so a number that
 * changed because an agent finished something announces itself.
 */
function MetricPanel({
  def,
  value,
  panelId,
}: {
  def: UiComponentDef;
  value: number;
  panelId: string | null;
}) {
  const suffix = def.metric === "completion" ? "%" : "";
  // What this panel last told *this reader*, and whether anything it was asked
  // to watch for has happened. See lib/panel-memory: a dashboard that cannot
  // answer "what changed since I last looked" is answering the wrong question.
  const { state, attentionClass } = usePanelAttention(panelId, value);

  return (
    <Card
      className={cn(
        "flex h-full flex-col justify-between rounded-2xl p-5 transition-shadow",
        attentionClass,
      )}
    >
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {def.title}
      </span>
      <p className="mt-2 text-4xl tabular-nums">
        <LiveNumber value={value} />
        {suffix}
      </p>
      {/* The delta sits where the explanation belongs — under the number it
          explains, not in an inbox on another screen. Absent when nothing
          moved, which is most of the time and the point. */}
      <PanelDelta state={state} className="mt-1" />
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        {describeComponent(def)}
      </p>
    </Card>
  );
}

function MetaLine({ def, row }: { def: UiComponentDef; row: Row }) {
  const bits: string[] = [];
  for (const field of def.fields) {
    const value = row.meta[field];
    if (value === null || value === undefined || value === "") continue;
    if (field === "due" && typeof value === "number") {
      bits.push(`due ${timeAgo(value)}`);
    } else if (field === "added" && typeof value === "number") {
      bits.push(timeAgo(value));
    } else if (field === "updated" && typeof value === "number") {
      bits.push(timeAgo(value));
    } else if (field === "when" && typeof value === "number") {
      bits.push(timeAgo(value));
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

function RowTitle({ row }: { row: Row }) {
  const text = <span className="block truncate text-sm">{row.title}</span>;
  if (!row.href) return text;
  return (
    <Link href={row.href} className="block min-w-0 hover:underline">
      {text}
    </Link>
  );
}

function ListRows({ def, rows }: { def: UiComponentDef; rows: Row[] }) {
  // `.ui-list` hands the spacing to the room's list style (ruled lines, tiles,
  // condensed, or the default rows) — see globals.css. The panel's own density
  // is a second, narrower knob and stays a modifier on top of it.
  return (
    <Stagger
      className={cn("ui-list mt-3", def.density === "compact" && "ui-list-tight")}
    >
      {rows.map((row) => (
        <StaggerItem key={row.id} className="min-w-0">
          <RowTitle row={row} />
          <MetaLine def={def} row={row} />
        </StaggerItem>
      ))}
    </Stagger>
  );
}

function CardRows({ def, rows }: { def: UiComponentDef; rows: Row[] }) {
  return (
    <Stagger className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
      {rows.map((row) => (
        <StaggerItem key={row.id}>
          <div className="bento-tile min-w-0 p-3">
            <RowTitle row={row} />
            <MetaLine def={def} row={row} />
          </div>
        </StaggerItem>
      ))}
    </Stagger>
  );
}

/**
 * The table.
 *
 * Wrapped in its own horizontal scroll, per the shell's rule: a wide panel
 * scrolls inside itself rather than letting the page pan sideways.
 */
function TableRows({ def, rows }: { def: UiComponentDef; rows: Row[] }) {
  return (
    <div className="mt-3 -mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[24rem] text-left text-xs">
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
                    className="py-1.5 pr-3 text-muted-foreground tabular-nums"
                  >
                    {value === null || value === undefined
                      ? "—"
                      : f === "due" || f === "added" || f === "updated" || f === "when"
                        ? typeof value === "number"
                          ? timeAgo(value)
                          : "—"
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
