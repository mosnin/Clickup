"use client";

import { Button } from "@/components/ui/button";
import { StudioChrome } from "@/components/appearance/studio-chrome";
import {
  ChartKindTile,
  GalleryTile,
  PaletteTile,
  PanelPreview,
  specimenFor,
  styleFrom,
} from "@/components/appearance/style-gallery";
import { Chart, type ChartKind } from "@/components/charts/chart";
import { useComponentStyle } from "@/components/appearance/use-component-style";
import {
  STYLE_ENUMS,
  STYLE_RANGES,
  type Axes,
  type BarShape,
  type BarWidth,
  type ChartFill,
  type Curve,
  type DataLabels,
  type Grid,
  type Legend,
  type Markers,
  type Palette,
  type StackMode,
  type StyleKey,
} from "@/lib/component-style";
import { cn } from "@/lib/utils";

// The Charts chapter.
//
// What was here before was four grey bars beside the word "Ruled" and a lonely
// 62% ring — options that looked like loading skeletons and told you nothing
// about what picking them would do. Every tile on this page is now the real
// `<Chart>` running the real style, at roughly the size a panel draws at. If a
// palette looks wrong here it looks wrong in the app, because it is the same
// code path with the same numbers.
//
// Density is deliberate. A gallery is for comparing, and comparing means
// seeing them at once — the previous layout gave four options the full width
// of the page and you had to scroll to hold two of them in your head.

const KIND_LABELS: [ChartKind, string][] = [
  ["column", "Column"],
  ["bar", "Bar"],
  ["line", "Line"],
  ["area", "Area"],
  ["donut", "Donut"],
  ["pie", "Pie"],
  ["radial", "Dial"],
  ["scatter", "Scatter"],
  ["waterfall", "Waterfall"],
  ["treemap", "Treemap"],
  ["sparkline", "Sparkline"],
];

