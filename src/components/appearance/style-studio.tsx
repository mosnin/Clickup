"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, MotionConfig, motion, useDragControls } from "motion/react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EASE, SPRING } from "@/components/motion";
import {
  ExpandableScreen,
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
  LivePanelCard,
  builderDef,
  shapeItems,
  useAddCard,
  useBuilderScope,
  useCardBuilder,
  watchItems,
} from "@/components/appearance/card-builder";
import { useMintableBuiltIn } from "@/components/appearance/mintable-panels";
import {
  QuestionCard,
  WhenStep,
  questionsFor,
  situationProblem,
  usePanelSituation,
  useSituationCommit,
  useStudioPanel,
} from "@/components/appearance/only-when";
import {
  describeSituation,
  newDraft,
  seedFor,
  situationFromDraft,
  type SituationDraft,
} from "@/lib/situation";
import { mintFromBuiltIn } from "@/lib/built-in-panel";
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
  ROW_PRESETS,
  DEFAULT_STYLE,
  STYLE_ENUMS,
  normalizeStyle,
  normalizeStylePatch,
  paletteColors,
  type ComponentStyle,
  type StylePatch,
} from "@/lib/component-style";
import {
  isChartShape,
  normalizePanel,
  panelIdFromWidgetId,
  panelWidgetId,
  shapeLabel,
  shapesFor,
  type PanelDef,
  type PanelShape,
} from "@/lib/panel";

// The studio, as an island that opens into a shelf.
//
// Collapsed: a floating island that names the scope and leaves the page
// reachable, so clicking a panel IS the scope selector. Tap it and it rises
// into a sheet asking one question — a single carousel on the centre axis,
// dots beneath, the choice named once. Colour, Card and Chart are steps you
// move between, never sections stacked down a page.
//
// Four rules this file answers for, each one a shipped failure:
//
// **It must not cover the thing it edits.** It used to expand to a full
// screen, and the two complaints it earned — "it's not intuitive" and "they
// don't save" — were the same complaint: picks WERE saving, onto a dashboard
// nobody could see. A studio that hides your work can only be judged by
// reading its own labels, which is the settings page it exists to replace.
// So it is a sheet across the bottom (~58svh on a phone, a bounded floating
// panel from `sm` up), the canvas stays live above it, and choosing a colour
// is something you watch land on your own panels. Nothing here is modal:
// there is no scrim, and a tap on a panel behind the sheet still selects it,
// which is how you re-point the studio without closing it.
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

/**
 * Seven days of buckets, so the library draws its own date axis.
 *
 * It was fourteen, and fourteen is what made every specimen unreadable: a card
 * here is ~340px wide and ~100px tall, so fourteen points across two series is
 * twenty-eight marks with about 24px between them. At the ring size the
 * presets ask for, that is not a chart with markers on it — it is a braid of
 * overlapping circles with a line somewhere underneath, and it was the first
 * thing anybody saw when they opened the studio.
 *
 * Seven is also the honest number for a specimen: a week reads as a week, and
 * the point of these cards is to show how a look draws, not to be a plausible
 * quantity of data.
 */
const DAYS = Array.from({ length: 7 }, (_, i) => ({
  key: String(Date.UTC(2025, 5, 2) + i * 86_400_000),
  label: "",
}));

// Two series that stay apart across the whole span. They used to converge in
// the middle, which put the two strokes on top of each other in exactly the
// place the eye lands first.
const FLOW = [6, 10, 8, 14, 12, 18, 21];
const EBB = [3, 4, 3, 6, 5, 8, 9];

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

/**
 * The card width.
 *
 * Sized so a specimen fits INSIDE the sheet with its neighbours peeking, not
 * so it fills a screen: the shelf is now roughly half the viewport tall, and a
 * card cut off by the sheet's own edge is a card you cannot judge.
 */
const CARD_W = "min(74vw, 380px)";

/** Chart heights, chosen against the sheet's height rather than a screen's. */
const SPECIMEN_H = 120;
const CARD_SPECIMEN_H = 76;
/**
 * The chart chapter runs shorter than the colour chapter on purpose.
 *
 * A shelf is as tall as its TALLEST card — the flex row stretches, so one
 * specimen that draws a legend and a value axis lifts the caption of every
 * other one, and the name of what is centred goes under the sheet's edge.
 * Three of the chart presets carry ~46px of extra chrome, so the plot they
 * are given is smaller and the shelf lands at the same height as the others.
 */
const CHART_SPECIMEN_H = 96;

/**
 * Three rows, drawn by the same rules a panel draws them with.
 *
 * Not a picture of a list — the attributes below are the ones
 * `dashboard/panel.tsx` puts on its own root, and the classes are the ones the
 * row components carry, so what this shows is what you get. A specimen that
 * merely resembles the thing drifts the moment the renderer changes, which is
 * the whole argument for drawing options rather than naming them.
 */
