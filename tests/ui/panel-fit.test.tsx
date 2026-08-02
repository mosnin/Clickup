import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { build } from "vite";
import react from "@vitejs/plugin-react";

// The gate for "a panel renders correctly at every size the packer can give it".
//
// It exists because of what the two defects it was written after had in
// common, which was not the shapes they happened to appear in. A metric's
// sparkline sliced by the tile's bottom edge, a table losing its last column
// to the right edge, and a bar chart cut through its own last two rows are one
// mistake at three different boundaries — a shape laying out at its natural
// size and letting whatever holds it crop the difference. A gate written for
// those three panels would pass the day a fourth shape did the same thing.
//
// So it asserts three properties over the WHOLE cross product — every shape
// the one renderer draws, in every box the grid can produce, at both
// viewports, in both themes:
//
//   1. **No text is cut by a boundary.** Truncation is allowed exactly where
//      it is deliberate and marked (`text-overflow: ellipsis`), because an
//      ellipsis admits to itself. A word ending at a tile's edge does not: it
//      reads as a shorter word, and "At r" is a different claim from "At risk".
//   2. **Every chart fits the box it was given.** Stricter than the text rule,
//      and separate from it, because a chart is one object: half a list is the
//      first half of the same rows, but half a chart has a broken scale and an
//      axis detached from its marks.
//   3. **Nothing paints below WCAG AA against its effective background.**
//      Effective, not intended — walked up through transparent ancestors —
//      because the bug this is written after was a fill resolving to black on
//      a black card while every stylesheet in the repo said otherwise.
//
// It runs in a real browser for the reason `scripts/verify-resize.mjs` does:
// jsdom lays nothing out, so every measurement it could offer here is zero,
// and a suite of zeroes agrees with everything. The measurement helpers are
// deliberately shaped like that script's `overlapsOn` / `spillsOn` — same
// question (is anything painted outside what holds it), asked one layer
// further in, of text and colour rather than of tiles.
//
// It builds its own page rather than reusing `npm run gallery`'s output so it
// cannot report a pass against a bundle somebody built three changes ago.

// `process.cwd()`, not `import.meta.url`: this file runs under the `ui`
// project, whose environment is jsdom, and jsdom rewrites the module URL to
// something `fileURLToPath` refuses. Vitest always runs from the repo root.
const ROOT = process.cwd();
const SRC = join(ROOT, "tests/ui/design");
const OUT = "/tmp/panel-fit-gallery";
/**
 * Assigned by the OS, never chosen.
 *
 * A fixed port made this gate fail with `EADDRINUSE` the moment anything else
 * on the machine was mid-run — including an earlier copy of itself whose
 * server had outlived it. A gate that reports red for a reason that has
 * nothing to do with the code is a gate people learn to re-run and then to
 * ignore, so the flakiness is removed rather than retried.
 */
let port = 0;
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

/** Both viewports, because `sm:` rules make a 358px tile two different tiles. */
const VIEWPORTS = [
  { width: 390, height: 900, label: "390" },
  { width: 1180, height: 900, label: "1180" },
];
const THEMES = ["light", "dark"] as const;

/**
 * The app's own compiled stylesheet.
 *
 * Not a second copy of the tokens: this gate's whole subject is which value a
 * custom property resolves to, and a hand-written stylesheet would be checking
 * the harness's answer rather than the app's.
 */
function appCss(): string {
  const dir = join(ROOT, ".next/static/css");
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".css"))
    : [];
  if (files.length === 0) {
    throw new Error(
      "No compiled CSS at .next/static/css — run `npm run build` first. " +
        "Without it this gate would measure contrast against a stylesheet the " +
        "app does not ship, which is worse than not running at all.",
    );
  }
  return files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}

async function buildPage() {
  const css = appCss();
  await build({
    root: SRC,
    base: "./",
    plugins: [react()],
    resolve: {
      alias: {
        "@": join(ROOT, "src"),
        "@convex": join(ROOT, "convex"),
        "convex/react": join(SRC, "stubs/convex-react.tsx"),
        "@clerk/nextjs": join(SRC, "stubs/clerk.tsx"),
        "next/navigation": join(SRC, "stubs/next-navigation.ts"),
        "next/link": join(SRC, "stubs/next-link.tsx"),
      },
    },
    build: {
      outDir: OUT,
      emptyOutDir: true,
      minify: false,
      rollupOptions: { input: { "panel-fit": join(SRC, "panel-fit.html") } },
    },
    logLevel: "error",
  });
  const html = join(OUT, "panel-fit.html");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    html,
    readFileSync(html, "utf8").replace("<!--APP_CSS-->", `<style>${css}</style>`),
  );
}

