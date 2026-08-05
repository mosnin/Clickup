# The rebrand: one language for Work and Chat

Three references, one direction. This is what I read out of them and what it
means for the code, so the pages that "look sloppy" have something specific to
be measured against rather than a taste argument per screen.

## What the references actually share

Strip the branding and all three agree on five things:

1. **Tinted canvas, floating cards.** Nothing is white-on-white. The page is a
   soft wash and content sits on it as rounded cards with a diffuse shadow.
   That single relationship is what makes all three read as "designed" and its
   absence is most of why our inner pages read as flat.
2. **One accent, spent carefully.** Panze uses orange, TeamUnity orange,
   Atlassian green. Each spends it on the primary action and *one* hero metric.
   Everything else is ink, grey and pastel.
3. **A big page header.** Eyebrow line, then a large title. Not a 14px heading
   flush against a table.
4. **A dark pill as the active segment.** View switchers, time filters, tabs —
   all three use a rounded track with a solid dark active pill.
5. **Cards carry metadata as chips.** Pastel category tags, a date chip, an
   avatar stack, small counts. Never a paragraph of grey text.

## What we already have

Most of this vocabulary is in `globals.css` already: `.bento` (soft floating
shadow), `.bento-tile`, `.segmented` + `.segmented-on` (the raised active
pill), the `--color-pastel-*` ramp, `.title-rule`, `.soft-field`, `.icon-tile`.

**So this is not a rebrand from zero.** It is the Phase 21 bento language
applied to the pages that were built before it existed, plus three primitives
we never made. That reframing matters: a from-scratch rebrand would mean 36
pages of judgement calls, where this is mechanical on most screens.

## The three missing primitives

Everything sloppy about the inner pages traces to one of these being absent, so
they get built once and used everywhere rather than re-improvised per page.

### `PageHeader`

Eyebrow + title + optional description, actions on the right, `title-rule`
underneath. Home has one. `/dashboard/agents`, `/dashboard/pages`,
`/dashboard/projects`, `/dashboard/spaces`, `/dashboard/templates`,
`/dashboard/inbox` each roll their own, which is why they don't match.

### `StatTile`

The big-number card all three references open with: label, large figure,
optional delta chip, optional accent fill for the one that matters. We render
this shape on Home, on the agent detail page and in reports — three times,
three different ways.

### `EntityCard`

The card in a board column or a grid: pastel tag chips, title, one line of
description, then a meta row of date chip + avatar stack + counts. Board,
Projects, Pages and Templates each draw their own version today.

## Where the references are wrong for us

Copying them wholesale would cost us things we already decided:

- **Saturated accents on every card.** Panze tints each task card a different
  pastel. At forty rows that is noise, and our brand system already says
  meaning is carried by pastel *chips*, not by tinted surfaces.
- **A second nav.** TeamUnity has a dark rail and a light content area with its
  own menu. We just deleted our second nav for exactly that reason.
- **Charts as decoration.** Atlassian's gauge is lovely and says one number. We
  have a real chart vocabulary in `AnimatedBar` / `chartStyle` that the reader
  controls; a hardcoded gauge would sit outside it.

## Colour

Keep the monochrome-plus-pastel system. Add **one** accent, used only for the
primary action and the single hero metric on a screen — the discipline all
three references share. Green stays reserved for positive deltas, which is
already the rule.

The canvas relationship is the actual change: `--color-page` should sit
visibly under `--color-card` in light mode, so `.bento` has something to float
on. Chat already does this (`:root[data-app="chat"]` recedes the canvas); Work
should adopt the same relationship rather than Chat keeping it as a
speciality.

## Motion

`morphicons` is now installed and wrapped in `src/components/morph-glyph.tsx`.
The rule in that file is the one that keeps it from becoming noise: **a morph
must mean a state change** — collapsed→expanded, light→dark,
customising→done. Two icons that are the same object in different states are a
morph; two unrelated glyphs are a swap, and animating a swap is decoration.

Reduced motion renders the target shape directly rather than animating
quickly, via the existing `motionScale()` gate.

Icon geometry for morphing pairs lives in `src/lib/glyphs.ts`, generated from
the installed lucide modules, because lucide 0.468 exports components but not
the node data morphing needs. Non-morphing icons keep importing from
`lucide-react` so that file stays a short list of pairs.

## Order of work

1. `PageHeader`, `StatTile`, `EntityCard` — the three primitives.
2. The canvas/card relationship in Work, matching Chat's.
3. Sweep the eight inner pages onto the primitives. Mechanical once 1 and 2
   exist.
4. Morph pairs on the disclosure chevron, the theme toggle and the sidebar
   collapse — the three highest-frequency state changes in the app.
5. The panel builder's own surfaces, which are the "customizable components
   are slop" complaint and deserve their own pass rather than being folded in
   here.

Verify by looking, as always: `npm run gallery` for Work,
`node tests/ui/chat-gallery/shoot.mjs` for Chat.
