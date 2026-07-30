"use client";

import Link from "next/link";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCustomize } from "@/components/appearance/customize-provider";
import {
  useComponentStyle,
  type ComponentStyleScope,
} from "@/components/appearance/use-component-style";
import { styleFrom } from "@/components/appearance/style-gallery";
import { IntentComposer } from "@/components/appearance/intent-composer";
import { Chart, type ChartKind } from "@/components/charts/chart";
import {
  DEFAULT_STYLE,
  STYLE_ENUMS,
  STYLE_PRESETS,
  normalizeStylePatch,
  paletteColors,
  type StyleKey,
} from "@/lib/component-style";
import { cn } from "@/lib/utils";

// The inspector.
//
// It is beside your work, not instead of it. Everything it changes is visible
// on the same screen at the moment you change it — your projects, your tasks,
// your numbers — so nobody has to imagine the result or translate an option's
// name into an effect.
//
// The two decisions that make it work:
//
// **Scope is the first control, and the narrowest option is first.** You
// arrived here by pointing at one panel, so "just this one" is the default
// reading of what you meant. Offering "everywhere" first invites the change
// nobody asked for and then makes them find the undo.
//
// **Every option is a picture.** No field takes a value; no control names a
// colour. Someone who has never opened a stylesheet has to be able to work
// this, and the only way that is true is if choosing is recognising.

const SCOPE_COPY: Record<ComponentStyleScope, { label: string; hint: string }> = {
  panel: { label: "Just this", hint: "Only this panel, only for you." },
  personal: { label: "Everywhere", hint: "Every panel you see, in every space." },
  space: { label: "This space", hint: "Everyone in this space sees it." },
  personalSpace: { label: "Me, here", hint: "Only yours, only in this space." },
};

export function CustomizeRail() {
  const { active, selection, select, setActive } = useCustomize();
  const {
    style,
    sources,
    commit,
    clear,
    reset,
    scopes,
    spaceName,
    dirty,
    revert,
  } = useComponentStyle(selection?.id ?? null);

  if (!active) return null;

  // Default to the narrowest scope available, which is the panel you clicked.
  const scope: ComponentStyleScope = scopes[0];
  const set = (patch: Parameters<typeof commit>[0]) => commit(patch, scope);

  return (
    <aside
      data-customize-rail
      aria-label="Customise"
      className="fixed inset-y-0 right-0 z-50 flex w-[min(21rem,100vw)] flex-col border-l border-border bg-card shadow-2xl"
    >
      <header className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Customising
          </p>
          <p className="truncate text-sm font-medium">
            {selection ? selection.label : "Everything you see"}
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
            aria-label="Done customising"
            onClick={() => setActive(false)}
            className="tap-target flex h-8 w-8 items-center justify-center rounded-full hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
        {!selection && (
          <p className="rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            Click any panel on the page to change just that one. Nothing here
            takes you away from your work.
          </p>
        )}

        {selection && (
          <button
            type="button"
            onClick={() => select(null)}
            className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            ← Change everything instead
          </button>
        )}

        {/* What this change reaches. */}
        {scopes.length > 1 && (
          <section>
            <Label>Applies to</Label>
            <div className="segmented mt-2 w-full">
              {scopes.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={s === scope}
                  onClick={() => {
                    // Switching scope is not a write; it changes which layer
                    // the next pick lands on. Selecting the panel is how you
                    // choose the narrow one, so this only widens.
                    if (s !== scope) select(s === "panel" ? selection : null);
                  }}
                  className={cn(
                    "min-w-0 flex-1 truncate px-2 py-1.5 text-[11px]",
                    s === scope && "segmented-on",
                  )}
                >
                  {s === "space" && spaceName ? spaceName : SCOPE_COPY[s].label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {SCOPE_COPY[scope].hint}
            </p>
          </section>
        )}

        {/* The fastest path for anyone who does not want to learn nineteen
            axes: describe it. Same vocabulary, same result as the pickers —
            neither is the "advanced" one. */}
        <IntentComposer
          style={style}
          panelLabel={selection ? selection.label : "your panels"}
          onApply={(patch) => set(patch)}
        />

        <section>
          <Label>Start from</Label>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {STYLE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                title={preset.description}
                onClick={() => {
                  reset(scope);
                  commit(preset.patch, scope);
                }}
                className="overflow-hidden rounded-lg bg-page p-2 text-left ring-1 ring-border transition-colors hover:ring-muted-foreground/40"
              >
                <Chart
                  kind="column"
                  series={MINI}
                  style={{
                    ...DEFAULT_STYLE,
                    ...normalizeStylePatch(preset.patch),
                    stackMode: "stacked",
                  }}
                  unit="count"
                  width={120}
                  height={40}
                  label={preset.name}
                />
                <span className="mt-1 block truncate text-[11px] font-medium">
                  {preset.name}
                </span>
              </button>
            ))}
          </div>
        </section>

        <Swatches
          label="Colour"
          keyName="palette"
          owned={sources.palette !== "default"}
          onClear={() => clear(["palette"], scope)}
          options={STYLE_ENUMS.palette}
          current={style.palette}
          onPick={(palette) => set({ palette })}
          render={(palette) => (
            <span aria-hidden className="flex h-6 w-full overflow-hidden rounded">
              {paletteColors(palette as never).map((color, i) => (
                <span key={i} className="flex-1" style={{ background: color }} />
              ))}
            </span>
          )}
        />

        <MiniRow
          label="Frame"
          keyName="frame"
          style={style}
          sources={sources}
          options={STYLE_ENUMS.frame}
          onPick={(frame) => set({ frame })}
          onClear={() => clear(["frame"], scope)}
        />
        <MiniRow
          label="Bars"
          keyName="barShape"
          style={style}
          sources={sources}
          options={STYLE_ENUMS.barShape}
          onPick={(barShape) => set({ barShape })}
          onClear={() => clear(["barShape"], scope)}
        />
        <MiniRow
          label="Grid"
          keyName="grid"
          style={style}
          sources={sources}
          options={STYLE_ENUMS.grid}
          onPick={(grid) => set({ grid })}
          onClear={() => clear(["grid"], scope)}
        />
        <MiniRow
          label="Axes"
          keyName="axes"
          style={style}
          sources={sources}
          options={STYLE_ENUMS.axes}
          onPick={(axes) => set({ axes })}
          onClear={() => clear(["axes"], scope)}
        />
        <MiniRow
          label="Numbers on marks"
          keyName="dataLabels"
          style={style}
          sources={sources}
          options={STYLE_ENUMS.dataLabels}
          onPick={(dataLabels) => set({ dataLabels })}
          onClear={() => clear(["dataLabels"], scope)}
        />
      </div>

      <footer className="space-y-2 border-t border-border px-4 py-3">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => reset(scope)}
        >
          {scope === "panel" ? "Match everything else" : "Back to the defaults"}
        </Button>
        {/* The wider settings — typefaces, navigation, motion — are about the
            whole app rather than about anything on this screen, so they are one
            click further in rather than crowded into the rail. */}
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

/** A very small specimen — enough shape to tell options apart at rail width. */
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
  {
    key: "b",
    label: "B",
    points: [
      { key: "1", label: "", value: 3 },
      { key: "2", label: "", value: 4 },
      { key: "3", label: "", value: 7 },
      { key: "4", label: "", value: 2 },
    ],
  },
];

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </span>
  );
}

