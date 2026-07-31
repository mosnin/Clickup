"use client";

import { useMemo, useState } from "react";
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
import { cn } from "@/lib/utils";
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

/**
 * The expanded state: one choice at a time.
 *
 * The structure is a phone's set-up flow, because that is the only mass-market
 * pattern that has ever made configuration feel finished: one question on the
 * screen, one row of full-size options on the centre axis, dots underneath,
 * and the thing you are choosing named once, large, in one place. Chapters —
 * colour, cards, chart — are steps you move between, never sections stacked
 * down a page. Everything sits on one vertical axis; symmetry is the layout
 * rule, not a styling touch.
 */
function StudioScreen() {
  const { selection, select, setActive } = useCustomize();
  const { style, commit, reset, dirty, revert } = useComponentStyle(
    selection?.id ?? null,
  );
  const scope = selection ? ("panel" as const) : ("personal" as const);
  const [chapter, setChapter] = useState<"colour" | "cards" | "chart">(
    "colour",
  );
  const [centred, setCentred] = useState<string | null>(null);

  const chapters = [
    { id: "colour" as const, label: "Colour" },
    { id: "cards" as const, label: "Card" },
    { id: "chart" as const, label: "Chart" },
  ];

  return (
    <ExpandableScreenContent
      className="bg-foreground text-background"
      showCloseButton={false}
    >
      <div className="flex h-full min-h-[calc(100vh-1.5rem)] flex-col items-center px-6 py-8 text-center">
        {/* The step you are on. Centred, because everything here is. */}
        <Rise delay={0}>
          <div className="segmented" role="tablist" aria-label="Choosing">
            {chapters.map((c) => (
              <button
                aria-selected={chapter === c.id}
                className={cn(
                  "px-4 py-1.5 text-xs",
                  chapter === c.id && "segmented-on",
                )}
                key={c.id}
                onClick={() => {
                  setChapter(c.id);
                  setCentred(null);
                }}
                role="tab"
                type="button"
              >
                {c.label}
              </button>
            ))}
          </div>
          <p className="mt-3 text-sm text-background/60">
            {selection
              ? `Styling ${selection.label} — picks land on it instantly.`
              : "Styling every panel. Close and click one to style it alone."}
          </p>
        </Rise>

        {/* ONE carousel, filling the middle of the screen. Re-keyed per
            chapter so switching is an arrival, not a repaint. */}
        <div className="flex w-full max-w-6xl flex-1 flex-col justify-center">
          <Rise delay={0.1} key={chapter + (selection?.id ?? "all")}>
            {chapter === "colour" && (
              <HeroShelf
                centred={centred}
                items={STYLE_ENUMS.palette.map((palette) => ({
                  id: palette,
                  label: palette[0].toUpperCase() + palette.slice(1),
                  render: () => (
                    <span className="pointer-events-none block rounded-3xl bg-background p-5 text-foreground shadow-2xl">
                      <Chart
                        height={150}
                        kind="column"
                        label={palette}
                        series={SPECIMEN}
                        style={normalizeStyle({ ...style, palette })}
                        unit="count"
                      />
                      <span
                        aria-hidden
                        className="mt-4 flex h-3.5 w-full overflow-hidden rounded-full"
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
                onCentred={setCentred}
                onPick={(palette) =>
                  commit(
                    {
                      palette:
                        palette as (typeof STYLE_ENUMS.palette)[number],
                    },
                    scope,
                  )
                }
                selectedId={style.palette}
              />
            )}

            {chapter === "cards" && (
              <HeroShelf
                centred={centred}
                items={CARD_PRESETS.map((preset) => ({
                  id: preset.id,
                  label: preset.name,
                  hint: preset.description,
                  render: () => (
                    <span className="pointer-events-none block rounded-3xl bg-background p-5 text-foreground shadow-2xl">
                      <PanelPreview
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
                label="Card"
                onCentred={setCentred}
                onPick={(id) => {
                  const preset = CARD_PRESETS.find((p) => p.id === id);
                  if (preset)
                    commit(normalizeStylePatch(preset.patch), scope);
                }}
              />
            )}

            {chapter === "chart" &&
              (selection ? (
                <ShapeShelf
                  centred={centred}
                  onCentred={setCentred}
                  selectionId={selection.id}
                  style={style}
                />
              ) : (
                <HeroShelf
                  centred={centred}
                  items={CHART_PRESETS.map((preset) => ({
                    id: preset.id,
                    label: preset.name,
                    hint: preset.description,
                    render: () => (
                      <span className="pointer-events-none block rounded-3xl bg-background p-5 text-foreground shadow-2xl">
                        <Chart
                          height={170}
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
                  label="Chart"
                  onCentred={setCentred}
                  onPick={(id) => {
                    const preset = CHART_PRESETS.find((p) => p.id === id);
                    if (preset)
                      commit(normalizeStylePatch(preset.patch), scope);
                  }}
                />
              ))}
          </Rise>
        </div>

        <Rise delay={0.18}>
          <footer className="flex items-center justify-center gap-5">
            {dirty && <ScreenLink onClick={revert}>Undo</ScreenLink>}
            {selection && (
              <ScreenLink onClick={() => select(null)}>All panels</ScreenLink>
            )}
            <ScreenLink onClick={() => reset(scope)}>
              {selection ? "Match the others" : "Defaults"}
            </ScreenLink>
            <CollapseButton />
            <ScreenLink onClick={() => setActive(false)}>Done</ScreenLink>
          </footer>
        </Rise>
      </div>
    </ExpandableScreenContent>
  );
}

/**
 * One shelf plus the one place its centred item is named.
 *
 * The caption lives here, under the dots, large and alone — never on the
 * cards. Fifty labels moving past is a list; one label that changes as the
 * shelf settles is a choice.
 */
function HeroShelf({
  items,
  selectedId,
  onPick,
  onCentred,
  centred,
  label,
}: {
  items: { id: string; label: string; hint?: string; render: () => React.ReactNode }[];
  selectedId?: string;
  onPick: (id: string) => void;
  onCentred: (id: string) => void;
  centred: string | null;
  label: string;
}) {
  const current = items.find((i) => i.id === centred) ?? items[0];
  return (
    <div>
      <StyleCarousel
        hero
        itemWidth={340}
        items={items}
        label={label}
        onCentred={onCentred}
        onPick={onPick}
        selectedId={selectedId}
        tone="dark"
      />
      <div aria-live="polite" className="mt-5 min-h-[3.25rem]">
        <p className="text-lg font-semibold">{current?.label}</p>
        {current?.hint && (
          <p className="mx-auto mt-1 max-w-md text-sm text-background/60">
            {current.hint}
          </p>
        )}
      </div>
    </div>
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
  centred,
  onCentred,
}: {
  selectionId: string;
  style: ReturnType<typeof useComponentStyle>["style"];
  centred: string | null;
  onCentred: (id: string) => void;
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
      <p className="mx-auto max-w-md py-8 text-sm leading-relaxed text-background/60">
        This panel is built in, so its shape is fixed — colour and card still
        change how it looks.
      </p>
    );
  }

  const shapes = shapesFor(stored.query.from).filter(isChartShape);

  return (
    <HeroShelf
      centred={centred}
      items={shapes.map((shape) => ({
        id: shape,
        label: shapeLabel(shape),
        render: () => (
          <span className="pointer-events-none block rounded-3xl bg-background p-5 text-foreground shadow-2xl">
            <Chart
              height={170}
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
      onCentred={onCentred}
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
    />
  );
}