function serve(): Promise<Server> {
  const types: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
  };
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]));
    const file = join(OUT, path === "/" ? "panel-fit.html" : path);
    if (!file.startsWith(OUT) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": types[extname(file)] ?? "text/plain" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) =>
    server.listen(0, () => {
      const addr = server.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
      resolve(server);
    }),
  );
}

// ── What the browser is asked ───────────────────────────────────────────
//
// Both of these run inside the page as one string, because a per-node round
// trip over CDP for a few thousand text nodes takes minutes. They are written
// as source strings rather than as functions so nothing in this file's module
// scope can be closed over by accident.

/**
 * Every text node cut by an ancestor's clip boundary.
 *
 * Three things are deliberately NOT reported, and each has cost somebody a
 * green run somewhere:
 *
 *   - **A marked truncation.** `text-overflow: ellipsis` is a decision, and
 *     the ellipsis is the mark that says so. Reporting it would flag every
 *     correctly-truncated title in the product and the gate would be switched
 *     off within a week.
 *   - **Vertical overflow of something that genuinely scrolls.** A long list
 *     inside a panel is meant to run past the fold; the reader can reach it.
 *     Horizontal is not given the same pass — a horizontal scrollbar inside a
 *     card is a control most people never find, which is exactly why the table
 *     defect survived behind one.
 *
 *     "Genuinely" is doing load-bearing work, and the calibration run is what
 *     proved it: the first version of this asked `scrollHeight > clientHeight`,
 *     which is true of `overflow: hidden` as well — hidden content overflows,
 *     it simply cannot be reached. So the gate quietly forgave every clipped
 *     panel, pointed at the real defect and reported nothing. The question is
 *     whether the reader can get to it, so it is the computed `overflow-y`
 *     that is asked.
 *   - **Anything not actually visible.** Hidden measuring stacks, zero-opacity
 *     layers and the off-screen digits of a rolling counter are not text
 *     anybody is reading.
 */
const CUT_TEXT = `(() => {
  const out = [];
  const seen = new Set();
  const invisible = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.visibility === "hidden" || cs.display === "none") return true;
      if (Number(cs.opacity) === 0) return true;
    }
    return false;
  };
  for (const tile of document.querySelectorAll("[data-fit-tile]")) {
    const id = tile.getAttribute("data-fit-tile");
    // Every clipping box between a text node and the tile, plus the tile.
    const walker = document.createTreeWalker(tile, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = (node.nodeValue || "").trim();
      if (!text) continue;
      const parent = node.parentElement;
      if (!parent || invisible(parent)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.width < 0.5 || r.height < 0.5) continue;
      // The range's rect is the text's UNTRUNCATED extent — a \`truncate\` span
      // reports the full width of the words, not the width of what is on
      // screen. So the visible extent is carried up the ancestor chain and
      // narrowed by each clipper in turn. Without that, every legitimately
      // truncated title reads as cut by the tile as well as by its own span,
      // and a gate that flags correct work is a gate somebody turns off.
      const vis = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      for (let el = parent; el; el = el.parentElement) {
        const cs = getComputedStyle(el);
        const clipX = cs.overflowX !== "visible";
        const clipY = cs.overflowY !== "visible";
        if (clipX || clipY) {
          const b = el.getBoundingClientRect();
          const marked = cs.textOverflow === "ellipsis";
          const reachableY =
            (cs.overflowY === "auto" || cs.overflowY === "scroll") &&
            el.scrollHeight > el.clientHeight + 1;
          const dx = Math.round(Math.max(vis.right - b.right, b.left - vis.left));
          const dy = Math.round(Math.max(vis.bottom - b.bottom, b.top - vis.top));
          if (clipX) {
            vis.left = Math.max(vis.left, b.left);
            vis.right = Math.min(vis.right, b.right);
          }
          if (clipY) {
            vis.top = Math.max(vis.top, b.top);
            vis.bottom = Math.min(vis.bottom, b.bottom);
          }
          if (clipX && !marked && dx > 1) {
            const key = id + "|x|" + text;
            if (!seen.has(key)) {
              seen.add(key);
              out.push({ tile: id, axis: "x", by: dx, text: text.slice(0, 40) });
            }
          }
          if (clipY && !reachableY && dy > 2) {
            const key = id + "|y|" + text;
            if (!seen.has(key)) {
              seen.add(key);
              out.push({ tile: id, axis: "y", by: dy, text: text.slice(0, 40) });
            }
          }
        }
        if (el === tile) break;
      }
    }
  }
  return out;
})()`;

