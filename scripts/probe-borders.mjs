// Objective border/shadow census: load the built gallery pages in real
// Chromium and report the computed border-color, border-width and box-shadow
// of every surface class, per theme. Exists because "obnoxious white borders"
// is a claim about COMPUTED style, and reading the stylesheet cannot answer
// it — tokens cascade, providers override, and the failure is exactly the
// value that arrives, not the one that was written.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright-core";

const ROOT = "/tmp/design-gallery";
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const server = createServer((req, res) => {
  const path = join(ROOT, req.url === "/" ? "index.html" : req.url.split("?")[0]);
  if (!existsSync(path)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
  res.end(readFileSync(path));
});
await new Promise((r) => server.listen(4601, r));

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});

const SELECTORS = [
  ".panel",
  ".bento",
  ".bento-tile",
  ".chat-surface",
  ".ui-chip",
  "[data-slot=sidebar-container]",
  ".segmented",
];

async function census(pageName, theme) {
  const p = await browser.newPage({ viewport: { width: 1180, height: 1200 } });
  await p.goto(`http://127.0.0.1:4601/${pageName}`, { waitUntil: "networkidle" });
  await p.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await p.waitForTimeout(600);
  const rows = await p.evaluate((selectors) => {
    const out = [];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const cs = getComputedStyle(el);
      out.push({
        sel,
        borderColor: cs.borderTopColor,
        borderWidth: cs.borderTopWidth,
        shadow: cs.boxShadow.slice(0, 90),
        bg: cs.backgroundColor,
      });
    }
    // Also: how bright is the average border vs its background? Count every
    // element whose border luminance exceeds its own background's by > 60
    // (out of 255) in dark — the "white rim" census.
    const bright = [];
    // Composite an rgba() over a resolved background before measuring, so
    // an alpha hairline is judged by what it actually renders as (4% white
    // over #1e1e22 is a delta-9 step, not delta-240). oklab() and other
    // non-rgb syntaxes return null and are skipped rather than mis-scored.
    const parse = (c) => {
      const m = c.match(/^rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[,/ ]+([\d.]+))?\)$/);
      if (!m) return null;
      return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
    };
    const lum = (c, over) => {
      const p = parse(c);
      if (!p) return null;
      const bg = over ? parse(over) : null;
      const r = bg ? p.r * p.a + bg.r * (1 - p.a) : p.r;
      const g = bg ? p.g * p.a + bg.g * (1 - p.a) : p.g;
      const b = bg ? p.b * p.a + bg.b * (1 - p.a) : p.b;
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const el of document.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (cs.borderTopStyle !== "solid" || parseFloat(cs.borderTopWidth) === 0) continue;
      let bg = el;
      let bgc = "rgba(0, 0, 0, 0)";
      while (bg && (bgc === "rgba(0, 0, 0, 0)" || bgc === "transparent")) {
        bgc = getComputedStyle(bg).backgroundColor;
        bg = bg.parentElement;
      }
      const bl = lum(cs.borderTopColor, bgc);
      const bgl = lum(bgc);
      if (bl === null || bgl === null) continue;
      const delta = bl - bgl;
      if (delta > 60 && el.getBoundingClientRect().width > 40) {
        bright.push({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className).slice(0, 70),
          border: cs.borderTopColor,
          bg: bgc,
          delta: Math.round(delta),
        });
      }
    }
    return { out, bright: bright.slice(0, 20), brightCount: bright.length };
  }, SELECTORS);
  console.log(`\n== ${pageName} [${theme}] ==`);
  for (const r of rows.out) {
    console.log(
      `${r.sel.padEnd(30)} border ${r.borderWidth} ${r.borderColor}  bg ${r.bg}\n${"".padEnd(30)} shadow ${r.shadow}`,
    );
  }
  console.log(`bright-rim elements (border ≫ own bg): ${rows.brightCount}`);
  for (const b of rows.bright.slice(0, 8)) {
    console.log(`  <${b.tag}> Δ${b.delta} border ${b.border} on ${b.bg} :: ${b.cls}`);
  }
  await p.close();
}

for (const page of ["home.html", "sidebar.html", "panels.html"]) {
  for (const theme of ["light", "dark"]) {
    await census(page, theme);
  }
}

await browser.close();
server.close();
