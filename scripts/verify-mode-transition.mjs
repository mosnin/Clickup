// Does the Work ⇄ Chat transition actually animate, and in the right direction?
//
//   node scripts/verify-mode-transition.mjs
//
// jsdom cannot answer this. It has no View Transitions API at all, so a unit
// test of the hook would assert that a mock got called — which proves the code
// I wrote is the code I wrote, and nothing about whether a browser does
// anything with it. The failure mode this guards is specific and silent: a
// `view-transition-name` that never matches, or a `:root[data-mode-dir]`
// selector that does not reach the pseudo-elements, produces no error and no
// animation. The switch just cuts, exactly as it did before the feature
// existed, and looks like "the browser doesn't support it".
//
// So this drives real Chromium and reads `document.getAnimations()` *during*
// the transition, which is the only place the browser will tell you what it
// actually decided to run.
//
// **What this harness does not prove.** It runs the real CSS — read out of
// globals.css rather than retyped, so the two cannot drift — against a
// two-shell fixture, not against /dashboard and /chat, because signing in to
// Clerk is not possible in this environment. It proves the mechanism: names
// match, direction drives the keyframes, reduced motion suppresses it. It does
// not prove the two real shells tag the right boxes; that is checked
// statically at the bottom, by grepping for the attributes.

import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { CHROME } from "./lib/browser.mjs";

let failures = 0;
const note = (ok, label, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
};

// The real rules, lifted from the real stylesheet. Retyping them here is how a
// harness ends up passing against CSS the app does not ship.
const css = readFileSync("src/app/globals.css", "utf8");
const start = css.indexOf("/* ── Work ⇄ Chat transition");
const end = css.indexOf("/* ── Mobile sidebar drawer", start);
if (start === -1 || end === -1) {
  console.error("Could not find the Work ⇄ Chat block in globals.css");
  process.exit(1);
}
const block = css.slice(start, end);

