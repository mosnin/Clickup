import { describe, expect, it } from "vitest";
import {
  CHART_KEYS,
  DEFAULT_STYLE,
  FRAME_KEYS,
  STYLE_ENUMS,
  STYLE_KEYS,
  STYLE_PRESETS,
  barPadding,
  barRadius,
  clearStyleKeys,
  cornerRadius,
  describeStyle,
  matchingStylePresetId,
  normalizeStyle,
  normalizeStylePatch,
  paletteColors,
  pruneStylePatch,
  resolveStyle,
  seriesColor,
  type Palette,
  type StyleKey,
} from "../src/lib/component-style";

// How a panel looks, as data.
//
// The properties that matter are the same three the appearance model rests on,
// because the failure modes are the same: a default that quietly changes the
// product, a patch that is not sparse and therefore blocks every layer beneath
// it, and a vocabulary that is not closed while agents are writing into it.

describe("the defaults are the shipped design", () => {
  it("resolves to the shipped look when nothing is set anywhere", () => {
    // Personalisation that changes the app for someone who never opened the
    // settings is a regression wearing a feature's clothes.
    expect(resolveStyle({}).style).toEqual(DEFAULT_STYLE);
    expect(normalizeStyle(undefined)).toEqual(DEFAULT_STYLE);
    expect(normalizeStyle({})).toEqual(DEFAULT_STYLE);
  });

  it("reports every value as coming from the defaults", () => {
    const { sources } = resolveStyle({});
    for (const key of STYLE_KEYS) expect(sources[key], key).toBe("default");
  });

  it("ships monochrome — the brand rule survives the feature", () => {
    expect(DEFAULT_STYLE.palette).toBe("mono");
  });
});

describe("the vocabulary is closed", () => {
  it("drops values it does not enumerate rather than defaulting them", () => {
    // Coercing to the default silently promotes garbage into an explicit
    // override that then shadows the layer beneath it.
    expect(normalizeStylePatch({ palette: "chartreuse" })).toEqual({});
    expect(normalizeStylePatch({ frame: 7 })).toEqual({});
    expect(normalizeStylePatch({ curve: null })).toEqual({});
    expect(normalizeStylePatch({ notAKey: "bento" })).toEqual({});
  });

  it("refuses anything that is not a named option", () => {
    // A style is a choice among options — never a colour string, a CSS
    // fragment, or a number the renderer will paste into a stylesheet.
    for (const hostile of [
      { palette: "#ff0000" },
      { fill: "url(javascript:alert(1))" },
      { frame: "</style><script>" },
      { corner: "1px solid red" },
    ]) {
      expect(normalizeStylePatch(hostile)).toEqual({});
    }
  });

  it("accepts every value it advertises", () => {
    for (const [key, values] of Object.entries(STYLE_ENUMS)) {
      for (const value of values) {
        expect(normalizeStylePatch({ [key]: value }), `${key}=${value}`).toEqual({
          [key]: value,
        });
      }
    }
  });

  it("survives anything at all", () => {
    for (const junk of [null, undefined, 0, "", [], { frame: {} }]) {
      expect(() => normalizeStyle(junk)).not.toThrow();
      expect(normalizeStyle(junk)).toEqual(DEFAULT_STYLE);
    }
  });

  it("clamps numbers rather than dropping them", () => {
    // "As large as possible" is a real intention badly expressed.
    expect(normalizeStylePatch({ donutHole: 99 }).donutHole).toBe(0.85);
    expect(normalizeStylePatch({ donutHole: -5 }).donutHole).toBe(0);
    expect(normalizeStylePatch({ donutHole: NaN })).toEqual({});
  });
});

describe("patches are sparse", () => {
  it("keeps only what was explicitly set", () => {
    expect(normalizeStylePatch({ palette: "vivid" })).toEqual({ palette: "vivid" });
    expect(Object.keys(normalizeStylePatch({ palette: "vivid" }))).toHaveLength(1);
  });

  it("honours an allow-list", () => {
    const patch = { palette: "vivid", frame: "glass" };
    expect(normalizeStylePatch(patch, CHART_KEYS)).toEqual({ palette: "vivid" });
    expect(normalizeStylePatch(patch, FRAME_KEYS)).toEqual({ frame: "glass" });
  });

  it("prunes keys equal to the default, recovering sparse intent", () => {
    // A row holding all nineteen keys is indistinguishable from someone having
    // pinned all nineteen, and a space theme could then never reach them.
    const full = { ...DEFAULT_STYLE, palette: "ocean" as const };
    expect(pruneStylePatch(full)).toEqual({ palette: "ocean" });
  });

  it("clears by deleting, not by copying the parent's value down", () => {
    // Copying looks identical today and stops tracking tomorrow.
    const patch = { palette: "vivid" as const, frame: "glass" as const };
    const cleared = clearStyleKeys(patch, ["palette"]);
    expect("palette" in cleared).toBe(false);
    expect(cleared.frame).toBe("glass");
    // And it does not mutate its input.
    expect(patch.palette).toBe("vivid");
  });
});