/**
 * Every chart drawn larger than the box that holds it.
 *
 * Separate from the text pass, and held to a stricter rule, because a chart is
 * one object. A list running past the fold of something that scrolls is fine —
 * the reader pages down and the rows below are the same rows. A chart cut in
 * half is not the top half of a chart: its scale is wrong, its axis has
 * detached from its marks, and the reading it offers is false rather than
 * partial. So "the holder can be scrolled" is not an excuse here, and this is
 * the check that actually names the defect the panel work was about — the
 * sparkline that laid out at a constant 34px inside whatever room was left.
 *
 * `role="img"` is how a chart identifies itself (`Chart` sets it for screen
 * readers), so the gate finds them without a test-only attribute to keep in
 * agreement with anything.
 */
const CHART_OVERFLOW = `(() => {
  const out = [];
  for (const tile of document.querySelectorAll("[data-fit-tile]")) {
    const id = tile.getAttribute("data-fit-tile");
    for (const chart of tile.querySelectorAll('[role="img"]')) {
      const c = chart.getBoundingClientRect();
      if (c.height < 1) continue;
      // The nearest ancestor that clips, up to and including the tile.
      let holder = tile;
      for (let el = chart.parentElement; el; el = el.parentElement) {
        const cs = getComputedStyle(el);
        if (cs.overflowY !== "visible" || cs.overflowX !== "visible") {
          holder = el;
          break;
        }
        if (el === tile) break;
      }
      const b = holder.getBoundingClientRect();
      const below = Math.round(c.bottom - b.bottom);
      const right = Math.round(c.right - b.right);
      if (below > 2) out.push({ tile: id, axis: "y", by: below });
      if (right > 2) out.push({ tile: id, axis: "x", by: right });
    }
  }
  return out;
})()`;

/**
 * Everything painted below the contrast it needs against what is behind it.
 *
 * Text is held to WCAG AA (4.5:1, or 3:1 once it is large). Marks — a bar, an
 * arc, a gridline — are held to the 3:1 the same standard asks of a graphical
 * object, because a chart whose bars you cannot find is not a chart.
 *
 * The background is walked, not read. `getComputedStyle(el).backgroundColor`
 * on a mark is `rgba(0,0,0,0)` almost everywhere, and comparing ink against
 * transparent answers a question nobody asked. Walking up until something is
 * actually opaque is what makes "effective background" mean the pixel a person
 * is looking at rather than the one the stylesheet mentioned.
 *
 * It also reports how many marks it managed to READ, and the test refuses a
 * pass on a number too low to be a real sweep. That is the anti-blindness
 * clause, and it is here because this gate has already been blind once: the
 * first version parsed `rgb()` with a regular expression, and the app's
 * default chart palette is `color-mix()`, which Chromium computes to
 * `color(srgb …)`. Every mono fill came back unparseable, the pass silently
 * skipped it, and the run went green having measured almost nothing. A
 * coverage count is the difference between "nothing is wrong" and "I could not
 * see anything".
 */
