"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { X } from "lucide-react";
import { SPRING } from "@/components/motion";
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
  normalizePanel,
  panelIdFromWidgetId,
  shapeLabel,
  shapesFor,
  isChartShape,
  type PanelDef,
  type PanelShape,
} from "@/lib/panel";
import { cn } from "@/lib/utils";

// The studio.
//
// A sheet that rises from the bottom of the screen and holds three shelves —
// colours, cards, charts — each a carousel of the real component you scroll
// through and pick from. It replaces the settings rail, and the difference is
// the point: a rail is a form you read, a shelf is a row of finished things
// you recognise. Nobody is asked to name a property; every choice is made by
// looking at the thing itself.
//
// **It is a sheet, not a dialog, because the screen behind it is the
// preview.** Every pick lands on the real panels immediately — the sheet
// covers the bottom third and your work keeps rendering above it, so the
// feedback loop is the page you were already looking at. A centered modal
// would hide the one thing that can tell you whether the choice was right.
//
// **Pointing is the scope.** Click a panel first (the screen is pointable
// while the studio is up) and the shelves style that panel; click none and
// they style all of them. No selector restates this, so nothing can disagree
// with it.
//
// **The chart shelf only appears with a panel in hand**, and it rewrites that
// panel's definition — the same write the builder makes — because "draw this
// as rings" is a change to the panel, not to a preference.

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

type Chapter = "colour" | "cards" | "charts";

export function StyleStudio() {
  const { active, selection, select, setActive } = useCustomize();
  const { style, commit, reset, dirty, revert } = useComponentStyle(
    selection?.id ?? null,
  );
  const [chapter, setChapter] = useState<Chapter>("colour");

  // Pointing is the scope — see the header comment.
  const scope = selection ? ("panel" as const) : ("personal" as const);

  const chapters: { id: Chapter; label: string }[] = [
    { id: "colour", label: "Colour" },
    { id: "cards", label: "Cards" },
    { id: "charts", label: "Charts" },
  ];

  return (
    <AnimatePresence>
      {active && (
        <motion.aside
          animate={{ y: 0, opacity: 1 }}
          aria-label="Style studio"
          className="fixed inset-x-0 bottom-0 z-50 mx-auto max-w-4xl px-3 pb-3"
          exit={{ y: 48, opacity: 0 }}
          initial={{ y: 48, opacity: 0 }}
          transition={SPRING}
        >
          <div className="bento overflow-hidden rounded-3xl bg-card/95 shadow-2xl backdrop-blur-md">
            <header className="flex items-center gap-3 px-5 pb-1 pt-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {selection ? selection.label : "Every panel"}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {selection
                    ? "Styling this panel — changes land on it as you pick."
                    : "Click any panel above to style just that one."}
                </p>
              </div>

              <div className="segmented" role="tablist" aria-label="Chapter">
                {chapters.map((c) => (
                  <button
                    aria-selected={chapter === c.id}
                    className={cn(
                      "px-3 py-1 text-xs",
                      chapter === c.id && "segmented-on",
                    )}
                    key={c.id}
                    onClick={() => setChapter(c.id)}
                    role="tab"
                    type="button"
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              {dirty && (
                <button
                  className="text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
                  onClick={revert}
                  type="button"
                >
                  Undo
                </button>
              )}
              {selection && (
                <button
                  className="text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
                  onClick={() => select(null)}
                  type="button"
                >
                  All panels
                </button>
              )}
              <button
                aria-label="Close the studio"
                className="tap-target flex h-8 w-8 items-center justify-center rounded-full hover:bg-muted"
                onClick={() => setActive(false)}
                type="button"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            {/* One chapter at a time. Re-keyed so switching re-mounts the
                shelf and its entrance reads as arriving, not repainting. */}
            <motion.div
              animate={{ opacity: 1, y: 0 }}
              initial={{ opacity: 0, y: 12 }}
              key={chapter + (selection?.id ?? "all")}
              transition={SPRING}
            >
              {chapter === "colour" && (
                <StyleCarousel
                  itemWidth={190}
                  items={STYLE_ENUMS.palette.map((palette) => ({
                    id: palette,
                    label: palette[0].toUpperCase() + palette.slice(1),
                    render: () => (
                      <span className="pointer-events-none block rounded-xl bg-page p-2 ring-1 ring-border">
                        <Chart
                          height={64}
                          kind="column"
                          label={palette}
                          series={SPECIMEN}
                          style={normalizeStyle({ ...style, palette })}
                          unit="count"
                        />
                        <span
                          aria-hidden
                          className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full"
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
                />
              )}

              {chapter === "cards" && (
                <StyleCarousel
                  itemWidth={210}
                  items={CARD_PRESETS.map((preset) => ({
                    id: preset.id,
                    label: preset.name,
                    hint: preset.description,
                    render: () => (
                      <PanelPreview
                        compact
                        kind="column"
                        style={normalizeStyle({
                          ...style,
                          ...normalizeStylePatch(preset.patch),
                        })}
                        title="Throughput"
                      />
                    ),
                  }))}
                  label="Cards"
                  onPick={(id) => {
                    const preset = CARD_PRESETS.find((p) => p.id === id);
                    if (preset) commit(normalizeStylePatch(preset.patch), scope);
                  }}
                />
              )}

              {chapter === "charts" &&
                (selection ? (
                  <ShapeShelf selectionId={selection.id} style={style} />
                ) : (
                  <StyleCarousel
                    itemWidth={210}
                    items={CHART_PRESETS.map((preset) => ({
                      id: preset.id,
                      label: preset.name,
                      hint: preset.description,
                      render: () => (
                        <span className="pointer-events-none block rounded-xl bg-page p-2 ring-1 ring-border">
                          <Chart
                            height={72}
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
                      if (preset)
                        commit(normalizeStylePatch(preset.patch), scope);
                    }}
                  />
                ))}
            </motion.div>

            <footer className="flex items-center justify-between px-5 pb-3">
              <button
                className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
                onClick={() => reset(scope)}
                type="button"
              >
                {selection ? "Match the others" : "Back to the defaults"}
              </button>
              <Link
                className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
                href="/dashboard/appearance"
                onClick={() => setActive(false)}
              >
                Type, navigation and motion →
              </Link>
            </footer>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

/**
 * The chart shelf for one panel: every shape its question can be drawn as,
 * each rendered live in the panel's own style, committed with one click.
 *
 * This is the builder's shape control moved to where the panel is. It writes
 * the definition — not a style — because "draw it as rings" changes what the
 * panel is.
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
      <p className="px-5 py-6 text-xs leading-relaxed text-muted-foreground">
        This panel is built in, so its shape is fixed — but the colour and card
        shelves still change how it looks.
      </p>
    );
  }

  const shapes = shapesFor(stored.query.from).filter(isChartShape);

  return (
    <StyleCarousel
      itemWidth={190}
      items={shapes.map((shape) => ({
        id: shape,
        label: shapeLabel(shape),
        render: () => (
          <span className="pointer-events-none block rounded-xl bg-page p-2 ring-1 ring-border">
            <Chart
              height={84}
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
        const next = normalizePanel({
          ...stored,
          shape: shape as PanelShape,
        });
        void update({ componentId: row.componentId, definition: next }).catch((e) =>
          toast(errorMessage(e, "Couldn't change the chart"), {
            kind: "error",
          }),
        );
      }}
      selectedId={stored.shape}
    />
  );
}
