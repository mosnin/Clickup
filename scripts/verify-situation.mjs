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
//
// Two surfaces, one walk. The demo canvas is the controlled case: mixed tile
// heights, a known tile count, a layout readable as JSON. **Home is the real
// one** — six blocks at four heights inside the actual shell, with a sidebar
// taking width off the grid and a page taller than the viewport. A placement
// bug shows there and cannot show against four identical cards, which is
// exactly how this project shipped overlapping panels once already. Running the
// same assertions over both is the point: if the arrival needed anything from
// the demo page that Home cannot give it, that is a broken contract rather than
// Home being special.

import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { overlapsOn, spillsOn } from "./lib/tile-geometry.mjs";
import { CHROME } from "./lib/browser.mjs";

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
  executablePath: CHROME,
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
/** The Home block `?arrival=1` leaves off the screen for a condition to offer. */
const HOME_ARRIVING = "agents";
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

/**
 * Is the announcement actually readable?
 *
 * Not a style preference. `flex-wrap` only wraps an item that cannot shrink
 * further, so a text block with `min-w-0` beside a row of buttons never wraps —
 * it narrows until the sentence is a two-word-wide column, which is exactly
 * what shipped at 390px and exactly what no unit test can see. The number is
 * the honest floor: a condition stated in a strip narrower than this is not
 * being stated.
 */
async function bannerLegible(page, at) {
  const width = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("p")).find((n) =>
      n.textContent?.startsWith("Blocked tasks reached 3"),
    );
    return el ? Math.round(el.getBoundingClientRect().width) : -1;
  });
  if (width < 0) {
    failures.push(`${at}: the announcement's sentence is not on the page`);
  } else if (width < 200) {
    failures.push(
      `${at}: the announcement is ${width}px wide — the sentence is being ` +
        "crushed by the buttons beside it instead of them wrapping",
    );
  }
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
  await bannerLegible(page, `@${width}`);

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


/**
 * The same walk on the real Home.
 *
 * The assertions are the demo page's, minus the two it cannot make: Home has no
 * `#layout-json` (its arrangement lives in `userSettings`, written through a
 * stubbed mutation) and no write counter. What it has instead is the thing the
 * demo cannot give — a genuinely composed screen, in the shell, at a height
 * that scrolls. So the layout claims are made against the DOM: the arriving
 * block is drawn, everything already there is still drawn, exactly once, and no
 * box is painted over another.
 */
async function runHome(page, width) {
  const at = `home@${width}`;
  await page.goto("http://127.0.0.1:4601/home.html?arrival=1");
  await page.waitForTimeout(1800);

  const before = await tiles(page);
  if (before.length < 4) {
    failures.push(
      `${at}: Home drew ${before.length} blocks — everything below this is ` +
        "measuring a page that did not render",
    );
  }
  if (before.includes(HOME_ARRIVING)) {
    failures.push(`${at}: the block was on Home before anybody agreed to it`);
  }
  if ((await page.locator("text=Blocked tasks reached 3").count()) === 0) {
    failures.push(`${at}: nothing announced a condition that is true`);
  }
  await measure(page, `${at} announced`);
  await bannerLegible(page, at);
  await shoot(page, `situation-home-${width}-announced.png`);

  await page.getByRole("button", { name: "Preview" }).click();
  await page.waitForTimeout(800);
  const previewed = await tiles(page);
  if (!previewed.includes(HOME_ARRIVING)) {
    failures.push(`${at}: previewing did not put the block on Home`);
  }
  for (const id of before) {
    if (previewed.filter((t) => t === id).length !== 1) {
      failures.push(`${at}: ${id} was displaced when the block arrived`);
    }
  }
  await measure(page, `${at} previewing`);

  await page.getByRole("button", { name: "Keep" }).click();
  await page.waitForTimeout(900);
  const kept = await tiles(page);
  if (!kept.includes(HOME_ARRIVING)) {
    failures.push(`${at}: keeping it took the block off Home`);
  }
  if (await page.locator("text=Blocked tasks reached 3").count()) {
    failures.push(`${at}: the banner is still offering a block that is placed`);
  }
  for (const id of before) {
    if (kept.filter((t) => t === id).length !== 1) {
      failures.push(`${at}: ${id} was displaced when the block was kept`);
    }
  }
  await measure(page, `${at} kept`);

  await page.locator("#end-condition").click();
  await page.waitForTimeout(800);
  if (!(await tiles(page)).includes(HOME_ARRIVING)) {
    failures.push(`${at}: a kept block vanished when its condition lapsed`);
  }
  if ((await page.getByRole("button", { name: "Remove it" }).count()) === 0) {
    failures.push(`${at}: nothing told the reader the reason had expired`);
  }
  await measure(page, `${at} departed`);

  await shoot(page, `situation-home-${width}-departed.png`);
}

/**
 * Look at it.
 *
 * The dashboard's scroll container is the inset, not the document, so
 * `fullPage` expands nothing and a shot taken after a walk shows wherever the
 * page happened to be — which for the first run was the bottom, with the
 * banner the whole feature is about out of frame. Scrolling the real container
 * back to the top is what makes these pictures answer the question they are
 * taken to answer.
 */
async function shoot(page, name) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("*")) {
      if (el.scrollTop > 0) el.scrollTop = 0;
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(OUT, name) });
}

const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 } });
console.log("demo canvas, desktop");
await run(desktop, 1280);

// The same flow under a finger's viewport. One column, so the packer has to
// answer a different question with the same function — the split that made
// mobile its own bug surface last time.
const phone = await browser.newPage({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});
console.log("demo canvas, phone");
await run(phone, 390);

// ── The same walk, on Home ───────────────────────────────────────────────
console.log("home, desktop");
await runHome(
  await browser.newPage({ viewport: { width: 1280, height: 900 } }),
  1280,
);
console.log("home, phone");
await runHome(
  await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  }),
  390,
);

await browser.close();
server.close();

if (failures.length > 0) {
  console.error("FAIL:");
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(
  "PASS: on the demo canvas AND on Home, a panel arrives with consent, " +
    "displaces nothing at 1280 or 390, spills nothing, and stays when its " +
    "condition lapses",
);
