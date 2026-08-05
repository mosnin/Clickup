import { describe, expect, it } from "vitest";
import {
  APPEARANCE_PRESETS,
  APPEARANCE_RANGES,
  DEFAULT_APPEARANCE,
  hslToHex,
  matchingPresetId,
  normalizeAppearance,
  resolveTokens,
  APPEARANCE_KEYS,
  PERSONAL_KEYS,
  PLACE_KEYS,
  clearKeys,
  normalizePatch,
  prunePatch,
  resolveLayered,
} from "../src/lib/appearance";
import { spaceTargetForPath } from "../src/lib/space-route";

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
    // Shadows are written against tokens the stylesheet owns per theme, not
    // against literal rgb: a near-black shadow on a near-black surface is
    // invisible, and this function cannot know which theme is on.
    expect(tokens["--ui-surface-shadow"]).toContain("var(--ui-shade)");
    expect(tokens["--ui-surface-shadow"]).not.toMatch(/rgb\(/);
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
    // 0.75 of the card, not 0.5: controls got a softer corner when buttons
    // became pills, so a field beside a pill reads as the same family.
    expect(half["--ui-radius-control"]).toBe("0.375rem");
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

// ── Layers ──────────────────────────────────────────────────────────────
//
// Three writers, one set of tokens. The properties that keep that honest:
//
//  1. The place/person partition is TOTAL and DISJOINT. If someone adds a
//     setting and forgets to classify it, that is a setting no layer can set,
//     or one a space can set when it shouldn't. The first test below is the
//     one that catches it.
//  2. Patches are sparse, and absence means "ask the layer below me".
//  3. A space theme physically cannot carry a personal key.

describe("the place / person partition", () => {
  it("covers every setting exactly once", () => {
    const classified = [...PLACE_KEYS, ...PERSONAL_KEYS];
    expect([...classified].sort()).toEqual([...APPEARANCE_KEYS].sort());
    expect(new Set(classified).size).toBe(classified.length);
  });

  it("keeps how someone reads out of a space's hands", () => {
    // The specific hostile cases: a space must not be able to shrink your
    // type, re-enable motion you turned off, or move your navigation.
    for (const key of ["fontScale", "motionScale", "sidebarPosition", "density"] as const) {
      expect(PERSONAL_KEYS).toContain(key);
      expect(PLACE_KEYS).not.toContain(key);
    }
  });
});

describe("patches", () => {
  it("keeps only what was explicitly set", () => {
    expect(normalizePatch({ radiusScale: 1.5 })).toEqual({ radiusScale: 1.5 });
    expect(normalizePatch({})).toEqual({});
    expect(normalizePatch(null)).toEqual({});
    expect(normalizePatch(undefined)).toEqual({});
  });

  it("clamps an out-of-range number rather than dropping it", () => {
    // "As big as possible" is a real intention, badly expressed.
    expect(normalizePatch({ fontScale: 40 })).toEqual({
      fontScale: APPEARANCE_RANGES.fontScale[1],
    });
  });

  it("drops a value of the wrong kind instead of coercing it", () => {
    // Coercing would promote garbage into an explicit override that shadows
    // whatever the layer beneath it says.
    expect(normalizePatch({ surface: "banana" })).toEqual({});
    expect(normalizePatch({ fontScale: "big" })).toEqual({});
    expect(normalizePatch({ fontScale: Number.NaN })).toEqual({});
    expect(normalizePatch({ nonsense: 3 })).toEqual({});
  });

  it("agrees with the whole-object normalizer", () => {
    // Whatever route a value takes, it lands on the same setting.
    for (const input of [
      { fontScale: 40 },
      { surface: "banana" },
      { radiusScale: 1.5, accentMode: "hue", accentHue: 12 },
      { sidebarWidth: -3 },
      {},
    ]) {
      expect(normalizeAppearance(normalizePatch(input))).toEqual(
        normalizeAppearance(input),
      );
    }
  });

  it("reads a legacy full snapshot as only what differs from the shipped look", () => {
    // Every row written before layering existed holds all eleven keys. Read
    // literally, those users would be immune to space themes forever.
    const legacy = { ...DEFAULT_APPEARANCE, radiusScale: 1.6, fontScale: 1.1 };
    expect(prunePatch(legacy)).toEqual({ radiusScale: 1.6, fontScale: 1.1 });
    expect(prunePatch(DEFAULT_APPEARANCE)).toEqual({});
  });
});

describe("resolution", () => {
  it("is the shipped design when nobody has chosen anything", () => {
    const { appearance, sources } = resolveLayered({});
    expect(appearance).toEqual(DEFAULT_APPEARANCE);
    expect(new Set(Object.values(sources))).toEqual(new Set(["default"]));
  });

  it("lets a space's look beat your global one, and your override beat the space", () => {
    const { appearance, sources } = resolveLayered({
      personal: { radiusScale: 0.5, fontScale: 1.1 },
      space: { radiusScale: 1.6, surface: "raised" },
      personalSpace: { surface: "flat" },
    });
    // The space wins over the person's global preference for a place key…
    expect(appearance.radiusScale).toBe(1.6);
    expect(sources.radiusScale).toBe("space");
    // …and the person's override of *this* space wins over the space.
    expect(appearance.surface).toBe("flat");
    expect(sources.surface).toBe("personalSpace");
    // A personal key is untouched by any of it.
    expect(appearance.fontScale).toBe(1.1);
    expect(sources.fontScale).toBe("personal");
  });

  it("ignores a personal key smuggled into a space's theme", () => {
    const { appearance, sources } = resolveLayered({
      personal: { fontScale: 1.2 },
      // A space admin — or an agent with the space's key — writing this must
      // not be able to change how anyone reads.
      space: {
        fontScale: 0.85,
        motionScale: 1.5,
        sidebarPosition: "right",
        density: "compact",
        accentMode: "hue",
      },
    });
    expect(appearance.fontScale).toBe(1.2);
    expect(appearance.motionScale).toBe(DEFAULT_APPEARANCE.motionScale);
    expect(appearance.sidebarPosition).toBe(DEFAULT_APPEARANCE.sidebarPosition);
    expect(appearance.density).toBe(DEFAULT_APPEARANCE.density);
    // The place key it was entitled to set still lands.
    expect(appearance.accentMode).toBe("hue");
    expect(sources.accentMode).toBe("space");
  });

  it("ignores a personal key in a per-space override too", () => {
    // The narrower layer is per-space, and "my font size, but only in this
    // space" is a setting that would follow you around by surprise.
    const { appearance } = resolveLayered({
      personalSpace: { fontScale: 0.85, radiusScale: 0.25 },
    });
    expect(appearance.fontScale).toBe(DEFAULT_APPEARANCE.fontScale);
    expect(appearance.radiusScale).toBe(0.25);
  });

  it("falls back to the layer beneath when an override is cleared", () => {
    const mine = { surface: "flat" as const, radiusScale: 0.5 };
    const cleared = clearKeys(mine, ["surface"]);
    expect(cleared).toEqual({ radiusScale: 0.5 });

    const { appearance, sources } = resolveLayered({
      space: { surface: "raised" },
      personalSpace: cleared,
    });
    // Falling back means tracking the space again, not freezing on the value
    // the space happened to have when you stopped overriding it.
    expect(appearance.surface).toBe("raised");
    expect(sources.surface).toBe("space");
  });

  it("still resolves when a stored layer is garbage", () => {
    // A row written by a newer build, or by hand, must not be able to lock
    // anyone out of their own app.
    const { appearance } = resolveLayered({
      personal: "not an object",
      space: 42,
      personalSpace: [{ surface: "flat" }],
    });
    expect(appearance).toEqual(DEFAULT_APPEARANCE);
  });

  it("resolves to tokens that globals.css can render", () => {
    const { appearance } = resolveLayered({
      personal: { fontScale: 1.1 },
      space: { accentMode: "hue", accentHue: 200, accentSaturation: 60 },
    });
    const tokens = resolveTokens(appearance);
    expect(tokens["--ui-font-scale"]).toBe("1.100");
    expect(tokens["--color-brand-600"]).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("which space a path is in", () => {
  it("recognises the space-shaped routes", () => {
    expect(spaceTargetForPath("/dashboard/s/abc123")).toEqual({
      kind: "space",
      id: "abc123",
    });
    expect(spaceTargetForPath("/dashboard/p/proj1")).toEqual({
      kind: "project",
      id: "proj1",
    });
    // A task page carries its list, and a list is one hop from the space.
    expect(spaceTargetForPath("/dashboard/l/list1/t/task1")).toEqual({
      kind: "list",
      id: "list1",
    });
    // Nested routes inside a space still resolve to that space, which is what
    // lets the customiser live at a space path.
    expect(spaceTargetForPath("/dashboard/s/abc123/appearance")).toEqual({
      kind: "space",
      id: "abc123",
    });
  });

  it("says nothing for surfaces that belong to no space", () => {
    // A page, a doc and a whiteboard hang off a user or a workspace, and Home
    // hangs off nothing. Those render the person's own look.
    for (const path of [
      "/dashboard",
      "/dashboard/pages/xyz",
      "/dashboard/d/doc1",
      "/dashboard/wb/board1",
      "/dashboard/w/ws1",
      "/dashboard/settings/appearance",
      "/dashboard/spaces",
      "/dashboard/agents/a1",
      null,
    ]) {
      expect(spaceTargetForPath(path)).toBeNull();
    }
  });
});