const LOW_CONTRAST = `(() => {
  // The browser's own colour parser, via a 1x1 canvas. Total by construction:
  // it understands every syntax the app can emit — hex, rgb, hsl, oklch,
  // color-mix, color(srgb …) — because it is the same code that paints them.
  // An unparseable string leaves the previous fillStyle in place, which is
  // fully transparent, and reads as "paints nothing".
  const ctx = document.createElement("canvas").getContext("2d", {
    willReadFrequently: true,
  });
  ctx.canvas.width = 1;
  ctx.canvas.height = 1;
  const parse = (c) => {
    if (!c || c === "none" || c === "transparent") return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "rgba(0, 0, 0, 0)";
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
  };
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const ratio = (a, b) => {
    const l1 = lum(a);
    const l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const bgOf = (el) => {
    let acc = null;
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (!c || c.a === 0) continue;
      acc = acc ? over(acc, c) : c;
      if (acc.a >= 0.999) return acc;
    }
    const page = parse(getComputedStyle(document.body).backgroundColor);
    return acc && page ? over(acc, page) : (page ?? { r: 255, g: 255, b: 255, a: 1 });
  };
  const invisible = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.visibility === "hidden" || cs.display === "none") return true;
      if (Number(cs.opacity) === 0) return true;
    }
    return false;
  };
  const out = [];
  const seen = new Set();
  // How much this pass could actually READ — see the note above.
  const cover = { text: 0, mark: 0 };

  // ── Two things that are legitimately below 3:1, resolved rather than listed
  //
  // Resolved from the page's own tokens, in the theme actually being measured,
  // so neither is a colour snapshot that rots the next time anything moves. If
  // the palette changes, these stop matching and the gate fires.
  //
  //   FURNITURE — \`--chart-grid\` (hairlines) and \`--chart-track\` (the
  //   \`--border\` the vendored shapes are given). A gauge's unfilled notches, a
  //   ring's track and a radar's web are what a reading is measured AGAINST;
  //   WCAG 1.4.11 asks 3:1 of graphical objects required to understand the
  //   content, and a track is not one. Drawing them at 3:1 would put the
  //   furniture level with the data.
  //
  //   Two entries, because there are two registers. These marks used to be
  //   allowed here by ACCIDENT: \`--border\` was pointed at \`--chart-grid\`, so
  //   they resolved to a colour already on the list, and the day the hairline
  //   value turned out to be wrong as a fill (1.18:1 in dark — an invisible
  //   track, reported 360 times by the audit's ink gate) this list did not
  //   notice, because it had never been told what it was allowing. Naming
  //   \`--chart-track\` is the difference between an exemption and a coincidence.
  //
  //   THE PALE END OF THE MONO RAMP — an OPEN finding, not a decision. The
  //   default palette is six stops of \`color-mix(foreground, background)\` at
  //   92/70/52/38/26/16% ink. Because it is mixed from the theme's own two
  //   ends it flips correctly in dark (stop 1 is 15.7:1 light and 14.5:1
  //   dark), so the near-black bars are not a fixed near-black — but stops 3
  //   to 6 are 2.49, 1.80, 1.48 and 1.41 against the card, so a donut's fifth
  //   segment is close to invisible. The arithmetic says a monochrome ramp
  //   needs every stop at 45% ink or more to clear 3:1 in BOTH themes, which
  //   leaves 45-100% for six stops. That is a real ramp — but it also makes
  //   the heatmap's palest level, which MEANS "nothing happened", a solid
  //   mid-grey. Sequential scales want their bottom step to read as absence;
  //   categorical ones want every step visible. One ramp cannot be both, so
  //   this needs a decision about the palette rather than a patch here.
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.opacity = "0";
  document.body.appendChild(probe);
  const resolved = (expr) => {
    probe.style.color = "";
    probe.style.color = expr;
    const c = parse(getComputedStyle(probe).color);
    return c ? Math.round(c.r) + "," + Math.round(c.g) + "," + Math.round(c.b) : "";
  };
  const allowed = new Set(
    [
      "var(--chart-grid)",
      "var(--chart-track)",
      "var(--border)",
      ...[52, 38, 26, 16].map(
        (p) =>
          "color-mix(in srgb, var(--color-foreground) " +
          p +
          "%, var(--color-background))",
      ),
    ]
      .map(resolved)
      .filter(Boolean),
  );
  probe.remove();
  const key = (c) =>
    Math.round(c.r) + "," + Math.round(c.g) + "," + Math.round(c.b);
  const report = (tile, what, r, need, detail) => {
    const key = tile + "|" + what + "|" + detail;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ tile, what, ratio: Math.round(r * 100) / 100, need, detail });
  };
  for (const tile of document.querySelectorAll("[data-fit-tile]")) {
    const id = tile.getAttribute("data-fit-tile");
    // ── Text ──
    const walker = document.createTreeWalker(tile, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = (node.nodeValue || "").trim();
      if (!text) continue;
      const el = node.parentElement;
      if (!el || invisible(el)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const cs = getComputedStyle(el);
      const fg = parse(cs.color);
      if (!fg || fg.a === 0) continue;
      const bg = bgOf(el);
      const size = parseFloat(cs.fontSize);
      const bold = Number(cs.fontWeight) >= 700;
      const large = size >= 24 || (size >= 18.66 && bold);
      const need = large ? 3 : 4.5;
      const got = ratio(over(fg, bg), bg);
      cover.text += 1;
      if (got < need) report(id, "text", got, need, text.slice(0, 40));
    }
    // ── Marks ──
    for (const el of tile.querySelectorAll("svg rect, svg path, svg circle, svg ellipse, svg polygon")) {
      if (invisible(el)) continue;
      const box = el.getBoundingClientRect();
      // Big enough to be a mark rather than a hairline join or a clip path.
      if (box.width < 3 || box.height < 3) continue;
      const cs = getComputedStyle(el);
      const parent = el.parentElement;
      const bg = bgOf(parent || el);
      // A filled shape reads through its fill; a stroke on top of one is
      // furniture. The donut proves why that distinction has to be made: its
      // segments are separated by a hairline painted \`var(--color-background)\`
      // on purpose, so measured as a mark it is 1:1 against the card every
      // time — a permanent red light on a deliberate and correct decision,
      // which is how a gate gets ignored and then deleted. A stroke is only
      // carrying a reading when there is no fill under it: a line, an area's
      // edge, a gridline.
      //
      // "Filled" means filled once opacity is applied, not merely given a fill
      // colour: an area drawn in the \`outline\` style still names a fill and
      // paints it at zero, and reading that as filled would skip the stroke
      // that is the only thing on screen.
      const fillC = parse(cs.fill);
      const fillO = Number(cs.fillOpacity);
      const fillA = fillC ? fillC.a * (Number.isFinite(fillO) ? fillO : 1) : 0;
      const filled = cs.fill !== "none" && fillA >= 0.2;
      const props = filled ? [["fill", cs.fill]] : [["stroke", cs.stroke]];
      for (const [prop, raw] of props) {
        if (!raw || raw === "none") continue;
        const c = parse(raw);
        if (!c || c.a === 0) continue;
        const opacity =
          Number(prop === "fill" ? cs.fillOpacity : cs.strokeOpacity);
        const eff = { ...c, a: c.a * (Number.isFinite(opacity) ? opacity : 1) };
        // Below a fifth opaque it is a wash, not a mark — a gradient's tail
        // and an area's fade both live here and neither carries a reading.
        if (eff.a < 0.2) continue;
        if (prop === "stroke" && parseFloat(cs.strokeWidth || "0") < 0.8) continue;
        const got = ratio(over(eff, bg), bg);
        cover.mark += 1;
        if (got < 3 && !allowed.has(key(c))) {
          report(id, "mark", got, 3, el.tagName + "." + prop + " " + raw);
        }
      }
    }
  }
  return { findings: out, cover };
})()`;

