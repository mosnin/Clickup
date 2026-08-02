// A panel arrives, and displaces nothing.
//
// The property this exists for is the one the whole feature is not allowed to
// break: a panel that shows up because a condition became true must never land
// on top of what somebody already has. Placement goes through `pack`, which
// proves non-overlap by construction — but this codebase has shipped
// overlapping panels once already behind a green suite that proved things about
// a model nothing rendered from, and shipped content spilling out of boxes
// whose geometry was correct. So the claim is checked against what a real
// browser painted, at a desktop width and at a phone width, before AND after
// the panel is kept.
//
// It also drives the consent path with a real pointer, because that is the part
// that decides whether the panel is on the screen at all: announce, preview,
// keep. And it ends the condition, which is where the departure decision lives
// — a kept panel is the reader's, so it must still be there.

import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { overlapsOn, spillsOn } from "./lib/tile-geometry.mjs";

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

const ARRIVING = "custom:blocked-now";
/**
 * What the fixture starts with.
 *
 * Asserted rather than assumed, because "zero overlaps" is trivially true of a
 * blank page — a harness that reports a screen clean because it never rendered
 * is the exact shape of the gates this codebase has already been burned by.
 */
const BASE_TILES = 5;
const failures = [];

const tiles = (p) =>
  p.$$eval("[data-tile]", (els) => els.map((e) => e.dataset.tile));
const layoutIds = async (p) =>
  JSON.parse(await p.locator("#layout-json").innerText()).widgets.map((w) => w.id);
const writes = async (p) => Number(await p.locator("#write-count").innerText());

/**
 * Measure the page and record anything painted over anything.
 *
 * Run at every step rather than once at the end: "no overlap after the whole
 * flow" would pass while the preview overlapped for as long as somebody was
 * looking at it, which is exactly when a reader is deciding whether to keep it.
 */
async function measure(p, at) {
  const overlap = await overlapsOn(p);
  const spill = await spillsOn(p);
  console.log(`  ${at}: overlap ${overlap.length}, spill ${spill.length}`);
  for (const h of overlap) failures.push(`${at}: ${h}`);
  for (const h of spill) failures.push(`${at}: ${h}`);
}

/** The whole consent path, at one viewport. */
async function run(page, width) {
  await page.goto("http://127.0.0.1:4601/situation.html");
  await page.waitForTimeout(1200);

  const before = await tiles(page);
  if (before.length !== BASE_TILES) {
    failures.push(
      `@${width}: the canvas drew ${before.length} tiles, not ${BASE_TILES} — ` +
        "everything below this is measuring a page that did not render",
    );
  }
  if (before.includes(ARRIVING)) {
    failures.push(`@${width}: the panel was on the canvas before anybody agreed to it`);
  }
  await measure(page, `@${width} announced`);

  // The announcement names the CONDITION. A banner that named the panel would
  // be telling the reader about the interface instead of about their work.
  const banner = await page.locator("text=Blocked tasks reached 3").count();
  if (banner === 0) {
    failures.push(`@${width}: nothing announced a condition that is true`);
  }

  // ── Preview: the panel goes on the real canvas, and writes nothing ──
  const writesBefore = await writes(page);
  await page.getByRole("button", { name: "Preview" }).click();
  await page.waitForTimeout(700);
  const previewed = await tiles(page);
  if (previewed.length !== BASE_TILES + 1) {
    failures.push(
      `@${width}: previewing left ${previewed.length} tiles on a canvas that ` +
        `should hold ${BASE_TILES + 1}`,
    );
  }
  if (!previewed.includes(ARRIVING)) {
    failures.push(`@${width}: previewing did not put the panel on the canvas`);
  }
  if ((await layoutIds(page)).includes(ARRIVING)) {
    failures.push(`@${width}: previewing wrote the panel into the layout`);
  }
  if ((await writes(page)) !== writesBefore) {
    failures.push(`@${width}: previewing cost a write — looking is not consenting`);
  }
  // Every tile that was there before is still there, and still exactly one of
  // each: an arriving panel that "fits" by evicting a neighbour is the failure
  // wearing a tidier face than an overlap.
  for (const id of before) {
    if (previewed.filter((t) => t === id).length !== 1) {
      failures.push(`@${width}: ${id} was displaced when the panel arrived`);
    }
  }
  await measure(page, `@${width} previewing`);

  // ── Keep: placed for real, in this reader's own layout ──
  await page.getByRole("button", { name: "Keep" }).click();
  await page.waitForTimeout(900);
  const kept = await tiles(page);
  if (kept.length !== BASE_TILES + 1) {
    failures.push(
      `@${width}: keeping it left ${kept.length} tiles, not ${BASE_TILES + 1} — ` +
        "a panel that fits by evicting a neighbour is the failure with a tidier face",
    );
  }
  if (!kept.includes(ARRIVING)) {
    failures.push(`@${width}: keeping it took the panel off the canvas`);
  }
  if (!(await layoutIds(page)).includes(ARRIVING)) {
    failures.push(`@${width}: keeping it never reached the layout`);
  }
  if (await page.locator("text=Blocked tasks reached 3").count()) {
    failures.push(`@${width}: the banner is still offering a panel that is now placed`);
  }
  for (const id of before) {
    if (kept.filter((t) => t === id).length !== 1) {
      failures.push(`@${width}: ${id} was displaced when the panel was kept`);
    }
  }
  await measure(page, `@${width} kept`);

  // ── The condition lapses ──
  //
  // The departure decision, checked rather than asserted in a comment: a panel
  // the reader kept is theirs and stays. Removing it would be the screen
  // editing itself, which is the adaptive UI this codebase refuses — and it is
  // no less adaptive for being a removal.
  await page.locator("#end-condition").click();
  await page.waitForTimeout(700);
  if (!(await tiles(page)).includes(ARRIVING)) {
    failures.push(`@${width}: a kept panel vanished when its condition lapsed`);
  }
  if (!(await layoutIds(page)).includes(ARRIVING)) {
    failures.push(`@${width}: a kept panel was removed from the layout by itself`);
  }
  if ((await page.getByRole("button", { name: "Remove it" }).count()) === 0) {
    failures.push(`@${width}: nothing told the reader the reason had expired`);
  }
  await measure(page, `@${width} departed`);

  await page.screenshot({ path: join(OUT, `situation-${width}.png`), fullPage: true });
}

const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 } });
console.log("desktop");
await run(desktop, 1280);

// The same flow under a finger's viewport. One column, so the packer has to
// answer a different question with the same function — the split that made
// mobile its own bug surface last time.
const phone = await browser.newPage({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});
console.log("phone");
await run(phone, 390);

await browser.close();
server.close();

if (failures.length > 0) {
  console.error("FAIL:");
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(
  "PASS: a panel arrives with consent, displaces nothing at 1280 or 390, " +
    "spills nothing, and stays when its condition lapses",
);
