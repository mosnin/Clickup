// One command. One verdict. No uncalibrated greens.
//
//   node scripts/audit.mjs                 (needs `npm run gallery` first)
//   node scripts/audit.mjs --only=home     one surface, while iterating
//   node scripts/audit.mjs --fail-on=high  exit non-zero on real defects
//
// The whole point of this file is a rule it enforces mechanically rather than
// asks for: **a run that has not demonstrated its own gates firing on broken
// fixtures does not emit a result.** Not a worse result — no result. It prints
// `VERDICT: unknown` and exits non-zero, because "an audit whose instrument
// was never checked" and "an audit that found nothing" produce the same green
// text, and this project has already shipped a defect through that gap. There
// is no flag to skip calibration; it is step one of every invocation.
//
// Three artefacts come out, in `/tmp/audit`:
//
//   findings.json   machine-readable: calibration, coverage, caps, findings
//   FINDINGS.md     the same thing, ranked, for a person
//   crops/          native-resolution PNGs — one per finding, one per element
//   context/        full-page shots at 1x, explicitly NOT evidence
//
// That last distinction is the reason this exists. A full-page shot of a
// 2360x5158 screen is downscaled to ~830px by everything that reads it, which
// turns 10px text into a 3px smear — so it can show you that a page exists and
// it cannot show you anything about the page. It is kept, and it is labelled,
// and no finding is ever cited from one.

import { chromium } from "playwright-core";
import { createServer } from "node:http";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { extname, join, normalize } from "node:path";
import { GATES, SEVERITY_ORDER, ceilingFor, collectFindings } from "./audit-gates.mjs";
import { overlapsOn, spillsOn } from "./lib/tile-geometry.mjs";
import { SURFACES, measureLiveBehind } from "./audit-surfaces.mjs";
import {
  measureResize,
  measureReorder,
  gestureFindings,
} from "./audit-gesture.mjs";

const GALLERY = "/tmp/design-gallery";
const OUT = "/tmp/audit";
const PORT = 4617;
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith("--only=")) || "").slice(7);
const failOn = (args.find((a) => a.startsWith("--fail-on=")) || "").slice(10);

// The widest a crop may be in CSS pixels. At deviceScaleFactor 2 this lands at
// 1360 device px, under the point where a reader downscales it. Anything wider
// is tiled, with overlap, because a defect straddling a tile seam is a defect
// nobody sees.
const TILE = 680;
const VIEWPORTS = [
  { width: 1280, height: 900, label: "1280", coarse: false },
  { width: 390, height: 844, label: "390", coarse: true },
];
const THEMES = ["light", "dark"];

if (!existsSync(join(GALLERY, "index.html"))) {
  console.error("No gallery built. Run `npm run gallery` first.");
  process.exit(1);
}
if (!existsSync(join(GALLERY, "broken.html"))) {
  console.error(
    "The gallery has no calibration page. Rebuild it (`npm run gallery`) — " +
      "an audit cannot run without one.",
  );
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "crops"), { recursive: true });
mkdirSync(join(OUT, "context"), { recursive: true });

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
};
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]));
  // A 404 for a favicon nobody asked for is a console error, and a console
  // error is how this runner decides a surface rendered something other than
  // what ships. Answering it keeps the error channel meaning what it says.
  if (path === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }
  const file = join(GALLERY, path === "/" ? "index.html" : path);
  if (!file.startsWith(GALLERY) || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "text/plain" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, r));
const base = `http://127.0.0.1:${PORT}/`;

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--no-sandbox"],
});

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 46) || "x";

/** A page set up the way every measurement in this file expects one. */
async function openPage(url, viewport, theme, settle = 2600) {
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
    // Touch emulation is what makes `@media (pointer: coarse)` match, which is
    // what makes `.tap-target`'s hit area exist at all. A tap-target reading
    // taken with a mouse is a reading of a different page — and the proof that
    // this is on is in the calibration: the 30px `.tap-target` control stays
    // quiet, which it could only do if its `::after` were being applied.
    hasTouch: viewport.coarse,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 400)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon/.test(m.text())) {
      errors.push("console: " + m.text().slice(0, 400));
    }
  });
  await page.goto(base + url);
  if (theme === "dark") {
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
  }
  // Long enough for the entrance animations to land. Anything caught
  // mid-reveal looks broken in a still, which is a false alarm every time.
  await page.waitForTimeout(settle);
  return { page, errors };
}

