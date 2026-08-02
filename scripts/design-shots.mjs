// Screenshot the design gallery.
//
// This exists because of a failure in how this project was worked on: the
// charts and panels were verified by tests for weeks and never once looked at.
// jsdom can tell you an `<svg>` has eleven `<rect>`s. It cannot tell you the
// bars overlap, the palette is garish, or the whole thing looks cheap — which
// are the only questions that matter about a chart.
//
// Served over HTTP rather than opened as a file, because the gallery is a real
// module bundle now and `file://` refuses to load one.
//
// The dark shot flips `data-theme` on the root, which is the app's own
// mechanism — a bare `.dark` class is a different design system's, and using
// it is how the previous harness reported a dark mode nobody was rendering.

import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { extname, join, normalize } from "node:path";

// Where the BUILD lives, and where SHOTS live — deliberately two directories.
// `build-gallery.mjs` runs Vite with `emptyOutDir`, so writing shots into the
// build output meant every rebuild deleted the audit's own evidence. Asked for
// an audit after a rebuild, the harness had three PNGs left.
const OUT = "/tmp/design-gallery";
const SHOTS = "/tmp/design-shots";
mkdirSync(SHOTS, { recursive: true });
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
};

if (!existsSync(join(OUT, "index.html"))) {
  console.error("No gallery built. Run `npm run gallery`.");
  process.exit(1);
}

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
await new Promise((resolve) => server.listen(4599, resolve));

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({
  viewport: { width: 1180, height: 1400 },
  deviceScaleFactor: 2,
});

const errors = [];
const overflows = [];
page.on("pageerror", (e) => errors.push(String(e)));

for (const [url, name] of [
  ["http://127.0.0.1:4599/", "charts"],
  ["http://127.0.0.1:4599/sidebar.html", "sidebar"],
  ["http://127.0.0.1:4599/labels.html", "labels"],
]) {
  await page.goto(url);
  // Long enough for the entrance animations to land — anything caught
  // mid-reveal looks broken in a still, which is a false alarm every time.
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(SHOTS, `${name}-light.png`), fullPage: true });
  console.log(`shot ${name}-light.png`);

  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  });
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(SHOTS, `${name}-dark.png`), fullPage: true });
  console.log(`shot ${name}-dark.png`);

  await page.evaluate(() => {
    document.documentElement.removeAttribute("data-theme");
  });

  // The sidebar's highlight is one element that moves, positioned against a
  // scroll container. Whether it lands on the row under the cursor is not
  // something a static render can answer, so hover one and shoot it.
  if (name === "sidebar") {
    await page.getByText("In review").hover();
    await page.waitForTimeout(500);
    await page.screenshot({
      path: join(SHOTS, "sidebar-hover.png"),
      clip: { x: 0, y: 600, width: 400, height: 500 },
    });
    console.log("shot sidebar-hover.png");

    // The island, then the screen it morphs into. A state that is never
    // opened is a state that ships broken.
    const island = await page
      .locator("#style-island")
      .boundingBox()
      .catch(() => null);
    if (island) {
      await page.screenshot({
        path: join(SHOTS, "studio-island.png"),
        clip: {
          x: Math.max(island.x - 120, 0),
          y: Math.max(island.y - 60, 0),
          width: island.width + 280,
          height: island.height + 120,
        },
      });
      console.log("shot studio-island.png");
      await page.locator("#style-island button").first().click();
      await page.waitForTimeout(1600);
    }
    await page.screenshot({ path: join(SHOTS, "studio-screen.png") });
    console.log("shot studio-screen.png");
    // The theme check that was skipped is the theme bug that shipped: the
    // studio in dark mode, which must render dark.
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(SHOTS, "studio-screen-dark.png") });
    console.log("shot studio-screen-dark.png");
    await page.evaluate(() => {
      document.documentElement.removeAttribute("data-theme");
    });

    // The Card chapter, which is the one that shipped eight indistinguishable
    // cards — a chapter never opened is a chapter nobody checked.
    await page.getByRole("tab", { name: "Card", exact: true }).click();
    await page.waitForTimeout(1600);
    await page.screenshot({ path: join(SHOTS, "studio-cards.png") });
    console.log("shot studio-cards.png");
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(SHOTS, "studio-cards-dark.png") });
    console.log("shot studio-cards-dark.png");
    await page.evaluate(() => {
      document.documentElement.removeAttribute("data-theme");
    });

    // The builder chapter — both steps, because a step never opened is a
    // step that ships broken.
    await page.getByRole("tab", { name: "New card" }).click();
    await page.waitForTimeout(1800);
    await page.screenshot({ path: join(SHOTS, "builder-watch.png") });
    console.log("shot builder-watch.png");
    await page.locator('[data-item-id]').first().click();
    await page.waitForTimeout(1800);
    await page.screenshot({ path: join(SHOTS, "builder-shape.png") });
    console.log("shot builder-shape.png");
  }
}

