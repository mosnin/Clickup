import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A class that matches nothing looks exactly like a class that works.
//
// This is the cheapest failure mode in the whole styling layer and it has now
// shipped three times. Three of four project status chips were named
// `bg-pastel-amber` / `-rose` / `-slate`; there are no such tokens, so Tailwind
// generated no rule, so they had been colourless pills since the day they
// landed. The studio's trigger carried `[&>div:first-child]:bg-foreground` on a
// layer that was covered by an opaque vendored surface, so the pill was black
// in both themes and its `text-background` label measured 1.09:1 in dark. Both
// are invisible to typecheck, to lint, to every unit test, and to a reviewer —
// the class is spelled plausibly and sits in a list of classes that do work.
//
// Fixing them one at a time buys nothing, because the next one is written the
// same afternoon. So the class of defect is made detectable instead:
//
//   **A colour utility that names a token family the stylesheet defines, but a
//   shade of it that the stylesheet does not, is a class that paints nothing.**
//
// That is decidable from the two files alone. It is narrow on purpose — it
// only fires when the family is real (`brand-`, `pastel-`, `azure-`, …), which
// is exactly the case where the name reads as correct and the eye slides over
// it. A wholly invented family (`bg-flamingo-300`) would be caught in review;
// `dark:text-brand-400` sitting next to `text-brand-600` is not.
//
// The other half of the shape — an arbitrary variant (`[&>…]`) reaching into
// another component's internal DOM — is not statically decidable and is not
// checked here. A sweep of the tree found exactly one, the studio trigger's,
// and it is gone; every other `[&…]` in the tree addresses its own component's
// children, which is ordinary and correct. A new one is worth arguing about in
// review rather than banning by regex.

const root = new URL("..", import.meta.url).pathname;
const css = readFileSync(join(root, "src/app/globals.css"), "utf8");

/** Every `--color-*` the stylesheet defines, at any scope. */
function definedTokens(): Set<string> {
  const names = new Set<string>();
  for (const m of css.matchAll(/--color-([a-z0-9-]+)\s*:/g)) names.add(m[1]);
  return names;
}

/** A family is a token name with a sub-scale: `brand` from `brand-600`. */
function families(names: Set<string>): Set<string> {
  const fams = new Set<string>();
  for (const n of names) {
    const i = n.indexOf("-");
    if (i > 0) fams.add(n.slice(0, i));
  }
  return fams;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(tsx?|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

const PREFIXES = [
  "bg",
  "text",
  "border",
  "ring",
  "fill",
  "stroke",
  "from",
  "to",
  "via",
  "outline",
  "decoration",
  "accent",
  "caret",
  "divide",
  "placeholder",
  "shadow",
];

/**
 * `bg-brand-400`, `dark:hover:text-pastel-amber`, … — a colour utility with a
 * family and a shade, wherever it appears in a source file.
 */
const UTILITY = new RegExp(
  "(?:^|[\\s\"'`(])((?:[a-z0-9-]+:)*(?:" +
    PREFIXES.join("|") +
    ")-([a-z][a-z0-9]*)-([a-z0-9-]+))(?![a-zA-Z0-9-])",
  "g",
);

function findDeadUtilities(): string[] {
  const names = definedTokens();
  const fams = families(names);
  const dead: string[] = [];
  for (const file of sourceFiles(join(root, "src"))) {
    const src = readFileSync(file, "utf8");
    for (const line of src.split("\n")) {
      // Prose in a comment is allowed to say "border-brand-400".
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      for (const m of line.matchAll(UTILITY)) {
        const [, full, family, shade] = m;
        if (!fams.has(family)) continue;
        const token = `${family}-${shade.replace(/\/.*$/, "")}`;
        if (names.has(token)) continue;
        dead.push(`${file.slice(root.length)}: ${full}`);
      }
    }
  }
  return dead.sort();
}

/**
 * Known dead classes. The list is EMPTY, and getting it there is the story.
 *
 * Every entry generated no rule, so the element silently inherited whatever
 * colour it was going to have. The note that used to sit here said that meant
 * `text-brand-600` survived into dark at "about 3.8:1, under AA" — and that
 * was wrong in the direction nobody checks, because it assumed the
 * stylesheet's dark ramp was what `text-brand-600` resolved to. It wasn't:
 * `resolveTokens` was pinning the LIGHT ramp inline over every theme, so the
 * real value in dark was `#131316` on a `#1e1e22` card. 1.12:1. Invisible, not
 * merely under AA — nine labels that rendered as nothing at all.
 *
 * With the ramp fixed (iteration 17) the base class resolves to `#71717a` and
 * measures 3.44:1, so the shade actually worth naming is `brand-500`
 * (`#a1a1aa`, 6.48:1) — chosen by measuring, which is what this note always
 * asked for and what nobody could do while the token lied.
 *
 * The assertion stays exact. A stale entry fails as loudly as a new offender,
 * which is the point: the list cannot quietly become a permanent allow-list,
 * and now there is nothing in it to hide behind.
 */
const KNOWN_DEAD: string[] = [];

describe("colour utilities name tokens that exist", () => {
  it("finds no colour utility naming a shade the stylesheet never defines", () => {
    expect(findDeadUtilities()).toEqual(KNOWN_DEAD);
  });

  it("would catch a new one — the detector is not vacuous", () => {
    // A gate that has never fired on a known defect cannot be trusted to
    // report its absence, so it is fired here on a synthetic one.
    const names = definedTokens();
    expect(names.has("brand-600")).toBe(true);
    expect(names.has("brand-400")).toBe(false);
    expect(families(names).has("brand")).toBe(true);

    const line = '<span className="text-brand-400" />';
    const hit = [...line.matchAll(UTILITY)].map((m) => m[1]);
    expect(hit).toContain("text-brand-400");
  });
});