function RowSpecimen({ patch }: { patch: StylePatch }) {
  const s = { ...DEFAULT_STYLE, ...patch };
  return (
    <div
      data-row-divider={s.rowDivider}
      data-row-marker={s.rowMarker}
      data-row-emphasis={s.rowEmphasis}
      data-chip-shape={s.chipShape}
      data-number-style={s.numberStyle}
      className="w-full px-1 py-1.5"
    >
      <div className="ui-list">
        {[
          { title: "Ship the release gate", meta: "Ada", n: "4" },
          { title: "Draft the launch note", meta: "Grace", n: "12" },
          { title: "Review agent budgets", meta: "Alan", n: "7" },
        ].map((row) => (
          <div key={row.title} className="flex items-center gap-2 py-1.5">
            <span className="ui-row-title min-w-0 flex-1 truncate text-sm">
              {row.title}
            </span>
            <span className="ui-chip bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {row.meta}
            </span>
            <span className="ui-figure text-xs text-muted-foreground">
              {row.n}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function StyleStudio() {
  const { active } = useCustomize();
  if (!active) return null;
  return (
    // The studio is mounted in the dashboard *layout*, outside the template
    // that sets `reducedMotion="user"` — so it sets it itself rather than
    // inheriting an accessibility guarantee from a component it does not
    // live inside.
    <MotionConfig reducedMotion="user">
      <DynamicIslandProvider initialSize={SIZE_PRESETS.COMPACT}>
        <ExpandableScreen layoutId="style-studio" lockScroll={false}>
          <StudioIsland />
          <StudioSheet />
        </ExpandableScreen>
      </DynamicIslandProvider>
    </MotionConfig>
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
  const { isExpanded } = useExpandableScreen();

  // The trigger hides itself when the sheet opens; Done did not, so a second
  // Done sat behind the sheet and peeked out under its bottom edge on a
  // desktop. The row is one object — it leaves as one.
  if (isExpanded) return null;

  return (
    <motion.div
      animate={{ y: 0, opacity: 1 }}
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center gap-2 px-4"
      data-studio
      initial={{ y: 40, opacity: 0 }}
      transition={{ duration: 0.32, ease: EASE }}
    >
      <div className="pointer-events-auto">
        {/* The pill paints itself, from the button.

            It used to be painted by `[&>div:first-child]:bg-foreground` on the
            trigger, and that class was doing nothing at all. The selector does
            match — the trigger's first child is its shared-layout background
            layer — but that layer is (a) completely covered by the island,
            which is a vendored component carrying a hardcoded opaque `bg-black`
            of its own, and (b) never morphed into anything, because this studio
            renders its own sheet rather than `ExpandableScreenContent`, so no
            second element shares the layoutId.

            So the pill was black in both themes while its label asked for
            `text-background` — near-white in light (which is why nobody saw
            it) and near-black in dark, where it measured 1.09:1 on black.

            `ui-inverted` is the same token set the inverted panel fill uses:
            surface = the theme's ink, writing = the theme's canvas. The button
            is `h-full w-full` inside the island, so painting it here covers the
            vendored black without reaching into a component we do not own, and
            the pill inverts with the theme the way it always claimed to. */}
        <ExpandableScreenTrigger>
          <DynamicIsland id="style-island">
            <button
              className="ui-inverted flex h-full w-full items-center justify-center gap-2.5 rounded-full px-4"
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
        className="pointer-events-auto flex h-11 shrink-0 items-center self-center rounded-full bg-card px-4 text-xs font-medium shadow-md"
        onClick={() => setActive(false)}
        type="button"
      >
        Done
      </button>
    </motion.div>
  );
}

type Chapter = "colour" | "cards" | "rows" | "chart" | "only" | "new";

const CHAPTERS: { id: Chapter; label: string }[] = [
  { id: "colour", label: "Colour" },
  { id: "cards", label: "Card" },
  // Rows sit BEFORE charts, because they are the common case. Most panels on
  // most screens are a list or a table; a chart is the exception. The studio
  // opened on chart controls for months while offering none of these, which
  // read — correctly — as a customiser built for a product this isn't.
  { id: "rows", label: "Rows" },
  { id: "chart", label: "Chart" },
  { id: "only", label: "Only when…" },
  { id: "new", label: "New card" },
];

/**
 * The opened state: a sheet across the bottom, the canvas alive above it.
 *
 * Why a sheet and not the screen it used to be: see the file header. The
 * mechanics that make it one rather than a small full-screen:
 *
 *   - **No scrim, no scroll lock, no overlay layer.** The fixed wrapper is
 *     `pointer-events-none` and only the sheet itself takes input, so every
 *     pixel beside and above it belongs to the dashboard — including the click
 *     that re-points the studio at a different panel.
 *   - **The canvas keeps room to scroll clear of it** (`data-studio-sheet` on
 *     the root; the rule lives in globals.css). A panel permanently pinned
 *     under the sheet is a panel you are still editing blind.
 *   - **It leaves the way a sheet leaves**: drag the handle down, or press the
 *     chevron, and it returns to the island it came from.
 */
function StudioSheet() {
  const { isExpanded, collapse } = useExpandableScreen();
  const { selection, select, setActive } = useCustomize();
  const { style, commit, reset, dirty, revert } = useComponentStyle(
    selection?.id ?? null,
  );
  const scope = selection ? ("panel" as const) : ("personal" as const);
  const [chapter, setChapter] = useState<Chapter>("colour");
  const [centred, setCentred] = useState<string | null>(null);
  const hint = useShelfHint();
  const drag = useDragControls();

  // The shell reserves room under the sheet only while it is open — a
  // reservation that outlived the component is the bug this mode already
  // shipped once, as a 21rem rail for an inspector nobody rendered.
  useEffect(() => {
    if (!isExpanded) return;
    const root = document.documentElement;
    root.dataset.studioSheet = "true";
    return () => {
      delete root.dataset.studioSheet;
    };
  }, [isExpanded]);

  return (
    <AnimatePresence>
      {isExpanded && (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center sm:px-6 sm:pb-5">
          {/* `data-studio` marks everything inside as part of customise mode,
              so the tap-outside-to-leave rule never fires on a tap in here. */}
          <motion.div
            animate={{ y: 0, opacity: 1 }}
            className={cn(
              "pointer-events-auto flex w-full flex-col overflow-hidden bg-page text-foreground",
              // A hairline as well as a shadow: the sheet is page-coloured
              // (its specimens are the card-coloured things on it), and in
              // dark mode a shadow over near-black separates nothing — the
              // sheet's own edge disappeared into the canvas.
              "ring-1 ring-border",
              "h-[58svh] min-h-[22rem] rounded-t-3xl shadow-[0_-14px_44px_-16px_rgb(0_0_0/0.32)]",
              "sm:h-[min(34rem,72svh)] sm:max-w-[42rem] sm:rounded-3xl sm:shadow-[0_18px_54px_-18px_rgb(0_0_0/0.34)]",
            )}
            data-studio
            dragConstraints={{ top: 0, bottom: 0 }}
            dragControls={drag}
            dragElastic={{ top: 0, bottom: 0.5 }}
            dragListener={false}
            drag="y"
            exit={{ y: "104%", opacity: 0 }}
            initial={{ y: "104%", opacity: 0 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 90 || info.velocity.y > 700) collapse();
            }}
            transition={SPRING}
          >
            {/* The grab rail: the sheet's own handle, and the one place a
                downward drag is listened for — a sheet-wide drag would eat
                the shelf's horizontal swipe, which is the gesture that
                matters most in here. */}
            <div
              className="relative flex shrink-0 touch-none items-center justify-center pt-2.5"
              onPointerDown={(event) => drag.start(event)}
            >
              <span
                aria-hidden
                className="h-1 w-10 rounded-full bg-foreground/20"
              />
              <button
                aria-label="Back to the pill"
                className="absolute right-1 top-0 flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
                onClick={collapse}
                type="button"
              >
                <ChevronDown className="h-5 w-5" />
              </button>
            </div>

            {/* Chapters. On a phone the five of them FIT — one full-width row
                of equal thirds-of-a-fifth, every chapter visible, nothing
                behind an edge. The previous answer was a scroller with its
                scrollbar hidden, and 36px of "New card" lived past the right
                edge of a 390px screen with no mark on the screen saying so: a
                person who never swipes a tab strip they cannot see is a person
                who never finds the builder. A hidden scrollbar is not an
                affordance, and a chapter you cannot see is a chapter you do
                not have.

                `overflow-x-auto` stays as the safety valve rather than as the
                layout: at a large type scale the labels can still outgrow the
                row, and scrolling is the honest failure. From `sm` up it goes
                back to the centred pill — a five-up bar stretched across a
                desktop is a menu bar, not a control. */}
            <div className="mt-1 shrink-0 overflow-x-auto px-0 sm:px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div
                aria-label="Choosing"
                className="segmented flex w-full sm:mx-auto sm:w-max"
                role="tablist"
              >
                {CHAPTERS.map((c) => (
                  <button
                    aria-selected={chapter === c.id}
                    className={cn(
                      // `flex-auto`, not `flex-1`: equal fifths give every
                      // chapter 78px and "Only when…" needs 68 of its own, so
                      // an equal split clipped the one label that could not
                      // afford it while "Card" sat in 78px of air. Sizing from
                      // content and then sharing what is left over means the
                      // long one is the one that gets the room.
                      "inline-flex h-11 min-w-0 flex-auto items-center justify-center truncate px-1.5 text-[13px] sm:flex-none sm:px-4",
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
            </div>

            <ShelfHintContext.Provider value={hint}>
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-1 text-center">
                {chapter !== "only" && (
                  <Rise delay={0}>
                    {/* One plain question per chapter, and one plain sentence
                        about what a pick DOES. The previous copy named the
                        mechanism ("Styling every panel", "picks land on it
                        instantly") without ever answering the two questions a
                        person actually has: what am I choosing, and how do I
                        keep it.

                        And it must not name the *gesture*: the coach mark six
                        millimetres below already does, in the one verb this
                        sheet uses for it. Saying "scroll to one" here and
                        "swipe" there is one action under two names, which
                        reads as two people having written the screen. The
                        subtitle carries the consequence; the hint carries the
                        mechanic. */}
                    <StudioHeading>
                      {chapter === "colour"
                        ? "What colour is your data?"
                        : chapter === "cards"
                          ? "How should a card look?"
                          : chapter === "chart"
                            ? "How should the numbers be drawn?"
                            : "What should your new card watch?"}
                    </StudioHeading>
                    <StudioSub>
                      {chapter === "new"
                        ? "Every card here is running on your real work."
                        : /* The chart chapter, pointed at one panel, does NOT
                             apply on scroll — it rewrites a definition, so it
                             asks for a pick. A line promising "there's nothing
                             to save" over a shelf that saves nothing until you
                             press it is the same lie this studio shipped once
                             already, told the other way round. */
                          chapter === "chart" && selection
                          ? "Drawn each way. Nothing changes until you pick."
                          : `It applies ${
                              selection ? `to ${selection.label}` : "everywhere"
                            }, live behind.`}
                    </StudioSub>
                  </Rise>
                )}

                <Rise delay={0.08} key={chapter + (selection?.id ?? "all")}>
                  {chapter === "colour" && (
                    <HeroShelf
                      centred={centred}
                      items={STYLE_ENUMS.palette.map((palette) => ({
                        id: palette,
                        label: palette[0].toUpperCase() + palette.slice(1),
                        render: (locked: boolean) => (
                          <SpecimenCard>
                            {/* Re-mounted as it locks (`key`), so the
                                library's own reveal replays on arrival — the
                                feed-snap moment. */}
                            <Chart
                              height={SPECIMEN_H}
                              key={locked ? "locked" : "resting"}
                              kind="area"
                              label={palette}
                              series={SPECIMEN}
                              style={specimen(style, { palette })}
                              unit="count"
                            />
                            <span
                              aria-hidden
                              className="mt-3 flex h-3 w-full overflow-hidden rounded-full"
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
                            palette:
                              palette as (typeof STYLE_ENUMS.palette)[number],
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
                        if (preset)
                          commit(normalizeStylePatch(preset.patch), scope);
                      }}
                      title="Card"
                    />
                  )}

                  {chapter === "new" && (
                    <BuilderChapter centred={centred} onCentred={setCentred} />
                  )}

                  {chapter === "only" && (
                    <OnlyWhenChapter
                      centred={centred}
                      onCentred={setCentred}
                      selection={selection}
                    />
                  )}

                  {chapter === "rows" && (
                    <HeroShelf
                      centred={centred}
                      items={ROW_PRESETS.map((preset) => ({
                        id: preset.id,
                        label: preset.name,
                        hint: preset.description,
                        render: () => (
                          <SpecimenCard>
                            <RowSpecimen
                              patch={normalizeStylePatch(preset.patch)}
                            />
                          </SpecimenCard>
                        ),
                      }))}
                      onCentred={setCentred}
                      onPick={(id) => {
                        const preset = ROW_PRESETS.find((p) => p.id === id);
                        if (preset)
                          commit(normalizeStylePatch(preset.patch), scope);
                      }}
                      title="Rows"
                    />
                  )}

                  {chapter === "chart" &&
                    (selection ? (
                      <ShapeShelf
                        centred={centred}
                        onCentred={setCentred}
                        selectionId={selection.id}
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
                                height={CHART_SPECIMEN_H}
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
            </ShelfHintContext.Provider>

            {/* The action bar. Done is a filled pill at the bottom edge of a
                sheet whose bottom edge is the bottom of the phone — the one
                place a thumb rests — rather than the underlined word at the
                foot of a scrolling screen it used to be. The secondary verbs
                scroll beside it instead of shrinking it. */}
            <footer
              className="flex shrink-0 items-center gap-2 border-t border-border/60 bg-card/60 px-3 pt-2"
              style={{
                paddingBottom: "max(env(safe-area-inset-bottom), 0.5rem)",
              }}
            >
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {dirty && <SheetAction onClick={revert}>Undo</SheetAction>}
                {selection && (
                  <SheetAction onClick={() => select(null)}>
                    All panels
                  </SheetAction>
                )}
                <SheetAction onClick={() => reset(scope)}>
                  {selection ? "Match the others" : "Defaults"}
                </SheetAction>
              </div>
              <Button
                className="h-11 shrink-0 rounded-full px-6"
                onClick={() => setActive(false)}
                type="button"
              >
                Done
              </Button>
            </footer>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

/**
 * The gesture nothing taught.
 *
 * The shelf applies what comes to rest at its centre, which is a lovely thing
 * to use and an invisible thing to discover: at 390px the neighbours peek by a
 * few millimetres, so the shelf reads as one card with decoration beside it.
 * People pressed the card, nothing obvious happened, and the report was "they
 * don't save". So the first time somebody opens the studio, the shelf says
 * what it is — once, and never again after they touch it.
 */
const HINT_KEY = "operate.studio.shelf-hint";

type ShelfHint = { show: boolean; dismiss: () => void };

const ShelfHintContext = createContext<ShelfHint>({
  show: false,
  dismiss: () => {},
});

function useShelfHint(): ShelfHint {
  const [show, setShow] = useState(false);
  // Read after mount: `localStorage` on the server is a crash, and a hint
  // rendered by the server and removed by the client is a flash.
  useEffect(() => {
    try {
      if (!window.localStorage.getItem(HINT_KEY)) setShow(true);
    } catch {
      setShow(true);
    }
  }, []);
  const dismiss = useCallback(() => {
    setShow(false);
    try {
      window.localStorage.setItem(HINT_KEY, "1");
    } catch {
      /* private mode: the hint is simply shown again next time. */
    }
  }, []);
  return useMemo(() => ({ show, dismiss }), [show, dismiss]);
}

/** The hint itself: a line under the shelf, and a hand that swipes. */
function ShelfHint({ applyOnCentre }: { applyOnCentre: boolean }) {
  return (
    <motion.p
      animate={{ opacity: 1, y: 0 }}
      className="pointer-events-none mx-auto mt-1.5 flex w-max max-w-[94%] items-center gap-1.5 rounded-full bg-foreground px-3 py-1 text-[11px] font-medium text-background"
      initial={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.4, ease: EASE, delay: 0.5 }}
    >
      <motion.span
        aria-hidden
        animate={{ x: [0, 5, 0, -5, 0] }}
        className="text-sm leading-none"
        transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
      >
        ⇢
      </motion.span>
      {applyOnCentre
        ? "Swipe — the middle one is applied"
        : "Swipe, then press to use one"}
    </motion.p>
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
    <span className="bento pointer-events-none block rounded-3xl bg-card p-4 text-left text-foreground sm:p-5">
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
    <span className="bento-tile pointer-events-none block p-3 sm:p-6">
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
            )}
          >
            Throughput
          </span>
        )}
        <span className="mt-2 block">
          <Chart
            height={CARD_SPECIMEN_H}
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
  applyOnCentre = true,
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
  /**
   * Whether coming to rest on a card applies it.
   *
   * True for a *style*, which is a sparse patch that another scroll undoes
   * just as cheaply. False for anything that rewrites what a panel IS — a
   * shape change replaces the stored definition, and wiring scroll-to-choose
   * into that meant flicking past nineteen shapes rewrote the panel nineteen
   * times. Scroll-to-choose is the right gesture for picking a look and the
   * wrong one for redefining an object; the difference is whether the last
   * scroll can be undone by the next one.
   */
  applyOnCentre?: boolean;
}) {
  const restingId = centred ?? selectedId ?? items[0]?.id;
  const current = items.find((i) => i.id === restingId) ?? items[0];
  const hint = useContext(ShelfHintContext);
  return (
    // The hint is spent by the first touch of the shelf, whichever way it
    // arrives — a swipe, a wheel, or a keyboard. Capture phase, because the
    // carousel stops none of these but the point is to react to the attempt,
    // not to its outcome.
    <div
      onKeyDownCapture={hint.dismiss}
      onPointerDownCapture={hint.dismiss}
      onWheelCapture={hint.dismiss}
    >
      {/* Above the shelf, not below it: under the dots it separated the cards
          from the one line that names what is centred, which is the shelf's
          own answer. A hint that pushes the answer off the sheet is a hint
          that costs more than it teaches. */}
      {hint.show && <ShelfHint applyOnCentre={applyOnCentre} />}
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
          if (applyOnCentre) onPick(id);
        }}
        onPick={onPick}
        selectedId={selectedId}
      />
      {/* The centred card's name, and — where a pick is required — the pick,
          on the SAME row. Stacked, the button landed below the sheet's edge
          on a phone, which is a commit control you have to go looking for. */}
      <div
        aria-live="polite"
        className={cn(
          "mt-1 px-4",
          !applyOnCentre && "flex items-center justify-center gap-3",
        )}
      >
        <div className={cn(!applyOnCentre && "min-w-0 text-right")}>
          <p className="truncate text-[15px] font-semibold sm:text-base">
            {current?.label}
          </p>
          {/* The description is desktop-only, and that is a decision about
              the sheet's last 20 pixels rather than about the sentence: on a
              phone it lands half-under the action bar, and a line sliced
              through the middle reads as a rendering fault. The name — the
              answer to "which one is this" — always fits. */}
          {current?.hint && (
            <p className="mx-auto hidden line-clamp-2 max-w-md text-[12px] text-muted-foreground sm:block">
              {current.hint}
            </p>
          )}
        </div>
        {/* Scrolling does not apply here, so something has to. A shelf whose
            centred card looks chosen and isn't is the exact failure this
            studio already shipped once. */}
        {!applyOnCentre && current && (
          <Button
            className="h-11 shrink-0 rounded-full px-5"
            onClick={() => onPick(current.id)}
            type="button"
          >
            {current.id === selectedId ? "Current" : `Use ${current.label}`}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The sheet's one question, and the one line under it.
 *
 * Primitives rather than markup repeated per chapter, because the chapters that
 * ask their question in two steps ("Only when…") have to say it in exactly the
 * same voice as the ones that ask it in one — and the first thing to drift when
 * a heading is copy-pasted is the size it is drifting at.
 */
function StudioHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-1 px-6 text-[15px] font-semibold sm:text-base">
      {children}
    </h2>
  );
}

function StudioSub({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-0.5 px-6 text-[12px] text-muted-foreground sm:text-[13px]">
      {children}
    </p>
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
      initial={{ opacity: 0, y: 14, filter: "blur(6px)" }}
      transition={{ ...SPRING, delay: 0.1 + delay }}
    >
      {children}
    </motion.div>
  );
}

/**
 * A secondary verb in the sheet's action bar.
 *
 * A button on a 44px target rather than the dotted-underline text link it
 * was: these sit at the bottom edge of a phone, where a 16px word is a miss
 * and a miss here means "Defaults" instead of "Undo".
 */
function SheetAction({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className="inline-flex h-11 shrink-0 items-center whitespace-nowrap rounded-full px-3 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      onClick={onClick}
      type="button"
    >
      {children}
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
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2 px-3">
        <SheetAction onClick={builder.back}>← Watch something else</SheetAction>
        {def && (
          <Button
            className="h-11 rounded-full px-5"
            onClick={() => add.add(def, scope)}
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
 *
 * Two panels arrive here and they are not the same object. One has a stored
 * definition, and picking a shape rewrites it — "draw it as rings" changes what
 * the panel IS, not a preference about it. The other is **built in**, and used
 * to land on a paragraph reading "this panel is built in, so its shape is
 * fixed" — which on Home was every panel on the screen. The control was present
 * and inert for the whole surface, which is the exact failure this studio
 * already shipped once with scroll-to-choose: a control that looks live and
 * is not.
 *
 * A built-in has no definition, so a pick MINTS one — the built-in's question
 * (src/lib/built-in-panel.ts) in the chosen shape — and the screen swaps it
 * into the slot the built-in was standing in. From then on it is an ordinary
 * authored panel and every later pick edits it.
 *
 * Both paths draw the candidate with the real `<Panel>` over real data rather
 * than the invented `SPECIMEN` series the style chapters use. That is not
 * polish: a minted panel is close to its built-in but never identical to it
 * (one scope instead of every scope, chiefly), and a made-up specimen cannot
 * show a difference that exists only in the data. Looking at the actual card,
 * with the actual numbers, is what makes the pick informed.
 */
function ShapeShelf({
  selectionId,
  centred,
  onCentred,
}: {
  selectionId: string;
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
  const create = useMutation(api.uiComponents.create);
  // Null for a selection that already has a definition — a stored panel's
  // widget id is `custom:<id>`, which no built-in registry answers for.
  const mintable = useMintableBuiltIn(selectionId);
  const { select } = useCustomize();
  const { toast } = useToast();

  const stored = useMemo<PanelDef | null>(
    () => (row ? normalizePanel(row.definition) : null),
    [row],
  );

  const base = stored ?? mintable?.question ?? null;
  const scope = row
    ? { scopeType: row.scopeType, scopeId: row.scopeId }
    : (mintable?.scope ?? null);

  if (!base || !scope) {
    return (
      <p className="mx-auto max-w-md px-6 py-8 text-[13px] leading-relaxed text-muted-foreground">
        This panel is built in, so its shape is fixed — colour and card still
        change how it looks.
      </p>
    );
  }

  // The question's own shape first, so the shelf opens on the drawing that
  // most resembles what is standing there. Not marked "current" — for a
  // built-in it is a suggestion, and a button reading "Current" over a panel
  // that has never been drawn that way is the same class of lie as a shelf
  // that looks chosen and isn't.
  const chartShapes = shapesFor(base.query.from).filter(isChartShape);
  const shapes = stored
    ? chartShapes
    : [
        ...chartShapes.filter((s) => s === base.shape),
        ...chartShapes.filter((s) => s !== base.shape),
      ];

  function pick(shape: PanelShape) {
    if (stored && row) {
      const next = normalizePanel({ ...stored, shape });
      void update({ componentId: row.componentId, definition: next }).catch(
        (e) =>
          toast(errorMessage(e, "Couldn't change the chart"), { kind: "error" }),
      );
      return;
    }
    if (!mintable || !base) return;
    const next = mintFromBuiltIn(base, shape);
    // The mutation returns an id and the screen places it. It cannot place it
    // itself: the server can't tell "never arranged this screen" from
    // "arranged it empty", so a layout written here would wipe the screen down
    // to this one panel. See convex/uiComponents.ts.
    void create({ ...scope!, definition: next })
      .then((componentId) => {
        mintable.replace(componentId as unknown as string);
        // Re-point the inspector at what is now standing there, or the next
        // pick would mint a second panel from the built-in that is no longer
        // on the screen.
        select({
          id: `${selectionId.slice(0, selectionId.indexOf(":"))}:${panelWidgetId(
            componentId as unknown as string,
          )}`,
          label: next.title,
          screenKey: selectionId.slice(0, selectionId.indexOf(":")),
        });
        toast(
          `“${next.title}” is yours now — drawn as a ${shapeLabel(
            shape,
          ).toLowerCase()}.`,
        );
      })
      .catch((e) =>
        toast(errorMessage(e, "Couldn't change the chart"), { kind: "error" }),
      );
  }

  return (
    <div>
      {!stored && (
        <p className="mx-auto max-w-md px-6 text-[12px] text-muted-foreground">
          Picking one makes this card your own.
        </p>
      )}
      <HeroShelf
        applyOnCentre={false}
        centred={centred}
        items={shapes.map((shape) => ({
          id: shape,
          label: shapeLabel(shape),
          render: () => (
            <LivePanelCard
              def={
                stored ? normalizePanel({ ...stored, shape }) : mintFromBuiltIn(base!, shape)
              }
              scope={scope!}
            />
          ),
        }))}
        onCentred={onCentred}
        onPick={(shape) => pick(shape as PanelShape)}
        selectedId={stored?.shape}
        title="Drawn as"
      />
    </div>
  );
}

/**
 * Saying when this card should be here at all.
 *
 * Every other chapter changes how a panel *looks*; this one changes whether it
 * is on the screen. That is the ceiling the rest of the studio leaves in place:
 * a dashboard is a shelf, and the only lever anybody has is "on it" or "not on
 * it", so the panel that matters twice a quarter either clutters the screen for
 * the rest of the year or is not there when it is needed.
 *
 * It asks two questions and not one form. **What should decide it** — a shelf
 * of questions, the panel's own first, each drawn as the number it answers
 * right now on real work. Then **when** — three comparisons drawn as what they
 * do, and a threshold set against the live reading, so "6" is picked next to
 * "it's 4 right now" instead of guessed at.
 *
 * Nothing is written until the last press. The composer can never write a
 * condition the mutation would refuse (`situationProblem` runs the server's own
 * two refusals first, and the button says what is missing), and clearing one is
 * a single tap with an undo window rather than a dialog.
 */
function OnlyWhenChapter({
  selection,
  centred,
  onCentred,
}: {
  selection: { id: string; label: string; screenKey: string | null } | null;
  centred: string | null;
  onCentred: (id: string) => void;
}) {
  const screenKey = selection?.screenKey ?? null;
  // The widget id, which is what a subscription is keyed by. Split on the FIRST
  // colon only — an authored panel's own widget id carries one (`custom:<id>`).
  const panelId = selection
    ? selection.id.slice(selection.id.indexOf(":") + 1)
    : null;

  const panel = useStudioPanel(selection?.id ?? null);
  const existing = usePanelSituation(screenKey, panelId);
  const { clearing, save, clear } = useSituationCommit(screenKey);
  const [draft, setDraft] = useState<SituationDraft | null>(null);
  const [step, setStep] = useState<"question" | "when">("question");
  const seeded = useRef("");

  const questions = questionsFor(panel);

  // Pointing the studio at a different panel starts a different sentence.
  useEffect(() => {
    setDraft(null);
    setStep("question");
    seeded.current = "";
  }, [selection?.id]);

  if (!selection || !screenKey || !panelId) {
    return (
      <div>
        <StudioHeading>Which card comes and goes?</StudioHeading>
        <StudioSub>
          Tap one behind this sheet and it can be here only when something is
          true.
        </StudioSub>
      </div>
    );
  }

  const live =
    existing && !clearing.includes(existing.subscriptionId) ? existing : null;

  // What is already set, and the one tap out of it. Shown instead of the
  // composer rather than above it: a chapter that renders a state AND a form
  // for the same thing is the stacked settings panel this studio replaced.
  if (live && step === "question" && draft === null) {
    return (
      <div>
        <StudioHeading>{selection.label} comes and goes</StudioHeading>
        <StudioSub>
          It is on your screen only while this is true — checked every quarter
          hour.
        </StudioSub>
        <div className="mx-auto mt-3 max-w-md px-4">
          <p className="bento rounded-2xl bg-card p-4 text-left">
            <span className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Only here when
            </span>
            {/* The server's own `describeSituation`, unchanged. */}
            <span className="mt-0.5 block text-[15px] font-semibold">
              {live.description}
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {live.isTrue ? "True now" : "Not true now"}
            </span>
          </p>
          <div className="mt-3 flex items-center justify-center gap-2">
            {/* Opening a draft is what takes the chapter off this state and
                into the composer — the state above is shown precisely while
                there is nothing being composed. */}
            <SheetAction onClick={() => setDraft(newDraft(questions[0]))}>
              Change it
            </SheetAction>
            <Button
              className="h-11 rounded-full px-5"
              onClick={() => clear(live.subscriptionId, live.description)}
              type="button"
            >
              Always show it
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const current = draft ?? newDraft(questions[0]);

  if (step === "question") {
    return (
      <div>
        <StudioHeading>What should decide it?</StudioHeading>
        <StudioSub>
          {panel
            ? "Its own question first — that is usually the one."
            : "Each one is answered by your work right now."}
        </StudioSub>
        <HeroShelf
          applyOnCentre={false}
          centred={centred}
          items={questions.map((q) => ({
            id: q.id,
            label: q.label,
            render: () => (
              <QuestionCard
                label={q.label}
                query={q.query}
                scope={panel?.scope ?? null}
              />
            ),
          }))}
          onCentred={(id) => {
            onCentred(id);
            const next = questions.find((q) => q.id === id);
            if (next) setDraft(newDraft(next, current.compare));
          }}
          onPick={(id) => {
            const next = questions.find((q) => q.id === id);
            if (next) setDraft(newDraft(next, current.compare));
            setStep("when");
          }}
          title="What should decide it?"
        />
      </div>
    );
  }

  const situation = situationFromDraft(panelId, current);
  const problem = panel
    ? situationProblem(situation, panel.scope.scopeType)
    : "Still working out where this card reads from.";

  return (
    <div>
      <StudioHeading>When should it be here?</StudioHeading>
      <StudioSub>Set against what it answers right now.</StudioSub>
      <div className="mx-auto mt-3 max-w-md">
        <WhenStep
          compare={current.compare}
          label={current.label}
          onCompare={(compare) => setDraft({ ...current, compare })}
          onMeasured={(value) => {
            // Seeded once per question, and never after the number has been
            // touched — see `seedFor`.
            const key = `${current.starterId}:${current.compare}`;
            if (seeded.current === key) return;
            const next = seedFor(current, value);
            if (next === null) return;
            seeded.current = key;
            setDraft({ ...current, threshold: next });
          }}
          onThreshold={(threshold) =>
            setDraft({ ...current, threshold, touched: true })
          }
          query={current.query}
          scope={panel?.scope ?? null}
          threshold={current.threshold}
        />

        {/* The same sentence the toast, the event log and the arrival banner
            use — VERBATIM, under a label, rather than folded into a line of
            this screen's own prose. Recasing it to fit a sentence here is
            enough to make one condition read as two different conditions
            depending on where you meet it. */}
        <p aria-live="polite" className="mt-4 px-4 text-center">
          <span className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Only here when
          </span>
          <span className="mt-0.5 block text-[15px] font-semibold">
            {describeSituation(situation)}
          </span>
        </p>
        {problem && (
          <p className="mt-2 px-4 text-center text-[12px] leading-relaxed text-muted-foreground">
            {problem}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-center gap-2 px-3">
          <SheetAction onClick={() => setStep("question")}>
            ← Ask something else
          </SheetAction>
          <Button
            className="h-11 rounded-full px-5"
            disabled={problem !== null || !panel}
            onClick={() => {
              if (!panel || problem) return;
              save(panel.scope, panelId, situation, () => {
                setDraft(null);
                setStep("question");
              });
            }}
            type="button"
          >
            Only show it then
          </Button>
        </div>
      </div>
    </div>
  );
}
