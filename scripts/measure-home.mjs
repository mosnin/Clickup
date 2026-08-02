// What each Home block actually needs, at every shape the grid has.
//
// This exists because "how tall should this panel start" was answered by
// guessing, and the guess was one row — 168px — for every block on the screen,
// while Projects wanted 458 and Live wanted 546. Since the packer took over, a
// tile clips and scrolls whatever does not fit, which is right for a size
// somebody chose and wrong for a size nobody chose: a brand-new account landed
// on a stat card sliced through its own number.
//
// So the defaults in `DEFAULT_ROWS` (src/app/dashboard/page.tsx) come from
// here. Each tile's box is freed (height:auto) and its content reports the
// height it wants, at the three widths the grid draws 1, 2 and 3 columns at —
// height cannot be one number, because the same four stat cards are 94px wide
// and 224px narrow. The row ladder is 1 -> 168px, 2 -> 360px, 3 -> 552px, and
// 3 is the ceiling the grid enforces.
//
// Run `npm run gallery` first; this reads the same built gallery the
// screenshots do. Anything marked SCROLLS is a block whose default is a lie.
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const OUT = "/tmp/design-gallery";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]));
  const file = join(OUT, path === "/" ? "index.html" : path);
  if (!file.startsWith(OUT) || !existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "text/plain" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(4601, r));

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});

const ROW_UNIT = 10.5 * 16;
const ROW_GAP = 1.5 * 16;
const heightOf = (r) => r * ROW_UNIT + (r - 1) * ROW_GAP;
const rowsFor = (h) => {
  for (let r = 1; r <= 3; r++) if (heightOf(r) >= h) return r;
  return "3+";
};

for (const width of [1180, 900, 390]) {
  const p = await browser.newPage({ viewport: { width, height: 1000 } });
  await p.goto("http://127.0.0.1:4601/home.html?plain=1");
  await p.waitForTimeout(3000);
  const { rows, grid } = await p.evaluate(() => {
    const out = [];
    const g = document.getElementById("home-grid");
    for (const el of document.querySelectorAll("[data-tile]")) {
      const inner = el.querySelector("[data-tile-inner]");
      const box = el.getBoundingClientRect();
      const child = inner.firstElementChild;
      const prevTileH = el.style.height;
      const prevInnerH = inner.style.height;
      el.style.height = "auto";
      inner.style.height = "auto";
      if (child) child.style.height = "auto";
      const natural = Math.ceil(inner.getBoundingClientRect().height);
      el.style.height = prevTileH;
      inner.style.height = prevInnerH;
      if (child) child.style.height = "";
      out.push({
        id: el.dataset.tile,
        w: el.dataset.w,
        h: el.dataset.h,
        boxW: Math.round(box.width),
        boxH: Math.round(box.height),
        natural,
      });
    }
    return { rows: out, grid: Math.round(g.getBoundingClientRect().width) };
  });
  const cols = grid >= 768 ? 3 : grid >= 448 ? 2 : 1;
  console.log(`\n=== viewport ${width}px | grid ${grid}px | ${cols} column(s) ===`);
  for (const r of rows) {
    const want = rowsFor(r.natural);
    const flag = r.natural > r.boxH + 4 ? "  <-- SCROLLS" : "";
    console.log(
      `${r.id.padEnd(10)} span=${r.w} rows=${r.h} box=${r.boxW}x${r.boxH} needs=${String(r.natural).padStart(4)}px -> rows ${want}${flag}`,
    );
  }
  await p.close();
}

await browser.close();
server.close();
