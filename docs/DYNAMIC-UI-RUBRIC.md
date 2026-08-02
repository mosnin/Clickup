# The dynamic UI rubric

This document exists because of a specific failure mode. An audit whose
criteria are written *after* the results are in is not an audit — it is a
justification, and it will find that the work scores well. So the bar is
written down first, in advance of the run it will judge, and it is not
adjusted to fit an outcome. If the work scores badly against this, the work
changes. This file does not.

It also exists because of a second failure mode, which this codebase has
already suffered: an auditor returned a **clean result on a surface with a
defect documented twice**, because it was reading downscaled screenshots in
which 10px text was three pixels tall. It was not lying; it was blind. So
every gate below has to name **what it measured**, not what it looked at.

## How to score

Ten dimensions, each 1–10. The reported figure is the **mean**, but the
caps below are applied first and they are not negotiable, because the whole
point of a cap is to stop one fatal defect being averaged away by nine
comfortable scores. A dashboard where panels overlap is not an 8.2 with an
issue; it is broken, and the number has to say so.

### Automatic caps

| Condition | Caps the total at |
| --- | --- |
| Any two panels overlap, at any viewport, in any theme | **4** |
| Content escapes its tile (spill) anywhere | **4** |
| Horizontal overflow at 390px on any dynamic surface | **5** |
| A literal `NaN`, `undefined`, `null`, `Infinity` or an empty required label renders | **5** |
| A gesture writes more than once, or commits a position other than where it was released | **5** |
| Any text fails WCAG AA against its effective background, in either theme | **6** |
| A control is present and does nothing | **6** |
| A surface could not be reached by the instrument and was scored anyway | **6** |

That last one is the anti-blindness clause. **An unreachable surface scores
its dimension as unknown and drags the total, rather than being quietly
skipped.** A coverage list with silent holes is the same failure as the
downscaled screenshot, and it is more dangerous because it looks complete.

### Calibration precondition

**A gate that has never detected a known defect cannot be trusted to report
its absence.** Before any score is believed, each automated gate must be
shown firing on a deliberately broken fixture and passing on the real one.
An audit run that cannot show its calibration is not a 9; it is an unknown,
and unknowns do not clear the bar.

## The ten dimensions

**1. Geometry integrity.** Do panels ever overlap, spill, or land somewhere
other than where they were released — across 1–4 columns, every span, every
row count, both viewports, both themes, and after a reorder? A 9 requires
that overlap be impossible *by construction* rather than absent by
observation: the property is proven over the pure packer, and the browser
gate confirms the rendering agrees with it.

**2. Gesture quality.** Does resize follow the finger, does drag track
without lag or jump, does the tile settle rather than snap, does the grid
stay coherent while a tile is in flight? A 9 feels like rearranging a phone
home screen. Choppiness, elements glitching past each other, or a tile
landing and then correcting itself are each a 5 at best — a visible
correction after release means the screen disagreed with the gesture.

**3. Legibility of purpose.** Can somebody who has never seen this screen
say what each panel is telling them, and why it is there? A 9 means every
panel's question is recoverable from the panel itself. Chrome that requires
you to already know what it does scores low regardless of how it looks.

**4. Discoverability of authorship.** Can somebody who has never opened a
stylesheet change what they are looking at, *while looking at it*, and see
the result immediately? This is the product's own test, from CLAUDE.md. A 9
means the path from noticing to changing is short and local. Anything that
sends you to a separate settings place to change the thing you were reading
is capped at 6 by definition, whatever its quality.

**5. Mobile at 390.** Not "does it fit" — does it *work* with a thumb, in a
PWA, one-handed? A 9 requires reachable targets ≥44px, no horizontal
scroll, no control stranded off-axis, and gestures that work on touch and
not only with a mouse. This dimension is scored from native-resolution
crops at 390, never from a downscaled full-page shot.

**6. Theme parity.** Does every surface hold up in dark as well as light —
every chart, every border, every piece of vendored furniture? A 9 requires
contrast measured against the *effective* background rather than the
intended one. This dimension has a history: a vendored chart painted with a
custom property this app never defined, which resolved to black on a black
card, and it survived a review because nobody measured.

**7. Honesty.** Does anything claim more than it does — a control that
produces a stub, a shape name with no renderer behind it, a preview that is
a mockup of the result rather than the result, an explanation that can
disagree with the thing it explains? A 9 means every affordance produces
the thing it names. A single control that produces a placeholder caps this
at 3; it is worse than the control's absence, because absence is honest.

**8. Consent.** Does anything change a person's screen without them
agreeing to it? Every arrival — agent proposal, minted panel, situation —
must announce, say why in the reader's language, and be refusable, per
person. A 9 requires that refusing be durable and that accepting write only
the acceptor's layout. Anything that rearranges a screen unasked scores 1,
regardless of how good the rearrangement is.

**9. Coherence.** One product, not three. One easing, one empty-state
voice, one way to name a thing, one motion feel, one type scale, one
palette that is safe in both themes. A 9 means you cannot tell which
surfaces were built in which week.

**10. Recovery.** What happens when it goes wrong — empty data, one record,
ten thousand, a failed query, a stale definition, a hostile one, a slow
network? A 9 requires that loading states not relayout the page, that empty
states teach rather than apologise, and that a definition written by an
older or newer build degrade rather than fail. Nothing here may be checked
by reasoning about the code; each case is provoked and observed.

## What a 9 is

A 9 is not "no bugs found". It is: **the instrument was calibrated, the
coverage was complete, every cap was cleared, and the remaining findings
are things a careful person would notice but not things that would stop
them working.** A 10 is reserved for a surface where the remaining findings
are matters of taste on which reasonable people differ.

Anything below 9 means a new plan and another loop.
