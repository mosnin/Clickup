// Build the Chat gallery and photograph it.
//
// The project's own harness (`scripts/build-gallery.mjs` + `design-shots.mjs`)
// is ground for the concurrent dynamic-UI build, so this is a second one that
// keeps its two load-bearing rules:
//
//   • The stylesheet is the app's own compiled CSS from `.next/static/css`.
//     A gallery styled by hand is a picture of a design system rather than the
//     design system, and it drifts the first time a token changes. Run
//     `npm run build` first.
//   • Shots go somewhere the build does not empty. Vite runs with
//     `emptyOutDir`, and shots written into the build output are deleted by
//     the next rebuild — which is how an audit ended up with three PNGs.
//
// Usage: node tests/ui/chat-gallery/shoot.mjs

import { build } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const OUT = "/tmp/chat-gallery";
const SHOTS = "/tmp/design-shots";
const PORT = 4601;

function appCss() {
  const dir = join(ROOT, ".next/static/css");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".css"));
  if (files.length === 0) return null;
  return files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}

const css = appCss();
if (css === null) {
  console.error(
    "No compiled CSS at .next/static/css — run `npm run build` first, or the\n" +
      "gallery will show you the shell without the design system.",
  );
  process.exit(1);
}

await build({
  root: HERE,
  base: "./",
  plugins: [react()],
  resolve: {
    // Order matters: Vite tries these in sequence, so anything more specific
    // than `@` has to come first or the broad prefix swallows it.
    alias: [
      {
        // The fourth module that needs a server. Typing never touches the
        // database — it rides Ably — so it is the one signal the Convex stub
        // cannot supply, and without this the typing band would be the only
        // surface in Chat nobody had ever looked at.
        find: "@/lib/use-ably-channel",
        replacement: join(HERE, "stubs/use-ably-channel.tsx"),
      },
      { find: "@convex", replacement: join(ROOT, "convex") },
      { find: "@/", replacement: join(ROOT, "src") + "/" },
      { find: "convex/react", replacement: join(HERE, "stubs/convex-react.tsx") },
      { find: "@clerk/nextjs", replacement: join(HERE, "stubs/clerk.tsx") },
      { find: "next/navigation", replacement: join(HERE, "stubs/next-navigation.ts") },
      { find: "next/link", replacement: join(HERE, "stubs/next-link.tsx") },
    ],
  },
  build: {
    outDir: OUT,
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    rollupOptions: { input: { chat: join(HERE, "chat.html") } },
  },
  logLevel: "warn",
});

const page = join(OUT, "chat.html");
writeFileSync(
  page,
  readFileSync(page, "utf8").replace("<!--APP_CSS-->", `<style>${css}</style>`),
);

mkdirSync(SHOTS, { recursive: true });
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
};

const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]));
  const file = join(OUT, path === "/" ? "chat.html" : path);
  if (!file.startsWith(OUT) || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "text/plain" });
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(PORT, resolve));

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});

const errors = [];
const base = `http://127.0.0.1:${PORT}/chat.html`;

/**
 * `context` is how a shot says it is a *phone* rather than a narrow window.
 *
 * `hasTouch` makes Chromium report `pointer: coarse`, which is the media query
 * the stylesheet uses to decide whether hover-revealed chrome exists at all.
 * Without it a 390px shot is a desktop with a small window, and every control
 * that appears on hover photographs as present when on a real phone it is not.
 */
async function shoot(view, name, url, prepare, context = {}) {
  const tab = await browser.newPage({
    viewport: view,
    deviceScaleFactor: 2,
    ...context,
  });
  tab.on("pageerror", (e) => errors.push(`${name}: ${e}`));
  await tab.goto(url);
  await tab.waitForTimeout(1200);
  if (prepare) await prepare(tab);
  await tab.screenshot({ path: join(SHOTS, `${name}-light.png`) });
  await tab.evaluate(() =>
    document.documentElement.setAttribute("data-theme", "dark"),
  );
  await tab.waitForTimeout(500);
  await tab.screenshot({ path: join(SHOTS, `${name}-dark.png`) });
  console.log(`shot ${name}-light.png / ${name}-dark.png`);

  // The pinned viewport, checked rather than assumed: if the document can
  // scroll, the composer walks off the bottom and the shell has failed at the
  // one thing it is for.
  const scrolls = await tab.evaluate(() => ({
    y: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    x: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  }));
  if (scrolls.y) errors.push(`${name}: the document scrolls vertically`);
  if (scrolls.x) errors.push(`${name}: the document scrolls horizontally`);
  await tab.close();
}

