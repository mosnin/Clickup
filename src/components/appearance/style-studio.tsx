"use client";

import { useMemo } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { X } from "lucide-react";
import { SPRING } from "@/components/motion";
import {
  ExpandableScreen,
  ExpandableScreenContent,
  ExpandableScreenTrigger,
  useExpandableScreen,
} from "@/components/cult/expandable-screen";
import {
  DynamicIsland,
  DynamicIslandProvider,
  SIZE_PRESETS,
  useDynamicIslandSize,
} from "@/components/cult/dynamic-island";
import { useCustomize } from "@/components/appearance/customize-provider";
import { useComponentStyle } from "@/components/appearance/use-component-style";
import { PanelPreview } from "@/components/appearance/style-gallery";
import { StyleCarousel } from "@/components/appearance/style-carousel";
import { Chart, type ChartKind } from "@/components/charts/operate/chart";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import {
  CARD_PRESETS,
  CHART_PRESETS,
  STYLE_ENUMS,
  normalizeStyle,
  normalizeStylePatch,
  paletteColors,
} from "@/lib/component-style";
import {
  isChartShape,
  normalizePanel,
  panelIdFromWidgetId,
  shapeLabel,
  shapesFor,
  type PanelDef,
  type PanelShape,
} from "@/lib/panel";

// The studio, as an island.
//
// Customising lives in a small floating island at the bottom of the screen.
// Tap it and it MORPHS — one shared element, not a dialog appearing — into a
// full screen of shelves: colours, cards, chart shapes, each a carousel of
// the real component that rises into place with depth as the screen opens.
// Close it and it shrinks back to the island. Open and closed at will, and
// the island is never in the way of the work.
//
// Why two states rather than one sheet:
//
// **Collapsed is for pointing.** The page is fully reachable with the island
// up, so you click the panel you mean and the island narrates the scope
// ("Styling: Throughput"). A control that floats over your work has to earn
// its pixels; a one-line island does, a third-of-the-screen sheet does not.
//
// **Expanded is for choosing.** Shelves want width and attention — the
// reference for this screen is a wallet of cards, not a settings page — so
// choosing gets the whole viewport, on the app's ink, with the carousels
// staggering in. Every pick still lands on the real panels instantly; the
// screen closes with one tap to see them.
//
// The island's size machine (the vendored cult-ui component) is what makes
// the collapsed state feel alive: it stretches between compact and long as
// the selection changes, on the same spring the rest of the app uses.

const SPECIMEN = [
  {
    key: "a",
    label: "Shipped",
    points: [
      { key: "mon", label: "Mon", value: 6 },
      { key: "tue", label: "Tue", value: 10 },
      { key: "wed", label: "Wed", value: 4 },
      { key: "thu", label: "Thu", value: 12 },
      { key: "fri", label: "Fri", value: 8 },
    ],
  },
  {
    key: "b",
    label: "Open",
    points: [
      { key: "mon", label: "Mon", value: 3 },
      { key: "tue", label: "Tue", value: 5 },
      { key: "wed", label: "Wed", value: 7 },
      { key: "thu", label: "Thu", value: 4 },
      { key: "fri", label: "Fri", value: 6 },
    ],
  },
];

export function StyleStudio() {
  const { active } = useCustomize();
  if (!active) return null;
  return (
    <DynamicIslandProvider initialSize={SIZE_PRESETS.COMPACT}>
      <ExpandableScreen layoutId="style-studio" lockScroll={false}>
        <StudioIsland />
        <StudioScreen />
      </ExpandableScreen>
    </DynamicIslandProvider>
  );
}

