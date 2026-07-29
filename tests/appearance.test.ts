import { describe, expect, it } from "vitest";
import {
  APPEARANCE_PRESETS,
  APPEARANCE_RANGES,
  DEFAULT_APPEARANCE,
  hslToHex,
  matchingPresetId,
  normalizeAppearance,
  resolveTokens,
} from "../src/lib/appearance";

// The appearance model. Two properties matter more than anything else here:
//
//  1. **The defaults reproduce the shipped design.** Personalisation that
//     changes the look of the app for someone who never opened the settings is
//     a bug. This is the test that catches it.
//  2. **Nothing that arrives can produce an unusable UI.** These values come
//     from a slider, from a row written by an older build, and eventually from
//     an agent. A font scale of 40 is not a preference.

describe("defaults", () => {
  it("resolves to the shipped token values", () => {
    const tokens = resolveTokens(DEFAULT_APPEARANCE);
    // The monochrome ink ramp, unchanged.
    expect(tokens["--color-brand-600"]).toBe("#131316");
    expect(tokens["--color-brand-700"]).toBe("#000000");
    // The shipped radii, density and type scale.
    expect(tokens["--ui-radius-card"]).toBe("1.000rem");
    expect(tokens["--ui-font-scale"]).toBe("1.000");
    expect(tokens["--ui-motion-scale"]).toBe("1.000");
    expect(tokens["--ui-pad"]).toBe("1.25rem");
    expect(tokens["--ui-sidebar-width"]).toBe("16.00rem");
    expect(tokens["--ui-surface-shadow"]).toContain("rgb(16 16 16 / 0.04)");
  });

  it("is the Editorial preset", () => {
    expect(matchingPresetId(DEFAULT_APPEARANCE)).toBe("editorial");
  });
});

describe("normalization", () => {
  it("fills in everything from nothing", () => {
    expect(normalizeAppearance(undefined)).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance({})).toEqual(DEFAULT_APPEARANCE);
  });

  it("clamps a value that would make the app unusable", () => {
    const wild = normalizeAppearance({
      fontScale: 40,
      radiusScale: -12,
      motionScale: 1e9,
      sidebarWidth: 0,
      headingWeight: 12,
    });
    expect(wild.fontScale).toBe(APPEARANCE_RANGES.fontScale[1]);
    expect(wild.radiusScale).toBe(APPEARANCE_RANGES.radiusScale[0]);
    expect(wild.motionScale).toBe(APPEARANCE_RANGES.motionScale[1]);
    expect(wild.sidebarWidth).toBe(APPEARANCE_RANGES.sidebarWidth[0]);
    expect(wild.headingWeight).toBe(APPEARANCE_RANGES.headingWeight[0]);
  });

  it("ignores a value it has never heard of", () => {
    // A row written by a newer build must not break an older client.
    const next = normalizeAppearance({
      density: "hyperdense",
      surface: "glass",
      sidebarPosition: "underneath",
      somethingElse: true,
    });
    expect(next.density).toBe(DEFAULT_APPEARANCE.density);
    expect(next.surface).toBe(DEFAULT_APPEARANCE.surface);
    expect(next.sidebarPosition).toBe(DEFAULT_APPEARANCE.sidebarPosition);
    expect(next).toEqual(DEFAULT_APPEARANCE);
  });

  it("survives NaN and non-numbers where a number belongs", () => {
    const next = normalizeAppearance({
      fontScale: Number.NaN,
      radiusScale: "1.5" as never,
      motionScale: Number.POSITIVE_INFINITY,
    });
    expect(next.fontScale).toBe(DEFAULT_APPEARANCE.fontScale);
    expect(next.radiusScale).toBe(DEFAULT_APPEARANCE.radiusScale);
    expect(next.motionScale).toBe(DEFAULT_APPEARANCE.motionScale);
  });
});

