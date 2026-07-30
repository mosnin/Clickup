"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  STUDIO_SECTIONS,
  StudioChrome,
} from "@/components/appearance/studio-chrome";
import { PanelPreview, PresetTile } from "@/components/appearance/style-gallery";
import { useComponentStyle } from "@/components/appearance/use-component-style";
import { useAppearance } from "@/components/appearance/appearance-provider";
import { ActorGlyph } from "@/components/appearance/actor-glyph";
import { AnimatedBar } from "@/components/motion";
import {
  DEFAULT_STYLE,
  STYLE_PRESETS,
  matchingStylePresetId,
  normalizeStylePatch,
} from "@/lib/component-style";
import {
  APPEARANCE_PRESETS,
  matchingPresetId,
} from "@/lib/appearance";
import { morphLayout, SHELL_PARTS } from "@/lib/anime";
import { cn } from "@/lib/utils";

// The studio's front door.
//
// Its job is to answer "what does my app look like right now" in one screen,
// and to be the fastest route to a different answer. Everything finer-grained
// lives in a chapter, because a single page holding thirty-odd controls is a
// page people scroll past rather than use.
//
// The preview is the real app: real panels, the real chart component, the real
// list and teammate primitives. A framed mock-up would be a second thing to
// keep in agreement with the first, and it would lie the moment they diverged.

export function AppearanceOverview() {
  const { appearance, commit: commitAppearance, reset: resetAppearance } =
    useAppearance();
  const {
    style,
    commit: commitStyle,
    reset: resetStyle,
    dirty,
    revert,
  } = useComponentStyle();

  const activeLook = matchingPresetId(appearance);
  const activePanel = matchingStylePresetId(style);

  return (
    <StudioChrome
      base="/dashboard/appearance"
      title="Appearance"
      context="How the app looks to you, everywhere. Changes save as you make them and follow you to every device — there is no apply step."
      actions={
        <div className="flex items-center gap-2">
          {dirty && (
            <Button variant="outline" size="sm" onClick={revert}>
              Undo
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              resetAppearance("personal");
              resetStyle("personal");
            }}
          >
            Reset everything
          </Button>
        </div>
      }
    >
      <div className="space-y-10">
        {/* The app, as it is. Real components — if this looks wrong, the app
            looks wrong, because it is the same code. */}
        <section>
          <h2 className="text-sm font-medium">Right now</h2>
          <div className="mt-3 grid gap-4 lg:grid-cols-3">
            <PanelPreview style={style} title="Throughput" kind="column" />
            <PanelPreview style={style} title="By status" kind="donut" />
            <div className="panel rounded-2xl p-5">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                A list
              </p>
              <div className="ui-list mt-3">
                {["Ship the migration", "Review the audit"].map((t) => (
                  <div key={t} className="min-w-0">
                    <span className="block truncate text-sm">{t}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      due tomorrow
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-4">
                <AnimatedBar
                  pct={62}
                  className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                  barClassName="h-full rounded-full bg-foreground"
                />
              </div>
              <div className="ui-list mt-4">
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

        <section>
          <h2 className="text-sm font-medium">The room</h2>
          <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">
            Type, colour, spacing and motion, in one move. Adjust any of it in
            the chapters.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {APPEARANCE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                aria-pressed={activeLook === preset.id}
                onClick={() =>
                  morphLayout(
                    "body",
                    () => commitAppearance(preset.settings, "personal"),
                    { children: SHELL_PARTS },
                  )
                }
                className={cn(
                  "rounded-xl bg-card p-3 text-left transition-all duration-150",
                  activeLook === preset.id
                    ? "ring-2 ring-foreground"
                    : "ring-1 ring-border hover:ring-muted-foreground/40",
                )}
              >
                <span aria-hidden className="flex items-center gap-0.5">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="h-5 w-2.5"
                      style={{
                        borderRadius: `${(0.35 * preset.settings.radiusScale).toFixed(2)}rem`,
                        background:
                          preset.settings.accentMode === "hue"
                            ? `hsl(${preset.settings.accentHue} ${preset.settings.accentSaturation}% ${46 + i * 16}%)`
                            : ["#131316", "#3f3f46", "#d9d9de"][i],
                      }}
                    />
                  ))}
                </span>
                <span className="mt-2 block truncate text-xs font-medium">
                  {preset.name}
                </span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-sm font-medium">The panels</h2>
          <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">
            Frames, fills and how charts are drawn. Any panel can still
            override this for itself.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {STYLE_PRESETS.map((preset) => (
              <PresetTile
                key={preset.id}
                name={preset.name}
                description={preset.description}
                style={{ ...DEFAULT_STYLE, ...normalizeStylePatch(preset.patch) }}
                selected={activePanel === preset.id}
                onPick={() => {
                  resetStyle("personal");
                  commitStyle(preset.patch, "personal");
                }}
              />
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-sm font-medium">Go deeper</h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {STUDIO_SECTIONS.filter((s) => s.slug).map((section) => (
              <li key={section.slug}>
                <Link
                  href={`/dashboard/appearance/${section.slug}`}
                  className="block rounded-xl bg-card p-4 ring-1 ring-border transition-colors hover:bg-muted"
                >
                  <span className="block text-sm font-medium">{section.label}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {section.blurb}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </StudioChrome>
  );
}
