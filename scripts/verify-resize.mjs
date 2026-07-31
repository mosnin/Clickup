// Drag the resize grip with a real pointer and measure what happened.
//
// The vertical resize was fixed twice against jsdom and reported broken twice
// by a person. jsdom cannot drag. This can, so this is the arbiter: it fails
// loudly if pulling the corner down does not change the committed layout AND
// the on-screen height, with the neighbour left alone.

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
await new Promise((r) => server.listen(4599, r));

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto("http://127.0.0.1:4599/grid.html");
await page.waitForTimeout(1200);

const tile = (id) => page.locator(`[data-tile="${id}"]`);
const height = async (id) => (await tile(id).boundingBox()).height;

const beforeA = await height("a");
const beforeB = await height("b");
await page.screenshot({ path: join(OUT, "grid-before.png") });

// A real drag on tile A's grip: down, pull 260px south, release.
const grip = page.getByLabel(/^Resize Today/);
const box = await grip.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
for (let i = 1; i <= 13; i++) {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + i * 20);
  await page.waitForTimeout(16);
}
await page.mouse.up();
await page.waitForTimeout(800);

const afterA = await height("a");
const afterB = await height("b");
const layout = JSON.parse(await page.locator("#layout-json").innerText());
await page.screenshot({ path: join(OUT, "grid-after.png") });

console.log(`tile a: ${Math.round(beforeA)} -> ${Math.round(afterA)}px`);
console.log(`tile b (neighbour): ${Math.round(beforeB)} -> ${Math.round(afterB)}px`);
console.log("committed:", JSON.stringify(layout.widgets.find((w) => w.id === "a")));

await browser.close();
server.close();

const a = layout.widgets.find((w) => w.id === "a");
if (!(afterA > beforeA + 80)) {
  console.error("FAIL: dragging the corner down did not make the tile taller");
  process.exit(1);
}
if (a.rows === undefined || a.rows < 2) {
  console.error("FAIL: the taller height was not committed to the layout");
  process.exit(1);
}
if (layout.widgets.find((w) => w.id === "b").rows !== undefined) {
  console.error("FAIL: resizing one tile stamped a height onto its neighbour");
  process.exit(1);
}
console.log("PASS: vertical resize works under a real pointer");