async function gate(page, viewport) {
  return page.evaluate(collectFindings, {
    coarse: viewport.coarse,
    viewport: viewport.width,
    ignore: [],
  });
}

/** A native-resolution crop of one element, tiled if it is wider than TILE. */
async function cropElement(page, auditId, name, dir = "crops") {
  const locator = page.locator(`[data-audit-id="${auditId}"]`).first();
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 1500 });
  } catch {
    return [];
  }
  await page.waitForTimeout(80);
  const box = await locator.boundingBox().catch(() => null);
  if (!box || box.width < 4 || box.height < 4) return [];

  // A little air around the element, so "the mark touches the card edge" is a
  // thing the crop can show rather than a thing it crops away.
  const pad = 8;
  const vp = page.viewportSize();
  const x = Math.max(box.x - pad, 0);
  const y = Math.max(box.y - pad, 0);
  const w = Math.min(box.width + pad * 2, vp.width - x);
  const h = Math.min(box.height + pad * 2, vp.height - y);
  if (w < 4 || h < 4) return [];

  const written = [];
  if (w <= TILE) {
    const file = join(OUT, dir, `${name}.png`);
    await page.screenshot({ path: file, clip: { x, y, width: w, height: h } });
    written.push(`${dir}/${name}.png`);
    return written;
  }
  const tiles = Math.ceil(w / TILE);
  const step = w / tiles;
  for (let i = 0; i < tiles; i++) {
    const tx = Math.max(x + i * step - (i === 0 ? 0 : 24), 0);
    const tw = Math.min(step + (i === 0 ? 24 : 48), x + w - tx);
    const file = join(OUT, dir, `${name}-t${i + 1}.png`);
    await page.screenshot({ path: file, clip: { x: tx, y, width: tw, height: h } });
    written.push(`${dir}/${name}-t${i + 1}.png`);
  }
  return written;
}

// ════════════════════════════════════════════════════════════════════════
// Step one, always: prove the instrument can see.
// ════════════════════════════════════════════════════════════════════════

/**
 * Every gate, fired on a specimen and silent on a control.
 *
 * The specimens live in `tests/ui/design/broken-app.tsx`, one `[data-calib]`
 * block per gate beside one `[data-calib-ok]` block. Both halves matter: a
 * gate that fires on everything is as useless as one that fires on nothing,
 * and it is worse in practice because people mute it.
 */
