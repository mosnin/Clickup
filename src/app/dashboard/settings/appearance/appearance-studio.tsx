"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PanelLeft, PanelRight, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import {
  useAppearance,
  type AppearanceScope,
} from "@/components/appearance/appearance-provider";
import {
  APPEARANCE_PRESETS,
  APPEARANCE_RANGES,
  matchingPresetId,
  type Appearance,
  type AppearanceKey,
  type AppearanceLayerId,
  type Density,
  type SidebarPosition,
  type SurfaceStyle,
} from "@/lib/appearance";
import { animate, morphLayout, scaled, stagger } from "@/lib/anime";
import { cn } from "@/lib/utils";

// The appearance studio.
//
// Three decisions carry this screen:
//
// **The app is the preview.** There is no framed mock-up of a fake interface —
// dragging a slider changes the real UI you are looking at, including this page,
// its sliders, and the sidebar beside it. A preview panel would be a second
// thing to keep in sync with the first, and it would lie the moment they
// diverged. It is also why the space scope lives on a route *inside* the space:
// the URL says which room you are in, so the whole app previews that room.
//
// **Presets first, sliders second.** Nine controls with no starting point is a
// customisation surface nobody touches. "Pick one of these, then adjust" is one
// people use.
//
// **Every control says where its value came from.** Three writers decide what
// you see, so a slider showing 1.6 has to answer "who set that?" — otherwise
// the customiser is a set of numbers arriving from nowhere, and the space's
// look and yours are indistinguishable. A value inherited from another layer is
// labelled; one set at the scope you are editing offers to stop overriding.

const SCOPE_COPY: Record<
  AppearanceScope,
  { tab: string; title: string; context: string; resetLabel: string }
> = {
  personal: {
    tab: "Everywhere",
    title: "How you see the app",
    context: "Yours, in every space. Saved as you go, on every device.",
    resetLabel: "Reset yours",
  },
  space: {
    tab: "This space",
    title: "How this space looks",
    context:
      "Shared. Everyone in this space sees it, and it changes for them the moment you do.",
    resetLabel: "Clear the space's look",
  },
  personalSpace: {
    tab: "Just me, here",
    title: "How this space looks to you",
    context: "Only yours, and only in this space. Nobody else's view moves.",
    resetLabel: "Match the space again",
  },
};

const LAYER_LABEL: Record<AppearanceLayerId, string> = {
  default: "Default",
  personal: "Your setting",
  space: "From this space",
  personalSpace: "Your override here",
};

