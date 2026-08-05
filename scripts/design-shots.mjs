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
  // The vendored typefaces — without these the shot renders in a fallback face.
  ".woff2": "font/woff2",
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
async function shootHome(width, label, query = "") {
  const p = await browser.newPage({
    viewport: { width, height: 900 },
    deviceScaleFactor: 2,
  });
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(`http://127.0.0.1:4599/home.html${query}`);
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

// ── The shelf that turns a built-in into your own card ───────────────────
//
// The chart chapter has two states and only one of them had ever been
// photographed. Pointed at a stored panel it edits a definition; pointed at a
// BUILT-IN it offers to mint one — and that second state needs a screen
// offering its built-ins, which the sidebar page (where every studio shot came
// from) does not have. So the state that shipped was the unseen one, at both
// widths and in both themes.
//
// Driven by real clicks through the app's own path — select the tile, open the
// island, choose the chapter — because the question is whether a person can
// reach it, not whether the component renders when handed props.
async function shootMintShelf(width, label) {
  const p = await browser.newPage({
    viewport: { width, height: width < 500 ? 844 : 1000 },
    deviceScaleFactor: 2,
  });
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto("http://127.0.0.1:4599/home.html?studio=1");
  await p.waitForTimeout(2200);

  // Clicking the tile IS the scope selector — the delegated capture-phase
  // handler in customize-provider turns it into a selection, and a selection
  // now OPENS the sheet rather than relabelling a lozenge (see OpenOnSelect).
  // So the island is legitimately gone by the time this looks, and what it
  // checks instead is that the sheet arrived naming the right panel.
  await p.locator('[data-tile="activity"]').click({ position: { x: 40, y: 30 } });
  await p.waitForTimeout(1400);
  const sheet = await p.locator("[data-studio]").first().innerText();
  if (!/recent activity/i.test(sheet)) {
    errors.push(
      `mint shelf at ${width}px: clicking the tile did not open the studio on ` +
        `it (sheet reads "${sheet.slice(0, 120).trim()}")`,
    );
  }

  await p.getByRole("tab", { name: "Chart", exact: true }).click();
  await p.waitForTimeout(1800);

  // A shelf of chart shapes is the whole point; a paragraph reading "this
  // panel is built in, so its shape is fixed" is the inert control this
  // change exists to remove, and a screenshot of it would look fine.
  const shapes = await p.locator("[data-item-id]").count();
  if (shapes === 0) {
    errors.push(`mint shelf at ${width}px: no shapes offered for a built-in`);
  }

  // Can the pick actually be pressed?
  //
  // This shelf is the one that does NOT apply on scroll — a shape change
  // rewrites a definition, so it asks for a press — which makes "Use <shape>"
  // the only pointer path to the whole feature. Counting shapes says the shelf
  // rendered; it says nothing about whether the button is on screen or under
  // something, and a screenshot of a covered button looks fine.
  const commit = await p.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((b) =>
      /^Use /.test(b.textContent ?? ""),
    );
    if (!button) return { found: false };
    const r = button.getBoundingClientRect();
    const over = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      found: true,
      label: button.textContent,
      belowFold: r.bottom > window.innerHeight,
      covered: over !== button && !button.contains(over),
      coveredBy: over ? `${over.tagName}` : null,
    };
  });
  if (!commit.found) {
    errors.push(`mint shelf at ${width}px: no way to commit a shape`);
  } else if (commit.covered || commit.belowFold) {
    errors.push(
      `mint shelf at ${width}px: "${commit.label}" is ` +
        (commit.belowFold ? "below the fold" : `covered by <${commit.coveredBy}>`) +
        " — the studio's middle section is `flex-1 justify-center`, so a " +
        "chapter taller than its slot overflows past the bottom and the " +
        "footer paints over it. Only this shelf is tall enough, because it " +
        "is the only one carrying a commit row (applyOnCentre={false}). " +
        "Fix lives in src/components/appearance/style-studio.tsx.",
    );
  }

  await p.screenshot({ path: join(SHOTS, `mint-shelf-${label}-light.png`) });
  console.log(`shot mint-shelf-${label}-light.png (${shapes} shapes)`);

  await p.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  });
  await p.waitForTimeout(900);
  await p.screenshot({ path: join(SHOTS, `mint-shelf-${label}-dark.png`) });
  console.log(`shot mint-shelf-${label}-dark.png`);
  await p.close();
}