async function calibrate() {
  const results = [];
  const elementGates = [
    "overlap",
    "spill",
    "junk",
    "contrast",
    "ink",
    "clipped",
    "truncated",
    "tap",
    "inert",
  ];

  // The element-level gates, on a coarse pointer so `tap` is live.
  const { page, errors } = await openPage(
    "broken.html",
    VIEWPORTS[1],
    "light",
    1800,
  );
  if (errors.length > 0) {
    results.push({
      gate: "*",
      ok: false,
      why: `the calibration page threw: ${errors.join(" | ")}`,
    });
  }
  const { findings } = await gate(page, VIEWPORTS[1]);
  const located = await page.evaluate((ids) => {
    const out = {};
    for (const id of ids) {
      const el = document.querySelector(`[data-audit-id="${id}"]`);
      if (!el) {
        out[id] = null;
        continue;
      }
      const spec = el.closest("[data-calib]");
      const ctrl = el.closest("[data-calib-ok]");
      out[id] = {
        specimen: spec ? spec.getAttribute("data-calib") : null,
        control: ctrl ? ctrl.getAttribute("data-calib-ok") : null,
      };
    }
    return out;
  }, findings.map((f) => f.auditId).filter(Boolean));

  for (const id of elementGates) {
    const mine = findings.filter((f) => f.gate === id);
    const fired = mine.filter((f) => located[f.auditId]?.specimen === id);
    const falseAlarms = mine.filter(
      (f) => located[f.auditId]?.control !== null && located[f.auditId]?.control !== undefined,
    );
    const strayControls = falseAlarms.filter(
      (f) => located[f.auditId].control === id,
    );
    results.push({
      gate: id,
      ok: fired.length > 0 && strayControls.length === 0,
      firedOnSpecimen: fired.length,
      firedOnItsOwnControl: strayControls.length,
      // Cross-fire is reported rather than failed: a spill specimen is allowed
      // to be low-contrast too. It is here so a gate that has quietly started
      // firing on everything is visible before somebody mutes it.
      firedOnOtherControls: falseAlarms.length - strayControls.length,
      why:
        fired.length === 0
          ? `never fired on its own specimen — this gate cannot report its absence`
          : strayControls.length > 0
            ? `fired ${strayControls.length}x on the clean control`
            : null,
      exemplar: fired[0]?.message ?? null,
    });
  }
  await page.close();

  // Horizontal overflow is a property of a whole page, so it gets its own
  // pair of pages rather than a pair of blocks.
  {
    const bad = await openPage("broken.html?defect=overflow", VIEWPORTS[1], "light", 1200);
    const badF = (await gate(bad.page, VIEWPORTS[1])).findings.filter(
      (f) => f.gate === "overflow",
    );
    await bad.page.close();
    const good = await openPage("broken.html", VIEWPORTS[1], "light", 1200);
    const goodF = (await gate(good.page, VIEWPORTS[1])).findings.filter(
      (f) => f.gate === "overflow",
    );
    await good.page.close();
    results.push({
      gate: "overflow",
      ok: badF.length > 0 && goodF.length === 0,
      firedOnSpecimen: badF.length,
      firedOnItsOwnControl: goodF.length,
      firedOnOtherControls: 0,
      why:
        badF.length === 0
          ? "never fired on a page 900px wide in a 390px viewport"
          : goodF.length > 0
            ? "fired on a page that fits"
            : null,
      exemplar: badF[0]?.message ?? null,
    });
  }

  // The gesture cap, driven with a real pointer on both a broken grid and a
  // correct one wearing the same DOM contract.
  {
    const bad = await openPage("broken.html?defect=gesture", VIEWPORTS[0], "light", 1200);
    const badResize = await measureResize(bad.page);
    const badReorder = await measureReorder(bad.page);
    const badF = gestureFindings("calibration", badResize, badReorder);
    await bad.page.close();

    const good = await openPage(
      "broken.html?defect=gesture-ok",
      VIEWPORTS[0],
      "light",
      1200,
    );
    const goodResize = await measureResize(good.page);
    const goodReorder = await measureReorder(good.page);
    // The clean fixture is a two-tile stub, so it cannot follow a pointer
    // through thirteen distinct heights the way the real grid does; only the
    // two properties the rubric caps on are asserted here.
    const goodF = gestureFindings("calibration", goodResize, goodReorder).filter(
      (f) => !/quantising/.test(f.message),
    );
    await good.page.close();

    results.push({
      gate: "gesture",
      ok: badF.length >= 2 && goodF.length === 0,
      firedOnSpecimen: badF.length,
      firedOnItsOwnControl: goodF.length,
      firedOnOtherControls: 0,
      why:
        badF.length < 2
          ? `only ${badF.length} of the two seeded gesture defects were detected`
          : goodF.length > 0
            ? `fired on a correct gesture: ${goodF.map((f) => f.message).join("; ")}`
            : null,
      exemplar: badF[0]?.message ?? null,
      measured: { broken: badResize, clean: goodResize },
    });
  }

  return results;
}

// ════════════════════════════════════════════════════════════════════════
// Step two: stand in front of every surface.
// ════════════════════════════════════════════════════════════════════════

const coverage = [];
const raw = [];