describe("layering runs general to specific", () => {
  it("lets each layer beat the one before it", () => {
    const { style, sources } = resolveStyle({
      personal: { palette: "vivid", frame: "flat" },
      space: { palette: "ocean" },
      personalSpace: { frame: "glass" },
    });
    expect(style.palette).toBe("ocean");
    expect(sources.palette).toBe("space");
    expect(style.frame).toBe("glass");
    expect(sources.frame).toBe("personalSpace");
  });

  it("gives the component the last word", () => {
    // It is the most specific statement anyone made: "this panel, in
    // particular, is a dial."
    const { style, sources } = resolveStyle({
      personal: { palette: "vivid" },
      space: { palette: "ocean" },
      personalSpace: { palette: "ember" },
      component: { palette: "neon" },
    });
    expect(style.palette).toBe("neon");
    expect(sources.palette).toBe("component");
  });

  it("draws an authored panel the way its author meant", () => {
    // The look a definition carries is a layer rather than decoration. Before
    // it was one, `PanelDef.style` was stored, described in the tray, and
    // never applied to anything — an agent writing "spend, as a donut, in
    // red" produced a grey donut.
    const { style, sources } = resolveStyle({
      personal: { palette: "vivid" },
      definition: { palette: "neon" },
    });
    expect(style.palette).toBe("neon");
    expect(sources.palette).toBe("definition");
  });

  it("still lets the reader overrule the panel's author", () => {
    // Otherwise every shared or agent-authored panel is a change to somebody
    // else's dashboard that they cannot take back.
    const { style, sources } = resolveStyle({
      definition: { palette: "neon" },
      component: { palette: "ocean" },
    });
    expect(style.palette).toBe("ocean");
    expect(sources.palette).toBe("component");
  });

  it("puts the author above the room they are standing in", () => {
    // A space theme says how charts in this room are drawn; a definition says
    // what this panel *is*. The more specific statement wins.
    const { style } = resolveStyle({
      space: { palette: "ocean" },
      personalSpace: { palette: "ember" },
      definition: { palette: "neon" },
    });
    expect(style.palette).toBe("neon");
  });

  it("lets absence fall through every layer", () => {
    const { style, sources } = resolveStyle({
      personal: { frame: "flat" },
      component: { palette: "neon" },
    });
    expect(style.frame).toBe("flat");
    expect(style.curve).toBe(DEFAULT_STYLE.curve);
    expect(sources.curve).toBe("default");
  });

  it("ignores a hostile layer entirely rather than half-applying it", () => {
    const { style } = resolveStyle({
      space: { palette: "not-a-palette", frame: "outlined" },
    });
    expect(style.palette).toBe(DEFAULT_STYLE.palette);
    expect(style.frame).toBe("outlined");
  });
});

describe("the key partition", () => {
  it("covers every axis exactly once", () => {
    const classified = [...FRAME_KEYS, ...CHART_KEYS];
    expect([...classified].sort()).toEqual([...STYLE_KEYS].sort());
    expect(new Set(classified).size).toBe(classified.length);
  });
});

