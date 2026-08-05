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
await new Promise((r) => server.listen(4612, r));
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const ROW_UNIT = 6 * 16, ROW_GAP = 1.5 * 16;
const heightOf = (r) => r * ROW_UNIT + (r - 1) * ROW_GAP;
const rowsFor = (h) => { for (let r = 1; r <= 6; r++) if (heightOf(r) >= h) return r; return "6+"; };
for (const width of [1180, 900, 390]) {
  const p = await b.newPage({ viewport: { width, height: 1000 } });
  await p.goto("http://127.0.0.1:4612/project.html");
  await p.waitForTimeout(3000);
  const out = await p.evaluate(() => {
    const rows = [];
    for (const el of document.querySelectorAll("[data-tile]")) {
      const inner = el.querySelector("[data-tile-inner]");
      const child = inner.firstElementChild;
      const pt = el.style.height, pi = inner.style.height;
      el.style.height = "auto"; inner.style.height = "auto";
      if (child) child.style.height = "auto";
      const natural = Math.ceil(inner.getBoundingClientRect().height);
      el.style.height = pt; inner.style.height = pi;
      if (child) child.style.height = "";
      rows.push({ id: el.dataset.tile, w: el.dataset.w, h: el.dataset.h, natural });
    }
    return rows;
  });
  console.log(`\n=== ${width}px ===`);
  for (const r of out) console.log(`${r.id.padEnd(12)} span=${r.w} rows=${r.h} needs=${String(r.natural).padStart(4)}px -> rows ${rowsFor(r.natural)}`);
  await p.close();
}
await b.close(); server.close();