async function runState(surface, state, viewport, theme) {
  const url = surface.url;
  const id = state ? `${surface.id}--${state.id}` : surface.id;
  const title = state ? state.title : surface.title;
  const row = {
    surface: id,
    title,
    url,
    viewport: viewport.label,
    theme,
    status: "reached",
    reason: null,
    crops: [],
    context: null,
    counts: {},
  };

  let opened;
  try {
    opened = await openPage(url, viewport, theme, surface.settle ?? 2600);
  } catch {
    row.status = "unreachable";
    row.reason = `the page would not load: ${String(e).slice(0, 200)}`;
    coverage.push(row);
    return;
  }
  const { page, errors } = opened;

  try {
    if (surface.prep) await surface.prep(page, { viewport, theme });
    if (state?.enter) await state.enter(page);

    const verifiers = [surface.verify, state?.verify].filter(Boolean);
    for (const v of verifiers) {
      const why = await v(page);
      if (why) {
        row.status = "unreachable";
        row.reason = why;
        break;
      }
    }
  } catch {
    row.status = "unreachable";
    row.reason = `driving it threw: ${String(e).slice(0, 240)}`;
  }

  if (errors.length > 0) {
    row.status = row.status === "reached" ? "reached-with-errors" : row.status;
    row.reason = (row.reason ? row.reason + " | " : "") + errors.join(" | ");
  }

  // A context shot is taken even for an unreachable surface — it is the
  // evidence of WHY it could not be reached — and it is taken at 1x and
  // labelled, because a full-page shot is not evidence about anything small.
  try {
    const ctx = `context/${slug(id)}-${viewport.label}-${theme}.png`;
    await page.screenshot({ path: join(OUT, ctx), fullPage: false });
    row.context = ctx;
  } catch {
    /* a shot that will not take is not worth failing the run over */
  }

  if (row.status === "unreachable") {
    raw.push({
      gate: "unreachable",
      surface: id,
      title,
      viewport: viewport.label,
      theme,
      message: row.reason,
      numbers: {},
      element: null,
      auditId: null,
      crops: row.context ? [row.context] : [],
    });
    coverage.push(row);
    await page.close();
    return;
  }

  const { findings, skipped, viewport: measured } = await gate(page, viewport);

  // ── Two implementations of one property, made to agree ──
  //
  // `scripts/lib/tile-geometry.mjs` is the shared overlap/spill measurement
  // every harness in this repo uses. The gate collector cannot import it —
  // it is serialized whole into the page and may not close over anything — so
  // the property exists here in two places, which is exactly the situation
  // that ends with a gate passing in one version and failing in the other.
  // Rather than pretend, the two are run side by side and a disagreement is
  // itself reported. An instrument whose halves disagree is not measuring.
  const shared = {
    overlap: (await overlapsOn(page)).length,
    spill: (await spillsOn(page)).length,
  };
  const mine = {
    overlap: findings.filter((f) => f.gate === "overlap").length,
    spill: findings.filter((f) => f.gate === "spill").length,
  };
  for (const which of ["overlap", "spill"]) {
    if (shared[which] !== mine[which]) {
      raw.push({
        gate: "unreachable",
        surface: id,
        title,
        viewport: viewport.label,
        theme,
        message:
          `the instrument disagrees with itself about ${which}: the shared ` +
          `measurement in scripts/lib/tile-geometry.mjs found ${shared[which]}, ` +
          `the audit gate found ${mine[which]} — one of them is wrong and ` +
          `neither reading can be believed until they agree`,
        numbers: { shared: shared[which], gate: mine[which] },
        element: null,
        auditId: null,
        crops: [],
      });
    }
  }

  row.counts = findings.reduce((acc, f) => {
    acc[f.gate] = (acc[f.gate] ?? 0) + 1;
    return acc;
  }, {});
  row.measured = measured;
  row.unmeasurable = skipped;

  // A native crop per finding, and one per structural element, so a clean
  // surface still leaves photographs somebody can look at rather than a line
  // of text saying it was fine.
  //
  // Capped per gate, because the report cites six exemplars and the two
  // hundred and sixtieth photograph of the same ellipsised title is not
  // evidence of anything — it is four minutes of wall clock and a directory
  // nobody will open. The FINDING is still recorded every time, so the counts
  // and the fold are unaffected; only the pictures stop.
  const cropped = new Map();
  for (const f of findings) {
    f.surface = id;
    f.title = title;
    f.viewport = viewport.label;
    f.theme = theme;
    f.crops = [];
    raw.push(f);
    if (!f.auditId) continue;
    const seen = cropped.get(f.gate) ?? 0;
    if (seen >= 6) continue;
    cropped.set(f.gate, seen + 1);
    const name = `${slug(id)}-${viewport.label}-${theme}-${f.gate}-${f.auditId}`;
    f.crops = await cropElement(page, f.auditId, name);
  }

  const structural = await page.evaluate(() => {
    const sel =
      '[data-tile], [data-audit-panel], .cell, #style-island, [role="dialog"]';
    const out = [];
    let n = 0;
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) continue;
      // Nested cards would be photographed twice; the outer one is the panel.
      if (el.parentElement && el.parentElement.closest(sel)) continue;
      let id = el.getAttribute("data-audit-id");
      if (!id) {
        id = "s" + n++;
        el.setAttribute("data-audit-id", id);
      }
      out.push({
        auditId: id,
        label:
          el.getAttribute("data-shape") ||
          el.getAttribute("data-tile") ||
          (el.querySelector(".cap")?.textContent ?? "") ||
          el.id ||
          "element",
      });
    }
    return out;
  });
  for (const s of structural.slice(0, 80)) {
    const name = `${slug(id)}-${viewport.label}-${theme}-${slug(s.label)}-${s.auditId}`;
    row.crops.push(...(await cropElement(page, s.auditId, name)));
  }

  coverage.push(row);
  await page.close();
}