export function AppearanceStudio() {
  const {
    appearance,
    sources,
    space,
    patchFor,
    availableScopes,
    commit,
    preview,
    clear,
    reset,
    dirty,
    revert,
    liveEditor,
  } = useAppearance();

  const [scope, setScope] = useState<AppearanceScope>("personal");
  const activePreset = matchingPresetId(appearance);
  const gridRef = useRef<HTMLDivElement | null>(null);

  // Leaving the space (or losing the right to theme it) must not strand the
  // editor on a scope it can no longer write.
  useEffect(() => {
    if (!availableScopes.includes(scope)) setScope("personal");
  }, [availableScopes, scope]);

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

  const copy = SCOPE_COPY[scope];
  const editingPlaceOnly = scope !== "personal";
  const patch = patchFor(scope);

  /** What one control needs to know about the layer it is editing. */
  function field(...keys: AppearanceKey[]) {
    const owned = keys.some((k) => k in patch);
    // The source of the first key stands for the group; the grouped controls
    // (hue + saturation) are always written together.
    const from = sources[keys[0]];
    return {
      owned,
      /** Named only when it comes from somewhere other than here. */
      inheritedFrom: !owned && from !== "default" ? LAYER_LABEL[from] : null,
      /** True when saving here won't change what *you* see. */
      shadowed:
        scope === "space" &&
        keys.some((k) => sources[k] === "personalSpace"),
      onClear: owned ? () => morphLayout("body", () => clear(keys, scope)) : null,
    };
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={copy.title}
        context={
          space && editingPlaceOnly
            ? copy.context.replace("this space", space.name)
            : copy.context
        }
        actions={
          <div className="flex items-center gap-2">
            {dirty && (
              <Button variant="outline" size="sm" onClick={revert}>
                Undo
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => reset(scope)}>
              {copy.resetLabel}
            </Button>
          </div>
        }
      />

      {/* The scope switch. Switching re-resolves and morphs, which is how this
          teaches the model: you see the layer you are editing take over. */}
      {availableScopes.length > 1 ? (
        <div className="segmented w-full sm:w-auto sm:inline-flex">
          {availableScopes.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={scope === s}
              onClick={() => morphLayout("body", () => setScope(s))}
              className={cn(
                "min-w-0 flex-1 truncate px-3 py-1.5 text-xs sm:flex-none",
                scope === s && "segmented-on",
              )}
            >
              {s === "space" && space ? space.name : SCOPE_COPY[s].tab}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Open a space to give it a look of its own.{" "}
          {space === null && "This page is your own settings, everywhere."}
        </p>
      )}

      {liveEditor && (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {liveEditor} is changing how this space looks right now. What you are
          seeing is their work in progress.
        </p>
      )}

      {editingPlaceOnly && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          A space sets its accent, its corners and its surfaces — that is what
          makes walking into it feel like a different room. Text size, motion,
          density and where the navigation lives stay yours alone, in every
          space, and nothing here can change them.
        </p>
      )}

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
                // rather than a cut. At a space scope the provider keeps only
                // the part a space is allowed to set.
                morphLayout("body", () => commit(p.settings, scope));
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
                {editingPlaceOnly ? placeHalfOf(p.description) : p.description}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          {/* Personal-only controls are absent at a space scope rather than
              disabled. A control that cannot do anything is worse than no
              control: it invites the attempt and then refuses it. */}
          {!editingPlaceOnly && (
            <>
              <Field label="Navigation" {...field("sidebarPosition")}>
                <div className="mt-1 grid grid-cols-3 gap-2">
                  {(
                    [
                      { v: "left", label: "Left", icon: PanelLeft },
                      { v: "right", label: "Right", icon: PanelRight },
                      { v: "floating", label: "Floating", icon: Square },
                    ] as {
                      v: SidebarPosition;
                      label: string;
                      icon: typeof PanelLeft;
                    }[]
                  ).map(({ v, label, icon: Icon }) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={appearance.sidebarPosition === v}
                      onClick={() =>
                        morphLayout("body", () =>
                          commit({ sidebarPosition: v }, scope),
                        )
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
              </Field>

              <Slider
                label="Sidebar width"
                value={appearance.sidebarWidth}
                range={APPEARANCE_RANGES.sidebarWidth}
                step={0.5}
                format={(v) => `${v.toFixed(1)}rem`}
                status={field("sidebarWidth")}
                onInput={(v) => preview({ sidebarWidth: v }, scope)}
                onCommit={(v) => commit({ sidebarWidth: v }, scope)}
              />

              <Field label="Density" {...field("density")}>
                <Segmented<Density>
                  value={appearance.density}
                  options={[
                    ["compact", "Compact"],
                    ["comfortable", "Comfortable"],
                    ["spacious", "Spacious"],
                  ]}
                  onPick={(v) => commit({ density: v }, scope)}
                />
              </Field>
            </>
          )}

          <Field label="Surfaces" {...field("surface")}>
            <Segmented<SurfaceStyle>
              value={appearance.surface}
              options={[
                ["flat", "Flat"],
                ["soft", "Soft"],
                ["raised", "Raised"],
                ["bordered", "Bordered"],
              ]}
              onPick={(v) => commit({ surface: v }, scope)}
            />
          </Field>
        </div>

        <div className="space-y-6">
          <Slider
            label="Corner radius"
            value={appearance.radiusScale}
            range={APPEARANCE_RANGES.radiusScale}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            status={field("radiusScale")}
            onInput={(v) => preview({ radiusScale: v }, scope)}
            onCommit={(v) => commit({ radiusScale: v }, scope)}
          />

          {!editingPlaceOnly && (
            <>
              <Slider
                label="Text size"
                value={appearance.fontScale}
                range={APPEARANCE_RANGES.fontScale}
                step={0.01}
                format={(v) => `${Math.round(v * 100)}%`}
                status={field("fontScale")}
                onInput={(v) => preview({ fontScale: v }, scope)}
                onCommit={(v) => commit({ fontScale: v }, scope)}
              />

              <Slider
                label="Heading weight"
                value={appearance.headingWeight}
                range={APPEARANCE_RANGES.headingWeight}
                step={100}
                format={(v) => String(Math.round(v))}
                status={field("headingWeight")}
                onInput={(v) => preview({ headingWeight: v }, scope)}
                onCommit={(v) => commit({ headingWeight: v }, scope)}
              />

              <Slider
                label="Motion"
                value={appearance.motionScale}
                range={APPEARANCE_RANGES.motionScale}
                step={0.05}
                format={(v) => (v === 0 ? "Off" : `${Math.round(v * 100)}%`)}
                hint="Zero turns animation off without turning anything else off. Your system's reduce-motion setting always wins."
                status={field("motionScale")}
                onInput={(v) => preview({ motionScale: v }, scope)}
                onCommit={(v) => commit({ motionScale: v }, scope)}
              />
            </>
          )}

          <Field
            label="Accent"
            {...field("accentMode", "accentHue", "accentSaturation")}
          >
            <div className="mt-1 flex gap-2">
              {(
                [
                  ["ink", "Ink"],
                  ["hue", "Colour"],
                ] as ["ink" | "hue", string][]
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={appearance.accentMode === mode}
                  onClick={() => commit({ accentMode: mode }, scope)}
                  className={cn(
                    "panel flex-1 rounded-xl px-3 py-2 text-xs",
                    appearance.accentMode === mode && "ring-2 ring-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {appearance.accentMode === "hue" && (
              <div className="mt-4 space-y-4">
                <Slider
                  label="Hue"
                  value={appearance.accentHue}
                  range={APPEARANCE_RANGES.accentHue}
                  step={1}
                  format={(v) => `${Math.round(v)}°`}
                  onInput={(v) => preview({ accentHue: v }, scope)}
                  onCommit={(v) => commit({ accentHue: v }, scope)}
                />
                <Slider
                  label="Saturation"
                  value={appearance.accentSaturation}
                  range={APPEARANCE_RANGES.accentSaturation}
                  step={1}
                  format={(v) => `${Math.round(v)}%`}
                  onInput={(v) => preview({ accentSaturation: v }, scope)}
                  onCommit={(v) => commit({ accentSaturation: v }, scope)}
                />
              </div>
            )}
          </Field>
        </div>
      </section>

      {space && !editingPlaceOnly && (
        <p className="text-xs text-muted-foreground">
          {space.mayTheme
            ? `You can also give ${space.name} a look of its own, for everyone in it.`
            : `${space.name} can have a look of its own — ask whoever created it.`}
        </p>
      )}

      {!space && (
        <p className="text-xs text-muted-foreground">
          Spaces can carry their own accent and surfaces. Open one and come back
          here to set it.{" "}
          <Link href="/dashboard/spaces" className="underline">
            Your spaces
          </Link>
        </p>
      )}

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

/** Drop the half of a preset's description that a space can't deliver. */
function placeHalfOf(description: string): string {
  return description
    .replace(/,? ?(Tighter rows, smaller type\.|smaller type\.)/i, "")
    .trim();
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </span>
  );
}

type FieldStatus = {
  owned: boolean;
  inheritedFrom: string | null;
  shadowed: boolean;
  onClear: (() => void) | null;
};

/**
 * A labelled control that says where its value came from.
 *
 * The three states are the whole point. **Inherited** names the layer, so a
 * value you did not choose does not read as one you did. **Set here** offers to
 * stop overriding, and clearing deletes the key rather than copying down the
 * parent's current value — copying looks identical today and stops tracking
 * tomorrow. **Shadowed** is the honest admission that a change you are about to
 * make to the space will not move your own view, because you are overriding it.
 */
function Field({
  label,
  owned,
  inheritedFrom,
  shadowed,
  onClear,
  children,
}: FieldStatus & { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="flex items-baseline justify-between gap-2">
        <SectionLabel>{label}</SectionLabel>
        <FieldStatusLabel
          owned={owned}
          inheritedFrom={inheritedFrom}
          shadowed={shadowed}
          onClear={onClear}
        />
      </span>
      <div className="mt-2">{children}</div>
      {shadowed && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          You have your own version of this here, so changing it for the space
          won&apos;t move your view.
        </p>
      )}
    </div>
  );
}

function FieldStatusLabel({ owned, inheritedFrom, onClear }: FieldStatus) {
  if (owned && onClear) {
    return (
      <button
        type="button"
        onClick={onClear}
        className="tap-target text-[11px] text-muted-foreground underline decoration-dotted hover:text-foreground"
      >
        Set here — clear
      </button>
    );
  }
  if (inheritedFrom) {
    return (
      <span className="text-[11px] text-muted-foreground">{inheritedFrom}</span>
    );
  }
  return null;
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
  status,
  onInput,
  onCommit,
}: {
  label: string;
  value: number;
  range: readonly [number, number];
  step: number;
  format: (v: number) => string;
  hint?: string;
  status?: FieldStatus;
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
      <span className="flex items-baseline justify-between gap-2">
        <SectionLabel>{label}</SectionLabel>
        <span className="flex items-baseline gap-2">
          {status && <FieldStatusLabel {...status} />}
          <span className="font-mono text-[11px] text-muted-foreground">
            {format(local)}
          </span>
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
      {status?.shadowed && (
        <span className="mt-1.5 block text-[11px] leading-relaxed text-muted-foreground">
          You have your own version of this here, so changing it for the space
          won&apos;t move your view.
        </span>
      )}
    </label>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onPick,
}: {
  value: T;
  options: [T, string][];
  onPick: (v: T) => void;
}) {
  return (
    <div className="segmented w-full">
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
  );
}
