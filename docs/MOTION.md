# Motion: what anime.js is still not doing

A plan, not a changelog. Everything below is unbuilt.

## The boundary that isn't moving

Three motion libraries, and the split is deliberate:

| Library        | Owns                                                              |
| -------------- | ----------------------------------------------------------------- |
| `motion/react` | Dashboard components — reveals, layout ids, presence, springs      |
| GSAP           | The marketing site, and nothing else                              |
| anime.js       | Things neither can do: tokens, FLIP, physics, SVG, text, the engine |

Nothing in this plan crosses those lines. anime.js earns each new job because
the other two *cannot* do it, not because it would be nice to use.

Four rules bind every proposal:

1. **`--ui-motion-scale` is law.** Everything goes through `scaled()`, and a
   scale of 0 means *instant*, never broken. `prefers-reduced-motion` beats the
   stored preference.
2. **No animation carries meaning alone.** If the only way to know something
   happened is to have been looking, it isn't finished.
3. **Transforms and opacity, not layout.** Anything that would animate
   `width`/`top`/`height` goes through FLIP instead.
4. **A flourish that fires on every render is noise.** Motion marks *change*.

## What we already use

`animate`, `createAnimatable`, `createDraggable`, `createLayout`,
`createScope`, `createSpring`, `stagger`, `svg.createDrawable`,
`text.scrambleText`, `utils.set/clamp`.

That is roughly half the library. The half we don't touch is the half that
would make this product feel like it is actually doing something.

---

## Tier 1 — fixes something people feel

### 1. `createTimeline` → a run you can replay

**Where:** `run-theater.tsx`, `agents/[agentId]`.

An agent run is a sequence with a shape: steps that start, narration that
replaces itself, numbers that move. Today each of those animates on its own the
moment its event lands, and when the run finishes the whole thing evaporates —
the person who stepped away for coffee gets a green tick and no idea what
happened.

A timeline changes what a run *is*. Build one from the stored events with a
label per step (`tl.label(step.key, at)`), and the run document becomes
seekable: a scrubber under a finished run replays it at whatever speed you
like, `tl.seek(t)` on drag, `tl.reverse()` to walk backwards through a failure.
The events are already stored and already ordered; nothing new is persisted.

This is the highest-value item on the list because it converts an ephemeral
view into an artifact. "Show me what the agent did at 14:02" currently has no
answer.

**Risk:** a timeline built from live events must not fight the live path.
Build it only for `status !== "running"`; the live view stays as it is.

**Done when:** a finished run has a scrubber, dragging it moves the checklist
and the narration, and a run with one step doesn't render a scrubber at all.

### 2. Draggable's physics parameters, which we never set

**Where:** `editable-grid.tsx`, `app-dock.tsx`, `sidebar-dock.tsx`.

`createDraggable` accepts `snap`, `containerFriction`,
`releaseContainerFriction`, `releaseStiffness`/`releaseDamping`/`releaseMass`,
`velocityMultiplier`, `minVelocity`/`maxVelocity`, `scrollThreshold`,
`dragThreshold`, `onSettle`. We set almost none of them, which is why the
direct manipulation reads as new rather than finished:

- **`snap`** — dock items to slot centres, sidebar width to whole rems. A
  throw that lands *between* two positions and stays there is the gesture
  admitting it doesn't know what you meant.
- **`releaseStiffness`/`releaseDamping`** — a thrown tile currently stops dead
  where the pointer left it. Momentum with a settle is the difference between
  dragging a rectangle and moving an object.
- **`scrollThreshold`** — drag a tile toward the bottom of a long screen and
  the page must scroll. Right now the drag simply ends at the viewport edge,
  so you cannot move a panel from the top of a screen to the bottom in one
  gesture. This is a bug wearing a missing-parameter costume.
- **`dragThreshold`** with separate mouse/touch values — the hand-rolled
  `HOLD_SLOP` in `sidebar-dock.tsx` is a worse version of this.
- **`onSettle`** — the only correct place to persist a new position. Today we
  write on `pointerup`, which is before the object has finished moving.

**Done when:** a tile thrown across the grid carries momentum and lands on a
slot; dragging toward a screen edge scrolls; nothing persists mid-flight.

### 3. `engine` — enforce the motion preference once

**Where:** `lib/anime.ts`, `appearance-provider.tsx`.

`scaled()` is applied by hand at every call site, which means it can be
forgotten, and every forgotten one is a person who set motion to zero still
watching things move. `engine.timeScale` applies it globally — set it from
`--ui-motion-scale` in the provider and the preference becomes structural
rather than a convention.

`engine.pauseOnDocumentHidden` is the other half: a dashboard holding presence
pulses, orb swirls and a running-timer chip is burning a laptop battery in a
background tab for nobody.

**Risk:** `timeScale` and per-call `scaled()` would compound. Land them
together — the global replaces the manual multiplications, it doesn't join
them.

**Done when:** deleting every `scaled()` call changes nothing visible, and a
hidden tab runs no frames.

### 4. `utils.createSeededRandom` — noise that belongs to the thing

**Where:** `jiggle`, `velocityDeform`, the orb swirl, any stagger jitter.

These reach for `Math.random`, so the same tile wobbles differently on every
mount, and two people looking at the same board see different noise. Now that
presence is real and two people genuinely are looking at the same board, that
is a small lie the app tells.

Seed on the entity id. The wobble becomes a property of *that* tile —
recognisable across reloads, identical for everyone watching. Free, and it is
the difference between decoration and identity.