const chosen = only
  ? SURFACES.filter((s) => s.id.includes(only))
  : SURFACES;
if (chosen.length === 0) {
  console.error(`No surface matches --only=${only}`);
  process.exit(1);
}

console.log("Calibrating…");
const calibration = await calibrate();
const calibrated = calibration.every((c) => c.ok);
for (const c of calibration) {
  console.log(
    `  ${c.ok ? "OK  " : "FAIL"} ${c.gate.padEnd(10)} ${c.ok ? c.exemplar ?? "" : c.why}`,
  );
}

console.log("\nCovering surfaces…");
for (const surface of chosen) {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      await runState(surface, null, viewport, theme);
      if (surface.states) {
        // The states are discovered from a live page rather than listed here,
        // so a chapter added to the studio is covered without anybody
        // remembering to add it — a manifest that goes stale under-reports
        // silently, which is the failure this whole file exists to prevent.
        let states = [];
        try {
          const probe = await openPage(
            surface.url,
            viewport,
            theme,
            surface.settle ?? 2600,
          );
          if (surface.prep) await surface.prep(probe.page, { viewport, theme });
          states = await surface.states(probe.page);
          await probe.page.close();
        } catch {
          coverage.push({
            surface: `${surface.id}--states`,
            title: `${surface.title} · sub-states`,
            url: surface.url,
            viewport: viewport.label,
            theme,
            status: "unreachable",
            reason: `could not enumerate sub-states: ${String(e).slice(0, 200)}`,
            crops: [],
          });
          continue;
        }
        for (const state of states) {
          await runState(surface, state, viewport, theme);
        }
      }
    }
  }
  console.log(`  ${surface.id}`);
}

// ── The gesture cap, on the real grid ────────────────────────────────────
console.log("\nDriving gestures…");
let gestureMeasurement = null;
{
  const { page } = await openPage("grid.html", VIEWPORTS[0], "light", 1600);
  const resize = await measureResize(page);
  // Onto tile `d` rather than the tile next door: `a` and `b` are adjacent, so
  // dropping one on the other is a gesture whose correct outcome is "nothing
  // moved" — which is indistinguishable from a reorder that silently did not
  // work. The target has to be somewhere the tile is not already.
  const reorder = await measureReorder(page, "a", "d");
  await page.close();
  const found = gestureFindings("grid", resize, reorder);
  for (const f of found) {
    f.title = "The editable grid, under a real pointer";
    f.viewport = "1280";
    f.theme = "light";
    f.crops = [];
    raw.push(f);
  }
  console.log(
    `  resize: ${resize.distinctHeights} distinct heights, ${resize.writes} write(s), ` +
      `${resize.driftAfterRelease}px drift after release`,
  );
  console.log(
    `  reorder: ${(reorder.before ?? []).join(",")} -> ${(reorder.settled ?? []).join(",")}, ` +
      `${reorder.writes} write(s), corrected after drop: ${reorder.correctedAfterDrop}`,
  );
  gestureMeasurement = { resize, reorder };
}

// ── The live-behind claim, measured ──────────────────────────────────────
console.log("\nMeasuring the studio's live-behind claim…");
const liveBehind = [];
for (const viewport of VIEWPORTS) {
  try {
    const { page } = await openPage("home.html?studio=1", viewport, "light", 2600);
    await page.locator('[data-tile="activity"]').first().click({
      position: { x: 40, y: 30 },
    });
    await page.waitForTimeout(400);
    await page.locator("#style-island button").first().click();
    await page.waitForTimeout(1500);
    await page.getByRole("tab", { name: "Colour", exact: true }).first().click();
    await page.waitForTimeout(1200);
    const before = `crops/live-behind-${viewport.label}-before.png`;
    await page.screenshot({ path: join(OUT, before) });
    const result = await measureLiveBehind(page);
    const after = `crops/live-behind-${viewport.label}-after.png`;
    await page.screenshot({ path: join(OUT, after) });
    await page.close();
    liveBehind.push({ viewport: viewport.label, ...result, before, after });
    if (result.measurable && !result.changed) {
      raw.push({
        gate: "dead",
        surface: "studio-home--chapter-colour",
        title: "Style studio · Colour, over Home",
        viewport: viewport.label,
        theme: "light",
        message:
          "picking a palette changed nothing on the canvas behind the sheet — " +
          "the studio's own on-screen claim is that it applies live behind",
        numbers: { before: result.before.slice(0, 4), after: result.after.slice(0, 4) },
        element: null,
        auditId: null,
        crops: [before, after],
      });
    }
    console.log(
      `  ${viewport.label}: ${
        result.measurable
          ? result.changed
            ? "the canvas behind the sheet changed"
            : "NOTHING changed behind the sheet"
          : "not measurable — " + result.why
      }`,
    );
  } catch {
    liveBehind.push({
      viewport: viewport.label,
      measurable: false,
      why: String(e).slice(0, 200),
    });
    raw.push({
      gate: "unreachable",
      surface: "studio-home--live-behind",
      title: "Style studio · live-behind claim",
      viewport: viewport.label,
      theme: "light",
      message: `could not drive the palette change: ${String(e).slice(0, 200)}`,
      numbers: {},
      element: null,
      auditId: null,
      crops: [],
    });
  }
}

