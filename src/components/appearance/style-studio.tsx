"use client";

import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { ChevronUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EASE, SPRING } from "@/components/motion";
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
import {
  builderDef,
  shapeItems,
  useAddCard,
  useBuilderScope,
  useCardBuilder,
  watchItems,
} from "@/components/appearance/card-builder";
import { useComponentStyle } from "@/components/appearance/use-component-style";
import { StyleCarousel } from "@/components/appearance/style-carousel";
import { Chart, type ChartKind } from "@/components/charts/operate/chart";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import {
  frameClass,
  fillClass,
  cornerCss,
  padCss,
} from "@/components/appearance/style-gallery";
import { cn } from "@/lib/utils";
import {
  CARD_PRESETS,
  CHART_PRESETS,
  STYLE_ENUMS,
  normalizeStyle,
  normalizeStylePatch,
  paletteColors,
  type ComponentStyle,
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
// Collapsed: a floating island that names the scope and leaves the page
// reachable, so clicking a panel IS the scope selector. Tap it and it morphs
// into one screen asking one question — a single full-width carousel on the
// centre axis, dots beneath, the choice named once. Colour, Card and Chart
// are steps you move between, never sections stacked down a page.
//
// Three rules this file answers for, each one a shipped failure:
//
// **The screen wears the app's theme.** It used to force an inverted ink
// canvas, so in dark mode the specimens rendered light — a different product
// stapled over this one. Every surface here is `bg-page`/`bg-card` tokens
// now; dark mode renders dark because there is nothing left to override.
//
// **The specimens are the library's own look.** Charts drawn over temporal
// buckets so the vendored library renders its own date axis, gradient fill
// and entrance reveal — not the same recoloured column chart eleven times.
//
// **Locking in is a moment.** The shelf snaps like a feed, and the card that
// arrives at centre re-mounts its chart, so the reveal animation replays as
// it locks — the settle is something you watch, not a scroll that stopped.

/** Fourteen days of buckets, so the library draws its own date axis. */
const DAYS = Array.from({ length: 14 }, (_, i) => ({
  key: String(Date.UTC(2025, 5, 2) + i * 86_400_000),
  label: "",
}));

const FLOW = [6, 9, 7, 12, 10, 14, 11, 16, 13, 18, 14, 19, 16, 21];
const EBB = [4, 3, 5, 4, 6, 5, 7, 8, 6, 9, 7, 10, 9, 11];

const SPECIMEN = [
  {
    key: "a",
    label: "Shipped",
    points: DAYS.map((d, i) => ({ ...d, value: FLOW[i] })),
  },
  {
    key: "b",
    label: "Open",
    points: DAYS.map((d, i) => ({ ...d, value: EBB[i] })),
  },
];

/** The card width: most of a phone, bounded on a desktop. */
const CARD_W = "min(76vw, 560px)";

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

/**
 * The collapsed state: the bar you get when you press Customise.
 *
 * It used to be a black lozenge reading "Style" beside a strip of colour, with
 * an unlabelled ✕ floating nine pixels off its right edge — and it was the
 * *entire* visible result of pressing Customise, so the honest report of it
 * was "it does this, and you have to click the thing at the bottom". Nothing
 * on it said what clicking would do, and the ✕ read as "dismiss this pill"
 * rather than "leave customising".
 *
 * So it says what it opens, and it rises in rather than appearing, because a
 * thing that arrives from somewhere is a thing the eye follows. The two verbs
 * are separate objects: what is left of the old ✕ is a labelled Done, beside
 * the bar rather than lying on top of whatever is behind it. Done cannot live
 * *inside* the trigger — every click in there expands the screen — which is
 * the real reason the original had it hovering outside.
 */
function StudioIsland() {
  const { selection, setActive } = useCustomize();
  const { style } = useComponentStyle(selection?.id ?? null);
  const { setSize } = useDynamicIslandSize();

  return (
    <motion.div
      animate={{ y: 0, opacity: 1 }}
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center gap-2 px-4"
      initial={{ y: 40, opacity: 0 }}
      transition={{ duration: 0.32, ease: EASE }}
    >
      <div className="pointer-events-auto">
        <ExpandableScreenTrigger className="[&>div:first-child]:bg-foreground">
          <DynamicIsland id="style-island">
            <button
              className="flex h-full w-full items-center justify-center gap-2.5 px-4 text-background"
              onClick={() => setSize(SIZE_PRESETS.COMPACT_LONG)}
              type="button"
            >
              <span
                aria-hidden
                className="flex h-2.5 w-8 shrink-0 overflow-hidden rounded-full"
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
                {selection ? `Style ${selection.label}` : "Style this screen"}
              </span>
              <ChevronUp aria-hidden className="h-3.5 w-3.5 shrink-0 opacity-70" />
            </button>
          </DynamicIsland>
        </ExpandableScreenTrigger>
      </div>
      <button
        className="pointer-events-auto shrink-0 self-center rounded-full bg-card px-3.5 py-2 text-xs font-medium shadow-md"
        onClick={() => setActive(false)}
        type="button"
      >
        Done
      </button>
    </motion.div>
  );
}

type Chapter = "colour" | "cards" | "chart" | "new";

/** The expanded state: one question, one carousel, the app's own theme. */
function StudioScreen() {
  const { selection, select, setActive } = useCustomize();
  const { style, commit, reset, dirty, revert } = useComponentStyle(
    selection?.id ?? null,
  );
  const scope = selection ? ("panel" as const) : ("personal" as const);
  const [chapter, setChapter] = useState<Chapter>("colour");
  const [centred, setCentred] = useState<string | null>(null);

  const chapters: { id: Chapter; label: string }[] = [
    { id: "colour", label: "Colour" },
    { id: "cards", label: "Card" },
    { id: "chart", label: "Chart" },
    { id: "new", label: "New card" },
  ];

  return (
    <ExpandableScreenContent
      className="bg-page text-foreground"
      showCloseButton={false}
    >
      <div className="flex min-h-[calc(100svh-1.5rem)] flex-col items-center px-0 py-6 text-center sm:py-8">
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
          {/* One plain question per chapter, and one plain sentence about
              what a pick does. The previous copy named the mechanism
              ("Styling every panel", "picks land on it instantly") without
              ever answering the two questions a person actually has: what am
              I choosing, and how do I keep it. */}
          <h2 className="mt-3 px-6 text-base font-semibold sm:text-lg">
            {chapter === "colour"
              ? "What colour is your data?"
              : chapter === "cards"
                ? "How should a card look?"
                : chapter === "chart"
                  ? "How should the numbers be drawn?"
                  : "What should your new card watch?"}
          </h2>
          <p className="mt-1 px-6 text-[13px] text-muted-foreground">
            {chapter === "new"
              ? "Every card here is running on your real work."
              : `Scroll to one and it's applied${
                  selection ? ` to ${selection.label}` : " everywhere"
                } — there's nothing to save.`}
          </p>
        </Rise>

        <div className="flex w-full flex-1 flex-col justify-center">
          <Rise delay={0.1} key={chapter + (selection?.id ?? "all")}>
            {chapter === "colour" && (
              <HeroShelf
                centred={centred}
                items={STYLE_ENUMS.palette.map((palette) => ({
                  id: palette,
                  label: palette[0].toUpperCase() + palette.slice(1),
                  render: (locked: boolean) => (
                    <SpecimenCard>
                      {/* Re-mounted as it locks (`key`), so the library's own
                          reveal replays on arrival — the feed-snap moment. */}
                      <Chart
                        height={260}
                        key={locked ? "locked" : "resting"}
                        kind="area"
                        label={palette}
                        series={SPECIMEN}
                        style={specimen(style, { palette })}
                        unit="count"
                      />
                      <span
                        aria-hidden
                        className="mt-4 flex h-3 w-full overflow-hidden rounded-full"
                      >
                        {paletteColors(palette).map((color, i) => (
                          <span
                            className="flex-1"
                            key={i}
                            style={{ background: color }}
                          />
                        ))}
                      </span>
                    </SpecimenCard>
                  ),
                }))}
                onCentred={setCentred}
                onPick={(palette) =>
                  commit(
                    {
                      palette: palette as (typeof STYLE_ENUMS.palette)[number],
                    },
                    scope,
                  )
                }
                selectedId={style.palette}
                title="Colour"
              />
            )}

            {chapter === "cards" && (
              <HeroShelf
                centred={centred}
                items={CARD_PRESETS.map((preset) => ({
                  id: preset.id,
                  label: preset.name,
                  hint: preset.description,
                  render: (locked: boolean) => (
                    <CardSpecimen
                      locked={locked}
                      style={normalizeStyle({
                        ...style,
                        ...normalizeStylePatch(preset.patch),
                      })}
                    />
                  ),
                }))}
                onCentred={setCentred}
                onPick={(id) => {
                  const preset = CARD_PRESETS.find((p) => p.id === id);
                  if (preset) commit(normalizeStylePatch(preset.patch), scope);
                }}
                title="Card"
              />
            )}

            {chapter === "new" && (
              <BuilderChapter centred={centred} onCentred={setCentred} />
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
                    render: (locked: boolean) => (
                      <SpecimenCard>
                        <Chart
                          height={260}
                          key={locked ? "locked" : "resting"}
                          kind={PRESET_KIND[preset.id] ?? "area"}
                          label={preset.name}
                          series={SPECIMEN}
                          style={specimen(
                            style,
                            normalizeStylePatch(preset.patch),
                          )}
                          unit="count"
                        />
                      </SpecimenCard>
                    ),
                  }))}
                  onCentred={setCentred}
                  onPick={(id) => {
                    const preset = CHART_PRESETS.find((p) => p.id === id);
                    if (preset)
                      commit(normalizeStylePatch(preset.patch), scope);
                  }}
                  title="Chart"
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
 * Each chart-look preset drawn as the kind that shows it off — the same
 * recoloured column eleven times is how good options read as slop.
 */
const PRESET_KIND: Record<string, ChartKind> = {
  editorial: "area",
  report: "column",
  deck: "column",
  console: "line",
  glass: "area",
  ledger: "bar",
  neon: "line",
  contrast: "column",
};

/** The base every specimen shares: the library's own expressive rendering. */
function specimen(
  base: ComponentStyle,
  patch: Partial<ComponentStyle>,
): ComponentStyle {
  return normalizeStyle({
    ...base,
    chartFill: "gradient",
    axes: "x",
    grid: "horizontal",
    ...patch,
  });
}

/** One card: the app's own surface, sized by the viewport. */
function SpecimenCard({ children }: { children: React.ReactNode }) {
  return (
    <span className="bento pointer-events-none block rounded-3xl bg-card p-5 text-left text-foreground sm:p-6">
      {children}
    </span>
  );
}

/**
 * The card chapter's specimen: a real panel frame, on a plinth.
 *
 * The plinth is the entire point and its absence was the bug. This chapter
 * changes the *frame* — a shadow, a hairline, a translucency, a radius — and
 * the previous version drew a 220px chart directly onto the screen's own
 * background, so eight genuinely different cards came out as eight identical
 * charts. Every distinguishing feature was either invisible (a shadow with
 * nothing to fall on, a translucency with nothing behind it) or crowded out by
 * a chart that dominated the card and never changed.
 *
 * So: the card sits on a page-coloured plinth, which is what gives a shadow
 * somewhere to land and glass something to frost; and the chart is small
 * enough that the padding, the corner and the title are what the eye lands
 * on — because they are what is being chosen.
 */
function CardSpecimen({
  style,
  locked,
}: {
  style: ComponentStyle;
  locked: boolean;
}) {
  return (
    /* `bento-tile` rather than `bg-page`: the studio screen is *itself* the
       page colour, so a page-coloured plinth on it is an invisible plinth —
       the design system's own nested-well surface is the one that separates. */
    <span className="bento-tile pointer-events-none block p-6 sm:p-8">
      <span
        className={cn(
          "block text-left",
          frameClass(style),
          fillClass(style),
        )}
        style={{ borderRadius: cornerCss(style), padding: padCss(style) }}
      >
        {style.titleStyle !== "hidden" && (
          <span
            className={cn(
              "block",
              style.titleAlign === "center" && "text-center",
              style.titleStyle === "micro" &&
                "text-[11px] font-medium uppercase tracking-wider text-muted-foreground",
              style.titleStyle === "plain" && "text-sm",
              style.titleStyle === "large" && "text-base font-medium",
              style.fill === "inverted" && "text-background",
            )}
          >
            Throughput
          </span>
        )}
        <span className="mt-2.5 block">
          <Chart
            height={132}
            key={locked ? "locked" : "resting"}
            kind="area"
            label="Throughput"
            series={SPECIMEN}
            style={style}
            unit="count"
          />
        </span>
      </span>
    </span>
  );
}

/**
 * One shelf plus the one place its centred item is named.
 *
 * **Coming to rest on a card chooses it.** The shelf snaps, scales the centred
 * card up, names it underneath and dims its neighbours — every signal it has
 * says "this one". It then used to require a *click* to actually apply, and
 * nothing on screen said so, so the honest report of this screen was "there's
 * no clear way to save it, they don't save, and none of the charts update".
 * They were saving fine; nobody had ever been told to click. A control that
 * looks chosen and isn't is worse than one that looks unavailable.
 *
 * Clicking still applies, immediately, for anyone who reaches for it.
 */
function HeroShelf({
  items,
  selectedId,
  onPick,
  onCentred,
  centred,
  title,
}: {
  items: {
    id: string;
    label: string;
    hint?: string;
    render: (locked: boolean) => React.ReactNode;
  }[];
  selectedId?: string;
  onPick: (id: string) => void;
  onCentred: (id: string) => void;
  centred: string | null;
  title: string;
}) {
  const restingId = centred ?? selectedId ?? items[0]?.id;
  const current = items.find((i) => i.id === restingId) ?? items[0];
  return (
    <div>
      <StyleCarousel
        hero
        itemWidth={CARD_W}
        items={items.map((item) => ({
          ...item,
          render: () => item.render(item.id === restingId),
        }))}
        label={title}
        onCentred={(id) => {
          onCentred(id);
          onPick(id);
        }}
        onPick={onPick}
        selectedId={selectedId}
      />
      <div aria-live="polite" className="mt-4 min-h-[4.25rem] px-6">
        <p className="text-lg font-semibold">{current?.label}</p>
        {current?.hint && (
          <p className="mx-auto mt-1 max-w-md text-[13px] text-muted-foreground">
            {current.hint}
          </p>
        )}
      </div>
    </div>
  );
}

/** The reference entrance: rise, sharpen, settle — staggered per block. */
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
      className="text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

/** Collapse back to the island — the screen's one way out besides Done. */
function CollapseButton() {
  const { collapse } = useExpandableScreen();
  return (
    <button
      aria-label="Back to the island"
      className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-foreground transition-colors hover:bg-muted/70"
      onClick={collapse}
      type="button"
    >
      <X className="h-4 w-4" />
    </button>
  );
}

/**
 * The new-card flow: two questions, then one button.
 *
 * Step one's shelf is finished starting points; step two is the chosen
 * question drawn every legal way. Every card on both shelves is the real
 * `<Panel>` on real data — see card-builder.tsx for why there is no naming
 * step and no field step.
 */
function BuilderChapter({
  centred,
  onCentred,
}: {
  centred: string | null;
  onCentred: (id: string) => void;
}) {
  const builder = useCardBuilder();
  const scope = useBuilderScope();
  const add = useAddCard(builder.back);

  if (!scope) {
    return (
      <p className="mx-auto max-w-md px-6 py-8 text-[13px] text-muted-foreground">
        Still connecting…
      </p>
    );
  }

  if (builder.step === "watch") {
    return (
      <HeroShelf
        centred={centred}
        items={watchItems(scope)}
        onCentred={onCentred}
        onPick={builder.pickPreset}
        title="What should it watch?"
      />
    );
  }

  const chosen = centred;
  const def = builderDef(
    builder.presetId,
    (chosen as never) ?? null,
  );

  return (
    <div>
      <HeroShelf
        centred={centred}
        items={shapeItems(builder.presetId!, scope)}
        onCentred={onCentred}
        onPick={(shape) => {
          const next = builderDef(builder.presetId, shape as never);
          if (next) add.add(next, scope);
        }}
        title="How should it be drawn?"
      />
      <div className="mt-3 flex items-center justify-center gap-4">
        <ScreenLink onClick={builder.back}>← Watch something else</ScreenLink>
        {def && (
          <Button
            onClick={() => add.add(def, scope)}
            size="sm"
          >
            Add &ldquo;{def.title}&rdquo;
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Every shape this panel's question can be drawn as, live, one click each.
 * Writes the panel's definition — "draw it as rings" changes what the panel
 * is, not a preference about it.
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
      <p className="mx-auto max-w-md px-6 py-8 text-[13px] leading-relaxed text-muted-foreground">
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
        render: (locked: boolean) => (
          <SpecimenCard>
            <Chart
              height={260}
              key={locked ? "locked" : "resting"}
              kind={shape as ChartKind}
              label={shapeLabel(shape)}
              series={SPECIMEN}
              style={style}
              unit="count"
            />
          </SpecimenCard>
        ),
      }))}
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
      title="Drawn as"
    />
  );
}