// ── Home: the screen people actually open ────────────────────────────────
//
// Shot at both widths and both themes, because every regression this harness
// was built after was found on a phone by the person using the product, not
// here. Home is not a specimen sheet — it is the real page inside the real
// shell — so it needs its own capture: the dashboard pins itself to the
// viewport and scrolls INSIDE the inset, which means `fullPage` returns one
// screenful and silently drops everything below it. A shot that quietly loses
// half the page is worse than no shot, so grow the window to the content and
// then shoot.
async function shootHome(width, label) {
  const p = await browser.newPage({
    viewport: { width, height: 900 },
    deviceScaleFactor: 2,
  });
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto("http://127.0.0.1:4599/home.html");
  await p.waitForTimeout(2500);
  const h = await p.evaluate(() => {
    const el = document.querySelector('[data-slot="sidebar-inset"]');
    return Math.ceil(el ? el.scrollHeight : document.body.scrollHeight);
  });
  const height = Math.max(h + 32, 900);
  if (height > 8000) {
    errors.push(`home.html at ${width}px is ${h}px tall — taller than the shot`);
  }
  await p.setViewportSize({ width, height: Math.min(height, 8000) });
  // Re-measure work (the grid packs against its own width) plus the entrance
  // animations, which look broken in a still if caught mid-reveal.
  await p.waitForTimeout(1600);
  await p.screenshot({ path: join(SHOTS, `home-${label}-light.png`) });
  console.log(`shot home-${label}-light.png`);

  await p.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  });
  await p.waitForTimeout(800);
  await p.screenshot({ path: join(SHOTS, `home-${label}-dark.png`) });
  console.log(`shot home-${label}-dark.png`);
  await p.close();
}

await shootHome(1180, "desktop");
await shootHome(390, "mobile");

// ── The mobile pass. Never taken before this audit, which is exactly how a
// 340px card shipped onto a 390px screen unseen. Every phase re-runs this.
const mobile = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
});
mobile.on("pageerror", (e) => errors.push(String(e)));

await mobile.goto("http://127.0.0.1:4599/sidebar.html");
await mobile.waitForTimeout(2000);
const mIsland = await mobile
  .locator("#style-island")
  .boundingBox()
  .catch(() => null);
if (mIsland) {
  await mobile.screenshot({
    path: join(SHOTS, "studio-island-mobile.png"),
    clip: {
      x: 0,
      y: Math.max(mIsland.y - 40, 0),
      width: 390,
      height: mIsland.height + 90,
    },
  });
  console.log("shot studio-island-mobile.png");
  await mobile.locator("#style-island button").first().click();
  await mobile.waitForTimeout(1600);
  await mobile.screenshot({ path: join(SHOTS, "studio-screen-mobile.png") });
  console.log("shot studio-screen-mobile.png");
  await mobile.getByRole("tab", { name: "New card" }).click();
  await mobile.waitForTimeout(1800);
  await mobile.screenshot({ path: join(SHOTS, "builder-watch-mobile.png") });
  console.log("shot builder-watch-mobile.png");
}

await mobile.goto("http://127.0.0.1:4599/labels.html");
await mobile.waitForTimeout(1500);
await mobile.screenshot({ path: join(SHOTS, "labels-mobile.png"), fullPage: true });
console.log("shot labels-mobile.png");

await mobile.goto("http://127.0.0.1:4599/grid.html");
await mobile.waitForTimeout(1500);
await mobile.screenshot({ path: join(SHOTS, "grid-mobile.png"), fullPage: true });
console.log("shot grid-mobile.png");

// ── Nothing may be wider than the phone ──
//
// The single check that would have caught the worst harness bug in this
// project: the grid fixture printed its layout JSON on one unwrapped line,
// which forced the page to 646px, so every shot taken at "390px" was a
// desktop layout wearing a phone's viewport — and every mobile conclusion
// drawn from those shots was worthless. A shot that silently lies is more
// expensive than no shot.
for (const page of ["sidebar.html", "labels.html", "grid.html", "home.html"]) {
  await mobile.goto(`http://127.0.0.1:4599/${page}`);
  await mobile.waitForTimeout(900);
  const over = await mobile.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    widest: Array.from(document.querySelectorAll("body *"))
      .map((el) => ({ w: el.getBoundingClientRect().width, t: el.tagName }))
      .sort((a, b) => b.w - a.w)[0],
  }));
  if (over.scroll > over.client + 1) {
    overflows.push(
      `${page}: page is ${over.scroll}px wide in a ${over.client}px viewport ` +
        `(widest element ${over.widest?.t} at ${Math.round(over.widest?.w)}px)`,
    );
  }
}

await browser.close();
server.close();

if (overflows.length > 0) {
  console.error("\nHorizontal overflow at 390px — these shots cannot be trusted:");
  for (const o of overflows) console.error("  " + o);
  process.exit(1);
}

if (errors.length > 0) {
  // A page that threw rendered something, and the something is not what
  // shipped. Failing loudly beats a screenshot that quietly lost a section.
  console.error("\nThe gallery threw while rendering:");
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}