await browser.close();
server.close();

// ════════════════════════════════════════════════════════════════════════
// Step three: rank, and refuse to pad.
// ════════════════════════════════════════════════════════════════════════

/**
 * Collapse the same defect seen many times into one finding.
 *
 * Forty nits with two real defects buried among them is how the two real
 * defects get shipped. The same low-contrast token on ninety nodes is ONE
 * thing to fix, and reporting it ninety times is a way of hiding it.
 */
function fold(findings) {
  const groups = new Map();
  for (const f of findings) {
    const shape = (f.message || "")
      .replace(/\d+(\.\d+)?/g, "#")
      .replace(/"[^"]*"/g, '"…"')
      .slice(0, 120);
    const key = `${f.gate}|${f.surface}|${shape}`;
    if (!groups.has(key)) {
      groups.set(key, {
        gate: f.gate,
        severity: GATES[f.gate]?.severity ?? "low",
        cap: GATES[f.gate]?.cap ?? null,
        capNeedsConfirming: GATES[f.gate]?.confirm === true,
        surface: f.surface,
        title: f.title,
        headline: f.message,
        occurrences: 0,
        viewports: new Set(),
        themes: new Set(),
        examples: [],
        crops: [],
      });
    }
    const g = groups.get(key);
    g.occurrences++;
    g.viewports.add(f.viewport);
    g.themes.add(f.theme);
    if (g.examples.length < 4) {
      g.examples.push({
        message: f.message,
        element: f.element,
        numbers: f.numbers,
        viewport: f.viewport,
        theme: f.theme,
        crops: f.crops ?? [],
      });
    }
    for (const c of f.crops ?? []) if (g.crops.length < 6) g.crops.push(c);
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      viewports: [...g.viewports].sort(),
      themes: [...g.themes].sort(),
    }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
        b.occurrences - a.occurrences,
    );
}

const folded = fold(raw);
const firedGates = [...new Set(raw.map((f) => f.gate))];
const { ceiling, binding } = ceilingFor(firedGates);

const caps = Object.entries(GATES)
  .filter(([, g]) => g.cap !== null)
  .map(([id, g]) => {
    const hits = raw.filter((f) => f.gate === id);
    return {
      gate: id,
      condition: g.rubric,
      capsTotalAt: g.cap,
      needsConfirming: g.confirm === true,
      status: hits.length === 0 ? "cleared" : g.confirm ? "candidate" : "HIT",
      occurrences: hits.length,
      surfaces: [...new Set(hits.map((h) => h.surface))],
    };
  });

const reached = coverage.filter((c) => c.status === "reached").length;
const withErrors = coverage.filter((c) => c.status === "reached-with-errors").length;
const unreachable = coverage.filter((c) => c.status === "unreachable");

const report = {
  generatedAt: new Date().toISOString(),
  // The precondition, stated first because nothing below it means anything
  // without it. There is no flag that skips this and no path that omits it.
  calibration: {
    ranInThisInvocation: true,
    passed: calibrated,
    gates: calibration,
  },
  verdict: calibrated ? "scored" : "unknown",
  // The machine computes a CEILING, never a score. Eight of the rubric's ten
  // dimensions are judgements about whether a person can understand what they
  // are looking at, and a number invented for them here would be a number with
  // nothing behind it — which is the failure mode this whole instrument exists
  // to remove, arriving through the instrument.
  scoreCeiling: calibrated ? ceiling : null,
  bindingCaps: calibrated ? binding : [],
  dimensionScores: null,
  dimensionScoresNote:
    "Not machine-derivable. This run reports which caps bind and what was " +
    "measured; the ten dimensions are scored by a person reading the crops.",
  coverage: {
    surfacesRequested: chosen.length,
    rowsAttempted: coverage.length,
    reached,
    reachedWithErrors: withErrors,
    unreachable: unreachable.length,
    viewports: VIEWPORTS.map((v) => v.label),
    themes: THEMES,
    rows: coverage,
  },
  caps,
  gestures: gestureMeasurement,
  liveBehind,
  findings: folded,
};

