// Crop the design gallery, one card at a time, at native resolution.
//
// This exists because of a failure of the *instrument*, not of the eye. The
// full-page shots in /tmp/design-shots are 2360px wide and 5000px tall; every
// tool that reads one downscales it to roughly 830px on the long edge. That is
// a ~0.35x reduction, which turns a 10px axis label into a 3.5px smear. An
// auditor looking at that image is not looking at small text at all — it is
// physically not in the file they were handed — and so a pass over it can
// return "no defects" while a label sits on top of a data point.
//
// The fix is not a bigger screenshot. It is a *smaller* one: shoot each chart
// card ALONE, so a 190px card arrives as a 380px image instead of one
// twelfth of a page. Nothing is downscaled, because nothing needs to be.
//
// Calibration: the SCATTER · 14 DAYS card in the "Over time" row has date
// labels ("Jun 8", "Jun 14") that collide with the scatter marks. If a crop
// pass cannot show that, the crops are still too coarse and every clean
// verdict it produces is worthless.
//
// Wide cards (the 1100px column of labels.html) are tiled rather than shot
// whole, for the same reason: a 2200px-wide image gets downscaled on the way
// into an eye, and the tiling is what keeps it 1:1.
//
//   node scripts/audit-crops.mjs        (needs `npm run gallery` first)

import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const GALLERY = "/tmp/design-gallery";
const OUT = "/tmp/design-crops";
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
};

// The widest a crop may be in CSS pixels. At deviceScaleFactor 2 this lands at
// 1360 device px, which is under the point where a reader downscales it.
const TILE = 680;

if (!existsSync(join(GALLERY, "index.html"))) {
  console.error("No gallery built. Run `npm run gallery`.");
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]));
  const file = join(GALLERY, path === "/" ? "index.html" : path);
  if (!file.startsWith(GALLERY) || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "text/plain" });
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(4601, resolve));

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({
  viewport: { width: 1180, height: 1400 },
  deviceScaleFactor: 2,
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "cell";

let written = 0;

/** Shoot one card. Wide cards are tiled so nothing is ever downscaled. */
async function shootCell(cell, name) {
  // `clip` on a viewport screenshot is viewport-relative, so the card has to
  // be on screen before its box means anything. Scrolling first is also what
  // keeps this fast — a fullPage render per card on a 5000px page is minutes.
  await cell.scrollIntoViewIfNeeded();
  await page.waitForTimeout(60);
  const box = await cell.boundingBox();
  if (!box || box.width < 8 || box.height < 8) return;
  // A little air around the card, so "the mark touches the card edge" is a
  // thing the crop can show rather than a thing it crops away.
  const pad = 6;
  const x = Math.max(box.x - pad, 0);
  const y = Math.max(box.y - pad, 0);
  const w = box.width + pad * 2;
  const h = box.height + pad * 2;

  if (w <= TILE) {
    await page.screenshot({
      path: join(OUT, `${name}.png`),
      clip: { x, y, width: w, height: h },
    });
    written++;
    return;
  }
  const tiles = Math.ceil(w / TILE);
  const step = w / tiles;
  for (let i = 0; i < tiles; i++) {
    // Overlap, or a defect that straddles a tile seam is a defect nobody sees.
    const tx = Math.max(x + i * step - (i === 0 ? 0 : 24), 0);
    const tw = Math.min(step + (i === 0 ? 24 : 48), x + w - tx);
    await page.screenshot({
      path: join(OUT, `${name}-t${i + 1}.png`),
      clip: { x: tx, y, width: tw, height: h },
    });
    written++;
  }
}

async function shootPage(url, pageName) {
  await page.goto(url);
  // The entrance animations must land, or every crop is a chart caught
  // mid-reveal and every finding is a false alarm.
  await page.waitForTimeout(2600);

  const cells = page.locator(".cell");
  const n = await cells.count();
  if (n === 0) errors.push(`${pageName}: no .cell found — selector drifted`);

  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => {
      if (t === "dark") document.documentElement.setAttribute("data-theme", "dark");
      else document.documentElement.removeAttribute("data-theme");
    }, theme);
    await page.waitForTimeout(700);

    for (let i = 0; i < n; i++) {
      const cell = cells.nth(i);
      const cap =
        (await cell.locator(".cap").first().textContent().catch(() => null)) ?? "";
      const idx = String(i).padStart(2, "0");
      await shootCell(cell, `${pageName}-${theme}-${idx}-${slug(cap)}`);
    }
    console.log(`${pageName} ${theme}: ${n} cards`);
  }
}

await shootPage("http://127.0.0.1:4601/", "charts");
await shootPage("http://127.0.0.1:4601/labels.html", "labels");

await browser.close();
server.close();

console.log(`\n${written} crops in ${OUT}`);
if (errors.length > 0) {
  console.error("\nThe gallery threw while rendering:");
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}
