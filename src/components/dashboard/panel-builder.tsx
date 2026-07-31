"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { Panel } from "@/components/dashboard/panel";
import { Chart, type ChartKind } from "@/components/charts/chart";
import { IntentComposer } from "@/components/appearance/intent-composer";
import {
  DEFAULT_STYLE,
  STYLE_PRESETS,
  normalizeStyle,
  normalizeStylePatch,
} from "@/lib/component-style";
import {
  dimensionLabel,
  dimensionsFor,
  measureLabel,
  measuresFor,
  type Dimension,
  type Measure,
  type SourceKind,
} from "@/lib/data-stream";
import {
  DEFAULT_PANEL,
  describePanel,
  fieldsFor,
  isBespokeShape,
  isChartShape,
  isMetricShape,
  normalizePanel,
  shapeLabel,
  shapesFor,
  type PanelDef,
  type PanelShape,
} from "@/lib/panel";
import { blankPanelFor, coherePanel } from "@/lib/panel-intent";
import { cn } from "@/lib/utils";

// Authoring a panel.
//
// Three questions in the order somebody actually has them — what do you want
// to see, how should it be drawn, what should it look like — and the answer to
// all three is visible the whole time, because the thing on the right is not a
// mockup. It is `<Panel>`, running the query it will run once it exists,
// against this scope's real data, at the size it will be read at. There is no
// gap for a preview to lie in.
//
// Two rules this holds to that a settings form would not:
//
// **Every option that can be drawn is drawn.** "Donut" and "waterfall" are two
// words that say nothing; the shapes themselves say it immediately, rendered by
// the same chart code the panel uses. The same goes for the presets.
//
// **No control takes a typed value.** One text field, for the name. Everything
// else is a pick or a drag — no steppers, no numeric spinners, no CSS.
//
// The nineteen style axes deliberately do NOT live here. You reach those by
// pointing at the panel once it is on your screen, which is the whole premise
// of the inspector — changing a look while looking at fake data is the thing
// this product refuses to make anybody do. What is offered here is a starting
// point and a sentence.

const UNTITLED = DEFAULT_PANEL.title;

const MINI = [
  {
    key: "a",
    label: "A",
    points: [
      { key: "1", label: "", value: 6 },
      { key: "2", label: "", value: 10 },
      { key: "3", label: "", value: 4 },
      { key: "4", label: "", value: 12 },
    ],
  },
];

const SOURCE_LABELS: Record<SourceKind, string> = {
  tasks: "Tasks",
  pages: "Pages",
  agents: "Agents",
  activity: "Activity",
  time: "Time",
  goals: "Goals",
  sprints: "Sprints",
};