writeFileSync(join(OUT, "findings.json"), JSON.stringify(report, null, 2));

// ── The same thing, for a person ─────────────────────────────────────────

const md = [];
md.push("# Dynamic UI audit\n");
md.push(`Run ${report.generatedAt}\n`);
md.push(
  `**VERDICT: ${report.verdict}** — ` +
    (calibrated
      ? `score ceiling **${ceiling}/10**` +
        (binding.length
          ? ` (bound by: ${binding.join(", ")})`
          : " (no cap binds)")
      : "the instrument could not demonstrate its own gates firing, so nothing " +
        "below is a result") +
    "\n",
);

md.push("\n## Calibration\n");
md.push(
  "A gate that has never detected a known defect cannot be trusted to report " +
    "its absence. Each row below was fired on a deliberately broken specimen " +
    "and checked against a clean control in this same run.\n",
);
md.push("| gate | fired on specimen | fired on its own control | verdict |");
md.push("| --- | --- | --- | --- |");
for (const c of calibration) {
  md.push(
    `| \`${c.gate}\` | ${c.firedOnSpecimen ?? "-"} | ${c.firedOnItsOwnControl ?? "-"} | ${
      c.ok ? "calibrated" : "**FAILED** — " + c.why
    } |`,
  );
}

md.push("\n## Automatic caps\n");
md.push(
  "From `docs/DYNAMIC-UI-RUBRIC.md`. A cap pins the whole total regardless of " +
    "everything else; `candidate` means the gate found something a person has " +
    "to confirm before the cap binds.\n",
);
// The gate is named alongside the condition because two gates answer one
// rubric line — `inert` finds controls with nothing behind them and `dead`
// confirms it by pressing one — and a table with the same sentence twice and
// two different verdicts reads as a bug in the report.
md.push("| gate | condition | caps at | status | occurrences | surfaces |");
md.push("| --- | --- | --- | --- | --- | --- |");
for (const c of caps) {
  md.push(
    `| \`${c.gate}\` | ${c.condition} | ${c.capsTotalAt} | ${c.status} | ${
      c.occurrences
    } | ${c.surfaces.slice(0, 4).join(", ") || "—"} |`,
  );
}

md.push("\n## Coverage\n");
md.push(
  `${reached} reached, ${withErrors} reached with page errors, ` +
    `${unreachable.length} **unreachable**. An unreachable surface scores its ` +
    "dimension as unknown and drags the total; it is never silently skipped.\n",
);
md.push("| surface | viewport | theme | status | reason / crops |");
md.push("| --- | --- | --- | --- | --- |");
for (const r of coverage) {
  md.push(
    `| ${r.title} \`${r.surface}\` | ${r.viewport} | ${r.theme} | ${
      r.status === "reached" ? "reached" : `**${r.status}**`
    } | ${r.reason ? r.reason.slice(0, 180) : `${r.crops.length} native crops`} |`,
  );
}

md.push("\n## Gestures, driven with a real pointer\n");
if (gestureMeasurement) {
  const { resize: rz, reorder: ro } = gestureMeasurement;
  md.push(
    `Resize: ${rz.distinctHeights} distinct heights over 13 pointer moves ` +
      `(a resize that follows the finger changes on almost every frame), ` +
      `${rz.writes} write(s), ${rz.heightBefore}px → ${rz.heightAtRelease}px at ` +
      `release → ${rz.heightAfter}px settled, neighbour ` +
      `${rz.neighbourChanged ? "CHANGED" : "untouched"}.\n`,
  );
  md.push(
    `\nReorder: \`${(ro.before ?? []).join(",")}\` → \`${(ro.atDrop ?? []).join(",")}\` ` +
      `at the drop → \`${(ro.settled ?? []).join(",")}\` after settling, ` +
      `${ro.writes} write(s). Looked at twice on purpose: "saves out of place ` +
      `then glitches in" is a late write landing, and one reading taken at the ` +
      `moment of release cannot see it.\n`,
  );
}