// A fixture with the same shape as the two shells: a nav box and a content box,
// swapped by replacing their contents. Same attributes, same names.
const page = `<!doctype html><html><head><style>
  * { margin: 0; box-sizing: border-box; }
  body { font: 14px system-ui; }
  .app { display: flex; height: 100vh; }
  [data-mode-surface="nav"] { width: 240px; background: #eee; padding: 12px; }
  [data-mode-surface="content"] { flex: 1; padding: 12px; }
  ${block}
</style></head><body>
  <div class="app">
    <div data-mode-surface="nav" id="nav">Work nav</div>
    <div data-mode-surface="content" id="content">Work content</div>
  </div>
  <script>
    window.__ran = null;
    window.switchTo = function (mode) {
      const dir = mode === "chat" ? "to-chat" : "to-work";
      const root = document.documentElement;
      root.dataset.modeDir = dir;
      root.style.setProperty("--mode-transition-ms", "320ms");
      const t = document.startViewTransition(function () {
        document.getElementById("nav").textContent = mode + " nav";
        document.getElementById("content").textContent = mode + " content";
      });
      // Read what the browser decided while it is mid-flight. After .finished
      // the pseudo-elements are gone and there is nothing left to inspect.
      t.ready.then(function () {
        window.__ran = document.getAnimations().map(function (a) {
          const pseudo = a.effect && a.effect.pseudoElement;
          return {
            pseudo: pseudo || null,
            name: a.animationName || (a.effect && a.effect.getKeyframes && "keyframes") || null,
            duration: a.effect ? a.effect.getTiming().duration : null,
          };
        });
      });
      return t.finished.then(function () {
        root.removeAttribute("data-mode-dir");
      }, function () {});
    };
  </script>
</body></html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(page);
});
await new Promise((r) => server.listen(4601, r));

const browser = await chromium.launch({
  executablePath: CHROME,
});

// ── 1. Support, and the animations the browser actually runs ──────────────
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const p = await ctx.newPage();
await p.goto("http://127.0.0.1:4601");

const supported = await p.evaluate(() => typeof document.startViewTransition === "function");
note(supported, "Chromium exposes startViewTransition", supported ? "" : "harness cannot test");

if (supported) {
  await p.evaluate(() => window.switchTo("chat"));
  const toChat = await p.evaluate(() => window.__ran);

  const names = (toChat ?? []).map((a) => a.name).filter(Boolean);
  const pseudos = (toChat ?? []).map((a) => a.pseudo).filter(Boolean);

  note(
    (toChat ?? []).length > 0,
    "a view transition actually ran",
    `${(toChat ?? []).length} animations`,
  );
  note(
    pseudos.some((x) => x.includes("mode-content")),
    "the content box was pulled out of the root snapshot",
    pseudos.join(" ") || "no named pseudo-elements",
  );
  note(
    pseudos.some((x) => x.includes("mode-nav")),
    "the nav box was pulled out of the root snapshot",
  );
  // The direction is the whole point: going to Chat, the old content leaves
  // left and the new arrives from the right.
  note(
    names.includes("mode-exit-left") && names.includes("mode-enter-right"),
    "to-chat runs the leftward exit and the rightward entry",
    names.join(" ") || "no keyframe names",
  );

  // ── 2. And the reverse actually reverses ────────────────────────────────
  await p.evaluate(() => window.switchTo("work"));
  const toWork = await p.evaluate(() => window.__ran);
  const backNames = (toWork ?? []).map((a) => a.name).filter(Boolean);
  note(
    backNames.includes("mode-exit-right") && backNames.includes("mode-enter-left"),
    "to-work runs the mirrored pair",
    backNames.join(" ") || "no keyframe names",
  );

  // ── 3. The duration is the one the hook set, not a browser default ──────
  const durations = (toWork ?? [])
    .map((a) => a.duration)
    .filter((d) => typeof d === "number" && d > 0);
  note(
    durations.length > 0 && durations.every((d) => d === 320),
    "every animation honours --mode-transition-ms",
    durations.join(",") || "none measured",
  );
}

// ── 4. Reduced motion suppresses it ───────────────────────────────────────
// The hook returns early under reduced motion so this should never be reached
// in the app; the CSS guard exists for the caller who forgets, and a guard
// nobody tests is a guard that quietly stops working.
const reducedCtx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  reducedMotion: "reduce",
});
const rp = await reducedCtx.newPage();
await rp.goto("http://127.0.0.1:4601");
await rp.evaluate(() => window.switchTo("chat"));
const reduced = await rp.evaluate(() => window.__ran);
const reducedRunning = (reduced ?? []).filter(
  (a) => typeof a.duration === "number" && a.duration > 0,
);
note(
  reducedRunning.length === 0,
  "reduced motion runs no timed transition animation",
  `${reducedRunning.length} still animating`,
);

await browser.close();
server.close();

// ── 5. The real shells tag the real boxes ─────────────────────────────────
// Static, because the dynamic half cannot reach an authenticated route here.
// Each of these is a file that must carry the attribute for the mechanism
// above to have anything to match in the actual product.
const tagged = [
  ["src/components/dashboard/sidebar.tsx", 'data-mode-surface="nav"', "Work nav"],
  ["src/app/dashboard/layout.tsx", 'data-mode-surface="content"', "Work content"],
  ["src/components/chat/shell/chat-shell.tsx", 'data-mode-surface="nav"', "Chat nav"],
  ["src/components/chat/shell/chat-shell.tsx", 'data-mode-surface="content"', "Chat content"],
];
for (const [file, needle, label] of tagged) {
  note(readFileSync(file, "utf8").includes(needle), `${label} is tagged`, file);
}

// Both halves must exist on both sides, or the browser has nothing to morph
// and silently falls back to cross-fading the viewport.
const switcher = readFileSync("src/components/chat/mode-switcher.tsx", "utf8");
note(
  switcher.includes("useModeTransition") && switcher.split("onModeClick").length >= 3,
  "both switcher forms (segmented + rail) call the transition",
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
