// Screenshot the marketing site in a real browser.
//
// The dashboard has had a gallery for months; the logged-out site — the only
// page most people will ever see — has had nothing, so every claim about it
// has been a claim about source code. These five animated pieces cannot be
// checked any other way: a canvas that paints the wrong thing, a scrim that
// leaves footer links unreadable over saturated yellow, a morphing card whose
// radius snaps at the end of its transition, all typecheck perfectly.
//
// Serves the production build (`next start`) rather than dev, because dev's
// double-render and unminified CSS are not what ships.
//
// Usage: npm run build && node scripts/marketing-shots.mjs
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const OUT = "/tmp/marketing-shots";
const PORT = 4610;
const BASE = `http://127.0.0.1:${PORT}`;

mkdirSync(OUT, { recursive: true });

const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, NODE_ENV: "production" },
});

let serverLog = "";
server.stdout.on("data", (d) => (serverLog += String(d)));
server.stderr.on("data", (d) => (serverLog += String(d)));

/** Wait for the server to answer rather than sleeping a guessed interval. */
async function waitForServer(timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(BASE, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error(`next start never answered on ${PORT}:\n${serverLog}`);
}

try {
  await waitForServer();

  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  });

  const errors = [];

  for (const [label, width, height] of [
    ["desktop", 1440, 1000],
    ["mobile", 390, 844],
  ]) {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 2,
    });
    page.on("pageerror", (e) => errors.push(`${label}: ${String(e)}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`${label} console: ${m.text()}`);
    });

    await page.goto(BASE, { waitUntil: "networkidle" });
    // The animated pieces run on rAF and reveal on scroll — give them real
    // time to start rather than catching frame zero, which is a picture of
    // nothing having happened yet.
    await page.waitForTimeout(2500);

    await page.screenshot({
      path: `${OUT}/home-${label}-top.png`,
      fullPage: false,
    });

    // Walk the page so every scroll-revealed section actually reveals, then
    // shoot the whole thing.
    await page.evaluate(async () => {
      const step = window.innerHeight * 0.8;
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 260));
      }
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((r) => setTimeout(r, 900));
    });
    await page.screenshot({ path: `${OUT}/home-${label}-footer.png` });

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1200);
    await page.screenshot({
      path: `${OUT}/home-${label}-full.png`,
      fullPage: true,
    });
    console.log(`shot home-${label}-{top,footer,full}.png`);
    await page.close();
  }

  await browser.close();

  if (errors.length > 0) {
    console.error("\nPage errors:");
    for (const e of errors.slice(0, 12)) console.error(`  ${e}`);
    process.exitCode = 1;
  } else {
    console.log("\nNo page errors.");
  }
} finally {
  server.kill("SIGTERM");
}