md.push("\n## The studio's live-behind claim\n");
md.push(
  "The sheet says on screen that a choice applies everywhere, live behind it. " +
    "That is a testable sentence, so it is tested rather than photographed: a " +
    "palette is picked with the sheet open and the marks on the canvas BEHIND " +
    "it are sampled before and after. A screenshot of the sheet cannot tell " +
    "you either way.\n",
);
md.push("| viewport | result | before / after |");
md.push("| --- | --- | --- |");
for (const lb of liveBehind) {
  md.push(
    `| ${lb.viewport} | ${
      lb.measurable
        ? lb.changed
          ? "the canvas changed"
          : "**NOTHING changed** — the control did not reach the product"
        : "not measurable — " + lb.why
    } | ${lb.before ? `\`${lb.before}\`, \`${lb.after}\`` : "—"} |`,
  );
}

md.push("\n## Findings, ranked\n");
if (folded.length === 0) {
  md.push("Nothing fired.\n");
} else {
  for (const sev of SEVERITY_ORDER) {
    const rows = folded.filter((f) => f.severity === sev);
    if (rows.length === 0) continue;
    md.push(`\n### ${sev} (${rows.length})\n`);
    for (const f of rows) {
      md.push(
        `**\`${f.gate}\`** on \`${f.surface}\` — ${f.occurrences}x, ` +
          `${f.viewports.join("/")} · ${f.themes.join("/")}` +
          (f.cap !== null
            ? ` · caps the total at ${f.cap}${f.capNeedsConfirming ? " once confirmed" : ""}`
            : ""),
      );
      md.push(`\n${f.headline}\n`);
      for (const e of f.examples) {
        const nums = Object.entries(e.numbers ?? {})
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(" ");
        md.push(`- \`${e.element ?? "—"}\` @${e.viewport}/${e.theme} ${nums}`);
      }
      if (f.crops.length > 0) {
        md.push(`\nCrops: ${f.crops.map((c) => `\`${OUT}/${c}\``).join(", ")}\n`);
      }
    }
  }
}

md.push("\n## What was not measurable\n");
const unmeasured = coverage.reduce(
  (acc, r) => acc + (r.unmeasurable?.contrast ?? 0),
  0,
);
md.push(
  `${unmeasured} text nodes could not have their contrast measured because the ` +
    "stack behind them contains a gradient or an image, so there is no single " +
    "effective background to measure against. They are counted rather than " +
    "passed: a number nobody can check is worse than a hole somebody can see.\n",
);
md.push(
  "\nFull-page shots in `" +
    OUT +
    "/context/` are at 1x and are **not evidence**. They show that a surface " +
    "rendered; they cannot show anything about text, marks or edges. Every " +
    "finding above cites a native-resolution crop instead.\n",
);

writeFileSync(join(OUT, "FINDINGS.md"), md.join("\n"));

// ── The verdict ──────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(64)}`);
if (!calibrated) {
  console.error("VERDICT: unknown");
  console.error(
    "The instrument could not demonstrate its gates firing on known defects, " +
      "so no result is emitted. Fix calibration before believing anything.",
  );
  for (const c of calibration.filter((c) => !c.ok)) {
    console.error(`  ${c.gate}: ${c.why}`);
  }
  console.error(`\nWritten to ${OUT}/FINDINGS.md`);
  process.exit(1);
}

const counts = SEVERITY_ORDER.map(
  (s) => `${folded.filter((f) => f.severity === s).length} ${s}`,
).join(", ");
console.log(`VERDICT: score ceiling ${ceiling}/10`);
console.log(
  `  caps hit: ${caps.filter((c) => c.status === "HIT").map((c) => c.gate).join(", ") || "none"}`,
);
console.log(
  `  caps needing confirmation: ${
    caps.filter((c) => c.status === "candidate").map((c) => c.gate).join(", ") || "none"
  }`,
);
console.log(`  coverage: ${reached} reached, ${unreachable.length} unreachable`);
console.log(`  findings: ${counts}`);
console.log(`\nWritten to ${OUT}/FINDINGS.md and ${OUT}/findings.json`);

if (failOn) {
  const bar = SEVERITY_ORDER.indexOf(failOn);
  const bad = folded.filter((f) => SEVERITY_ORDER.indexOf(f.severity) <= bar);
  if (bad.length > 0) {
    console.error(`\n${bad.length} finding(s) at or above "${failOn}".`);
    process.exit(1);
  }
}
