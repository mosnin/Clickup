// The nav must not come off in your hand.
//
// Reported as "if you click anything on the sidebar it gets disconnected and
// is moveable", which is a gesture bug, which means jsdom cannot see it: it
// has no pointer capture, no real event targeting, and no notion of a
// pointerup that lands somewhere other than where the pointerdown did.
//
// The mechanism being tested. Picking the nav up is a 650ms hold. Pointer
// capture is only taken once the hold SUCCEEDS, so during those 650ms the
// events are targeted normally — and if the release lands outside the
// container (a menu portal opening under the cursor, a row unmounting, the
// pointer leaving the rail) the container's own pointerup never fires. The
// timer then runs to completion and lifts a nav that nobody is holding,
// which from that moment follows the mouse with no way to put it down.
//
// So the assertion is not "dragging works". It is: after a press whose
// release the container never sees, moving the mouse must move nothing.

import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const OUT = "/tmp/design-gallery";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]));
  const file = join(OUT, path === "/" ? "index.html" : path);
  if (!file.startsWith(OUT) || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "text/plain" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(4601, r));

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto("http://127.0.0.1:4601/sidebar.html");
await page.waitForTimeout(900);

const RAIL = '[data-slot="sidebar-container"]';

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

// Is the nav currently displaced from where CSS puts it? A lifted nav writes
// a transform; an untouched one has none (or an identity one).
async function displacement() {
  return await page.$eval(RAIL, (el) => {
    const t = getComputedStyle(el).transform;
    if (!t || t === "none") return { x: 0, y: 0, scale: 1, engaged: false };
    const m = new DOMMatrixReadOnly(t);
    return {
      x: Math.round(m.m41),
      y: Math.round(m.m42),
      scale: Number(m.m11.toFixed(3)),
      engaged: el.dataset.navDragging === "true",
    };
  });
}

const rail = await page.locator(RAIL).boundingBox();
if (!rail) {
  console.error("sidebar container not found — harness did not render");
  process.exit(1);
}

// ── 1. The reported bug ────────────────────────────────────────────────
//
// Press inside the rail, then deliver the release somewhere the container
// cannot hear it, exactly as a portal opening under the cursor does. The
// press does NOT move, so the slop cancel never fires either — this is a
// click, not a drag.
const px = rail.x + rail.width / 2;
const py = rail.y + rail.height / 2;

await page.mouse.move(px, py);
await page.mouse.down();
// The release the container never sees. Dispatched on <body> so it does not
// bubble through the rail, which is what a portaled menu does for real.
await page.evaluate(() => {
  document.body.dispatchEvent(
    new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0 }),
  );
});
// Past the 650ms hold, so a surviving timer has fired by now.
await page.waitForTimeout(900);

const afterHold = await displacement();
check(
  "a press whose release was missed does not lift the nav",
  !afterHold.engaged,
  afterHold.engaged ? "nav is engaged with nothing held" : "not engaged",
);

// The part the person actually feels: does it now follow the mouse?
await page.mouse.move(px + 220, py + 90, { steps: 12 });
await page.waitForTimeout(120);
const afterMove = await displacement();
check(
  "the nav does not follow a pointer that is not pressed",
  Math.abs(afterMove.x) < 4 && Math.abs(afterMove.y) < 4,
  `displaced x=${afterMove.x} y=${afterMove.y}`,
);

// Release properly and confirm nothing was left behind.
await page.mouse.up();
await page.waitForTimeout(300);
const settled = await displacement();
check(
  "no stale transform is left on the nav",
  Math.abs(settled.x) < 4 && Math.abs(settled.y) < 4 && settled.scale > 0.99,
  `x=${settled.x} y=${settled.y} scale=${settled.scale}`,
);

// ── 2. Ordinary clicking still works ───────────────────────────────────
//
// The fix must not be "make the gesture impossible". A normal click on a nav
// row is press + release well inside 650ms and must leave the nav alone.
await page.mouse.move(px, rail.y + 120);
await page.mouse.down();
await page.waitForTimeout(80);
await page.mouse.up();
await page.waitForTimeout(200);
const afterClick = await displacement();
check(
  "a normal click leaves the nav where it is",
  !afterClick.engaged && Math.abs(afterClick.x) < 4,
  `engaged=${afterClick.engaged} x=${afterClick.x}`,
);

// ── 3. The deliberate gesture still engages ────────────────────────────
//
// A guard that also killed the feature would pass every check above.
//
// Escape first, and this is not housekeeping. The click above lands on the
// workspace switcher, which opens a Radix menu in a PORTAL that covers the
// rail — so the next press never reaches the container at all. That is the
// very mechanism this file exists to test, and leaving it open silently
// turns the check below into a test of nothing.
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
await page.mouse.move(px, py);
await page.mouse.down();
await page.waitForTimeout(820); // past HOLD_MS, without moving
const held = await displacement();
check(
  "holding still for 650ms does pick the nav up",
  held.engaged,
  held.engaged ? "engaged" : "never engaged — the gesture is gone",
);
await page.mouse.move(px + 160, py, { steps: 10 });
await page.waitForTimeout(120);
const dragged = await displacement();
check(
  "and it follows the hand while held",
  Math.abs(dragged.x) > 20,
  `displaced x=${dragged.x}`,
);
await page.mouse.up();
await page.waitForTimeout(400);

await browser.close();
server.close();

if (failures.length) {
  console.error(`\n${failures.length} failing:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nnav grab: all good");
