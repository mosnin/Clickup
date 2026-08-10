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
    // Software rasterisation, explicitly. This page is unusually expensive to
    // paint — stacked blurred glass layers, canvas fills, blurred PNG masks —
    // and with the default GPU path headless Chromium never hands back a frame,
    // so every screenshot times out with no error to explain it.
    args: ["--disable-gpu", "--use-gl=swiftshader", "--disable-dev-shm-usage"],
  });

  const errors = [];

  // Chromium does not get to open its own sockets here.
  //
  // The agent sandbox routes egress through a CONNECT-only proxy and has no
  // direct DNS, and Chromium honours neither escape: with the proxy it tunnels
  // 127.0.0.1 and gets a 405 error page back, and every way of turning the proxy
  // off (--no-proxy-server, --proxy-server=direct://, a PAC returning DIRECT,
  // --proxy-bypass-list) ends in ERR_NAME_NOT_RESOLVED — for an IP literal,
  // which is the tell that the network stack is not usable at all rather than
  // merely misconfigured.
  //
  // So Node does the fetching and the page is fulfilled from memory. Node's
  // built-in fetch ignores the proxy env unless asked, so it reaches loopback
  // directly. Anything not on our own origin is aborted rather than fetched:
  // this is a screenshot of OUR page, and a third-party widget that fails to
  // load is a truer picture of a slow network than one this script went out of
  // its way to help.
  async function serveFromNode(page) {
    // A predicate, not a `"**/*"` glob — the glob does not match a bare-origin
    // navigation like `http://127.0.0.1:4610/`, so the first request escapes
    // interception and the whole page falls back to the network.
    await page.route(() => true, async (route) => {
      const url = route.request().url();
      if (!url.startsWith(BASE)) {
        await route.abort();
        return;
      }
      // No service worker in the harness. It is not what these shots are
      // checking, and a worker that installs on the first load then serves the
      // reload from its own precache puts a second cache between the build on
      // disk and the pixels being judged.
      if (url === `${BASE}/sw.js`) {
        await route.fulfill({ status: 404, body: "" });
        return;
      }
      try {
        const req = route.request();
        // Only `accept` is forwarded, deliberately.
        //
        // Forwarding the browser's full header set makes Clerk's middleware
        // recognise a real browser with no dev-browser cookie and answer the
        // navigation with a 307 handshake to the Clerk domain, which does not
        // resolve here — so the page under test never loads. This script shoots
        // the LOGGED-OUT marketing site, where a plain client request is not a
        // workaround but the accurate case.
        //
        // (`host` would also make undici throw outright, and a route handler
        // that throws does not fail loudly: Playwright lets the request
        // continue to the network, so the symptom is a proxy error that looks
        // nothing like the actual bug.)
        const res = await fetch(url, {
          method: req.method(),
          headers: { accept: "*/*" },
          body: req.postDataBuffer() ?? undefined,
        });
        const out = Object.fromEntries(res.headers.entries());
        // fetch already decoded the body; leaving these on makes Chromium try
        // to decode it a second time and render nothing.
        delete out["content-encoding"];
        delete out["content-length"];
        await route.fulfill({
          status: res.status,
          headers: out,
          body: Buffer.from(await res.arrayBuffer()),
        });
      } catch (e) {
        errors.push(`route ${url}: ${String(e)}`);
        // Fulfil rather than abort, and never rethrow: a handler that throws
        // is the one failure mode this whole block exists to avoid.
        await route.fulfill({ status: 502, body: "" }).catch(() => {});
      }
    });
  }

  // "Is the stylesheet actually applied?"
  //
  // Not paranoia: with a placeholder Clerk key the script cannot load, Clerk's
  // timeout handler reloads the page, and a capture taken in the moment after
  // that reload is a picture of unstyled HTML — serif text, visible probe
  // elements, no layout. It looks like a catastrophic CSS bug and is entirely
  // an artefact of the harness, which is the worst kind of false alarm.
  const waitForStyled = (page) =>
    page.waitForFunction(() => {
      const el = document.querySelector("[data-canvas-card]");
      return !!el && getComputedStyle(el).position === "relative";
    });

  for (const [label, width, height] of [
    ["desktop", 1440, 1000],
    ["mobile", 390, 844],
  ]) {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 2,
    });
    page.on("pageerror", (e) => errors.push(`${label}: ${String(e)}`));
    // Generous: a full-page shot of this page is a very large, very blurry
    // raster, and the default 30s is not enough on a software rasteriser.
    page.setDefaultTimeout(120_000);
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`${label} console: ${m.text()}`);
    });
    await serveFromNode(page);

    // `domcontentloaded`, not `networkidle`: the page embeds third-party
    // widgets whose requests are aborted here, and a retrying widget means the
    // network is never idle — the wait below is what actually matters anyway.
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await waitForStyled(page);
    await page.evaluate(() => document.fonts.ready).catch(() => {});
    // The animated pieces run on rAF and reveal on scroll — give them real
    // time to start rather than catching frame zero, which is a picture of
    // nothing having happened yet.
    await page.waitForTimeout(2500);

    await page.screenshot({
      path: `${OUT}/home-${label}-top.png`,
      fullPage: false,
    });

    // Each animated piece on its own, in document order. The full-page shot is
    // too tall to read a 300px card in, and these are the only elements on the
    // page whose correctness cannot be inferred from source.
    //
    // Every step re-resolves the locator and retries once. Running against a
    // placeholder Clerk key, Clerk's script cannot load and its timeout handler
    // reloads the page part-way through — which detaches whatever element was
    // being captured, and (worse) the retry-less version silently captured a
    // half-loaded page with no stylesheet applied and called it a screenshot.
    const total = await page.locator("[data-canvas-card]").count();
    let shot = 0;
    for (let i = 0; i < total; i++) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await waitForStyled(page);
          const card = page.locator("[data-canvas-card]").nth(i);
          await card.waitFor({ state: "visible" });
          await card.scrollIntoViewIfNeeded();
          await page.waitForTimeout(1400);
          await card.screenshot({ path: `${OUT}/card-${label}-${i}.png` });
          shot++;
          break;
        } catch (e) {
          if (attempt === 1) errors.push(`${label} card ${i}: ${String(e)}`);
          else await page.waitForLoadState("domcontentloaded").catch(() => {});
        }
      }
    }
    console.log(`shot ${shot}/${total} card(s) at ${label}`);


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
