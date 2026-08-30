---
name: inspect
description: Full-platform inspection — build the gallery, run the calibrated UI audit and every real-browser gesture harness, check production health, then separate real defects from instrument false positives by looking at the evidence. Use when asked to audit the platform, verify "the UI is broken", check whether everything works, or investigate a vague quality complaint.
---

# Platform inspection

The one rule this codebase already states: **never claim something works that
you have not watched work.** This skill is the watching, made repeatable. It
produces a ranked, evidence-backed verdict — not a vibe — and it treats the
instruments themselves as fallible: a finding is not real until you have looked
at its crop, and a green is not trustworthy until calibration proved the gates
fire.

## 0. Preconditions

```bash
npm ci                                        # if node_modules is missing
npx playwright-core install chromium          # only off the managed container
```

The gallery bundles against the app's **compiled** stylesheet, so a build must
exist. No real secrets are needed — placeholder publishable values let
`next build` prerender (same values CI uses):

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk \
CLERK_SECRET_KEY=sk_test_placeholder \
NEXT_PUBLIC_CONVEX_URL=https://placeholder-000.convex.cloud \
npm run build
```

Rebuild (`npm run build` then `npm run gallery`) after ANY change to
`globals.css` or a fixture — the gallery reads `.next/static/css`, so a stale
build silently audits the old design.

## 1. Static gates (fast, run first)

```bash
npm run typecheck
npm test                       # 3,000+ vitest tests, ~2.5 min
node scripts/chat-sweep.mjs    # Chat wiring: routes, validators, imports
```

## 2. The calibrated audit (the centerpiece, ~15 min)

```bash
npm run gallery                          # bundle fixtures + take design shots
node scripts/audit.mjs --fail-on=high    # long — run in background
```

Artifacts land in `/tmp/audit`: `FINDINGS.md` (ranked, human),
`findings.json` (machine), `crops/` (native-resolution evidence — the ONLY
citable images), `context/` (full-page shots, explicitly not evidence).

Read `FINDINGS.md` top to bottom:

- **Calibration table first.** Every gate must say `calibrated` (fired on its
  broken specimen, quiet on its control). An uncalibrated run prints
  `VERDICT: unknown` and nothing in it may be cited.
- **`unreachable` is a red flag either way**: either the surface broke or the
  driver drifted from the fixture. Reproduce the driver's steps by hand (a
  small Playwright probe against `/tmp/design-gallery`) before deciding which.
  Driver drift is still a finding — it means that surface has been unaudited.
- **`info` findings are inventory, not defects** (deliberate truncations).

## 3. Confirm every finding against its crop — with your eyes

The gates are instruments, and instruments lie in known ways. Before reporting
a finding as real, `Read` its crop PNG:

- **Contrast**: the background attribution can miss a painted backdrop (a chip
  drawn by a sibling, an SVG fill). If the crop is plainly legible, it is a
  gate bug — fix `effectiveBackground` in `scripts/audit-gates.mjs`, do not
  report the finding. If the crop is genuinely faint, it is real.
- **Tap**: remember arrange mode scales tiles 0.965 (`inhale()`), so chrome
  measuring 44px in CSS presses at 42.5. The floor in `.tap-target` is
  deliberately 46px for exactly this.
- **Overlap/spill**: cross-check with `scripts/verify-resize.mjs`, which
  measures the same property after real gestures.

## 4. Gesture harnesses (real pointers; jsdom cannot drag)

```bash
node scripts/verify-resize.mjs           # grid: resize, reorder, touch, overlap, spill, one-write-per-gesture
node scripts/verify-mode-transition.mjs  # Work ⇄ Chat transition, measured mid-flight
node scripts/verify-customize.mjs        # select panel → sheet opens → a pick lands behind it
node scripts/verify-situation.mjs        # situation panels arrive with consent, displace nothing
node scripts/verify-negatives.mjs        # charts draw negatives on the correct side
node scripts/verify-nav-grab.mjs         # sidebar hold-and-drag pickup
node scripts/measure-home.mjs            # Home tiles fit their boxes at 1280/900/390 — any "SCROLLS" line is a clipped tile
```

`verify-resize` failing on overlap while `pack.test.ts` passes means the
*renderer or an animation* disagrees with the packer — dump `data-col/row/w/h`
attributes against `getBoundingClientRect()` per tile to see which. Stale
inline styles that `data-*` attributes contradict mean something outside React
mutated styles React owns; the grid deliberately animates by CSS transition
only, so treat any reintroduction of a JS layout animation on `[data-tile]`
geometry as the bug returning.

## 5. Production health

```bash
curl -sS https://www.operate.to/api/health   # expect status ok + convex ok; note the running commit
```

Also check open GitHub issues — the uptime monitor (`production-uptime.yml`,
every 15 min) files one on failure. Driving production pages in the sandbox
browser usually fails at the egress proxy; `curl` is the reliable check, and
the gallery is the honest instrument for how the UI behaves.

## 6. Screenshots you actually look at

`npm run gallery` leaves `/tmp/design-shots/*.png` (home, studio, charts,
labels, sidebar — both themes, desktop + mobile). `Read` at least Home
desktop/mobile in both themes. The audit's numbers cannot see composition;
your eyes are that gate.

## 7. Report

Lead with the verdict in one sentence. Then:

1. **Real defects, ranked** — each with its mechanism (not just the symptom),
   the harness or crop that proves it, and what a user would experience.
2. **What is healthy** — name the suites and counts; a report that only lists
   defects reads as "everything is broken" when 95% passed.
3. **Instrument debt** — false positives you disproved (say how), drivers that
   drifted, gates not in CI. An audit that cannot criticize itself inflates.

Fixes verify the same way they were found: the failing harness green, the
full audit re-run, and the relevant unit suites passing. CI runs all of this
in the `browser-harnesses` job — a fix is not done until that job would pass.
