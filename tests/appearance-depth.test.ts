import { describe, expect, it } from "vitest";
import {
  APPEARANCE_ENUMS,
  APPEARANCE_PRESETS,
  DEFAULT_APPEARANCE,
  PERSONAL_KEYS,
  PLACE_KEYS,
  appearanceLayers,
  displayStackFor,
  fontStackFor,
  normalizeAppearance,
  normalizePatch,
  resolveAppearance,
  resolveLayered,
  resolveTokens,
  type Appearance,
  type FontFamily,
} from "../src/lib/appearance";

// The settings added in the depth pass: typeface, secondary-text contrast,
// list/chart/teammate drawing, icon weight. Two properties matter more than
// the individual values:
//
//   1. **Nothing moves for someone who never opened the settings.** Every new
//      token has to be identity at its default, and every CSS fallback has to
//      match. A "personalisation" feature that changes the shipped design for
//      everyone is a regression wearing a feature's clothes.
//   2. **The face you read in belongs to you, not to the room.** A workspace
//      that can swap your body font or wash out your secondary text is the
//      same class of harm as one that can shrink your type.

const ALL_FAMILIES = APPEARANCE_ENUMS.fontFamily;
const ALL_DISPLAY = APPEARANCE_ENUMS.displayFont;

describe("typography", () => {
  it("gives every family a real stack ending in a generic family", () => {
    for (const family of ALL_FAMILIES) {
      const stack = fontStackFor(family);
      expect(stack.length, family).toBeGreaterThan(0);
      expect(
        /(?:sans-serif|serif|monospace)\s*$/.test(stack),
        `${family} must end in a generic family: ${stack}`,
      ).toBe(true);
    }
  });

  it("never reaches for a font that would have to be downloaded", () => {
    // Only the two faces bundled with the app may appear as custom properties;
    // everything else has to be a name the reader's machine already has. A
    // stack that referenced some other --font-* would render as a silent
    // fallback in production and look correct in dev.
    for (const family of ALL_FAMILIES) {
      const custom = fontStackFor(family).match(/var\(--font-[a-z-]+\)/g) ?? [];
      for (const ref of custom) {
        expect(["var(--font-instrument)", "var(--font-darker-grotesque)"]).toContain(ref);
      }
      expect(fontStackFor(family)).not.toMatch(/https?:|url\(/);
    }
  });

  it("resolves 'same as body' against whatever the body is", () => {
    for (const family of ALL_FAMILIES) {
      expect(displayStackFor("match", family)).toBe(fontStackFor(family));
    }
    // And the named faces ignore the body entirely.
    for (const family of ALL_FAMILIES) {
      expect(displayStackFor("serif", family)).toBe(displayStackFor("serif", "mono"));
    }
  });

  it("carries the grotesque's optical correction only on the grotesque", () => {
    // Darker Grotesque has a small x-height and needs font-size-adjust to sit
    // at the intended optical size. Every other face has an ordinary x-height
    // and would be rendered a third too large by the same number.
    for (const display of ALL_DISPLAY) {
      const tokens = resolveTokens({ ...DEFAULT_APPEARANCE, displayFont: display });
      expect(tokens["--ui-display-size-adjust"], display).toBe(
        display === "grotesque" ? "0.5" : "none",
      );
    }
  });

  it("emits the shipped pairing by default", () => {
    const tokens = resolveTokens(DEFAULT_APPEARANCE);
    expect(tokens["--ui-font-body"]).toContain("var(--font-instrument)");
    // Space Grotesk, not Darker Grotesque. And `none`, not 0.5: the optical
    // correction belongs to the condensed face that needed it, and a default
    // display face that needs no correction is half the reason it is the
    // default. Darker Grotesque is still offered, and still carries its 0.5 —
    // asserted below.
    expect(tokens["--ui-font-display"]).toContain("var(--font-space-grotesk)");
    expect(tokens["--ui-display-size-adjust"]).toBe("none");
  });

  it("keeps the condensed face's optical correction with the face", () => {
    const tokens = resolveTokens({
      ...DEFAULT_APPEARANCE,
      displayFont: "grotesque",
    });
    expect(tokens["--ui-font-display"]).toContain("var(--font-darker-grotesque)");
    expect(tokens["--ui-display-size-adjust"]).toBe("0.5");
  });
});

describe("secondary-text contrast", () => {
  it("is a no-op at its default, in both directions", () => {
    const tokens = resolveTokens(DEFAULT_APPEARANCE);
    expect(tokens["--ui-muted-toward-fg"]).toBe("0.0%");
    expect(tokens["--ui-muted-toward-bg"]).toBe("0.0%");
  });

  it("pushes exactly one way at a time", () => {
    // Both non-zero would mix toward the foreground and then back toward the
    // background, which lands somewhere neither slider position asked for.
    for (const contrast of [0.7, 0.85, 1, 1.1, 1.25, 1.5]) {
      const t = resolveTokens({ ...DEFAULT_APPEARANCE, contrast });
      const fg = Number.parseFloat(t["--ui-muted-toward-fg"]);
      const bg = Number.parseFloat(t["--ui-muted-toward-bg"]);
      expect(fg, `fg @ ${contrast}`).toBeGreaterThanOrEqual(0);
      expect(bg, `bg @ ${contrast}`).toBeGreaterThanOrEqual(0);
      expect(Math.min(fg, bg), `one of them must be 0 @ ${contrast}`).toBe(0);
      if (contrast > 1) expect(fg).toBeGreaterThan(0);
      if (contrast < 1) expect(bg).toBeGreaterThan(0);
    }
  });

  it("never emits the finished colour, which would outrank the dark theme", () => {
    // The provider writes tokens inline on the root element. An inline
    // --color-muted-foreground beats `:root[data-theme="dark"]`, so the
    // setting would look right in light mode and break dark mode.
    for (const contrast of [0.7, 1, 1.5]) {
      const t = resolveTokens({ ...DEFAULT_APPEARANCE, contrast });
      expect(Object.keys(t)).not.toContain("--color-muted-foreground");
    }
  });
});

describe("icon weight", () => {
  it("is the shipped stroke by default and clamps to something drawable", () => {
    expect(resolveTokens(DEFAULT_APPEARANCE)["--ui-icon-stroke"]).toBe("2.00");
    expect(normalizeAppearance({ iconStroke: 0 }).iconStroke).toBeGreaterThan(0);
    expect(normalizeAppearance({ iconStroke: 40 }).iconStroke).toBeLessThan(4);
  });
});

describe("who owns the new settings", () => {
  it("keeps the reading face and the text contrast personal", () => {
    // These are accessibility settings wearing a style costume: someone who
    // switched to a system font because it renders better for them, or raised
    // the contrast because the grey was too light, must not have a workspace
    // put it back.
    for (const key of ["fontFamily", "contrast"] as const) {
      expect(PERSONAL_KEYS).toContain(key);
      expect(PLACE_KEYS).not.toContain(key);
    }
  });

  it("lets a space own the drawing of lists, progress and teammates", () => {
    for (const key of ["listStyle", "chartStyle", "agentIcon", "iconStroke", "displayFont"] as const) {
      expect(PLACE_KEYS).toContain(key);
      expect(PERSONAL_KEYS).not.toContain(key);
    }
  });

  it("physically drops a personal key from a space theme", () => {
    // Not only in the resolver — in the layer builder, so there is no write
    // path that smuggles one through.
    const hostile = { fontFamily: "mono", contrast: 1.5, listStyle: "cards" };
    const layers = appearanceLayers({ space: hostile, personalSpace: hostile });
    for (const layer of layers) {
      if (layer.id === "personal") continue;
      expect(layer.patch.fontFamily, layer.id).toBeUndefined();
      expect(layer.patch.contrast, layer.id).toBeUndefined();
      expect(layer.patch.listStyle, layer.id).toBe("cards");
    }

    const resolved = resolveLayered({ space: hostile, personalSpace: hostile });
    expect(resolved.appearance.fontFamily).toBe(DEFAULT_APPEARANCE.fontFamily);
    expect(resolved.appearance.contrast).toBe(DEFAULT_APPEARANCE.contrast);
    expect(resolved.appearance.listStyle).toBe("cards");
    expect(resolved.sources.listStyle).toBe("personalSpace");
    expect(resolved.sources.fontFamily).toBe("default");
  });

  it("still lets your own override beat the space's drawing choices", () => {
    const resolved = resolveAppearance([
      { id: "space", patch: { listStyle: "cards" } },
      { id: "personalSpace", patch: { listStyle: "condensed" } },
    ]);
    expect(resolved.appearance.listStyle).toBe("condensed");
    expect(resolved.sources.listStyle).toBe("personalSpace");
  });
});

describe("normalization of the new choices", () => {
  it("drops values this build has never heard of rather than defaulting them", () => {
    // Coercing to the default would promote garbage into an explicit override
    // that shadows the layer beneath it.
    expect(normalizePatch({ listStyle: "spiral" })).toEqual({});
    expect(normalizePatch({ chartStyle: 42 })).toEqual({});
    expect(normalizePatch({ agentIcon: null })).toEqual({});
    expect(normalizePatch({ fontFamily: "Comic Sans" })).toEqual({});
  });

  it("accepts every value the full normalizer accepts", () => {
    // The two normalizers used to keep separate copies of these lists, which
    // is a setting that saves and then silently doesn't.
    for (const [key, values] of Object.entries(APPEARANCE_ENUMS)) {
      for (const value of values) {
        expect(normalizePatch({ [key]: value }), `${key}=${value}`).toEqual({
          [key]: value,
        });
        expect(
          normalizeAppearance({ [key]: value })[key as keyof Appearance],
          `${key}=${value}`,
        ).toBe(value);
      }
    }
  });
});

describe("presets", () => {
  it("reach the new axes, so one click is a real change of look", () => {
    const touched = new Set<string>();
    for (const preset of APPEARANCE_PRESETS) {
      for (const key of ["fontFamily", "displayFont", "listStyle", "chartStyle", "agentIcon"] as const) {
        if (preset.settings[key] !== DEFAULT_APPEARANCE[key]) touched.add(key);
      }
    }
    expect([...touched].sort()).toEqual([
      "agentIcon",
      "chartStyle",
      "displayFont",
      "fontFamily",
      "listStyle",
    ]);
  });

  it("every preset survives normalization unchanged", () => {
    for (const preset of APPEARANCE_PRESETS) {
      expect(normalizeAppearance(preset.settings), preset.id).toEqual(
        preset.settings,
      );
    }
  });

  it("renders a stack for whichever family a preset picked", () => {
    for (const preset of APPEARANCE_PRESETS) {
      const family: FontFamily = preset.settings.fontFamily;
      expect(fontStackFor(family).length, preset.id).toBeGreaterThan(0);
    }
  });
});