/** The collapsed state: a floating island that names the scope and opens. */
function StudioIsland() {
  const { selection, setActive } = useCustomize();
  const { style } = useComponentStyle(selection?.id ?? null);
  const { setSize } = useDynamicIslandSize();

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center">
      <div className="pointer-events-auto relative">
        <ExpandableScreenTrigger className="[&>div:first-child]:bg-foreground">
          <DynamicIsland id="style-island">
            <button
              className="flex h-full w-full items-center justify-center gap-2.5 px-4 text-background"
              onClick={() =>
                // Stretch as it opens, so the morph starts from motion
                // rather than from a static pill.
                setSize(SIZE_PRESETS.COMPACT_LONG)
              }
              type="button"
            >
              <span
                aria-hidden
                className="flex h-2.5 w-8 overflow-hidden rounded-full"
              >
                {paletteColors(style.palette).map((color, i) => (
                  <span
                    className="flex-1"
                    key={i}
                    style={{ background: color }}
                  />
                ))}
              </span>
              <span className="whitespace-nowrap text-xs font-medium">
                {selection ? `Styling: ${selection.label}` : "Style"}
              </span>
            </button>
          </DynamicIsland>
        </ExpandableScreenTrigger>
        <button
          aria-label="Done styling"
          className="pointer-events-auto absolute -right-9 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-foreground/90 text-background shadow-md"
          onClick={() => setActive(false)}
          type="button"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/** The expanded state: the island, unfolded into a screen of shelves. */
function StudioScreen() {
  const { selection, select, setActive } = useCustomize();
  const { style, commit, reset, dirty, revert } = useComponentStyle(
    selection?.id ?? null,
  );
  const scope = selection ? ("panel" as const) : ("personal" as const);

  return (
    <ExpandableScreenContent
      className="bg-foreground text-background"
      showCloseButton={false}
    >
      <div className="mx-auto flex min-h-full max-w-5xl flex-col gap-2 px-6 py-10">
        <Rise delay={0}>
          <header className="flex items-baseline justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">
                {selection ? selection.label : "Every panel"}
              </h2>
              <p className="mt-1 text-sm text-background/60">
                {selection
                  ? "Everything below lands on this panel the moment you pick it."
                  : "These set the look of every panel. Close and click one to style it alone."}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {dirty && <ScreenLink onClick={revert}>Undo</ScreenLink>}
              {selection && (
                <ScreenLink onClick={() => select(null)}>All panels</ScreenLink>
              )}
              <ScreenLink onClick={() => reset(scope)}>
                {selection ? "Match the others" : "Defaults"}
              </ScreenLink>
              <CollapseButton />
            </div>
          </header>
        </Rise>

        <Rise delay={0.08}>
          <Shelf title="Colour">
            <StyleCarousel
              itemWidth={230}
              items={STYLE_ENUMS.palette.map((palette) => ({
                id: palette,
                label: palette[0].toUpperCase() + palette.slice(1),
                render: () => (
                  <span className="pointer-events-none block rounded-2xl bg-background p-3 text-foreground">
                    <Chart
                      height={84}
                      kind="column"
                      label={palette}
                      series={SPECIMEN}
                      style={normalizeStyle({ ...style, palette })}
                      unit="count"
                    />
                    <span
                      aria-hidden
                      className="mt-2.5 flex h-3 w-full overflow-hidden rounded-full"
                    >
                      {paletteColors(palette).map((color, i) => (
                        <span
                          className="flex-1"
                          key={i}
                          style={{ background: color }}
                        />
                      ))}
                    </span>
                  </span>
                ),
              }))}
              label="Colour"
              onPick={(palette) =>
                commit(
                  { palette: palette as (typeof STYLE_ENUMS.palette)[number] },
                  scope,
                )
              }
              selectedId={style.palette}
              tone="dark"
            />
          </Shelf>
        </Rise>

        <Rise delay={0.16}>
          <Shelf title="Cards">
            <StyleCarousel
              itemWidth={250}
              items={CARD_PRESETS.map((preset) => ({
                id: preset.id,
                label: preset.name,
                hint: preset.description,
                render: () => (
                  <span className="pointer-events-none block rounded-2xl bg-background p-3 text-foreground">
                    <PanelPreview
                      compact
                      kind="column"
                      style={normalizeStyle({
                        ...style,
                        ...normalizeStylePatch(preset.patch),
                      })}
                      title="Throughput"
                    />
                  </span>
                ),
              }))}
              label="Cards"
              onPick={(id) => {
                const preset = CARD_PRESETS.find((p) => p.id === id);
                if (preset) commit(normalizeStylePatch(preset.patch), scope);
              }}
              tone="dark"
            />
          </Shelf>
        </Rise>

        <Rise delay={0.24}>
          {selection ? (
            <Shelf title="Drawn as">
              <ShapeShelf selectionId={selection.id} style={style} />
            </Shelf>
          ) : (
            <Shelf title="Charts">
              <StyleCarousel
                itemWidth={250}
                items={CHART_PRESETS.map((preset) => ({
                  id: preset.id,
                  label: preset.name,
                  hint: preset.description,
                  render: () => (
                    <span className="pointer-events-none block rounded-2xl bg-background p-3 text-foreground">
                      <Chart
                        height={90}
                        kind="column"
                        label={preset.name}
                        series={SPECIMEN}
                        style={normalizeStyle({
                          ...style,
                          ...normalizeStylePatch(preset.patch),
                        })}
                        unit="count"
                      />
                    </span>
                  ),
                }))}
                label="Chart looks"
                onPick={(id) => {
                  const preset = CHART_PRESETS.find((p) => p.id === id);
                  if (preset) commit(normalizeStylePatch(preset.patch), scope);
                }}
                tone="dark"
              />
            </Shelf>
          )}
        </Rise>

        <Rise delay={0.3}>
          <footer className="mt-auto flex items-center justify-between pt-4">
            <ScreenLink onClick={() => setActive(false)}>
              Done styling
            </ScreenLink>
            <Link
              className="text-xs text-background/50 underline decoration-dotted underline-offset-2 hover:text-background"
              href="/dashboard/appearance"
              onClick={() => setActive(false)}
            >
              Type, navigation and motion →
            </Link>
          </footer>
        </Rise>
      </div>
    </ExpandableScreenContent>
  );
}

/** The reference entrance: rise, sharpen, settle — staggered per shelf. */
function Rise({
  delay,
  children,
}: {
  delay: number;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      initial={{ opacity: 0, y: 28, filter: "blur(6px)" }}
      transition={{ ...SPRING, delay: 0.15 + delay }}
    >
      {children}
    </motion.div>
  );
}

function Shelf({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="px-1 text-[11px] font-medium uppercase tracking-wider text-background/50">
        {title}
      </h3>
      {children}
    </section>
  );
}

function ScreenLink({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className="text-xs text-background/60 underline decoration-dotted underline-offset-2 hover:text-background"
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

/** Collapse back to the island — the screen's one way out. */
function CollapseButton() {
  const { collapse } = useExpandableScreen();
  return (
    <button
      aria-label="Back to the island"
      className="flex h-9 w-9 items-center justify-center rounded-full bg-background/10 text-background transition-colors hover:bg-background/20"
      onClick={collapse}
      type="button"
    >
      <X className="h-4 w-4" />
    </button>
  );
}

/**
 * Every shape this panel's question can be drawn as, live, one click each.
 * Writes the panel's definition — the builder's write — because "draw it as
 * rings" changes what the panel is, not a preference about it.
 */
function ShapeShelf({
  selectionId,
  style,
}: {
  selectionId: string;
  style: ReturnType<typeof useComponentStyle>["style"];
}) {
  const componentId = useMemo(() => {
    const tail = selectionId.slice(selectionId.indexOf(":") + 1);
    return panelIdFromWidgetId(tail);
  }, [selectionId]);

  const row = useQuery(
    api.uiComponents.get,
    componentId ? { componentId } : "skip",
  );
  const update = useMutation(api.uiComponents.update);
  const { toast } = useToast();

  const stored = useMemo<PanelDef | null>(
    () => (row ? normalizePanel(row.definition) : null),
    [row],
  );

  if (!componentId || !row || !stored) {
    return (
      <p className="px-1 py-4 text-xs leading-relaxed text-background/50">
        This panel is built in, so its shape is fixed — colour and cards still
        change how it looks.
      </p>
    );
  }

  const shapes = shapesFor(stored.query.from).filter(isChartShape);

  return (
    <StyleCarousel
      itemWidth={230}
      items={shapes.map((shape) => ({
        id: shape,
        label: shapeLabel(shape),
        render: () => (
          <span className="pointer-events-none block rounded-2xl bg-background p-3 text-foreground">
            <Chart
              height={96}
              kind={shape as ChartKind}
              label={shapeLabel(shape)}
              series={SPECIMEN}
              style={style}
              unit="count"
            />
          </span>
        ),
      }))}
      label="Drawn as"
      onPick={(shape) => {
        const next = normalizePanel({ ...stored, shape: shape as PanelShape });
        void update({ componentId: row.componentId, definition: next }).catch(
          (e) =>
            toast(errorMessage(e, "Couldn't change the chart"), {
              kind: "error",
            }),
        );
      }}
      selectedId={stored.shape}
      tone="dark"
    />
  );
}
