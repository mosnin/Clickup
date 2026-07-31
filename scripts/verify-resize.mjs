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

const writeCount = async () =>
  Number(await page.locator("#write-count").innerText());
const order = async () =>
  page.$$eval("[data-tile]", (els) => els.map((e) => e.dataset.tile));

const beforeA = await height("a");
const beforeB = await height("b");
await page.screenshot({ path: join(OUT, "grid-before.png") });

// A real drag on tile A's grip: down, pull 260px south, release.
const grip = page.getByLabel(/^Resize Today/);
const box = await grip.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
const writesBeforeResize = await writeCount();
await page.mouse.down();
// Sampled every step: a resize that follows the finger changes height on
// almost every frame. The old one rounded to whole rows and only repainted on
// a threshold crossing, so this list held two or three distinct values and the
// tile jumped ~170px at a time — the reported "choppy, then snaps".
const heights = [];
for (let i = 1; i <= 13; i++) {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + i * 20);
  await page.waitForTimeout(16);
  heights.push(Math.round(await height("a")));
}
await page.mouse.up();
await page.waitForTimeout(800);
const steps = new Set(heights).size;
const writesDuringResize = (await writeCount()) - writesBeforeResize;
console.log(`resize: ${steps} distinct heights over 13 moves`, heights.join(","));
console.log(`resize writes: ${writesDuringResize}`);

const afterA = await height("a");
const afterB = await height("b");
const layout = JSON.parse(await page.locator("#layout-json").innerText());
await page.screenshot({ path: join(OUT, "grid-after.png") });

console.log(`tile a: ${Math.round(beforeA)} -> ${Math.round(afterA)}px`);
console.log(`tile b (neighbour): ${Math.round(beforeB)} -> ${Math.round(afterB)}px`);
console.log("committed:", JSON.stringify(layout.widgets.find((w) => w.id === "a")));

// ── The reorder, which is the gesture that was fighting itself ──
const beforeOrder = await order();
const writesBeforeDrag = await writeCount();
const from = await tile("a").boundingBox();
const to = await tile("d").boundingBox();
await page.mouse.move(from.x + from.width / 2, from.y + 40);
await page.mouse.down();
for (let i = 1; i <= 20; i++) {
  await page.mouse.move(
    from.x + from.width / 2 + ((to.x - from.x) * i) / 20,
    from.y + 40 + ((to.y - from.y) * i) / 20,
  );
  await page.waitForTimeout(16);
}
await page.mouse.up();
await page.waitForTimeout(900);
const afterOrder = await order();
const settledOrder = await (async () => {
  // Look again after another beat: "saves out of place then glitches in" is a
  // late write landing, so a single reading right after the drop cannot see it.
  await page.waitForTimeout(700);
  return order();
})();
const writesDuringDrag = (await writeCount()) - writesBeforeDrag;
console.log(`order: ${beforeOrder.join(",")} -> ${afterOrder.join(",")}`);
console.log(`order after settling: ${settledOrder.join(",")}`);
console.log(`drag writes: ${writesDuringDrag}`);

// ── The same gesture under a finger ──
//
// Touch is a different event path from mouse, and this grid is used from an
// installed PWA where there is no mouse at all. What is asserted here is what
// this harness can honestly see: that a touch actually starts a drag, that the
// tile moves under the finger, and that the gesture still costs exactly one
// write. It deliberately does NOT assert a reorder — the gallery page is not
// width-constrained, so its tiles stay desktop-width at a phone viewport and a
// vertical drag never enters a neighbour's box. Asserting a reorder here would
// be a test that passes or fails on the harness's own layout rather than on
// the app, which is the kind of test that reports a gesture fixed while it is
// broken.
const phone = await browser.newPage({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});
await phone.goto("http://127.0.0.1:4599/grid.html");
await phone.waitForTimeout(1200);
const phoneWrites = async () =>
  Number(await phone.locator("#write-count").innerText());
const wBefore = await phoneWrites();
const first = await phone.locator('[data-tile="a"]').boundingBox();
const cdp = await phone.context().newCDPSession(phone);
await cdp.send("Input.dispatchTouchEvent", {
  type: "touchStart",
  touchPoints: [{ x: first.x + first.width / 2, y: first.y + 40 }],
});
let touchDragging = false;
let moved = 0;
for (let i = 1; i <= 12; i++) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: first.x + first.width / 2, y: first.y + 40 + i * 30 }],
  });
  await phone.waitForTimeout(24);
  const state = await phone.evaluate(() => {
    const el = document.querySelector('[data-tile="a"]');
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return { dragging: document.documentElement.dataset.tileDragging === "true", y: m.f };
  });
  if (state.dragging) touchDragging = true;
  moved = Math.max(moved, Math.abs(state.y));
}
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await phone.waitForTimeout(700);
const phoneWriteCount = (await phoneWrites()) - wBefore;
const stranded = await phone.evaluate(
  () => document.documentElement.dataset.tileDragging ?? null,
);
console.log(
  `touch: drag started ${touchDragging}, tile moved ${Math.round(moved)}px, ` +
    `writes ${phoneWriteCount}, stranded ${stranded}`,
);
await phone.screenshot({ path: join(OUT, "grid-phone-after.png") });

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
if (steps < 8) {
  console.error(
    `FAIL: the resize moved in ${steps} jumps over 13 pointer moves — it is ` +
      "quantising to whole cells during the gesture instead of following the pointer",
  );
  process.exit(1);
}
if (writesDuringResize !== 1) {
  console.error(`FAIL: one resize gesture produced ${writesDuringResize} writes`);
  process.exit(1);
}
if (writesDuringDrag !== 1) {
  console.error(
    `FAIL: one reorder gesture produced ${writesDuringDrag} writes — mid-drag ` +
      "writes race each other and rebuild the draggable under the finger",
  );
  process.exit(1);
}
if (afterOrder.join(",") !== settledOrder.join(",")) {
  console.error(
    `FAIL: the arrangement changed after the drop (${afterOrder.join(",")} -> ` +
      `${settledOrder.join(",")}) — that is the "saves out of place then glitches in"`,
  );
  process.exit(1);
}
if (!touchDragging) {
  console.error("FAIL: a touch never started a drag — the grid is mouse-only");
  process.exit(1);
}
if (moved < 100) {
  console.error(`FAIL: the tile moved ${Math.round(moved)}px under a finger`);
  process.exit(1);
}
if (phoneWriteCount > 1) {
  console.error(`FAIL: one touch drag produced ${phoneWriteCount} writes`);
  process.exit(1);
}
if (stranded !== null) {
  console.error(
    "FAIL: the document is still flagged as dragging after touchend — " +
      "scrolling stays suppressed and the edge-scroll loop is still running",
  );
  process.exit(1);
}
console.log("PASS: resize follows the pointer, and one gesture is one write");