describe("palettes", () => {
  const ALL = STYLE_ENUMS.palette as readonly Palette[];

  it("gives every palette six distinct stops", () => {
    // Past six, a chart needs a different shape rather than more colours, and
    // cycling would put two identical series in one legend.
    for (const p of ALL) {
      const colors = paletteColors(p);
      expect(colors.length, p).toBe(6);
      expect(new Set(colors).size, p).toBe(6);
    }
  });

  it("derives the default palette from the theme's own tokens", () => {
    // A hard-coded grey ramp would be invisible in one of the two themes.
    for (const color of paletteColors("mono")) {
      expect(color).toContain("var(--color-foreground)");
      expect(color).toContain("var(--color-background)");
    }
  });

  it("pins the opt-in palettes to fixed hues", () => {
    // A palette called "vivid" that adapted to the theme would not be vivid.
    for (const p of ALL) {
      if (p === "mono") continue;
      for (const color of paletteColors(p)) {
        expect(color, `${p} ${color}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it("wraps rather than running out", () => {
    expect(seriesColor("vivid", 0)).toBe(seriesColor("vivid", 6));
    expect(seriesColor("vivid", -1)).toBe(seriesColor("vivid", 5));
    expect(typeof seriesColor("vivid", 999)).toBe("string");
  });

  it("never returns undefined for an unknown palette", () => {
    expect(paletteColors("nope" as Palette)).toEqual(paletteColors("mono"));
  });
});

describe("style to concrete values", () => {
  it("returns null for an inherited corner, so the app's radius wins", () => {
    expect(cornerRadius("inherit")).toBeNull();
    expect(cornerRadius("square")).toBe("0rem");
    expect(cornerRadius("round")).toBe("1.5rem");
  });

  it("makes a thicker bar leave a smaller gap", () => {
    expect(barPadding("thick")).toBeLessThan(barPadding("normal"));
    expect(barPadding("normal")).toBeLessThan(barPadding("thin"));
    for (const w of ["thin", "normal", "thick"] as const) {
      expect(barPadding(w)).toBeGreaterThanOrEqual(0);
      expect(barPadding(w)).toBeLessThan(1);
    }
  });

  it("keeps a pill a pill and a square square at any width", () => {
    expect(barRadius("square", 40)).toBe(0);
    expect(barRadius("pill", 40)).toBe(20);
    // Rounded stays modest even on a very wide bar, or it becomes a pill.
    expect(barRadius("rounded", 400)).toBe(4);
    // And never exceeds what the bar can carry.
    expect(barRadius("rounded", 4)).toBeLessThanOrEqual(2);
  });
});

describe("presets", () => {
  it("are all reachable and all normalize cleanly", () => {
    for (const preset of STYLE_PRESETS) {
      const patch = normalizeStylePatch(preset.patch);
      expect(patch, preset.id).toEqual(preset.patch);
      expect(preset.name.length, preset.id).toBeGreaterThan(0);
      expect(preset.description.length, preset.id).toBeGreaterThan(0);
    }
  });

  it("identify themselves after being applied", () => {
    // Valid because the presets are distinct — see the test below. Without
    // that, "matches some preset" would be a much weaker claim than it looks.
    for (const preset of STYLE_PRESETS) {
      const style = { ...DEFAULT_STYLE, ...normalizeStylePatch(preset.patch) };
      expect(matchingStylePresetId(style), preset.id).toBe(preset.id);
    }
  });

  it("say nothing when a style matches no preset", () => {
    expect(
      matchingStylePresetId({ ...DEFAULT_STYLE, donutHole: 0.13 }),
    ).toBeNull();
  });

  it("reach genuinely different looks, not eight names for one", () => {
    // The point of presets is range. Two that resolve identically are one
    // preset with two names.
    const seen = new Set<string>();
    for (const preset of STYLE_PRESETS) {
      const style = { ...DEFAULT_STYLE, ...normalizeStylePatch(preset.patch) };
      seen.add(JSON.stringify(style));
    }
    expect(seen.size).toBe(STYLE_PRESETS.length);
  });

  it("between them exercise most of the vocabulary", () => {
    const touched = new Set<StyleKey>();
    for (const preset of STYLE_PRESETS) {
      for (const key of Object.keys(normalizeStylePatch(preset.patch))) {
        touched.add(key as StyleKey);
      }
    }
    // Not every axis needs a preset behind it, but a starting set that only
    // moved three of nineteen would not be a starting set.
    expect(touched.size).toBeGreaterThanOrEqual(12);
  });
});

describe("a style reads back in words", () => {
  it("names what is unusual about it and stays quiet otherwise", () => {
    expect(describeStyle(DEFAULT_STYLE)).toBe("ink");
    const loud = normalizeStyle({
      palette: "neon",
      frame: "glass",
      axes: "none",
      grid: "none",
      dataLabels: "percent",
      legend: "right",
    });
    const text = describeStyle(loud);
    expect(text).toContain("neon");
    expect(text).toContain("glass frame");
    expect(text).toContain("no chrome");
    expect(text).toContain("percent labels");
  });
});
