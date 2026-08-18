// Regenerate the marketing site's product screenshots from the gallery's
// seeded fixture workspace — the scripted demo the Monday Review demanded.
//
//   npm run build && node scripts/build-gallery.mjs && node scripts/marketing-screens.mjs
//
// Why this exists: production shipped a scratch-account capture ("Test —
// 0 of 1 task", every stat zero, a retired design) as the homepage hero and
// showcase. A demo is a performance; this script is the rehearsal. It renders
// the REAL app (gallery fixtures = real components + seeded data), captures at
// the exact ratios the marketing slots declare, and overwrites the PNGs in
// public/screenshots/. Re-run it after any rebrand so the marketing site can
// never drift behind the product again.
//
// Each shot waits for the arm/entrance animations to settle so counters show
// their real values, then captures at deviceScaleFactor 2.

import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const GALLERY = "/tmp/design-gallery";
const OUT = join(ROOT, "public", "screenshots");
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

if (!existsSync(join(GALLERY, "home.html"))) {
  console.error("gallery not built — run: node scripts/build-gallery.mjs");
  process.exit(1);
}

const server = createServer((req, res) => {
  const path = normalize(
    join(GALLERY, decodeURIComponent(new URL(req.url, "http://x").pathname)),
  );
  if (!path.startsWith(GALLERY) || !existsSync(path)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, {
    "content-type": MIME[extname(path)] ?? "application/octet-stream",
  });
  res.end(readFileSync(path));
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

// name → { page, viewport (CSS px; PNG is 2x), theme }
// Ratios match the ScreenshotFrame declarations at the call sites — check
// src/app/(marketing)/ before changing one.
const SHOTS = [
  // Hero: 3014x1554 → 1507x777. The working-morning Home, dark (the
  // marketing site frames its product shots on the dark canvas).
  { name: "hero-dashboard", page: "home.html?hero=1", w: 1507, h: 777, theme: "dark" },
  // Showcase: 2498x1534 → 1249x767. The projects directory, mid-flight.
  { name: "home-showcase", page: "projects.html", w: 1249, h: 767, theme: "dark" },
];

const browser = await chromium.launch({ executablePath: CHROME });
for (const shot of SHOTS) {
  const page = await browser.newPage({
    viewport: { width: shot.w, height: shot.h },
    deviceScaleFactor: 2,
  });
  await page.goto(`http://127.0.0.1:${port}/${shot.page}`, {
    waitUntil: "networkidle",
  });
  if (shot.theme === "dark") {
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
  }
  // Let arm-on-view counters roll up and entrances settle.
  await page.waitForTimeout(3200);
  await page.screenshot({ path: join(OUT, `${shot.name}.png`) });
  console.log("shot", `${shot.name}.png`, `${shot.w * 2}x${shot.h * 2}`);
  await page.close();
}
await browser.close();
server.close();