const desktop = { width: 1280, height: 860 };
const phone = { width: 390, height: 844 };

await shoot(desktop, "chat-room", base);
await shoot(desktop, "chat-home", `${base}?screen=home`);
await shoot(desktop, "chat-details", base, async (tab) => {
  await tab.getByRole("button", { name: "Room details" }).click();
  await tab.waitForTimeout(400);
});

// The transcript's own states. Hover and the open menu are shot with a real
// pointer rather than by forcing a class, because "does the toolbar appear
// where the eye already is" is the only question the shot answers.
await shoot(desktop, "chat-hover", base, async (tab) => {
  await tab.locator("[data-message-id]").last().hover();
  await tab.waitForTimeout(250);
});
// The touch equivalent: a tap focuses the row, which is what reveals the bar
// where there is no pointer. Photographed at 390px because that is the width
// the "always visible" reading of the spec fell over at.
await shoot(phone, "chat-tap-mobile", base, async (tab) => {
  await tab.locator("[data-message-id]").nth(2).focus();
  await tab.waitForTimeout(250);
});
await shoot(desktop, "chat-menu", base, async (tab) => {
  await tab.locator("[data-message-id]").last().hover();
  await tab.getByRole("button", { name: "More actions" }).last().click();
  await tab.waitForTimeout(300);
});
await shoot(desktop, "chat-thread", base, async (tab) => {
  await tab.locator("[data-thread-summary]").first().click();
  await tab.waitForTimeout(500);
});
await shoot(desktop, "chat-unread", `${base}?screen=unread`);
await shoot(desktop, "chat-empty", `${base}?screen=empty`);
await shoot(desktop, "chat-loading", `${base}?screen=loading`);

// Agents in the room (C6c). Four states, and the last one is an absence: a
// turn past the recovery window must leave NO working row behind, which is the
// difference between an honest indicator and a spinner that outlives the
// process it was about.
await shoot(desktop, "chat-agents", `${base}?screen=agents`);
await shoot(desktop, "chat-agents-activity", `${base}?screen=agents`, async (tab) => {
  await tab.locator("[data-activity-summary]").first().click();
  await tab.waitForTimeout(300);
});
// The picker, open: a blocked agent is OFFERED with its reason rather than
// filtered out, because an agent missing from a picker is indistinguishable
// from an agent that does not exist.
await shoot(desktop, "chat-agents-add", `${base}?screen=agents`, async (tab) => {
  await tab.getByRole("button", { name: "Add an agent" }).click();
  await tab.waitForTimeout(400);
});
await shoot(desktop, "chat-agents-silent", `${base}?screen=silent`);
await shoot(desktop, "chat-agents-stalled", `${base}?screen=stalled`);
await shoot(desktop, "chat-agents-dead", `${base}?screen=dead`);
await shoot(phone, "chat-agents-mobile", `${base}?screen=agents`);
await shoot(phone, "chat-agents-silent-mobile", `${base}?screen=silent`);

// The lease, checked rather than described: with `?screen=dead` the room holds
// a turn whose last frame is two minutes old, so the working line must not be
// in the document at all.
{
  const tab = await browser.newPage({ viewport: desktop, deviceScaleFactor: 2 });
  await tab.goto(`${base}?screen=dead`);
  await tab.waitForTimeout(1200);
  const rows = await tab.locator("[data-testid='agent-working-line']").count();
  if (rows > 0) {
    errors.push("lease: a turn past its lease still drew a working row");
  } else {
    console.log("lease: an expired turn drew no working row");
  }
  await tab.close();
}

