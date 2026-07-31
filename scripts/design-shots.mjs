// Screenshot the design gallery.
//
// This exists because of a failure in how this project was worked on: the
// charts and panels were verified by tests for weeks and never once looked at.
// jsdom can tell you an `<svg>` has eleven `<rect>`s. It cannot tell you the
// bars overlap, the palette is garish, or the whole thing looks cheap — which
// are the only questions that matter about a chart.
//
// `npm run gallery` renders every chart, palette and preset with the app's
// real compiled CSS and shoots it here. Look at the PNGs before shipping
// anything visual.

import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1180, height: 1400 }, deviceScaleFactor: 2 });
for (const [file, out] of [["charts.html","charts-light.png"],["charts-dark.html","charts-dark.png"]]) {
  await page.goto(`file:///tmp/design-gallery/${file}`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `/tmp/design-gallery/${out}`, fullPage: true });
  console.log("shot", out);
}
await browser.close();
