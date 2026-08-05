"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Bot, PanelBottom, PanelLeft, PanelRight, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import { ActorGlyph } from "@/components/appearance/actor-glyph";
import { AnimatedBar } from "@/components/motion";
import { Orb } from "@/components/dashboard/orb";
import { identityFill } from "@/lib/identity-color";
import {
  useAppearance,
  type AppearanceScope,
} from "@/components/appearance/appearance-provider";
import {
  APPEARANCE_PRESETS,
  APPEARANCE_RANGES,
  displayStackFor,
  fontStackFor,
  matchingPresetId,
  type AgentIconStyle,
  type Appearance,
  type AppearanceKey,
  type AppearanceLayerId,
  type ChartStyle,
  type Density,
  type DisplayFont,
  type FontFamily,
  type ListStyle,
  type SidebarPosition,
  type SurfaceStyle,
} from "@/lib/appearance";
import {
  animate,
  morphLayout,
  scaled,
  stagger,
  SHELL_PARTS,
} from "@/lib/anime";
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
        eyebrow={"Appearance"}
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
          A space sets its accent, its corners, its surfaces, its heading face
          and how it draws lists, progress and teammates — that is what makes
          walking into it feel like a different room. The face you read
          paragraphs in, how hard the grey text works, text size, motion,
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

      {/* Chapters, not two arbitrary columns. Somebody arriving to change one
          thing needs to know where that thing lives, and "type" / "the room" /
          "how data is drawn" are the categories people actually think in. */}

      {/* ── Type ── */}
      {!editingPlaceOnly && (
        <Chapter
          title="Type"
          blurb="The face you read the app in. Every option here is either shipped with the app or already on your machine — nothing is downloaded, so switching costs nothing and works offline."
        >
          <Field label="Body" {...field("fontFamily")}>
            <ChoiceGrid<FontFamily>
              value={appearance.fontFamily}
              onPick={(v) => commit({ fontFamily: v }, scope)}
              options={[
                ["instrument", "Instrument"],
                ["system", "Your system"],
                ["serif", "Serif"],
                ["mono", "Mono"],
                ["rounded", "Rounded"],
              ]}
              render={(v) => (
                <span
                  style={{ fontFamily: fontStackFor(v) }}
                  className="block truncate text-base"
                >
                  Aa Bb 123
                </span>
              )}
            />
          </Field>

          <Field label="Headings" {...field("displayFont")}>
            <ChoiceGrid<DisplayFont>
              value={appearance.displayFont}
              onPick={(v) => commit({ displayFont: v }, scope)}
              options={[
                ["grotesque", "Grotesque"],
                ["match", "Same as body"],
                ["serif", "Serif"],
                ["mono", "Mono"],
              ]}
              render={(v) => (
                <span
                  style={{
                    fontFamily: displayStackFor(v, appearance.fontFamily),
                    fontWeight: appearance.headingWeight,
                  }}
                  className="block truncate text-lg"
                >
                  Heading
                </span>
              )}
            />
          </Field>

          <div className="grid gap-6 sm:grid-cols-2">
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
          </div>

          <Slider
            label="Secondary text"
            value={appearance.contrast}
            range={APPEARANCE_RANGES.contrast}
            step={0.02}
            format={(v) =>
              v === 1 ? "Default" : v > 1 ? `+${Math.round((v - 1) * 100)}%` : `${Math.round((v - 1) * 100)}%`
            }
            hint="How hard the grey metadata works — dates, counts, captions. Raise it if the labels are too light to read; lower it to push them further behind the content."
            status={field("contrast")}
            onInput={(v) => preview({ contrast: v }, scope)}
            onCommit={(v) => commit({ contrast: v }, scope)}
          />
        </Chapter>
      )}

      {/* ── The shell ── */}
      {!editingPlaceOnly && (
        <Chapter
          title="Layout"
          blurb="Where the navigation lives and how tightly everything sits. You can also just hold the sidebar for a moment and throw it where you want it — this is the same setting."
        >
          <Field label="Navigation" {...field("sidebarPosition")}>
            <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(
                [
                  { v: "left", label: "Left", icon: PanelLeft },
                  { v: "right", label: "Right", icon: PanelRight },
                  { v: "floating", label: "Floating", icon: Square },
                  { v: "dock", label: "Dock", icon: PanelBottom },
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
                    morphLayout(
                      "body",
                      () => commit({ sidebarPosition: v }, scope),
                      { children: SHELL_PARTS },
                    )
                  }
                  className={cn(
                    "panel flex flex-col items-center gap-1.5 rounded-xl px-3 py-3 text-xs",
                    appearance.sidebarPosition === v && "ring-2 ring-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Floating lifts the sidebar out of the layout entirely — the
              content runs full width and the nav slides in over it. Dock moves
              it to the bottom edge as a row of glyphs that magnify under the
              cursor.
            </p>
          </Field>

          <div className="grid gap-6 sm:grid-cols-2">
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
          </div>

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
        </Chapter>
      )}

      {/* ── The room ── */}
      <Chapter
        title="Surfaces and colour"
        blurb={
          editingPlaceOnly
            ? "What makes walking into this space feel like a different room."
            : "Your defaults everywhere. A space can carry its own, and you can still override it there."
        }
      >
        <div className="grid gap-6 sm:grid-cols-2">
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
        </div>

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
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
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
      </Chapter>

      {/* ── How data is drawn ── */}
      <Chapter
        title="How data is drawn"
        blurb="The three shapes this product repeats most: a list of things, a number against a target, and a teammate's name. Each is drawn hundreds of times on a busy screen, which is why how they are drawn is worth a choice."
      >
        <Field label="Lists" {...field("listStyle")}>
          <ChoiceGrid<ListStyle>
            value={appearance.listStyle}
            onPick={(v) => morphLayout("body", () => commit({ listStyle: v }, scope))}
            options={[
              ["rows", "Rows"],
              ["lines", "Ruled"],
              ["cards", "Tiles"],
              ["condensed", "Condensed"],
            ]}
            render={(v) => <ListSpecimen style={v} />}
          />
        </Field>

        <Field label="Progress" {...field("chartStyle")}>
          <ChoiceGrid<ChartStyle>
            value={appearance.chartStyle}
            onPick={(v) => commit({ chartStyle: v }, scope)}
            options={[
              ["bar", "Bar"],
              ["line", "Hairline"],
              ["ring", "Dial"],
              ["numeric", "Just the number"],
            ]}
            render={(v) => <ChartSpecimen style={v} />}
          />
        </Field>

        <Field label="Teammates" {...field("agentIcon")}>
          <ChoiceGrid<AgentIconStyle>
            value={appearance.agentIcon}
            onPick={(v) => commit({ agentIcon: v }, scope)}
            options={[
              ["orb", "Orb"],
              ["monogram", "Initial"],
              ["dot", "Dot"],
              ["glyph", "Machine mark"],
            ]}
            render={(v) => <GlyphSpecimen style={v} />}
          />
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            The machine mark distinguishes agents from people at a glance;
            people keep their initial under it. A room of eighty orbs is noisy,
            which is what the quieter options are for.
          </p>
        </Field>

        <Slider
          label="Icon weight"
          value={appearance.iconStroke}
          range={APPEARANCE_RANGES.iconStroke}
          step={0.05}
          format={(v) => v.toFixed(2)}
          hint="The stroke width of every line icon in the app."
          status={field("iconStroke")}
          onInput={(v) => preview({ iconStroke: v }, scope)}
          onCommit={(v) => commit({ iconStroke: v }, scope)}
        />
      </Chapter>

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
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
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

          {/* The real primitives, not drawings of them: `.ui-list` is the
              class every authored panel's rows wear, and AnimatedBar is the
              one used by every sprint, goal and roadmap in the app. If these
              look wrong, the app looks wrong. */}
          <div className="panel rounded-2xl p-5">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              A list
            </p>
            <div className="ui-list mt-3">
              {["Ship the migration", "Review the audit", "Draft the release"].map(
                (t) => (
                  <div key={t} className="min-w-0">
                    <span className="block truncate text-sm">{t}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      due tomorrow
                    </span>
                  </div>
                ),
              )}
            </div>
          </div>

          <div className="panel rounded-2xl p-5">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Progress
            </p>
            <div className="mt-3">
              <AnimatedBar
                pct={62}
                className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                barClassName="h-full rounded-full bg-foreground"
              />
            </div>
          </div>

          <div className="panel rounded-2xl p-5">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Teammates
            </p>
            <div className="ui-list mt-3">
              {[
                { name: "Ada", agent: true },
                { name: "Grace", agent: false },
              ].map((p) => (
                <div key={p.name} className="flex items-center gap-2">
                  <ActorGlyph name={p.name} size="sm" isAgent={p.agent} />
                  <span className="min-w-0 truncate text-sm">{p.name}</span>
                </div>
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

/**
 * A named group of related controls.
 *
 * The page used to be two columns filled in whatever order the controls were
 * written, which is fine at nine settings and unnavigable at eighteen. Someone
 * arriving to change one thing has to be able to guess where it is, and "type",
 * "layout", "surfaces", "how data is drawn" are the categories people already
 * hold in their heads.
 */
function Chapter({
  title,
  blurb,
  children,
}: {
  title: string;
  blurb: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel rounded-2xl p-5 sm:p-6">
      <h2 className="text-lg">{title}</h2>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted-foreground">
        {blurb}
      </p>
      <div className="mt-5 space-y-6">{children}</div>
    </section>
  );
}

/**
 * A row of options, each showing itself.
 *
 * The rule this exists to enforce: **an option that can be drawn must be drawn,
 * not named.** "Ruled" and "Tiles" are two words that tell you nothing about
 * which one you want; three lines with rules between them and three lines in
 * tiles tell you immediately. The specimen renders with the real tokens, so it
 * cannot drift from what choosing it produces.
 */
function ChoiceGrid<T extends string>({
  value,
  options,
  onPick,
  render,
}: {
  value: T;
  options: [T, string][];
  onPick: (v: T) => void;
  render: (v: T) => React.ReactNode;
}) {
  return (
    <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onPick(v)}
          className={cn(
            "panel lift flex flex-col gap-2 rounded-xl p-3 text-left",
            value === v && "ring-2 ring-foreground",
          )}
        >
          <span className="flex h-12 items-center overflow-hidden">
            {render(v)}
          </span>
          <span className="truncate text-[11px] text-muted-foreground">
            {label}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Three rows, drawn the way that list style draws them. */
function ListSpecimen({ style }: { style: ListStyle }) {
  // A line of "text" — the thing every row in every list actually holds.
  const line = <span className="block h-1 w-2/3 rounded-sm bg-muted-foreground/30" />;
  const rows = [0, 1, 2];

  if (style === "lines") {
    return (
      <span aria-hidden className="flex w-full flex-col">
        {rows.map((i) => (
          <span
            key={i}
            className={cn("block py-1.5", i > 0 && "border-t border-border")}
          >
            {line}
          </span>
        ))}
      </span>
    );
  }

  if (style === "cards") {
    return (
      <span aria-hidden className="flex w-full flex-col gap-1">
        {rows.map((i) => (
          <span key={i} className="block rounded bg-muted p-1.5">
            {line}
          </span>
        ))}
      </span>
    );
  }

  return (
    <span
      aria-hidden
      className={cn(
        "flex w-full flex-col",
        style === "condensed" ? "gap-[3px]" : "gap-2",
      )}
    >
      {rows.map((i) => (
        <span key={i} className="block">
          {line}
        </span>
      ))}
    </span>
  );
}

/** 62% of something, drawn four ways. */
function ChartSpecimen({ style }: { style: ChartStyle }) {
  if (style === "numeric") {
    return <span className="text-lg tabular-nums">62%</span>;
  }
  if (style === "ring") {
    return (
      <span
        aria-hidden
        className="meter-ring relative inline-flex h-9 w-9 items-center justify-center"
        style={{ ["--meter-turn" as string]: "0.62turn" }}
      >
        <span className="relative text-[10px] tabular-nums">62</span>
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "block w-full overflow-hidden rounded-full bg-muted",
        style === "line" ? "h-[2px]" : "h-1.5",
      )}
    >
      <span className="block h-full w-[62%] rounded-full bg-foreground" />
    </span>
  );
}

/** The same teammate, marked four ways. */
function GlyphSpecimen({ style }: { style: AgentIconStyle }) {
  const fill = identityFill("Ada");
  if (style === "dot") {
    return <span aria-hidden style={fill} className="h-3 w-3 rounded-full" />;
  }
  if (style === "glyph") {
    return (
      <span
        aria-hidden
        style={fill}
        className="flex h-8 w-8 items-center justify-center rounded-full text-white"
      >
        <Bot className="h-4 w-4" />
      </span>
    );
  }
  if (style === "monogram") {
    return (
      <span
        aria-hidden
        style={fill}
        className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium text-white"
      >
        A
      </span>
    );
  }
  return <Orb seed="Ada" size="sm" label="Ada" />;
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