// C13's wiring pass: the surfaces that were finished and had no call site.
//
// The question these answer is not "does each render" — every one of them has a
// unit test — but whether they compose, which is the only thing three bands
// under one transcript can fail at and the only thing a picture can settle.
await shoot(desktop, "chat-live", `${base}?screen=live`, async (tab) => {
  // The bar is drawn only while a call is up, so the shot joins one. With no
  // voice provider the session lands at `connected` and the bar says so on the
  // left — which is the steady state of this deployment, not an error.
  await tab.getByRole("button", { name: /Join huddle/ }).click();
  await tab.waitForTimeout(600);
});
await shoot(desktop, "chat-live-agents", `${base}?screen=live`, async (tab) => {
  await tab.getByRole("button", { name: "Agents" }).click();
  await tab.waitForTimeout(500);
});
await shoot(phone, "chat-live-mobile", `${base}?screen=live`, async (tab) => {
  await tab.getByRole("button", { name: /Join huddle/ }).click();
  await tab.waitForTimeout(600);
});
// The same band with no turn running: the line the person owns is the one
// drawn, in the same 20px the machine's line occupied.
await shoot(desktop, "chat-typing", `${base}?screen=typing`);

// Slot 8 and the 8b beside it, opened from the menu that now offers them.
await shoot(desktop, "chat-report", base, async (tab) => {
  await tab.locator("[data-message-id]").last().hover();
  await tab.getByRole("button", { name: "More actions" }).last().click();
  await tab.getByRole("menuitem", { name: "Report message" }).click();
  await tab.waitForTimeout(400);
});
await shoot(desktop, "chat-notify-why", base, async (tab) => {
  await tab.locator("[data-message-id]").last().hover();
  await tab.getByRole("button", { name: "More actions" }).last().click();
  await tab.getByRole("menuitem", { name: "Why this notified me" }).click();
  await tab.waitForTimeout(400);
});

// C14's wiring pass: the two surfaces that were finished and unmounted.
//
// The top chrome's control is addressed by its role rather than by its words —
// the sidebar also has a button whose name starts with "Search" (the one that
// dispatches ⌘K to the product's palette), and the whole point of this pass is
// that those two are different surfaces answering different questions.
const chatSearchButton = "[data-chat-top-chrome] button[aria-haspopup='dialog']";

// The pre-query state: the operator grammar, taught in words. This is the one
// thing the Chat dialog has that the palette cannot express, so it is the shot
// that says why there are two search surfaces rather than one.
await shoot(desktop, "chat-search", `${base}?screen=search`, async (tab) => {
  await tab.locator(chatSearchButton).click();
  await tab.waitForTimeout(400);
});
await shoot(desktop, "chat-search-results", `${base}?screen=search`, async (tab) => {
  await tab.locator(chatSearchButton).click();
  await tab.getByLabel("Search messages and channels").fill("green");
  // Past the 300 ms debounce, or the shot is of the skeleton.
  await tab.waitForTimeout(900);
});
// 390px is where a 40px strip holding a location line AND a control either
// works or does not, and where a 42rem dialog has to become a phone list.
await shoot(phone, "chat-search-mobile", `${base}?screen=search`, async (tab) => {
  await tab.locator(chatSearchButton).click();
  await tab.getByLabel("Search messages and channels").fill("green");
  await tab.waitForTimeout(900);
});

// The channel browser, which was the only way to find or create a room and had
// no call site at all — the sidebar's `+` was disabled.
await shoot(desktop, "chat-browser", base, async (tab) => {
  await tab.getByRole("button", { name: "Browse channels" }).click();
  await tab.waitForTimeout(400);
});
// Create mode, reached the way it is meant to be: type a name nothing carries
// and press Enter. If the create row were not keyboard index 0 this would open
// a channel instead, so the shot is also the check.
await shoot(desktop, "chat-browser-create", base, async (tab) => {
  await tab.getByRole("button", { name: "Browse channels" }).click();
  await tab.getByLabel("Search channels").fill("Release Notes");
  await tab.getByLabel("Search channels").press("Enter");
  await tab.waitForTimeout(400);
});
await shoot(phone, "chat-browser-mobile", base, async (tab) => {
  // Below `md` the sidebar is a drawer, so the `+` is behind it.
  await tab.getByRole("button", { name: "Show navigation" }).click();
  await tab.waitForTimeout(400);
  await tab.getByRole("button", { name: "Browse channels" }).click();
  await tab.waitForTimeout(400);
});
// The reachability shot, and the reason it emulates touch: the `+` is
// hover-revealed, and on a phone there is no hover — so a rule that only
// exists under a mouse would leave the only way to find or create a room
// unreachable on the device most people carry. Photographed *closed*, over
// the drawer, because the question is whether you can see it to press it.
await shoot(
  phone,
  "chat-nav-touch-mobile",
  base,
  async (tab) => {
    await tab.getByRole("button", { name: "Show navigation" }).click();
    await tab.waitForTimeout(500);
    const shown = await tab
      .getByRole("button", { name: "Browse channels" })
      .evaluate((el) => Number(getComputedStyle(el).opacity));
    if (!(shown > 0)) {
      errors.push("touch: the Browse channels + is invisible on a phone");
    } else {
      console.log(`touch: the Browse channels + is visible (opacity ${shown})`);
    }
  },
  { hasTouch: true, isMobile: true },
);

