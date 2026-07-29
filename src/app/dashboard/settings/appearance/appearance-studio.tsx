"use client";

import { useEffect, useRef, useState } from "react";
import { PanelLeft, PanelRight, Sparkles, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import { useAppearance } from "@/components/appearance/appearance-provider";
import {
  APPEARANCE_PRESETS,
  APPEARANCE_RANGES,
  matchingPresetId,
  type Appearance,
  type Density,
  type SidebarPosition,
  type SurfaceStyle,
} from "@/lib/appearance";
import { animate, morphLayout, scaled, stagger } from "@/lib/anime";
import { cn } from "@/lib/utils";

// The appearance studio.
//
// Two decisions carry this screen:
//
// **The app is the preview.** There is no framed mock-up of a fake interface —
// dragging a slider changes the real UI you are looking at, including this
// page, its sliders, and the sidebar beside it. A preview panel would be a
// second thing to keep in sync with the first, and it would lie the moment
// they diverged.
//
// **Presets first, sliders second.** Nine controls with no starting point is a
// customisation surface nobody touches. "Pick one of these, then adjust" is one
// people use — so the presets are the top of the page and the sliders are what
// you reach for after.

export function AppearanceStudio() {
  const { appearance, commit, preview, reset, dirty, revert } = useAppearance();
  const activePreset = matchingPresetId(appearance);
  const gridRef = useRef<HTMLDivElement | null>(null);

  // The one place a flourish is warranted: the preset cards cascade in, so the
  // page that is about motion demonstrates the motion setting on arrival.
  useEffect(() => {
    const cards = gridRef.current?.querySelectorAll("[data-preset]");
    if (!cards || cards.length === 0) return;
    const duration = scaled(420);
    if (duration === 0) return;
    animate(cards, {
      opacity: [0, 1],
      y: [10, 0],
      scale: [0.985, 1],
      duration,
      delay: stagger(40),
      ease: "cubicBezier(0.16, 1, 0.3, 1)",
    });
  }, []);

  return (
    <div className="space-y-8">
      <PageHeader
        icon={Sparkles}
        title="Appearance"
        context="Yours. Saved as you go, on every device you sign in from."
        actions={
          <div className="flex items-center gap-2">
            {dirty && (
              <Button variant="outline" size="sm" onClick={revert}>
                Undo
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={reset}>
              Reset
            </Button>
          </div>
        }
      />

      <section>
        <SectionLabel>Start from</SectionLabel>
        <div
          ref={gridRef}
          className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
        >
          {APPEARANCE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              data-preset={p.id}
              aria-pressed={activePreset === p.id}
              onClick={() => {
                // A preset can move the sidebar, so the whole shell re-lays
                // out — run it through anime.js so it reads as one movement
                // rather than a cut.
                morphLayout("body", () => commit(p.settings));
              }}
              className={cn(
                "panel lift block rounded-2xl p-4 text-left",
                activePreset === p.id && "ring-2 ring-foreground",
              )}
            >
              <span className="flex items-center gap-2">
                <PresetSwatch preset={p.settings} />
                <span className="text-sm font-medium">{p.name}</span>
              </span>
              <span className="mt-2 block text-xs leading-relaxed text-muted-foreground">
                {p.description}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <div>
            <SectionLabel>Navigation</SectionLabel>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {(
                [
                  { v: "left", label: "Left", icon: PanelLeft },
                  { v: "right", label: "Right", icon: PanelRight },
                  { v: "floating", label: "Floating", icon: Square },
                ] as { v: SidebarPosition; label: string; icon: typeof PanelLeft }[]
              ).map(({ v, label, icon: Icon }) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={appearance.sidebarPosition === v}
                  onClick={() =>
                    morphLayout("body", () => commit({ sidebarPosition: v }))
                  }
                  className={cn(
                    "panel flex flex-col items-center gap-1.5 rounded-xl px-3 py-3 text-xs",
                    appearance.sidebarPosition === v &&
                      "ring-2 ring-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Floating lifts the sidebar out of the layout entirely — the
              content runs full width and the nav slides in over it.
            </p>
          </div>

          <Slider
            label="Sidebar width"
            value={appearance.sidebarWidth}
            range={APPEARANCE_RANGES.sidebarWidth}
            step={0.5}
            format={(v) => `${v.toFixed(1)}rem`}
            onInput={(v) => preview({ sidebarWidth: v })}
            onCommit={(v) => commit({ sidebarWidth: v })}
          />

          <Choice<Density>
            label="Density"
            value={appearance.density}
            options={[
              ["compact", "Compact"],
              ["comfortable", "Comfortable"],
              ["spacious", "Spacious"],
            ]}
            onPick={(v) => commit({ density: v })}
          />

          <Choice<SurfaceStyle>
            label="Surfaces"
            value={appearance.surface}
            options={[
              ["flat", "Flat"],
              ["soft", "Soft"],
              ["raised", "Raised"],
              ["bordered", "Bordered"],
            ]}
            onPick={(v) => commit({ surface: v })}
          />
        </div>

        <div className="space-y-6">
          <Slider
            label="Corner radius"
            value={appearance.radiusScale}
            range={APPEARANCE_RANGES.radiusScale}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onInput={(v) => preview({ radiusScale: v })}
            onCommit={(v) => commit({ radiusScale: v })}
          />

          <Slider
            label="Text size"
            value={appearance.fontScale}
            range={APPEARANCE_RANGES.fontScale}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            onInput={(v) => preview({ fontScale: v })}
            onCommit={(v) => commit({ fontScale: v })}
          />

          <Slider
            label="Heading weight"
            value={appearance.headingWeight}
            range={APPEARANCE_RANGES.headingWeight}
            step={100}
            format={(v) => String(Math.round(v))}
            onInput={(v) => preview({ headingWeight: v })}
            onCommit={(v) => commit({ headingWeight: v })}
          />

          <Slider
            label="Motion"
            value={appearance.motionScale}
            range={APPEARANCE_RANGES.motionScale}
            step={0.05}
            format={(v) => (v === 0 ? "Off" : `${Math.round(v * 100)}%`)}
            hint="Zero turns animation off without turning anything else off. Your system's reduce-motion setting always wins."
            onInput={(v) => preview({ motionScale: v })}
            onCommit={(v) => commit({ motionScale: v })}
          />

          <div>
            <SectionLabel>Accent</SectionLabel>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                aria-pressed={appearance.accentMode === "ink"}
                onClick={() => commit({ accentMode: "ink" })}
                className={cn(
                  "panel flex-1 rounded-xl px-3 py-2 text-xs",
                  appearance.accentMode === "ink" && "ring-2 ring-foreground",
                )}
              >
                Ink
              </button>
              <button
                type="button"
                aria-pressed={appearance.accentMode === "hue"}
                onClick={() => commit({ accentMode: "hue" })}
                className={cn(
                  "panel flex-1 rounded-xl px-3 py-2 text-xs",
                  appearance.accentMode === "hue" && "ring-2 ring-foreground",
                )}
              >
                Colour
              </button>
            </div>
            {appearance.accentMode === "hue" && (
              <div className="mt-4 space-y-4">
                <Slider
                  label="Hue"
                  value={appearance.accentHue}
                  range={APPEARANCE_RANGES.accentHue}
                  step={1}
                  format={(v) => `${Math.round(v)}°`}
                  onInput={(v) => preview({ accentHue: v })}
                  onCommit={(v) => commit({ accentHue: v })}
                />
                <Slider
                  label="Saturation"
                  value={appearance.accentSaturation}
                  range={APPEARANCE_RANGES.accentSaturation}
                  step={1}
                  format={(v) => `${Math.round(v)}%`}
                  onInput={(v) => preview({ accentSaturation: v })}
                  onCommit={(v) => commit({ accentSaturation: v })}
                />
              </div>
            )}
          </div>
        </div>
      </section>

      <section>
        <SectionLabel>How it looks</SectionLabel>
        {/* Real components, not a mock: whatever this row does, the rest of
            the app does. */}
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div className="panel rounded-2xl p-5">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              A card
            </p>
            <p className="mt-2 text-2xl">128</p>
            <div className="bento-tile mt-3 p-3 text-xs text-muted-foreground">
              A nested well
            </div>
          </div>
          <div className="panel rounded-2xl p-5">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              A field
            </p>
            <input
              aria-label="Example field"
              defaultValue="Editable text"
              className="soft-field mt-2 w-full px-3 py-2 text-sm"
            />
            <div className="mt-3 flex gap-2">
              <Button size="sm">Primary</Button>
              <Button size="sm" variant="outline">
                Outline
              </Button>
            </div>
          </div>
          <div className="panel rounded-2xl p-5">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Chips
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {["To do", "In progress", "Done"].map((s) => (
                <span
                  key={s}
                  className="rounded-full bg-brand-100 px-2 py-0.5 text-[11px] text-brand-700"
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </span>
  );
}

/** A three-swatch read of what a preset does, without rendering the app twice. */
function PresetSwatch({ preset }: { preset: Appearance }) {
  const radius = `${(0.35 * preset.radiusScale).toFixed(2)}rem`;
  return (
    <span aria-hidden className="flex items-center gap-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            borderRadius: radius,
            boxShadow:
              preset.surface === "flat" || preset.surface === "bordered"
                ? "none"
                : "0 1px 3px rgb(16 16 16 / 0.25)",
            border:
              preset.surface === "bordered"
                ? "1px solid var(--color-foreground)"
                : "1px solid transparent",
            background:
              preset.accentMode === "hue"
                ? `hsl(${preset.accentHue} ${preset.accentSaturation}% ${46 + i * 16}%)`
                : ["#131316", "#3f3f46", "#d9d9de"][i],
          }}
          className="h-4 w-2.5"
        />
      ))}
    </span>
  );
}

/**
 * A range control that previews on input and saves on release.
 *
 * The split matters: `onInput` repaints on every frame of the drag so the app
 * responds under your finger, and `onCommit` is what reaches the database. One
 * without the other is either a laggy slider or four hundred writes.
 */
function Slider({
  label,
  value,
  range,
  step,
  format,
  hint,
  onInput,
  onCommit,
}: {
  label: string;
  value: number;
  range: readonly [number, number];
  step: number;
  format: (v: number) => string;
  hint?: string;
  onInput: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  const [local, setLocal] = useState(value);
  // Follow the stored value unless this slider is the thing changing it.
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setLocal(value);
  }, [value]);

  return (
    <label className="block">
      <span className="flex items-baseline justify-between">
        <SectionLabel>{label}</SectionLabel>
        <span className="font-mono text-[11px] text-muted-foreground">
          {format(local)}
        </span>
      </span>
      <input
        type="range"
        min={range[0]}
        max={range[1]}
        step={step}
        value={local}
        aria-label={label}
        onPointerDown={() => {
          dragging.current = true;
        }}
        onChange={(e) => {
          const next = Number.parseFloat(e.currentTarget.value);
          setLocal(next);
          onInput(next);
        }}
        onPointerUp={() => {
          dragging.current = false;
          onCommit(local);
        }}
        onBlur={() => {
          if (!dragging.current) onCommit(local);
        }}
        onKeyUp={() => onCommit(local)}
        className="mt-2 w-full accent-foreground"
      />
      {hint && (
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
          {hint}
        </span>
      )}
    </label>
  );
}

function Choice<T extends string>({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onPick: (v: T) => void;
}) {
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <div className="segmented mt-2 w-full">
        {options.map(([v, text]) => (
          <button
            key={v}
            type="button"
            aria-pressed={value === v}
            onClick={() => onPick(v)}
            className={cn(
              "min-w-0 flex-1 truncate px-2 py-1.5 text-xs",
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