function Swatches<T extends string>({
  label,
  keyName,
  options,
  current,
  owned,
  onPick,
  onClear,
  render,
}: {
  label: string;
  keyName: StyleKey;
  options: readonly T[];
  current: T;
  owned: boolean;
  onPick: (value: T) => void;
  onClear: () => void;
  render: (value: T) => React.ReactNode;
}) {
  return (
    <section>
      <span className="flex items-baseline justify-between gap-2">
        <Label>{label}</Label>
        {owned && <ClearButton onClick={onClear} />}
      </span>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {options.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={value === current}
            aria-label={value}
            onClick={() => onPick(value)}
            className={cn(
              "rounded-lg p-1.5 transition-all",
              value === current
                ? "ring-2 ring-foreground"
                : "ring-1 ring-border hover:ring-muted-foreground/40",
            )}
          >
            {render(value)}
          </button>
        ))}
      </div>
      <span className="sr-only">{keyName}</span>
    </section>
  );
}

/** One axis, each option drawn as the chart it produces. */
function MiniRow<T extends string>({
  label,
  keyName,
  style,
  sources,
  options,
  onPick,
  onClear,
}: {
  label: string;
  keyName: StyleKey;
  style: Parameters<typeof styleFrom>[1];
  sources: Record<StyleKey, string>;
  options: readonly T[];
  onPick: (value: T) => void;
  onClear: () => void;
}) {
  const kind: ChartKind = keyName === "frame" ? "column" : "column";
  return (
    <section>
      <span className="flex items-baseline justify-between gap-2">
        <Label>{label}</Label>
        {sources[keyName] !== "default" && <ClearButton onClick={onClear} />}
      </span>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {options.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={(style as Record<string, unknown>)[keyName] === value}
            onClick={() => onPick(value)}
            className={cn(
              "overflow-hidden rounded-lg bg-page p-1.5 text-left transition-all",
              (style as Record<string, unknown>)[keyName] === value
                ? "ring-2 ring-foreground"
                : "ring-1 ring-border hover:ring-muted-foreground/40",
            )}
          >
            <Chart
              kind={kind}
              series={MINI}
              style={styleFrom({ [keyName]: value }, style)}
              unit="count"
              width={120}
              height={38}
              label={value}
            />
            <span className="mt-1 block truncate text-[10px] text-muted-foreground">
              {value.replace(/_/g, " ")}
            </span>
          </button>
        ))}
      </div>
    </section>
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