// `/chat/settings`, which did not exist.
await shoot(desktop, "chat-settings", `${base}?screen=settings`);
await shoot(desktop, "chat-settings-presence", `${base}?screen=settings`, async (tab) => {
  await tab.getByRole("tab", { name: "Presence" }).click();
  await tab.waitForTimeout(300);
});
await shoot(phone, "chat-settings-mobile", `${base}?screen=settings`);

// The band's own rule, checked rather than described: a machine at work and a
// person typing must never draw two lines, because they are the same sentence
// about two kinds of colleague and the transcript has to sit still.
{
  const tab = await browser.newPage({ viewport: desktop, deviceScaleFactor: 2 });
  tab.on("pageerror", (e) => errors.push(`band: ${e}`));
  await tab.goto(`${base}?screen=live`);
  await tab.waitForTimeout(1500);
  const agent = await tab.locator("[data-testid='agent-working-line']").count();
  const typing = await tab.locator("[data-testid='message-typing-indicator']").count();
  if (agent !== 1) errors.push(`band: expected one working line, saw ${agent}`);
  if (typing !== 0) {
    errors.push("band: a typing line was drawn beside the working line");
  } else {
    console.log("band: one line under the transcript, not two");
  }
  await tab.close();
}

await shoot(phone, "chat-room-mobile", base);
await shoot(phone, "chat-nav-mobile", base, async (tab) => {
  await tab.getByRole("button", { name: "Show navigation" }).click();
  await tab.waitForTimeout(400);
});
await shoot(phone, "chat-details-mobile", base, async (tab) => {
  await tab.getByRole("button", { name: "Room details" }).click();
  await tab.waitForTimeout(400);
});
// The thread as a SHEET, not a squeezed column — the one thing that has to be
// looked at rather than asserted.
await shoot(phone, "chat-thread-mobile", base, async (tab) => {
  await tab.locator("[data-thread-summary]").first().click();
  await tab.waitForTimeout(500);
});

// Virtualization, watched rather than asserted in jsdom (which lays nothing
// out, so every window is the whole list there and the check is vacuous).
{
  const tab = await browser.newPage({ viewport: desktop, deviceScaleFactor: 2 });
  tab.on("pageerror", (e) => errors.push(`virtualization: ${e}`));
  await tab.goto(`${base}?screen=long`);
  await tab.waitForTimeout(1500);
  const mounted = await tab.locator("[data-message-id]").count();
  if (mounted === 0) errors.push("virtualization: nothing rendered at all");
  if (mounted >= 400) {
    errors.push(`virtualization: all ${mounted} rows are mounted — not windowing`);
  }
  // …and scrolling up must mount rows that were not there before, or the
  // window is stuck rather than moving.
  const firstBefore = await tab
    .locator("[data-message-id]")
    .first()
    .getAttribute("data-message-id");
  await tab.evaluate(() => {
    const el = document.querySelector("[data-transcript-scroller]");
    if (el) el.scrollTop = 0;
  });
  await tab.waitForTimeout(800);
  const firstAfter = await tab
    .locator("[data-message-id]")
    .first()
    .getAttribute("data-message-id");
  if (firstBefore === firstAfter) {
    errors.push("virtualization: scrolling to the top did not change the window");
  }
  const afterCount = await tab.locator("[data-message-id]").count();
  console.log(
    `virtualization: ${mounted} of 400 rows mounted at the bottom, ${afterCount} at the top`,
  );
  await tab.screenshot({ path: join(SHOTS, "chat-long-light.png") });
  await tab.close();
}

await browser.close();
server.close();

if (errors.length > 0) {
  console.error("\nThe Chat gallery reported problems:");
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}