export function PanelBuilder({
  scopeType,
  scopeId,
  onCreated,
}: {
  scopeType: "user" | "workspace";
  scopeId: string;
  onCreated: (componentId: string) => void;
}) {
  const create = useMutation(api.uiComponents.create);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [def, setDef] = useState<PanelDef>(() => blankPanelFor("tasks"));
  /** A sentence's answer, applied but not yet kept. */
  const [proposed, setProposed] = useState<PanelDef | null>(null);

  // Takes anything: every edit is re-validated by the normalizer on the way
  // in, so the controls hand over plain values rather than proving their types
  // twice — once here and once where it actually matters.
  function patch(next: Record<string, unknown>) {
    // Every edit round-trips both normalizers, so a change that invalidates
    // another field — a shape the new source cannot draw, a chart with nothing
    // to group by — is repaired as you make it rather than at save time.
    setProposed(null);
    setDef((current) =>
      coherePanel(normalizePanel({ ...current, ...next }), current),
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="bento-tile flex w-full items-center justify-between gap-2 p-3 text-left transition-colors hover:bg-accent"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium">Build a panel</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
            Pick what to show and how to draw it. It becomes a panel you can put
            on any screen.
          </span>
        </span>
        <span className="text-lg leading-none text-muted-foreground">+</span>
      </button>
    );
  }

  const showing = proposed ?? def;
  const shapes = shapesFor(showing.query.from);
  const dimensions = dimensionsFor(showing.query.from);
  const measures = measuresFor(showing.query.from);
  const catalog = fieldsFor(showing.query.from);
  const wantsSeries = isChartShape(showing.shape);
  const wantsScalar = isMetricShape(showing.shape);
  const wantsRows = !wantsSeries && !wantsScalar && !isBespokeShape(showing.shape);

  return (
    <div className="panel rounded-2xl p-4">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="min-w-0 space-y-6">
          {/* A definition always carries a title — an untitled panel renders a
              blank header — so the placeholder stands in for the default
              rather than the field being genuinely empty. */}
          <input
            value={showing.title === UNTITLED ? "" : showing.title}
            onChange={(e) => patch({ title: e.currentTarget.value })}
            aria-label="Panel name"
            placeholder={UNTITLED}
            className="soft-field w-full px-3 py-2 text-sm"
          />

          {/* ── What it shows ── */}
          <Chapter title="What it shows">
            <Choice
              label="From"
              value={showing.query.from}
              options={(Object.keys(SOURCE_LABELS) as SourceKind[]).map((s) => [
                s,
                SOURCE_LABELS[s],
              ])}
              onPick={(from) =>
                // Changing the source invalidates most of the rest, so start
                // from a coherent panel about the new thing rather than
                // carrying half a question across.
                patch(blankPanelFor(from as SourceKind))
              }
            />

            {showing.query.from === "tasks" && (
              <>
                <Choice
                  label="Status"
                  value={showing.query.filter.status}
                  options={[
                    ["any", "Any"],
                    ["open", "To do"],
                    ["in_progress", "Doing"],
                    ["complete", "Done"],
                  ]}
                  onPick={(status) => filterPatch(patch, showing, { status })}
                />
                <Choice
                  label="Assigned to"
                  value={showing.query.filter.assignee}
                  options={[
                    ["anyone", "Anyone"],
                    ["me", "Me"],
                    ["unassigned", "Nobody"],
                    ["agents", "Agents"],
                    ["humans", "People"],
                  ]}
                  onPick={(assignee) =>
                    filterPatch(patch, showing, { assignee })
                  }
                />
                <Choice
                  label="Due"
                  value={showing.query.filter.due}
                  options={[
                    ["any", "Any time"],
                    ["overdue", "Overdue"],
                    ["today", "Today"],
                    ["week", "This week"],
                    ["none", "No date"],
                  ]}
                  onPick={(due) => filterPatch(patch, showing, { due })}
                />
                <div className="flex flex-wrap gap-2">
                  <Toggle
                    label="Blocked only"
                    on={showing.query.filter.blocked}
                    onToggle={() =>
                      filterPatch(patch, showing, {
                        blocked: !showing.query.filter.blocked,
                      })
                    }
                  />
                  <Toggle
                    label="Waiting on approval"
                    on={showing.query.filter.needsApproval}
                    onToggle={() =>
                      filterPatch(patch, showing, {
                        needsApproval: !showing.query.filter.needsApproval,
                      })
                    }
                  />
                </div>
              </>
            )}

            {showing.query.filter.window !== undefined &&
              showing.query.from !== "agents" && (
                <Choice
                  label="Over"
                  value={showing.query.filter.window}
                  options={[
                    ["all", "All time"],
                    ["7d", "7 days"],
                    ["30d", "30 days"],
                    ["quarter", "Quarter"],
                    ["year", "Year"],
                  ]}
                  onPick={(window) => filterPatch(patch, showing, { window })}
                />
              )}
          </Chapter>

          {/* ── How it is drawn ── */}
          <Chapter title="How it's drawn">
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {shapes.map((shape) => (
                <button
                  key={shape}
                  type="button"
                  aria-pressed={shape === showing.shape}
                  onClick={() => patch({ shape })}
                  className={cn(
                    "overflow-hidden rounded-lg bg-page p-1.5 text-left transition-all",
                    shape === showing.shape
                      ? "ring-2 ring-foreground"
                      : "ring-1 ring-border hover:ring-muted-foreground/40",
                  )}
                >
                  <ShapeSpecimen shape={shape} />
                  <span className="mt-1 block truncate text-[10px] text-muted-foreground">
                    {shapeLabel(shape)}
                  </span>
                </button>
              ))}
            </div>

            {(wantsSeries || wantsScalar) && (
              <Choice
                label="Measuring"
                value={showing.query.measure}
                options={measures.map((m) => [m, measureLabel(m)])}
                onPick={(measure) =>
                  patch({
                    query: { ...showing.query, measure: measure as Measure },
                  })
                }
              />
            )}

            {wantsSeries && (
              <>
                <Choice
                  label="Grouped by"
                  value={showing.query.dimension}
                  options={dimensions
                    .filter((d) => d !== "none" && d !== "custom_field")
                    .map((d) => [d, dimensionLabel(d)])}
                  onPick={(dimension) =>
                    patch({
                      query: {
                        ...showing.query,
                        dimension: dimension as Dimension,
                      },
                    })
                  }
                />
                <Choice
                  label="Split by"
                  value={showing.query.breakdown}
                  options={[
                    ["none", "Nothing"],
                    ...dimensions
                      .filter(
                        (d) =>
                          d !== "none" &&
                          d !== "custom_field" &&
                          d !== showing.query.dimension,
                      )
                      .slice(0, 4)
                      .map((d): [string, string] => [d, dimensionLabel(d)]),
                  ]}
                  onPick={(breakdown) =>
                    patch({
                      query: {
                        ...showing.query,
                        breakdown: breakdown as Dimension,
                      },
                    })
                  }
                />
              </>
            )}

            {wantsRows && (
              <>
                <div>
                  <Label>Fields</Label>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {catalog.map((f) => {
                      const on = showing.fields.includes(f.key);
                      return (
                        <button
                          key={f.key}
                          type="button"
                          aria-pressed={on}
                          onClick={() =>
                            patch({
                              fields: on
                                ? showing.fields.filter((k) => k !== f.key)
                                : [...showing.fields, f.key],
                            })
                          }
                          className={cn(
                            "rounded-full px-2.5 py-1 text-xs transition-colors",
                            on
                              ? "bg-foreground text-background"
                              : "bento-tile text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {f.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <Choice
                  label="Ordered by"
                  value={showing.query.sort}
                  options={[
                    ["manual", "Default"],
                    ["due", "Due date"],
                    ["priority", "Priority"],
                    ["created", "Newest"],
                    ["title", "Name"],
                  ]}
                  onPick={(sort) =>
                    patch({
                      query: { ...showing.query, sort: sort as never },
                    })
                  }
                />
              </>
            )}

            {!wantsScalar && (
              <label className="block">
                <span className="flex items-baseline justify-between">
                  <Label>How many</Label>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {showing.query.limit}
                  </span>
                </span>
                <input
                  type="range"
                  min={1}
                  max={50}
                  value={showing.query.limit}
                  aria-label="How many"
                  onChange={(e) =>
                    patch({
                      query: {
                        ...showing.query,
                        limit: Number.parseInt(e.currentTarget.value, 10),
                      },
                    })
                  }
                  className="mt-2 w-full accent-foreground"
                />
              </label>
            )}
          </Chapter>

          {/* ── What it looks like ── */}
          <Chapter title="What it looks like">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {STYLE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  title={preset.description}
                  onClick={() => patch({ style: preset.patch })}
                  className="overflow-hidden rounded-lg bg-page p-2 text-left ring-1 ring-border transition-colors hover:ring-muted-foreground/40"
                >
                  <Chart
                    kind="column"
                    series={MINI}
                    style={{
                      ...DEFAULT_STYLE,
                      ...normalizeStylePatch(preset.patch),
                    }}
                    unit="count"
                    width={110}
                    height={36}
                    label={preset.name}
                  />
                  <span className="mt-1 block truncate text-[11px] font-medium">
                    {preset.name}
                  </span>
                </button>
              ))}
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Every other detail — frame, colour, grid, bars — is changed by
              pointing at the panel once it&apos;s on your screen, over your own
              data.
            </p>
          </Chapter>

          {/* One sentence reaches all three chapters. */}
          <IntentComposer
            def={def}
            label="this panel"
            onPreview={setProposed}
            onCommit={(next) => {
              setProposed(null);
              setDef(next);
            }}
          />

          <p className="text-xs leading-relaxed text-muted-foreground">
            {describePanel(showing)}
          </p>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                void create({ scopeType, scopeId, definition: showing })
                  .then((id) => {
                    setOpen(false);
                    setProposed(null);
                    setDef(blankPanelFor("tasks"));
                    onCreated(id as string);
                    toast("Panel added to this screen");
                  })
                  .catch((e) =>
                    toast(errorMessage(e, "Couldn't create that panel"), {
                      kind: "error",
                    }),
                  );
              }}
            >
              Add to screen
            </Button>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>

        {/* Not a mockup — the panel itself, running the query it will run. */}
        <div className="min-w-0">
          <Label>Preview</Label>
          <div className="mt-2 lg:sticky lg:top-4">
            <Panel
              definition={showing}
              scopeType={scopeType}
              scopeId={scopeId}
              className="min-h-[13rem]"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Merge one filter key without blanking the rest. */
function filterPatch(
  patch: (next: Record<string, unknown>) => void,
  def: PanelDef,
  next: Record<string, unknown>,
) {
  patch({ query: { ...def.query, filter: { ...def.query.filter, ...next } } });
}

/**
 * A shape, drawn.
 *
 * Charts render through the same code the panel uses, so a specimen cannot
 * drift from what choosing it produces. The record shapes have no chart to
 * draw, so they are drawn as what they are: ruled lines, a header and rows,
 * two cards, three columns.
 */
function ShapeSpecimen({ shape }: { shape: PanelShape }) {
  const style = normalizeStyle({ grid: "none", axes: "none", padding: "tight" });

  if (isChartShape(shape)) {
    return (
      <Chart
        kind={shape as ChartKind}
        series={MINI}
        style={style}
        unit="count"
        width={90}
        height={34}
        label={shapeLabel(shape)}
      />
    );
  }

  const bar = "block rounded-full bg-muted-foreground/30";
  return (
    <span aria-hidden className="flex h-[34px] w-full flex-col justify-center gap-1">
      {shape === "metric" || shape === "metric_spark" ? (
        <>
          <span className="block text-base font-medium leading-none tabular-nums">
            24
          </span>
          {shape === "metric_spark" && (
            <span className={cn(bar, "h-0.5 w-full")} />
          )}
        </>
      ) : shape === "table" ? (
        <>
          <span className="flex gap-1">
            <span className={cn(bar, "h-1 flex-1")} />
            <span className={cn(bar, "h-1 w-4")} />
            <span className={cn(bar, "h-1 w-3")} />
          </span>
          <span className="flex gap-1">
            <span className={cn(bar, "h-1 flex-1 opacity-60")} />
            <span className={cn(bar, "h-1 w-4 opacity-60")} />
            <span className={cn(bar, "h-1 w-3 opacity-60")} />
          </span>
          <span className="flex gap-1">
            <span className={cn(bar, "h-1 flex-1 opacity-60")} />
            <span className={cn(bar, "h-1 w-4 opacity-60")} />
            <span className={cn(bar, "h-1 w-3 opacity-60")} />
          </span>
        </>
      ) : shape === "cards" ? (
        <span className="flex gap-1">
          <span className="h-[26px] flex-1 rounded bg-muted-foreground/20" />
          <span className="h-[26px] flex-1 rounded bg-muted-foreground/20" />
        </span>
      ) : shape === "board" || shape === "sprint_board" ? (
        <span className="flex gap-1">
          <span className="h-[26px] flex-1 rounded bg-muted-foreground/25" />
          <span className="h-[26px] flex-1 rounded bg-muted-foreground/15" />
          <span className="h-[26px] flex-1 rounded bg-muted-foreground/20" />
        </span>
      ) : shape === "roadmap" ? (
        <>
          <span className={cn(bar, "h-1.5 w-3/4")} />
          <span className={cn(bar, "ml-3 h-1.5 w-1/2")} />
          <span className={cn(bar, "ml-6 h-1.5 w-1/3")} />
        </>
      ) : shape === "workload" ? (
        <>
          <span className={cn(bar, "h-1.5 w-full")} />
          <span className={cn(bar, "h-1.5 w-2/3")} />
          <span className={cn(bar, "h-1.5 w-1/3")} />
        </>
      ) : (
        <>
          <span className={cn(bar, "h-1 w-full")} />
          <span className={cn(bar, "h-1 w-4/5")} />
          <span className={cn(bar, "h-1 w-3/5")} />
        </>
      )}
    </span>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </span>
  );
}

function Chapter({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <span className="block border-b border-border/60 pb-1.5 text-xs font-medium">
        {title}
      </span>
      {children}
    </section>
  );
}

function Choice({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onPick: (value: string) => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      {/* Scrolls inside itself rather than panning the page — some of these
          lists are eleven long. */}
      <div className="segmented mt-2 w-full overflow-x-auto">
        {options.map(([v, text]) => (
          <button
            key={v}
            type="button"
            aria-pressed={value === v}
            onClick={() => onPick(v)}
            className={cn(
              "min-w-0 flex-1 whitespace-nowrap px-2 py-1.5 text-xs",
              value === v && "segmented-on",
            )}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function Toggle({
  label,
  on,
  onToggle,
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      className={cn(
        "rounded-full px-3 py-1.5 text-xs transition-colors",
        on
          ? "bg-foreground text-background"
          : "bento-tile text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