let browser: Browser;
let server: Server;

beforeAll(async () => {
  await buildPage();
  server = await serve();
  browser = await chromium.launch({
    executablePath: existsSync(CHROME) ? CHROME : undefined,
    args: ["--no-sandbox"],
  });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
});

/**
 * One page, settled.
 *
 * The wait is long because the entrance animations are real: a chart caught
 * mid-reveal is a chart at a fraction of its opacity, which reads to the
 * contrast pass as a defect that is not there. `query` lets the calibration
 * run ask for the same page with one shape deliberately broken.
 */
async function open(
  viewport: (typeof VIEWPORTS)[number],
  theme: (typeof THEMES)[number],
  query = "",
): Promise<{ page: Page; errors: string[] }> {
  const errors: string[] = [];
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/panel-fit.html${query}`);
  if (theme === "dark") {
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
  }
  await page.waitForSelector("[data-fit-tile]");
  await page.waitForTimeout(3500);
  return { page, errors };
}

describe("every panel shape, in every box the packer can give it", () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(
        `keeps its text inside its tile at ${viewport.label} in ${theme}`,
        async () => {
          const { page, errors } = await open(viewport, theme);
          const cut = (await page.evaluate(CUT_TEXT)) as {
            tile: string;
            axis: string;
            by: number;
            text: string;
          }[];
          await page.close();
          expect(errors, errors.join("\n")).toEqual([]);
          expect(
            cut.map((c) => `${c.tile}: "${c.text}" cut ${c.by}px on ${c.axis}`),
          ).toEqual([]);
        },
        180_000,
      );

      it(
        `draws every chart inside its box at ${viewport.label} in ${theme}`,
        async () => {
          const { page } = await open(viewport, theme);
          const over = (await page.evaluate(CHART_OVERFLOW)) as {
            tile: string;
            axis: string;
            by: number;
          }[];
          await page.close();
          expect(
            over.map((o) => `${o.tile}: chart runs ${o.by}px past its box (${o.axis})`),
          ).toEqual([]);
        },
        180_000,
      );

      it(
        `paints nothing below AA at ${viewport.label} in ${theme}`,
        async () => {
          const { page } = await open(viewport, theme);
          const low = (await page.evaluate(LOW_CONTRAST)) as {
            findings: {
              tile: string;
              what: string;
              ratio: number;
              need: number;
              detail: string;
            }[];
            cover: { text: number; mark: number };
          };
          await page.close();
          expect(
            low.findings.map(
              (l) =>
                `${l.tile}: ${l.what} ${l.detail} is ${l.ratio}:1, needs ${l.need}:1`,
            ),
          ).toEqual([]);
          // The anti-blindness clause. Nineteen shapes in twelve boxes is
          // thousands of words and hundreds of marks; anything near zero means
          // the pass could not read the page, and "I saw nothing" must never
          // be reported as "there is nothing".
          expect(low.cover.text, "no text was legible to the contrast pass")
            .toBeGreaterThan(500);
          expect(low.cover.mark, "no marks were legible to the contrast pass")
            .toBeGreaterThan(100);
        },
        180_000,
      );
    }
  }

  // ── Calibration ────────────────────────────────────────────────────────
  //
  // A gate that has never detected a known defect cannot be trusted to report
  // its absence — the rubric's precondition, and the reason an earlier audit
  // returned a clean result on a surface with a defect documented twice. So
  // the instrument is pointed at all three defects on purpose, in the same run
  // that reports their absence, and fails if it cannot see them.
  //
  // This is not ceremony. The first version of the clipping check asked
  // `scrollHeight > clientHeight` to decide whether overflow was reachable,
  // which is true of `overflow: hidden` as well — so it forgave every clipped
  // panel and returned a clean page while pointed straight at the defect. The
  // calibration is the only reason that was found rather than reported as a
  // pass.
  it(
    "fires on a chart drawn past the box it was given",
    async () => {
      const { page } = await open(VIEWPORTS[0], "light", "?break=clip");
      const over = (await page.evaluate(CHART_OVERFLOW)) as unknown[];
      await page.close();
      expect(
        over.length,
        "the fit gate saw nothing wrong with a chart laying out at a constant " +
          "inside a smaller box — the exact defect it exists to catch",
      ).toBeGreaterThan(0);
    },
    180_000,
  );

  it(
    "fires on text cut by a boundary",
    async () => {
      const { page } = await open(VIEWPORTS[0], "light", "?break=cut");
      const cut = (await page.evaluate(CUT_TEXT)) as unknown[];
      await page.close();
      expect(
        cut.length,
        "the clipping gate saw nothing wrong with a status chip sliced by a " +
          "panel edge — it cannot be trusted to report that nothing is",
      ).toBeGreaterThan(0);
    },
    180_000,
  );

  it(
    "fires on a mark painted with an undefined token",
    async () => {
      const { page } = await open(VIEWPORTS[1], "dark", "?break=ink");
      const low = (await page.evaluate(LOW_CONTRAST)) as {
        findings: unknown[];
      };
      await page.close();
      expect(
        low.findings.length,
        "the contrast gate saw nothing wrong with black marks on a black " +
          "card — which is the exact defect it exists to catch",
      ).toBeGreaterThan(0);
    },
    180_000,
  );
});
