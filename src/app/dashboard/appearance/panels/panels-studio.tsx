"use client";

import { Button } from "@/components/ui/button";
import { StudioChrome } from "@/components/appearance/studio-chrome";
import {
  PanelPreview,
  PresetTile,
  styleFrom,
} from "@/components/appearance/style-gallery";
import { useComponentStyle } from "@/components/appearance/use-component-style";
import {
  DEFAULT_STYLE,
  STYLE_ENUMS,
  STYLE_PRESETS,
  matchingStylePresetId,
  normalizeStylePatch,
  type StyleKey,
} from "@/lib/component-style";
import { cn } from "@/lib/utils";

// The Panels chapter: the frame around the data.
//
// Same rule as Charts — every option is drawn as the panel it produces, at the
// size a panel is actually drawn, using the same renderer. Frames and fills are
// the half of a look that a bare chart cannot show, so this page is miniatures
// of whole cards rather than swatches of colour.

export function PanelsStudio() {
  const { style, sources, commit, clear, reset, dirty, revert } =
    useComponentStyle();
  const set = (patch: Parameters<typeof commit>[0]) => commit(patch, "personal");
  const activePreset = matchingStylePresetId(style);

  function Row<T extends string>({
    label,
    hint,
    keyName,
    options,
    columns = 4,
  }: {
    label: string;
    hint?: string;
    keyName: StyleKey;
    options: readonly T[];
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
            "mt-3 grid gap-3",
            columns === 6
              ? "grid-cols-1 sm:grid-cols-3 lg:grid-cols-6"
              : columns === 5
                ? "grid-cols-1 sm:grid-cols-3 lg:grid-cols-5"
                : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
          )}
        >
          {options.map((value) => {
            const selected = (style[keyName] as unknown as T) === value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={selected}
                onClick={() => set({ [keyName]: value })}
                className={cn(
                  "flex flex-col overflow-hidden rounded-xl text-left transition-all duration-150",
                  selected
                    ? "ring-2 ring-foreground"
                    : "ring-1 ring-border hover:ring-muted-foreground/40",
                )}
              >
                <span className="block bg-page p-3">
                  <PanelPreview
                    style={styleFrom({ [keyName]: value }, style)}
                    compact
                  />
                </span>
                <span className="block border-t border-border bg-card px-3 py-2 text-xs font-medium">
                  {titleCase(value)}
                </span>
              </button>
            );
          })}
        </div>
      </section>
    );
  }

  return (
    <StudioChrome
      base="/dashboard/appearance"
      title="Panels"
      context="The frame around the data. Every tile is a real panel drawn with the setting applied — a swatch of colour could not tell you what a glass frame or an inverted fill does to the chart inside it."
      actions={
        <div className="flex items-center gap-2">
          {dirty && (
            <Button variant="outline" size="sm" onClick={revert}>
              Undo
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => reset("personal")}>
            Reset panels
          </Button>
        </div>
      }
    >
      <div className="space-y-10">
        <section>
          <h2 className="text-sm font-medium">Start from</h2>
          <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">
            Nineteen settings with no starting point is a surface nobody
            touches. Each of these moves a dozen of them at once; adjust from
            there.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {STYLE_PRESETS.map((preset) => (
              <PresetTile
                key={preset.id}
                name={preset.name}
                description={preset.description}
                style={{ ...DEFAULT_STYLE, ...normalizeStylePatch(preset.patch) }}
                selected={activePreset === preset.id}
                onPick={() => {
                  // A preset is a statement about the whole look, so it
                  // replaces rather than merges — merging leaves keys from the
                  // previous preset behind and the result matches neither.
                  reset("personal");
                  set(preset.patch);
                }}
              />
            ))}
          </div>
        </section>

        <Row label="Frame" keyName="frame" options={STYLE_ENUMS.frame} columns={6} />
        <Row
          label="Fill"
          hint="What the card is made of. Inverted flips the text with it."
          keyName="fill"
          options={STYLE_ENUMS.fill}
          columns={5}
        />
        <Row label="Corners" keyName="corner" options={STYLE_ENUMS.corner} />
        <Row label="Padding" keyName="padding" options={STYLE_ENUMS.padding} columns={4} />
        <Row
          label="Title"
          hint="Hidden is a real answer: a panel whose chart says what it is does not need a label above it."
          keyName="titleStyle"
          options={STYLE_ENUMS.titleStyle}
        />
      </div>
    </StudioChrome>
  );
}

function titleCase(value: string): string {
  return value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
