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
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const OUT = "/tmp/design-gallery";
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
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto("http://127.0.0.1:4599/");
// Long enough for the entrance animations to land — a chart caught mid-reveal
// looks broken in a still, which is a false alarm every single time.
await page.waitForTimeout(2500);
await page.screenshot({ path: join(OUT, "charts-light.png"), fullPage: true });
console.log("shot charts-light.png");

await page.evaluate(() => {
  document.documentElement.setAttribute("data-theme", "dark");
});
await page.waitForTimeout(600);
await page.screenshot({ path: join(OUT, "charts-dark.png"), fullPage: true });
console.log("shot charts-dark.png");

await browser.close();
server.close();

if (errors.length > 0) {
  // A page that threw rendered something, and the something is not what
  // shipped. Failing loudly beats a screenshot that quietly lost a section.
  console.error("\nThe gallery threw while rendering:");
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}