export function ChartsStudio() {
  const { style, sources, commit, preview, clear, reset, dirty, revert } =
    useComponentStyle();

  const set = (patch: Parameters<typeof commit>[0]) => commit(patch, "personal");

  /** A row of options, each drawn with the setting applied. */
  function Row<T extends string>({
    label,
    hint,
    keyName,
    options,
    render,
    columns = 4,
  }: {
    label: string;
    hint?: string;
    keyName: StyleKey;
    options: readonly T[];
    render: (value: T) => React.ReactNode;
    columns?: number;
  }) {
    const owned = sources[keyName] !== "default";
    return (
      <section>
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-medium">{label}</h2>
            {hint && (
              <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">
                {hint}
              </p>
            )}
          </div>
          {owned && (
            <button
              type="button"
              onClick={() => clear([keyName], "personal")}
              className="flex-shrink-0 text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
            >
              Reset
            </button>
          )}
        </div>
        <div
          className={cn(
            "mt-3 grid gap-2",
            columns === 6
              ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6"
              : columns === 5
                ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"
                : "grid-cols-2 sm:grid-cols-4",
          )}
        >
          {options.map((value) => (
            <GalleryTile
              key={value}
              selected={(style[keyName] as unknown as T) === value}
              label={titleCase(value)}
              onPick={() => set({ [keyName]: value })}
            >
              {render(value)}
            </GalleryTile>
          ))}
        </div>
      </section>
    );
  }

  /** A miniature chart with one axis of the style overridden. */
  const mini = (patch: Parameters<typeof styleFrom>[0], kind: ChartKind = "column") => (
    <Chart
      kind={kind}
      series={specimenFor(kind)}
      style={styleFrom(patch, style)}
      unit="count"
      width={150}
      height={68}
      label="Example"
    />
  );

  return (
    <StudioChrome
      base="/dashboard/appearance"
      title="Charts"
      context="Every tile here is a real chart drawn with the setting applied — the same component the app uses, with the same numbers. Picking one changes every chart on every screen; a panel can still override it for itself."
      actions={
        <div className="flex items-center gap-2">
          {dirty && (
            <Button variant="outline" size="sm" onClick={revert}>
              Undo
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => reset("personal")}>
            Reset charts
          </Button>
        </div>
      }
    >
      <div className="space-y-10">
        {/* The live article, at panel size, so the page is anchored by the
            thing it is about rather than by a row of thumbnails. */}
        <section>
          <h2 className="text-sm font-medium">Right now</h2>
          <div className="mt-3 grid gap-4 lg:grid-cols-3">
            <PanelPreview style={style} title="Throughput" kind="column" />
            <PanelPreview style={style} title="By status" kind="donut" />
            <PanelPreview style={style} title="Velocity" kind="area" />
          </div>
        </section>

        <section>
          <div className="flex items-baseline justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium">Palette</h2>
              <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">
                Ink is computed from the theme, so it is correct in light and
                dark. The rest are fixed hues — a palette called vivid that
                adapted to the theme would not be vivid.
              </p>
            </div>
            {sources.palette !== "default" && (
              <button
                type="button"
                onClick={() => clear(["palette"], "personal")}
                className="flex-shrink-0 text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
              >
                Reset
              </button>
            )}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {(STYLE_ENUMS.palette as readonly Palette[]).map((palette) => (
              <PaletteTile
                key={palette}
                palette={palette}
                base={style}
                selected={style.palette === palette}
                onPick={() => set({ palette })}
              />
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-sm font-medium">Default chart</h2>
          <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">
            What a new panel starts as. Every kind draws the same numbers, so
            this row is a fair comparison rather than eleven different stories.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {KIND_LABELS.map(([kind, label]) => (
              <ChartKindTile
                key={kind}
                kind={kind}
                label={label}
                base={style}
                selected={false}
                onPick={() => {
                  // Choosing a kind here is a preview of the vocabulary, not a
                  // global setting: which chart a panel is belongs to that
                  // panel. Selecting one shows it at size above.
                }}
              />
            ))}
          </div>
        </section>

        <Row<ChartFill>
          label="Fill"
          hint="How a bar, an area or a wedge is filled in."
          keyName="chartFill"
          options={STYLE_ENUMS.chartFill}
          render={(chartFill) => mini({ chartFill }, "area")}
        />

        <Row<Curve>
          label="Curve"
          hint="Smooth passes exactly through every reading; step is the honest shape for a value that jumps."
          keyName="curve"
          options={STYLE_ENUMS.curve}
          render={(curve) => mini({ curve, markers: "dot" }, "line")}
          columns={4}
        />

        <Row<BarShape>
          label="Bar shape"
          keyName="barShape"
          options={STYLE_ENUMS.barShape}
          render={(barShape) => mini({ barShape })}
        />

        <Row<BarWidth>
          label="Bar width"
          keyName="barWidth"
          options={STYLE_ENUMS.barWidth}
          render={(barWidth) => mini({ barWidth })}
        />

        <Row<StackMode>
          label="Multiple series"
          hint="Stacked shows the total, grouped compares the parts, percent compares the mix."
          keyName="stackMode"
          options={STYLE_ENUMS.stackMode}
          render={(stackMode) => mini({ stackMode })}
        />

        <Row<Axes>
          label="Axes"
          keyName="axes"
          options={STYLE_ENUMS.axes}
          render={(axes) => mini({ axes })}
        />

        <Row<Grid>
          label="Grid"
          keyName="grid"
          options={STYLE_ENUMS.grid}
          render={(grid) => mini({ grid })}
        />

        <Row<DataLabels>
          label="Numbers on the marks"
          keyName="dataLabels"
          options={STYLE_ENUMS.dataLabels}
          render={(dataLabels) => mini({ dataLabels })}
          columns={4}
        />

        <Row<Markers>
          label="Points on a line"
          keyName="markers"
          options={STYLE_ENUMS.markers}
          render={(markers) => mini({ markers }, "line")}
          columns={4}
        />

        <Row<Legend>
          label="Legend"
          keyName="legend"
          options={STYLE_ENUMS.legend}
          render={(legend) => mini({ legend, stackMode: "grouped" })}
          columns={4}
        />

        <section>
          <div className="flex items-baseline justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium">Donut hole</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Zero is a pie. Wide enough and the total fits in the middle.
              </p>
            </div>
            <span className="font-mono text-[11px] text-muted-foreground">
              {Math.round(style.donutHole * 100)}%
            </span>
          </div>
          <div className="mt-3 flex items-center gap-5">
            <span className="flex-shrink-0">
              <Chart
                kind="donut"
                series={specimenFor("donut")}
                style={style}
                unit="count"
                width={120}
                height={120}
                label="Donut"
              />
            </span>
            <input
              type="range"
              min={STYLE_RANGES.donutHole[0]}
              max={STYLE_RANGES.donutHole[1]}
              step={0.01}
              value={style.donutHole}
              aria-label="Donut hole"
              onChange={(e) =>
                preview({ donutHole: Number.parseFloat(e.currentTarget.value) })
              }
              onPointerUp={() => set({ donutHole: style.donutHole })}
              onKeyUp={() => set({ donutHole: style.donutHole })}
              className="w-full accent-foreground"
            />
          </div>
        </section>
      </div>
    </StudioChrome>
  );
}

function titleCase(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}