**Done when:** reloading a screen reproduces the same phase offsets.

---

## Tier 2 — makes the app read as alive

### 5. `svg.createMotionPath` — show the handoff

**Where:** task assignment, `handoff_task`, claims, the dependency diagram.

This product is *about* work moving between people and machines, and that
movement is currently invisible: an assignee chip changes and nothing travels.

A token animated along a quadratic path from the old chip to the new one, with
`rotate` bound to the path's angle, is one small element and about fifteen
lines. It fires on the change, not on render. In the network diagram, a pulse
travelling an edge answers "which way does this block?" without a legend.

**Risk:** fires on every subscription update if wired to render rather than to
a transition. Drive it from an event id, not from prop equality.

**Done when:** reassigning a task sends one token between the two chips, and
loading the page with the task already assigned sends none.

### 6. `svg.morphTo` — states that change rather than swap

**Where:** `status-pill.tsx`, checklist ticks, the collapse chevron, approval.

An icon that disappears and a different icon that appears is two events. A path
that morphs is one thing changing, which is what actually happened. The status
categories (`open` → `in_progress` → `complete`) are a natural progression:
circle → half-filled → check.

Small, cheap, and it lands on the single most-repeated indicator in the
product.

**Done when:** completing a task morphs its mark instead of replacing it, and
the mark still renders correctly with JS disabled.

### 7. `text.split` + per-character staggers

**Where:** page titles on route change, run narration, empty states.

`scrambleText` is the only text effect wired, and only on `LiveNumber`.
`text.split({ chars: true, words: true, accessible: true })` gives real
per-glyph targets with automatic staggers.

Three honest uses:

- **Page title on navigation** — words rise in sequence. One title, one time,
  on a route change. It marks arrival.
- **Run narration replacing itself** — the current sentence resolves character
  by character rather than cross-fading, which reads as the agent *saying* it.
- **Empty states** — the one place a sentence is the entire screen.

**Non-negotiable:** `accessible: true`, so splitting doesn't shred the
accessibility tree into per-character spans. And never on prose: a paragraph
that assembles itself is a paragraph nobody can read.

**Done when:** a screen reader reads a split title as one string.

### 8. `stagger` with `grid` / `from` / jitter

**Where:** board view, bento home, the project screen, agents HQ.

Our staggers are one-dimensional and fire in reading order, which is the
mechanical option. The board and the home screen are genuine 2D grids, and
`stagger(40, { grid: [cols, rows], from: index, axis })` makes a cascade
radiate from a *specific tile* — the one you just touched.

That is the point: complete a task and the ripple starts at that card. The
grid responds to you rather than replaying an entrance.

`jitter` (the tuple form ramps its magnitude across the ordering) breaks the
metronome without making it random.

**Done when:** completing a card ripples outward from that card, and a fresh
page load cascades from the top-left as before.

---

## Tier 3 — worth doing, no hurry

### 9. `waapi` for the forever-loops

**Where:** `PresenceDot`, `.orb`, the dock's idle breathing, `AgentEdge`.

These are infinite transform/opacity loops, potentially dozens at once, all
currently on the main thread. `waapi.animate` hands them to the compositor,
where they cost nothing and keep running through a long React render.

**Rule:** only for loops whose values are not JS-driven. Anything reading a
pointer or a Convex value stays on `createAnimatable`.

### 10. `onScroll` inside the dashboard

**Where:** long list/table views, the roadmap's horizontal timeline.

GSAP owns marketing scroll. The dashboard has no scroll-driven motion at all,
and two places want it: a sticky section header that scrubs as you pass
boundaries in a long list, and the roadmap timeline, where `axis: "x"` +
`sync: "smooth"` gives depth to a horizontally scrolled surface.

**Rule to write down before this lands:** dashboard scroll is anime.js,
marketing scroll is GSAP, and neither appears in the other's tree. Without
that, this becomes the fourth motion vocabulary.

### 11. `utils.damp` — frame-rate independence

**Where:** `createMagneticField`, the dock magnification.

Both smooth toward a target with fixed durations, which means they behave
differently on a 60Hz and a 120Hz display. `damp` is the correct primitive and
it is a two-line change per site.

### 12. `createTimer({ frameRate })` — one clock

**Where:** `running-timer-chip.tsx`, every `timeAgo` that ticks.

N components each holding a `setInterval` and re-rendering once a second is N
React renders a second for text that could be written straight into a text
node. One shared 1fps timer, subscribers write their own nodes.

Measure first. If nobody notices, don't.

---

## What not to do

- **Don't reach for anime.js where `motion/react` already works.** A component
  that fades in has a home.
- **Don't animate the marketing site with it.** That boundary is what keeps
  three libraries from becoming three dialects of the same one.
- **Don't add an effect without a reduced-motion path.** The check is not "does
  it degrade gracefully" but "is the final state correct with zero frames".
- **Don't animate a value that arrives over a subscription on every update.**
  Motion marks change; a Convex query that re-resolves is not necessarily a
  change.
- **Don't split text that someone has to read.**

## Order of work

1 → 2 → 3 → 4 land first: they fix things people can feel today (a run that
vanishes, a drag that can't reach the bottom of the screen, a motion setting
that leaks, noise that isn't shared). 5 → 8 are the expressive tier and want a
design pass together rather than one at a time. 9 → 12 are cleanup and can ride
along with whatever touches those files next.