// ── Saying when a panel should be here ───────────────────────────────────
//
// The studio's newest chapter, and the one with the most to get wrong on a
// phone: two steps, a shelf of live readings, then a row of three drawn
// comparisons plus a stepper plus a sentence plus a commit — all inside a
// ~58svh sheet. Every one of those is a candidate for the failure this harness
// exists to catch, which is a control that renders below the sheet's own edge
// and looks fine in a screenshot nobody took.
//
// Driven through the app's own path — select a tile, open the island, choose
// the chapter — because the question is whether a person can reach it.
async function shootOnlyWhen(width, label) {
  const p = await browser.newPage({
    viewport: { width, height: width < 500 ? 844 : 1000 },
    deviceScaleFactor: 2,
  });
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto("http://127.0.0.1:4599/home.html?studio=1");
  await p.waitForTimeout(2200);
  // Selecting a tile opens the sheet on it — there is no island step any more.
  await p.locator('[data-tile="activity"]').click({ position: { x: 40, y: 30 } });
  await p.waitForTimeout(1400);
  await p.getByRole("tab", { name: "Only when…" }).click();
  await p.waitForTimeout(1800);

  // Step one: a shelf of questions, the panel's own first. A chapter that
  // renders "tap a card" here would mean the selection never reached it.
  const questions = await p.locator("[data-item-id]").count();
  if (questions === 0) {
    errors.push(`only-when at ${width}px: no questions offered for a panel`);
  }
  await p.screenshot({ path: join(SHOTS, `only-when-question-${label}-light.png`) });
  console.log(`shot only-when-question-${label}-light.png (${questions} questions)`);

  await p.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  });
  await p.waitForTimeout(800);
  await p.screenshot({ path: join(SHOTS, `only-when-question-${label}-dark.png`) });
  console.log(`shot only-when-question-${label}-dark.png`);
  await p.evaluate(() => {
    document.documentElement.removeAttribute("data-theme");
  });

  // Step two. The commit is the whole feature, so it is checked the way the
  // mint shelf's is: on screen, and not painted over by the sheet's footer.
  await p.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((b) =>
      /^Use /.test(b.textContent ?? ""),
    );
    button?.click();
  });
  await p.waitForTimeout(1400);
  const commit = await p.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "Only show it then",
    );
    if (!button) return { found: false };
    const r = button.getBoundingClientRect();
    const over = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      found: true,
      belowFold: r.bottom > window.innerHeight,
      covered: over !== button && !button.contains(over),
      coveredBy: over ? over.tagName : null,
    };
  });
  if (!commit.found) {
    errors.push(`only-when at ${width}px: no way to commit a condition`);
  } else if (commit.covered || commit.belowFold) {
    errors.push(
      `only-when at ${width}px: "Only show it then" is ` +
        (commit.belowFold
          ? "below the fold"
          : `covered by <${commit.coveredBy}>`) +
        " — the sheet's middle section scrolls, but a commit you have to go " +
        "looking for is the failure this studio already shipped once. Fix " +
        "lives in src/components/appearance/style-studio.tsx.",
    );
  }
  await p.screenshot({ path: join(SHOTS, `only-when-when-${label}-light.png`) });
  console.log(`shot only-when-when-${label}-light.png`);

  await p.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  });
  await p.waitForTimeout(800);
  await p.screenshot({ path: join(SHOTS, `only-when-when-${label}-dark.png`) });
  console.log(`shot only-when-when-${label}-dark.png`);
  await p.close();
}

/**
 * The list of conditions, in the arrange tray.
 *
 * The surface with the strongest claim on a photograph: you go looking for it
 * precisely when the panel it governs is NOT on screen, so if it renders badly
 * there is no other way to turn a condition off. `?situations=1` gives this
 * reader two of them — one true, one not.
 */
async function shootOnlyWhenList(width, label) {
  const p = await browser.newPage({
    viewport: { width, height: width < 500 ? 844 : 1000 },
    deviceScaleFactor: 2,
  });
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto("http://127.0.0.1:4599/home.html?situations=1");
  await p.waitForTimeout(2000);
  // Through the page's own switch — the tray only exists while arranging.
  await p.getByRole("button", { name: "Customize", exact: true }).click();
  await p.waitForTimeout(900);
  const list = p.getByText("Only here sometimes");
  await list.scrollIntoViewIfNeeded().catch(() => {});
  await p.waitForTimeout(600);
  if ((await list.count()) === 0) {
    errors.push(`only-when list at ${width}px: the tray does not show it`);
  }
  await p.screenshot({ path: join(SHOTS, `only-when-list-${label}-light.png`) });
  console.log(`shot only-when-list-${label}-light.png`);

  await p.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  });
  await p.waitForTimeout(800);
  await p.screenshot({ path: join(SHOTS, `only-when-list-${label}-dark.png`) });
  console.log(`shot only-when-list-${label}-dark.png`);
  await p.close();
}

await shootHome(1180, "desktop");
await shootHome(390, "mobile");
await shootMintShelf(1180, "desktop");
await shootMintShelf(390, "mobile");
await shootOnlyWhen(1180, "desktop");
await shootOnlyWhen(390, "mobile");
await shootOnlyWhenList(390, "mobile");
await shootOnlyWhenList(1180, "desktop");
// The same page with nothing customised — the Home every account starts on,
// and the one it is easiest to never look at because the fixture author had
// to go out of their way to produce it.
await shootHome(1180, "desktop-plain", "?plain=1");
await shootHome(390, "mobile-plain", "?plain=1");

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
for (const page of [
  "sidebar.html",
  "labels.html",
  "grid.html",
  "home.html",
  // The studio open over Home: a full-width sheet of cards inside a 390px
  // phone is exactly the shape that overflows, and it had never been measured.
  "home.html?studio=1",
]) {
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
