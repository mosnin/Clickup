# The Monday Review — fix loop

Goal: comprehensively resolve every finding in the Monday Review audit
(published 2026-08: https://claude.ai/code/artifact/c9d68774-a377-4e6b-b74f-6e5780308cae).
Autonomous loop: one finding (or coherent group) per iteration — build, verify
in real Chromium at 1440px AND 390px in both themes, ship to main, update this
doc, then continue. Re-audit (walk production + `node scripts/audit.mjs`)
after every second shipped finding; final pass re-walks the whole journey.

Standing rules: nothing gets cut — focus, don't remove. Verify by looking
(screenshots), never by reading source. Production deploys from main via
Vercel, so every shipped fix should be re-checked on www.operate.to on a
later iteration (deploy lag ~minutes).

## Queue (priority order, from the audit)

1. [x] **Showcase demo (critical)** — homepage frame shows live scratch-account
   data ("Test — 0 of 1 task", "Chippi · HQ", "Personal · Personal") and an
   empty black frame on deep-link arrival. Fix: scripted, seeded showcase —
   real-looking project names, progress, an agent mid-run — rendered with real
   components, hardcoded content, renders instantly on cold arrival (no reveal
   gating; fails visible).
2. [ ] **Chat widget + ticker (critical)** — support bubble auto-pops over the
   curl block (390px) and pricing tiers; announcement ticker repeats 4×/viewport
   on every page. Fix: bubble opens on intent only, never overlaps interactive
   content; the announcement says it once, statically.
3. [ ] **One tagline (critical)** — tab title "recruit, direct and scale…", hero
   "Agents that finish what they start", sign-in "The operating system for AI
   agent workforces" — three positionings. Fix: "Agents that finish what they
   start." everywhere: layout metadata title/OG, sign-in panel, footer.
4. [ ] **First-morning Home (serious)** — two system banners stack above the
   user's own work; approvals (the heartbeat) buried in Inbox. Fix: banners
   collapse to one slim line each (invite stays actionable but compact);
   "Waiting on you" approval hero on Home when pendingApprovals > 0, with the
   agent's own account of the work and one-click Approve.
5. [ ] **Naming amnesty (serious)** — Space/Folder/List/Project/Board vocabulary;
   "Open board" opens a List; sidebar says Spaces + Projects + "Your spaces";
   Chat duplicates Home/Search/Projects nouns. Fix: "Project" = the thing with
   tasks, everywhere a person reads; Board/List/Calendar are views; Space
   appears once in the rail. No schema changes — words only.
6. [ ] **Pricing page (serious)** — two heroes before any price; decorative
   nothing-chart; tiers below fold. Fix: one hero ("Simple for people. Free
   for agents."), tiers in the first viewport, decorative chart deleted.
7. [ ] **Phone-first charts (serious)** — Pulse at 390px: six columns, labels
   truncated to "BILLI…"/"SOMED…"; marketing hero copy ~7 lines on phone;
   DONE — 7 DAYS tag wraps. Fix: Pulse draws rows (full name + one bar) in
   narrow containers via container query; mobile hero copy cut to ~2 lines;
   meta tags never wrap mid-word.
8. [ ] **Effects fail visible (serious)** — pixel-grid transition parked blocks
   over section copy mid-scroll; deep-link arrivals can land with text hidden.
   Fix: every scroll-armed effect must leave content readable if its trigger
   never fires; add a cold-arrival verify script (jump to every section,
   assert no text occlusion) to the house gates and fix what it catches.
9. [ ] **Instrument language rollout (polish)** — Home speaks it; project page,
   task page, Inbox, Agents, Chat still old voice. Fix: one-page language spec
   (docs/DESIGN-LANGUAGE.md — when a figure is dot-matrix, when a label is
   mono, when an LED may light), then sweep: list page header/tabs, task state
   rail, Inbox header, Agents vitals, Chat headers. Chat last, most carefully.
10. [ ] **Sign-in door (polish)** — left panel = fourth pitch (3 bullets); a
    blank-form state rendered in the sandbox harness — verify it isn't real.
    Fix: panel cut to the one sentence; watchdog around the Clerk mount that
    logs and shows a plain fallback path if the widget never paints.

## Audit checkpoints

- [ ] After items 1–2: re-walk production home, desktop + 390px.
- [ ] After item 4: `node scripts/audit.mjs --only=home-arranged` — expect no
  new findings over the known baseline (pre-existing studio probe high).
- [ ] After item 7: mobile walk at 390px — Pulse readable, hero copy short.
- [ ] After item 9: full `node scripts/audit.mjs` sweep — no new findings.
- [ ] FINAL: run the two-minute demo cold on production (phone first, then
  desktop, both themes); record the verdict here.

## Iteration log

- 2026-08-18 (setup): doc created; loop armed; starting item 1.
- 2026-08-18 (iter 1): item 1 shipped (006fc40). marketing-screens.mjs
  regenerates hero-dashboard.png + home-showcase.png from seeded fixtures
  (new projects-directory fixture; home ?hero=1 variant). Both PNGs now show
  the current design over a company mid-flight. Verify on production next
  iteration (Vercel deploy lag), then item 2.
