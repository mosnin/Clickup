// A negative value is drawn, and drawing it moved nothing else.
//
// This gate exists in a real browser rather than in jsdom, and the reason is
// worth stating because it cost three tests to learn. Bars enter through
// `AnimatedBar`, which renders the animation's *start* state — every bar sits
// at `height: 0px` on the plot floor regardless of the value it was handed,
// and jsdom never advances the animation. Three unit tests were written
// against that geometry and all three passed while measuring nothing at all;
// one of them asserted that a set of NaNs had exactly one element, which is
// true and says nothing. Only a browser that lays out and animates can answer
// whether a bar has extent.
//
// What it checks, on the gallery's own 14-day fixture (index 10 is -1, and
// indices 9 and 11 are 0, so the hard cases sit next to each other):
//
//   1. every point gets a bar with real height — a negative must not be blank
//   2. the negative hangs BELOW the baseline the positives sit on, so the
//      sign is legible and not merely present
//   3. a chart with no negatives is untouched: all its bars share one floor.
//
// (3) is the safety property and the reason the fix was allowed at all:
// `scale(0)` IS the bottom of the plot whenever the domain starts at zero, so
// every chart that existed before this change must be pixel-identical. If (3)
// ever fails, the fix has stopped being a no-op for the common case and the
// blast radius is every chart in the product.

import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { CHROME } from "./lib/browser.mjs";

const ROOT = "/tmp/design-gallery";
const PORT = 4611;

if (!existsSync(join(ROOT, "labels.html"))) {
  console.error("no gallery — run `node scripts/build-gallery.mjs` first");
  process.exit(1);
}

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const server = createServer((req, res) => {
  const rel = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]))
    .replace(/^(\.\.[/\\])+/, "")
    .replace(/^\//, "");
  const file = join(ROOT, rel || "index.html");
  if (!file.startsWith(ROOT) || !existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "text/plain" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, r));

// The pinned browser this repo ships with, same as every other gate here —
// `chromium.launch()` with no path asks Playwright to resolve its own download
// and fails in this environment.
const browser = await chromium.launch({
  executablePath: CHROME,
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

const problems = [];

/**
 * The bars of one fixture cell, as the browser actually laid them out.
 *
 * Bounding boxes rather than attributes: the bar's final position is reached
 * through a CSS transform, so the `y` attribute is the animation's start and
 * lying about it is exactly the trap this file exists to avoid.
 */
async function barsOf(caseName) {
  return page.evaluate((name) => {
    const cell = document.querySelector(`[data-case="${name}"]`);
    if (!cell) return null;
    const svg = cell.querySelector("svg");
    if (!svg) return null;
    // Bars carry the series fill; grid lines, the background and the clip
    // rect do not. Filtering on a positive area drops the zero-height
    // leftovers of anything that has not drawn.
    return [...svg.querySelectorAll("rect")]
      .map((el) => {
        const b = el.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, height: b.height, width: b.width };
      })
      .filter((b) => b.height > 0.5 && b.width > 0.5 && b.width < 200)
      .sort((a, b) => a.top - b.top);
  }, caseName);
}

await page.goto(`http://127.0.0.1:${PORT}/labels.html`);
// Long enough for the entrance animation to finish; the whole point is to
// measure the settled chart rather than a frame of it.
await page.waitForTimeout(2500);

// ── 1 & 2: the chart that contains a negative ──────────────────────────────

const mixed = await barsOf("by day · 14");
if (!mixed || mixed.length === 0) {
  problems.push("by day · 14: no bars found at all — fixture or selector wrong");
} else {
  // 14 buckets, one series. Every one must have put ink on the chart.
  if (mixed.length < 14) {
    problems.push(
      `by day · 14: ${mixed.length} bars for 14 points — ${14 - mixed.length} vanished`,
    );
  }
  // Straddle. Stated as "something ends deeper than the rest do" rather than
  // "a top is below a bottom": a correctly drawn negative bar has its top ON
  // the baseline, exactly equal to where every positive bar ends, so the
  // stricter phrasing can never hold no matter how right the chart is. The
  // first version of this gate used it and reported a working chart broken.
  const baseline = Math.min(...mixed.map((b) => b.bottom));
  const deepest = Math.max(...mixed.map((b) => b.bottom));
  const below = mixed.filter((b) => b.bottom > baseline + 0.5);
  if (below.length === 0) {
    problems.push(
      `by day · 14: every bar ends at ${baseline.toFixed(1)} — nothing hangs below the ` +
        `baseline, so the -1 is drawn on the wrong side of it or not at all`,
    );
  }
  // …and it must hang FROM the baseline, not float somewhere under it.
  for (const b of below) {
    if (Math.abs(b.top - baseline) > 1) {
      problems.push(
        `by day · 14: a bar below the baseline starts at ${b.top.toFixed(1)} rather than ` +
          `${baseline.toFixed(1)} — it is detached from the axis it is measured against`,
      );
    }
  }
  console.log(
    `by day · 14: ${mixed.length} bars, baseline ${baseline.toFixed(1)}, ` +
      `${below.length} below it, deepest ${deepest.toFixed(1)}`,
  );
}

// ── 3: the charts that contain none ────────────────────────────────────────

for (const name of ["by status", "by assignee"]) {
  const bars = await barsOf(name);
  if (!bars || bars.length === 0) {
    problems.push(`${name}: no bars found`);
    continue;
  }
  // `by assignee` is horizontal, so its shared edge is a left edge, not a
  // bottom one — checking bottoms there would compare band positions and fail
  // for a reason that has nothing to do with this change.
  const edges = bars.map((b) => Math.round(b.bottom));
  const shared = new Set(edges);
  const vertical = name === "by status";
  if (vertical && shared.size !== 1) {
    problems.push(
      `${name}: bars no longer share one floor (${[...shared].join(", ")}) — ` +
        `the negative-domain fix stopped being a no-op for all-positive data`,
    );
  }
  console.log(`${name}: ${bars.length} bars, ${shared.size} distinct bottom edge(s)`);
}

await browser.close();
server.close();

if (problems.length) {
  console.error("\nFAIL");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\nPASS: a negative is drawn, on the correct side, and no all-positive chart moved");