describe("tokens", () => {
  it("scales the radii together so a card and its well stay in proportion", () => {
    const half = resolveTokens({ ...DEFAULT_APPEARANCE, radiusScale: 0.5 });
    expect(half["--ui-radius-card"]).toBe("0.500rem");
    expect(half["--ui-radius-tile"]).toBe("0.375rem");
    expect(half["--ui-radius-control"]).toBe("0.250rem");
  });

  it("squares the pills only when everything else is square", () => {
    // A pill still round beside square cards reads as a mistake.
    expect(resolveTokens({ ...DEFAULT_APPEARANCE, radiusScale: 0 })[
      "--ui-radius-pill"
    ]).toBe("0.000rem");
    expect(resolveTokens({ ...DEFAULT_APPEARANCE, radiusScale: 0.5 })[
      "--ui-radius-pill"
    ]).toBe("9999px");
  });

  it("generates a coloured ramp that stays ordered light to dark", () => {
    const tokens = resolveTokens({
      ...DEFAULT_APPEARANCE,
      accentMode: "hue",
      accentHue: 258,
      accentSaturation: 70,
    });
    const brightness = (hex: string) => {
      const v = hex.slice(1);
      return (
        Number.parseInt(v.slice(0, 2), 16) +
        Number.parseInt(v.slice(2, 4), 16) +
        Number.parseInt(v.slice(4, 6), 16)
      );
    };
    const ramp = ["50", "100", "200", "500", "600", "700"].map(
      (k) => tokens[`--color-brand-${k}`],
    );
    for (const hex of ramp) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    // Monotonically darker — a ramp that isn't ordered can't be used for
    // hover states or text-on-fill.
    for (let i = 1; i < ramp.length; i += 1) {
      expect(brightness(ramp[i])).toBeLessThan(brightness(ramp[i - 1]));
    }
  });

  it("only emits hex colours, so they can be interpolated", () => {
    // The token morph interpolates hex and swaps everything else; a colour
    // that arrived as hsl() would jump instead of animating.
    for (const mode of ["ink", "hue"] as const) {
      const tokens = resolveTokens({ ...DEFAULT_APPEARANCE, accentMode: mode });
      for (const [name, value] of Object.entries(tokens)) {
        if (!name.startsWith("--color-")) continue;
        expect(value).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("never emits an empty or undefined token", () => {
    for (const p of APPEARANCE_PRESETS) {
      for (const [name, value] of Object.entries(resolveTokens(p.settings))) {
        expect(value, `${p.id} → ${name}`).toBeTruthy();
        expect(value).not.toContain("undefined");
        expect(value).not.toContain("NaN");
      }
    }
  });
});

describe("presets", () => {
  it("are each identifiable from their own settings", () => {
    for (const p of APPEARANCE_PRESETS) {
      expect(matchingPresetId(p.settings)).toBe(p.id);
    }
  });

  it("report no match once a setting has been tweaked", () => {
    const tweaked = { ...APPEARANCE_PRESETS[1].settings, fontScale: 1.11 };
    expect(matchingPresetId(tweaked)).toBeNull();
  });

  it("all survive normalization unchanged", () => {
    // A preset that gets clamped is a preset outside its own ranges.
    for (const p of APPEARANCE_PRESETS) {
      expect(normalizeAppearance(p.settings)).toEqual(p.settings);
    }
  });

  it("include one with motion off and one with the sidebar floating", () => {
    expect(APPEARANCE_PRESETS.some((p) => p.settings.motionScale === 0)).toBe(true);
    expect(
      APPEARANCE_PRESETS.some((p) => p.settings.sidebarPosition === "floating"),
    ).toBe(true);
  });
});

describe("hslToHex", () => {
  it("matches known values", () => {
    expect(hslToHex(0, 0, 0)).toBe("#000000");
    expect(hslToHex(0, 0, 100)).toBe("#ffffff");
    expect(hslToHex(0, 100, 50)).toBe("#ff0000");
    expect(hslToHex(120, 100, 50)).toBe("#00ff00");
    expect(hslToHex(240, 100, 50)).toBe("#0000ff");
  });

  it("always produces a six-digit hex, including at the extremes", () => {
    for (const h of [0, 45, 90, 180, 270, 360]) {
      for (const s of [0, 50, 100]) {
        for (const l of [0, 1, 50, 99, 100]) {
          expect(hslToHex(h, s, l)).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
    }
  });
});
