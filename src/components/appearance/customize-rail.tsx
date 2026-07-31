"use client";

import Link from "next/link";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCustomize } from "@/components/appearance/customize-provider";
import { useComponentStyle } from "@/components/appearance/use-component-style";
import { PanelPreview } from "@/components/appearance/style-gallery";
import { PanelQuestion } from "@/components/appearance/panel-question";
import { STYLE_ENUMS, paletteColors } from "@/lib/component-style";
import { cn } from "@/lib/utils";

// The style rail.
//
// Three things, because three things are what anyone wants: a colour, a way
// of drawing the data, and a way to make a new card. Everything else that used
// to be here — Frame, Bars, Grid, Axes, Numbers on marks, a four-way "applies
// to" selector, a natural-language box — was technical customisation wearing
// an aesthetic costume. Nobody opens a dashboard wanting to choose a bar cap.
//
// **There is no scope control any more.** There used to be a segmented switch
// with four positions that could not move off the first, which is why this
// panel had a reputation for not working. It is gone rather than fixed,
// because the answer was already on screen: click a panel and you are styling
// that panel; click nothing and you are styling all of them. A control that
// restates what pointing already said is a control that can disagree with it.
//
// **Every specimen is a real card drawing real shapes.** Six frame options all
// previewed as the same bare chart is how six identical thumbnails shipped.

export function CustomizeRail() {
  const { active, selection, select, setActive } = useCustomize();
  const { style, sources, commit, clear, reset, dirty, revert } =
    useComponentStyle(selection?.id ?? null);

  if (!active) return null;

  // Pointing is the scope. A selected panel is styled on its own layer;
  // nothing selected styles every panel you see.
  const scope = selection ? "panel" : "personal";

  return (
    <aside
      data-customize-rail
      aria-label="Style"
      className="fixed inset-y-0 right-0 z-50 flex w-[min(21rem,100vw)] flex-col border-l border-border bg-card shadow-2xl"
    >
      <header className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Style
          </p>
          <p className="truncate text-sm font-medium">
            {selection ? selection.label : "Every panel"}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          {dirty && (
            <Button variant="outline" size="sm" onClick={revert}>
              Undo
            </Button>
          )}
          <button
            type="button"
            aria-label="Done"
            onClick={() => setActive(false)}
            className="tap-target flex h-8 w-8 items-center justify-center rounded-full hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-4 py-4">
        {selection ? (
          <button
            type="button"
            onClick={() => select(null)}
            className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            ← Style every panel instead
          </button>
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Click a panel to style just that one.
          </p>
        )}

        {/* Colour first: it is the change that reads from across the room, and
            it is the only one that means something with nothing selected. */}
        <section>
          <span className="flex items-baseline justify-between gap-2">
            <Label>Colour</Label>
            {sources.palette !== "default" && (
              <ClearButton onClick={() => clear(["palette"], scope)} />
            )}
          </span>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {STYLE_ENUMS.palette.map((palette) => (
              <button
                key={palette}
                type="button"
                aria-pressed={palette === style.palette}
                onClick={() => commit({ palette }, scope)}
                className={cn(
                  "rounded-xl p-2 text-left transition-all",
                  palette === style.palette
                    ? "ring-2 ring-foreground"
                    : "ring-1 ring-border hover:ring-muted-foreground/40",
                )}
              >
                <span
                  aria-hidden
                  className="flex h-7 w-full overflow-hidden rounded-lg"
                >
                  {paletteColors(palette).map((color, i) => (
                    <span
                      className="flex-1"
                      key={i}
                      style={{ background: color }}
                    />
                  ))}
                </span>
                <span className="mt-1.5 block truncate text-[11px] font-medium capitalize">
                  {palette}
                </span>
              </button>
            ))}
          </div>
        </section>

        {/* How the data is drawn. Only with a panel in hand, because "change
            the chart type of everything" is not a thing anyone means. */}
        {selection && <PanelQuestion selectionId={selection.id} />}

        {!selection && (
          <section>
            <Label>See it drawn differently</Label>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              Click any panel and you can switch it between a bar chart, a
              donut, rings, a gauge, a radar, a heatmap and the rest.
            </p>
            <span className="mt-3 block">
              <PanelPreview compact kind="rings" style={style} title="Goals" />
            </span>
          </section>
        )}
      </div>

      <footer className="space-y-2 border-t border-border px-4 py-3">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => reset(scope)}
        >
          {selection ? "Match the others" : "Back to the defaults"}
        </Button>
        <Link
          href="/dashboard/appearance"
          onClick={() => setActive(false)}
          className="block text-center text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          Type, navigation and motion →
        </Link>
      </footer>
    </aside>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </span>
  );
}

function ClearButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[10px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
    >
      Reset
    </button>
  );
}
