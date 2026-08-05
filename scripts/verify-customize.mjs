// Does pressing Customise actually let you customise anything?
//
// The report was "the customize popup doesn't actually let you customize
// anything", and every studio test in the repo agreed with the code instead of
// with the person: they assert the control renders, mount the sheet directly,
// and never once perform the sequence a human performs — press Customise,
// click a panel, and see whether a control appeared. So the failure lived in
// the gap between two green tests. Pressing Customise drew a black pill; the
// pill's caption changed when a panel was clicked; every actual control was
// behind an unlabelled chevron on it.
//
// This drives that sequence in a real browser, which is the only place it can
// be driven: the sheet's open state lives in a vendored expandable-screen
// component whose animation jsdom does not run, so a jsdom assertion about
// "is the sheet open" is an assertion about a component that never rendered.
//
// Run `npm run gallery` first — this reads the same built bundle the
// screenshots do, so it can never pass against a build somebody made three
// changes ago.
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const OUT = "/tmp/design-gallery";
if (!existsSync(join(OUT, "home.html"))) {
  console.error("No gallery at /tmp/design-gallery — run `npm run gallery`.");
  process.exit(1);
}
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
const port = await new Promise((r) =>
  server.listen(0, () => r(server.address().port)),
);

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

const results = [];
const check = (ok, msg) => {
  results.push({ ok, msg });
  console.log(`${ok ? "  ok  " : " FAIL "} ${msg}`);
};

await page.goto(`http://127.0.0.1:${port}/home.html?studio=1`);
await page.waitForTimeout(3500);

// 1. The mode marks the document, and the canvas offers things to click.
const customizing = await page.evaluate(
  () => document.documentElement.dataset.customizing === "true",
);
check(customizing, "customise mode is on");
const targets = await page.$$("[data-customize-id]");
check(targets.length > 0, `${targets.length} panels are selectable`);

// 2. Clicking one selects it AND opens the controls.
//
// The second half is the whole point. Selection used to relabel a lozenge,
// which is indistinguishable from nothing happening.
// Deliberately not the first tile: on Home that is the stat ROW, which is
// four cards rather than one and so carries no surface of its own. Pick a
// panel that draws a card, because "does a pick reach the card" is the check.
const target =
  (await page.$("[data-customize-id]:has([data-row-divider])")) ?? targets[0];
await target.click({ force: true });
await page.waitForTimeout(900);

const chapters = await page.$$eval("[data-studio-chapter]", (els) =>
  els.map((e) => e.textContent.trim()).filter(Boolean),
);
check(
  chapters.length >= 4,
  `clicking a panel opens the controls: ${JSON.stringify(chapters)}`,
);

// 3. There is something to pick, drawn rather than named.
const specimens = await page.$$("[data-item-id]");
check(specimens.length > 0, `${specimens.length} specimens to choose from`);

// 4. A pick lands on the PAGE, not only on the sheet.
//
// The property that makes this a customiser rather than a form: the thing
// being edited is behind the sheet and changes under you.
// The SURFACE inside the selected tile — the element that carries the
// resolved frame, fill, corner and padding. Both kinds of panel emit
// `data-row-divider` from that element (see StyledSurface), so this finds it
// without a test-only attribute to keep in agreement with anything.
const surfaceOf = () => {
  const tile = document.querySelector("[data-customize-selected]") ??
    document.querySelector("[data-customize-id]");
  const el = tile?.querySelector("[data-row-divider]") ?? tile;
  if (!el) return "none";
  const cs = getComputedStyle(el);
  return `${cs.borderRadius}|${cs.backgroundColor}|${cs.boxShadow}|${cs.padding}`;
};
const panelBefore = await page.evaluate(surfaceOf);
// The "Card" chapter is the one whose effect is visible on any panel whatever
// it draws — colour only shows on a panel with marks in it.
const cardTab = await page.$("[data-studio-chapter='cards']");
if (cardTab) {
  await cardTab.click();
  await page.waitForTimeout(700);
}
const picks = await page.$$("[data-item-id]");
let landed = false;
for (const pick of picks.slice(0, 6)) {
  await pick.click({ force: true }).catch(() => {});
  await page.waitForTimeout(650);
  const after = await page.evaluate(surfaceOf);
  if (after !== panelBefore) {
    landed = true;
    break;
  }
}
check(
  landed,
  `a pick changes the panel behind the sheet (was ${panelBefore})`,
);

await page.screenshot({ path: "/tmp/verify-customize.png" });
check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors[0]}` : ""}`);

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\n${failed.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed. Shot at /tmp/verify-customize.png");
