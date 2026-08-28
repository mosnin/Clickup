// What the audit MEASURES, as opposed to what it looks at.
//
// The failure this exists to prevent is on record: a pass over this UI
// returned a clean result on a surface with a defect that had been written
// down twice, because the images it was handed were 2360px wide downscaled to
// 830 — 10px text arriving three pixels tall. The auditor was not lying. It
// was blind. So the instrument's job is not to produce prettier pictures; it
// is to turn "does this look right" into numbers a machine can fail on, and
// then to prove those numbers move when something is actually wrong.
//
// Everything below runs INSIDE the page. `collectFindings` is passed whole to
// `page.evaluate`, so it may not close over anything in this module — every
// helper it needs is defined inside it. That is why it is one long function
// rather than twelve small ones.
//
// Node-side, this module also owns the map from gate → severity → rubric cap
// (docs/DYNAMIC-UI-RUBRIC.md). A gate that fires is not a matter of taste: it
// pins a ceiling on the score, and the ceiling is written here rather than
// argued about after the results are in.

/**
 * The gates, and what each one costs when it fires.
 *
 * `cap` is the rubric's automatic cap — the highest total the whole audit may
 * report while this gate is firing. `null` means the gate contributes findings
 * but pins nothing. `confirm` means the gate finds *candidates* that a person
 * has to confirm before the cap binds; it is reported separately from the caps
 * that bind on their own, because a cap applied on a guess is a cap nobody
 * will believe the next time it fires.
 */
export const GATES = {
  overlap: {
    cap: 4,
    severity: "critical",
    title: "Two panels share pixels",
    rubric: "Any two panels overlap, at any viewport, in any theme",
  },
  spill: {
    cap: 4,
    severity: "critical",
    title: "Content escapes its tile",
    rubric: "Content escapes its tile (spill) anywhere",
  },
  overflow: {
    cap: 5,
    severity: "critical",
    title: "The page is wider than the phone",
    rubric: "Horizontal overflow at 390px on any dynamic surface",
  },
  junk: {
    cap: 5,
    severity: "critical",
    title: "A placeholder value reached the screen",
    rubric: "A literal NaN, undefined, null, Infinity or an empty required label renders",
  },
  gesture: {
    cap: 5,
    severity: "critical",
    title: "A gesture wrote twice, or landed somewhere it was not released",
    rubric: "A gesture writes more than once, or commits a position other than where it was released",
  },
  contrast: {
    cap: 6,
    severity: "high",
    title: "Text fails WCAG AA against what is actually behind it",
    rubric: "Any text fails WCAG AA against its effective background, in either theme",
  },
  unreachable: {
    cap: 6,
    severity: "high",
    title: "A surface the instrument could not reach",
    rubric: "A surface could not be reached by the instrument and was scored anyway",
  },
  // ── Gates that find things without pinning a ceiling on their own ──
  ink: {
    cap: null,
    severity: "high",
    title: "A mark is invisible against what it is drawn on",
    rubric: "Theme parity (dimension 6) — the black-on-black chart",
  },
  clipped: {
    cap: null,
    severity: "high",
    title: "Text is cut off with nothing to say so",
    rubric: "Legibility of purpose (dimension 3)",
  },
  // Deliberate ellipsis. This is the design working — `.truncate` and
  // `line-clamp-*` are in this product's vocabulary and a panel title that
  // shortens at 390px is the intended behaviour, not a defect. It is reported
  // at `info` rather than `low` because a severity implies somebody should act,
  // and nobody is ever going to act on this: three hundred entries of "a title
  // ellipsised, on purpose, exactly where it was told to" sitting in the same
  // ranked list as fifteen real defects is the burial this report exists to
  // prevent. It is kept because WHERE text shortens is worth being able to look
  // up — an inventory, filed under its own heading, and out of the defect list.
  truncated: {
    cap: null,
    severity: "info",
    title: "Text is deliberately shortened",
    rubric: "Legibility of purpose (dimension 3) — inventory, not a defect",
  },
  tap: {
    cap: null,
    severity: "high",
    title: "A target too small for a thumb",
    rubric: "Mobile at 390 (dimension 5) — reachable targets >=44px",
  },
  inert: {
    cap: 6,
    confirm: true,
    severity: "medium",
    title: "A control with no handler and no destination",
    rubric: "A control is present and does nothing",
  },
  // The confirmed form of `inert`: a control that was PRESSED and measurably
  // changed nothing. Separated from the candidate gate because a cap applied
  // on a guess is a cap nobody believes the second time it fires — this one
  // binds, and the one above does not.
  dead: {
    cap: 6,
    severity: "high",
    title: "A control was pressed and nothing changed",
    rubric: "A control is present and does nothing",
  },
};

// `info` is last on purpose, and it is not a severity so much as the absence of
// one: a gate reporting at `info` is describing the product, not accusing it.
// `--fail-on=<severity>` indexes into this list, so nothing at `info` can ever
// fail a run.
export const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];

/** The ceiling every firing gate imposes, and which one is binding. */
export function ceilingFor(firedGateIds) {
  let ceiling = 10;
  const binding = [];
  for (const id of firedGateIds) {
    const gate = GATES[id];
    if (!gate || gate.cap === null || gate.confirm) continue;
    if (gate.cap < ceiling) ceiling = gate.cap;
    binding.push(id);
  }
  return {
    ceiling,
    binding: binding.filter((id) => GATES[id].cap === ceiling),
  };
}

/**
 * Everything measurable about the page as it currently stands.
 *
 * Serialized into the page by Playwright, so: no imports, no closure, no
 * optional chaining on things older Chromiums choke on. Returns findings plus
 * an explicit account of what it could NOT measure — a gate that silently
 * skips what it cannot judge is the downscaled screenshot again, wearing a
 * pass.
 *
 * @param {{coarse: boolean, viewport: number, ignore: string[]}} opts
 */
export function collectFindings(opts) {
  const COARSE = opts.coarse === true;
  const IGNORE = (opts.ignore || []).concat([
    "[data-audit-ignore]",
    "[data-audit-ignore] *",
  ]);
  const findings = [];
  const skipped = { contrast: 0, reasons: {} };
  let idSeq = 0;

  // ── Colour, resolved the only way that is always right ──────────────
  //
  // `getComputedStyle` hands back whatever colour space the author wrote in,
  // and this app is Tailwind v4 — so `oklch(0.7 0.1 250)` is a real answer to
  // `color`, and a regex for `rgb(...)` silently reads it as black. Which is
  // exactly the bug class this gate exists to catch, arriving through the
  // gate itself. A 1x1 canvas is the browser's own parser, so it is right for
  // every colour syntax the browser will ever paint.
  const cvs = document.createElement("canvas");
  cvs.width = 1;
  cvs.height = 1;
  const ctx = cvs.getContext("2d", { willReadFrequently: true });
  const colourCache = new Map();

  function toRgba(css) {
    if (!css) return null;
    if (colourCache.has(css)) return colourCache.get(css);
    let out = null;
    try {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000000";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      out = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    } catch {
      out = null;
    }
    colourCache.set(css, out);
    return out;
  }

  /** `over` composited under `top`. Both opaque-or-not; result is `top` on `over`. */
  function composite(top, over) {
    const a = top.a + over.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (top.r * top.a + over.r * over.a * (1 - top.a)) / a,
      g: (top.g * top.a + over.g * over.a * (1 - top.a)) / a,
      b: (top.b * top.a + over.b * over.a * (1 - top.a)) / a,
      a,
    };
  }

  function luminance(c) {
    const ch = [c.r, c.g, c.b].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }

  function ratio(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  // ── The effective background: what is ACTUALLY behind this thing ─────
  //
  // Not the background it was given — the one it ends up on after every
  // transparent ancestor. Dimension 6 of the rubric exists because a chart
  // painted with a custom property this app never defines resolved to black
  // and sat on a black card, and the review that missed it was looking at the
  // colour the component asked for.
  //
  // When the stack contains a gradient or an image, this refuses to answer
  // rather than guessing, and the refusal is counted. A number nobody can
  // check is worse than a hole somebody can see.
  function effectiveBackground(el) {
    // The ink's translucency comes from its ancestors' opacity, whatever
    // turns out to paint behind it.
    let fgOpacity = 1;
    for (let n = el.parentElement; n && n.nodeType === 1; n = n.parentElement) {
      const o = parseFloat(getComputedStyle(n).opacity);
      if (Number.isFinite(o) && o < 1) fgOpacity *= o;
    }
    let acc = { r: 0, g: 0, b: 0, a: 0 };

    const finish = () => {
      // Nothing opaque in the stack: the canvas colour shows through.
      const canvasBg =
        toRgba(getComputedStyle(document.documentElement).backgroundColor) ||
        toRgba(getComputedStyle(document.body).backgroundColor);
      if (canvasBg && canvasBg.a > 0) {
        acc = composite(acc, canvasBg);
        if (acc.a >= 0.999) return { colour: acc, why: null, fgOpacity };
      }
      return { colour: null, why: "no opaque backdrop", fgOpacity };
    };

    // The element's own paint comes first, whatever else is under it — a
    // monogram chip IS its own backdrop, and a walk that starts below the
    // element reports the card behind the chip instead (538 white-on-white
    // findings in one run, every crop a legible purple or black chip).
    {
      const cs = getComputedStyle(el);
      if (cs.backgroundImage && cs.backgroundImage !== "none") {
        return { colour: null, why: "background-image", fgOpacity };
      }
      const own = toRgba(cs.backgroundColor);
      if (own && own.a > 0) {
        acc = composite(acc, own);
        if (acc.a >= 0.999) return { colour: acc, why: null, fgOpacity };
      }
    }

    // Then what is actually PAINTED under the text, topmost first. Walking
    // only the ancestor chain missed every backdrop drawn by a sibling — an
    // SVG bar under its axis label, a positioned chip under a name — and
    // composited the white card behind the chip instead, reporting
    // white-on-white for text that was perfectly legible on its near-black
    // pill (36 findings in one run, every crop fine). `elementsFromPoint`
    // returns the true stacking order with ancestors at their real position,
    // so both kinds of backdrop are one walk. SVG shapes paint with `fill`,
    // not `background-color`.
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (
      r.width > 0 &&
      r.height > 0 &&
      cx >= 0 &&
      cy >= 0 &&
      cx <= window.innerWidth &&
      cy <= window.innerHeight
    ) {
      const stack = document.elementsFromPoint(cx, cy);
      const from = stack.indexOf(el);
      // `el` absent (pointer-events: none, display quirks) means the stack
      // cannot be trusted relative to it — fall through to the ancestor walk.
      if (from !== -1) {
        for (const under of stack.slice(from + 1)) {
          const cs = getComputedStyle(under);
          const svgShape =
            under.namespaceURI === "http://www.w3.org/2000/svg" &&
            under.tagName.toLowerCase() !== "svg";
          if (svgShape) {
            const fill = cs.fill;
            if (fill && fill.startsWith("url(")) {
              return { colour: null, why: "svg paint", fgOpacity };
            }
            const paint = toRgba(fill);
            if (paint && paint.a > 0) {
              const fo = parseFloat(cs.fillOpacity);
              const eo = parseFloat(cs.opacity);
              const a =
                paint.a *
                (Number.isFinite(fo) ? fo : 1) *
                (Number.isFinite(eo) ? eo : 1);
              if (a > 0) {
                acc = composite(acc, { ...paint, a });
                if (acc.a >= 0.999) return { colour: acc, why: null, fgOpacity };
              }
            }
            continue;
          }
          if (cs.backgroundImage && cs.backgroundImage !== "none") {
            return { colour: null, why: "background-image", fgOpacity };
          }
          const bg = toRgba(cs.backgroundColor);
          if (bg && bg.a > 0) {
            acc = composite(acc, bg);
            if (acc.a >= 0.999) return { colour: acc, why: null, fgOpacity };
          }
        }
        return finish();
      }
    }

    // Fallback: the ancestor chain, for text the hit-test cannot see.
    acc = { r: 0, g: 0, b: 0, a: 0 };
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.backgroundImage && cs.backgroundImage !== "none") {
        return { colour: null, why: "background-image", fgOpacity };
      }
      const bg = toRgba(cs.backgroundColor);
      if (bg && bg.a > 0) {
        acc = composite(acc, bg);
        if (acc.a >= 0.999) return { colour: acc, why: null, fgOpacity };
      }
    }
    return finish();
  }

  // ── Bookkeeping ─────────────────────────────────────────────────────

  function ignored(el) {
    for (let i = 0; i < IGNORE.length; i++) {
      try {
        if (el.matches(IGNORE[i]) || el.closest(IGNORE[i])) return true;
      } catch {
        /* a bad selector is the caller's problem, not a crash */
      }
    }
    return false;
  }

  function paintedBox(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return null;
    if (parseFloat(cs.opacity) < 0.05) return null;
    // Off the top or left of the document entirely: a visually-hidden label.
    if (r.bottom < -400 || r.right < -400) return null;
    return r;
  }

  /**
   * The visually-hidden pattern: text clipped to nothing ON PURPOSE, so it
   * reaches a screen reader and not the screen.
   *
   * This has to be recognised by its computed signature rather than by the
   * class name that usually carries it. `.sr-only` is one convention — this
   * codebase also writes the same thing inline, other codebases call it
   * `.visually-hidden`, and a gate keyed on a string is a gate that goes blind
   * the day somebody renames a utility. The signature is what the browser
   * actually ends up with: a box clipped away to a pixel, by any of the three
   * mechanisms that have ever been used to do it.
   *
   * Getting this wrong is expensive in the direction it was wrong: the
   * `clipped` gate was reporting "Toggle Sidebar is cut off with no ellipsis"
   * on nearly every surface, about a span that is CORRECT CODE. Forty nits
   * with two real defects among them is how the two real defects ship.
   */
  function visuallyHidden(el, cs) {
    const style = cs || getComputedStyle(el);
    // `clip-path: inset(50%)` — the modern form.
    if (/inset\(\s*50%/.test(style.clipPath || "")) return true;
    // `clip: rect(0, 0, 0, 0)` — the classic one, and still what Tailwind's
    // `sr-only` emits.
    if (/^rect\(\s*0px(\s*,\s*0px){3}\s*\)$/.test((style.clip || "").trim()))
      return true;
    // Taken out of flow and clipped down to about a pixel. This is the pattern
    // itself rather than any spelling of it.
    const r = el.getBoundingClientRect();
    const tiny = Math.max(r.width, r.height) <= 2;
    const clips =
      style.overflow === "hidden" ||
      style.overflow === "clip" ||
      style.overflowX === "hidden" ||
      style.overflowX === "clip" ||
      style.overflowY === "hidden" ||
      style.overflowY === "clip";
    if (tiny && clips && (style.position === "absolute" || style.position === "fixed"))
      return true;
    return false;
  }

  function describe(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    const cls = typeof el.className === "string" ? el.className : "";
    if (cls) s += "." + cls.trim().split(/\s+/).slice(0, 3).join(".");
    return s;
  }

  /**
   * Where this element is, for the crop.
   *
   * Stamped onto the node rather than expressed as a CSS path: a path built
   * from nth-child is exactly the kind of thing that resolves to a DIFFERENT
   * element after one re-render, and a crop of the wrong element is a finding
   * nobody can act on.
   */
  function stamp(el) {
    let id = el.getAttribute("data-audit-id");
    if (!id) {
      id = "a" + idSeq++;
      el.setAttribute("data-audit-id", id);
    }
    return id;
  }

  function report(gate, el, message, numbers) {
    const r = el ? el.getBoundingClientRect() : null;
    findings.push({
      gate,
      message,
      numbers: numbers || {},
      element: el ? describe(el) : null,
      auditId: el ? stamp(el) : null,
      box: r
        ? {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
          }
        : null,
      // Where in the document, so a crop can scroll to it.
      pageY: r ? Math.round(r.y + window.scrollY) : null,
      pageX: r ? Math.round(r.x + window.scrollX) : null,
    });
  }

  // ── 1. Overlap ──────────────────────────────────────────────────────
  //
  // The gate that had to exist twice: the pure packer proves tiles cannot
  // overlap, and this confirms the renderer agrees. Both halves are needed —
  // the maths can be right while the browser draws something else, which is
  // precisely the gap the original overlap bug lived in.
  {
    const tiles = Array.from(
      document.querySelectorAll("[data-tile], [data-audit-panel]"),
    ).filter((el) => !ignored(el) && paintedBox(el));
    for (let i = 0; i < tiles.length; i++) {
      for (let j = i + 1; j < tiles.length; j++) {
        const a = tiles[i];
        const b = tiles[j];
        if (a.contains(b) || b.contains(a)) continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        // One pixel of tolerance: percentage widths round sub-pixel.
        const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (ox > 1 && oy > 1) {
          report(
            "overlap",
            a,
            `${a.dataset.tile || describe(a)} overlaps ` +
              `${b.dataset.tile || describe(b)} by ${Math.round(ox)}x${Math.round(oy)}px`,
            { overlapX: Math.round(ox), overlapY: Math.round(oy) },
          );
        }
      }
    }
  }

  // ── 2. Spill ────────────────────────────────────────────────────────
  //
  // Boxes not overlapping is not the property anyone cares about. "Nothing is
  // painted over anything" is — and Home passed the box check while every
  // panel painted over the one below it, because the tile did not clip.
  {
    const tiles = document.querySelectorAll("[data-tile]");
    for (const el of tiles) {
      if (ignored(el)) continue;
      // The CONTENT wrapper only. Edit chrome — the remove control, the resize
      // grip — is hung on the corner and straddles the edge by design;
      // measuring it reported a spill on every tile of a healthy screen, which
      // is the kind of false alarm that gets a gate switched off.
      const inner = el.querySelector("[data-tile-inner]");
      if (!inner) continue;
      const box = el.getBoundingClientRect();
      const c = inner.getBoundingClientRect();
      const below = Math.round(c.bottom - box.bottom);
      const right = Math.round(c.right - box.right);
      if (below > 4) {
        report("spill", el, `content spills ${below}px below its tile`, {
          below,
        });
      }
      if (right > 4) {
        report("spill", el, `content spills ${right}px past its right edge`, {
          right,
        });
      }
    }
  }

  // ── 3. Content the reader cannot reach sideways ─────────────────────
  //
  // The obvious measurement — `documentElement.scrollWidth > clientWidth` —
  // is DEAD in this app, and finding that out is the single best argument for
  // calibrating a gate before believing it. `globals.css` pins
  // `html, body { overflow-x: clip }` as a deliberate mobile backstop, so the
  // document can never report a width larger than the viewport no matter what
  // sticks out of it. A gate written that way returns "no horizontal overflow"
  // on a screen that is losing its right-hand column, forever, and it looks
  // exactly like a gate that is working.
  //
  // So the question asked here is the one anybody actually cares about: **is
  // there content the reader cannot get to?** An element past the right edge
  // is fine if some ancestor scrolls horizontally — that is the app's own
  // pattern, wide things scroll inside their own container. It is a defect in
  // every other case, because `clip` and `hidden` do not offer a way to reach
  // what they cut.
  {
    const de = document.documentElement;
    const limit = de.clientWidth;
    const offenders = [];
    for (const el of document.querySelectorAll("html, body, body *")) {
      if (ignored(el)) continue;
      const r = paintedBox(el);
      if (!r) continue;
      // A run of text that does not wrap has no element box of its own: the
      // paragraph holding it is still the width of its containing block, and
      // the letters simply hang out of it. A bounding-box scan cannot see that
      // — which is the shape of the worst harness bug this project has had,
      // where one unwrapped line of layout JSON forced every "390px" shot to
      // 646px. `scrollWidth` is where the overflowing content actually ends.
      //
      // Except on SVG, where `scrollWidth` means nothing and answers anyway.
      // Reading it off an axis label reported a 40px date sitting at 595px in
      // a 390px viewport — a confident, precise, entirely invented number, and
      // the crop is what gave it away. A gate that produces those is worse
      // than one that stays quiet, because somebody will go and look for it.
      //
      // And `scrollWidth` has to be brought into the same coordinate space as
      // the rectangle before the two are added together, which is the bug this
      // paragraph exists to stop coming back. `getBoundingClientRect` is where
      // the element is PAINTED — transforms applied, its own and every
      // ancestor's. `scrollWidth` is a layout-box property and ignores
      // transforms entirely. Adding a transformed `left` to an untransformed
      // width is adding inches to centimetres: it agrees on everything that is
      // not scaled, which is almost everything, and then invents a critical
      // finding on the one surface that is. Arrange mode scales a tile to 0.965
      // and the gate reported "a tile reaches 397px in a 390px viewport" about
      // a surface whose widest painted pixel was 375 — not a defect, an
      // arithmetic error, and it could not surface until the coverage hole over
      // arrange mode was closed. An instrument defect hiding behind an
      // unreachable surface is the hardest kind there is to find.
      //
      // So the overflow is measured as what it is: the content sticking out
      // PAST the element's own box, scaled the way that element is scaled, and
      // added to the painted right edge. When nothing overflows, the answer is
      // simply where the element is painted.
      const svgNs = el.namespaceURI === "http://www.w3.org/2000/svg";
      const layoutWidth = el.offsetWidth;
      const scaleX = layoutWidth > 0 ? r.width / layoutWidth : 1;
      const past = Math.max(0, el.scrollWidth - el.clientWidth);
      const contentRight = svgNs ? r.right : r.right + past * scaleX;
      const over = Math.round(contentRight - limit);
      if (over <= 1) continue;
      // Reachable by scrolling something? Then it is the app working.
      let anc = el.parentElement;
      let scrollable = false;
      while (anc) {
        const cs = getComputedStyle(anc);
        if (cs.overflowX === "auto" || cs.overflowX === "scroll") {
          scrollable = true;
          break;
        }
        anc = anc.parentElement;
      }
      if (scrollable) continue;
      // A container is reported rather than each of its children: the widest
      // ancestor is the thing to fix, and listing forty descendants of one
      // overflowing row is how a real defect gets buried.
      offenders.push({ el, over, right: Math.round(contentRight) });
    }
    const outer = offenders.filter(
      (o) => !offenders.some((p) => p !== o && p.el.contains(o.el)),
    );
    outer.sort((a, b) => b.over - a.over);
    for (const o of outer.slice(0, 3)) {
      report(
        "overflow",
        o.el,
        `${describe(o.el)} reaches ${o.right}px in a ${limit}px viewport — ` +
          `${o.over}px of it is cut off with no way to scroll to it ` +
          `(html is \`overflow-x: clip\`, so the document width reads clean)`,
        { overflow: o.over, right: o.right, viewport: limit },
      );
    }

    // The same defect one layer in: a near-full-width container that clips and
    // is wider inside than out. The dashboard inset does exactly this, which
    // is why a document-level reading cannot see the column it is losing.
    for (const el of document.querySelectorAll("body *")) {
      if (ignored(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < limit * 0.6) continue;
      const cs = getComputedStyle(el);
      if (cs.overflowX !== "hidden" && cs.overflowX !== "clip") continue;
      // A CONTAINER losing a column, not a line of text being shortened.
      // `.truncate` is `overflow:hidden` + `text-overflow:ellipsis` and it is
      // in this product's vocabulary — a panel title that ellipsises at 390 is
      // the design working, and reporting each one as horizontal overflow put
      // 52 false alarms at the top of this file and pinned the score at 5 on
      // nothing. Declared truncation belongs to the `truncated` gate, which
      // says so quietly; a text leaf clipped WITHOUT an ellipsis belongs to
      // `clipped`, which says so loudly. Neither is this.
      if (cs.textOverflow === "ellipsis") continue;
      if (el.childElementCount === 0) continue;
      // Both of these are layout-box properties, so they are already like for
      // like — but the number REPORTED is a number somebody goes and looks for
      // on a screen, so it is converted to painted pixels the same way the
      // scan above is.
      const scale = el.offsetWidth > 0 ? r.width / el.offsetWidth : 1;
      const inner = Math.round((el.scrollWidth - el.clientWidth) * scale);
      if (inner > 4) {
        report(
          "overflow",
          el,
          `${describe(el)} is ${el.scrollWidth}px wide inside a ` +
            `${el.clientWidth}px box that clips — ${inner}px of content is ` +
            `hidden rather than reachable`,
          {
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            overflow: inner,
          },
        );
      }
    }
  }

  // ── 4. Junk values and nameless controls ────────────────────────────
  //
  // The class of bug where a number that was never computed is shown to
  // somebody as though it were. `<pre>`/`<code>` are excluded because the
  // harness itself prints layout JSON into one, and a gate that fires on the
  // instrument's own scaffolding is a gate that gets muted.
  {
    const JUNK = /(^|[\s:>(\[,$£€])(NaN|Infinity|-Infinity|undefined|null|\[object Object\])([\s%,.)\]]|$)/;
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null,
    );
    let node;
    while ((node = walker.nextNode())) {
      const text = (node.nodeValue || "").trim();
      if (!text || text.length > 400) continue;
      const el = node.parentElement;
      if (!el || ignored(el)) continue;
      if (el.closest("pre, code, script, style, textarea")) continue;
      if (!paintedBox(el)) continue;
      if (JUNK.test(text)) {
        report("junk", el, `renders the literal text "${text.slice(0, 80)}"`, {
          text: text.slice(0, 120),
        });
      }
    }

    // A control nobody can name is a control a screen reader cannot offer and
    // a person cannot describe. Reported under the same cap because the rubric
    // puts them together: something required is missing and the screen says so.
    const controls = document.querySelectorAll(
      'button, a[href], [role="button"], [role="tab"], input, select, summary, [role="switch"], [role="checkbox"]',
    );
    for (const el of controls) {
      if (ignored(el)) continue;
      if (!paintedBox(el)) continue;
      const name = accessibleName(el);
      if (!name) {
        report("junk", el, `${el.tagName.toLowerCase()} has no accessible name`, {
          html: el.outerHTML.slice(0, 120),
        });
      }
    }
  }

  function accessibleName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      for (const id of by.split(/\s+/)) {
        const t = document.getElementById(id);
        if (t && (t.textContent || "").trim()) return t.textContent.trim();
      }
    }
    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();
    if (el.tagName === "INPUT") {
      const ph = el.getAttribute("placeholder");
      if (ph && ph.trim()) return ph.trim();
      if (el.id) {
        const lab = document.querySelector('label[for="' + el.id + '"]');
        if (lab && (lab.textContent || "").trim()) return lab.textContent.trim();
      }
      const wrap = el.closest("label");
      if (wrap && (wrap.textContent || "").trim()) return wrap.textContent.trim();
      const t = (el.getAttribute("type") || "text").toLowerCase();
      // A checkbox in a row whose label is the row is named by the row.
      if (t === "checkbox" || t === "radio") {
        const row = el.parentElement;
        if (row && (row.textContent || "").trim()) return row.textContent.trim();
      }
    }
    const text = (el.textContent || "").trim();
    if (text) return text;
    const img = el.querySelector("img[alt], svg title, [aria-label]");
    if (img) {
      const alt =
        img.getAttribute("alt") ||
        img.getAttribute("aria-label") ||
        img.textContent;
      if (alt && alt.trim()) return alt.trim();
    }
    return null;
  }

  // ── 5. Contrast, against the effective background, for real text ────
  {
    const all = document.querySelectorAll("body *");
    for (const el of all) {
      if (ignored(el)) continue;
      // Elements that DIRECTLY hold text. A wrapper inherits its child's
      // reading, so measuring both is one defect reported twice.
      let own = "";
      for (const child of el.childNodes) {
        if (child.nodeType === 3) own += child.nodeValue;
      }
      if (!own.trim()) continue;
      if (el.closest("script, style, [hidden]")) continue;
      // WCAG 1.4.3 exempts inactive controls, and so does this: a disabled
      // button is meant to read as unavailable, and flagging every one of them
      // would bury the failures that matter under the ones that are correct.
      if (el.closest('[disabled], [aria-disabled="true"]')) continue;
      const box = paintedBox(el);
      if (!box) continue;
      const cs = getComputedStyle(el);
      // SVG text is painted by `fill`, not by `color`.
      const isSvg = el.namespaceURI === "http://www.w3.org/2000/svg";
      let inkCss = isSvg ? cs.fill : cs.color;
      if (isSvg && (!inkCss || inkCss === "none")) inkCss = cs.stroke;
      const ink = toRgba(inkCss);
      if (!ink || ink.a === 0) continue;

      // Starting at the element itself, not its parent: text sits on ITS OWN
      // background first. A dark pill with white text inside a white card is
      // correct, and measuring the white card behind the pill would report it
      // as unreadable — a false alarm on a pattern this product uses on every
      // screen, which is the fastest way to get a contrast gate switched off.
      const back = effectiveBackground(el);
      if (!back.colour) {
        skipped.contrast++;
        skipped.reasons[back.why] = (skipped.reasons[back.why] || 0) + 1;
        continue;
      }
      const fg = composite(
        { r: ink.r, g: ink.g, b: ink.b, a: ink.a * back.fgOpacity },
        back.colour,
      );
      const size = parseFloat(cs.fontSize) || 16;
      const weight = parseInt(cs.fontWeight, 10) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const need = large ? 3 : 4.5;
      const got = ratio(fg, back.colour);
      if (got + 0.05 < need) {
        report(
          "contrast",
          el,
          `${got.toFixed(2)}:1 against its effective background ` +
            `(AA needs ${need}:1 at ${Math.round(size)}px/${weight}) — ` +
            `"${own.trim().slice(0, 48)}"`,
          {
            ratio: Number(got.toFixed(2)),
            need,
            fontSize: Math.round(size),
            fontWeight: weight,
            ink: `rgb(${Math.round(fg.r)}, ${Math.round(fg.g)}, ${Math.round(fg.b)})`,
            background: `rgb(${Math.round(back.colour.r)}, ${Math.round(back.colour.g)}, ${Math.round(back.colour.b)})`,
          },
        );
      }
    }
  }

  // ── 6. Ink: a mark you cannot see ───────────────────────────────────
  //
  // The specific history in dimension 6 of the rubric: a vendored chart
  // painted with a custom property this app never defined. `fill: var(--x)`
  // with no `--x` is invalid at computed-value time, so it falls back to the
  // initial value — black — and on a dark card that is a chart that is simply
  // not there. Nothing about the DOM is wrong; only the pixels are.
  {
    const marks = document.querySelectorAll(
      "svg rect, svg path, svg circle, svg ellipse, svg polygon",
    );
    for (const el of marks) {
      if (ignored(el)) continue;
      let box;
      try {
        box = el.getBoundingClientRect();
      } catch {
        continue;
      }
      const area = box.width * box.height;
      // Small enough and it is a tick, a dot or a rounding artefact; big
      // enough and it is the data. Gridlines are strokes with `fill: none`
      // and are meant to be faint, so they never reach here.
      if (area < 150) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const opacity = parseFloat(cs.opacity);
      if (!Number.isFinite(opacity) || opacity < 0.25) continue;
      const fillCss = cs.fill;
      if (!fillCss || fillCss === "none" || fillCss.indexOf("url(") === 0) continue;
      const fill = toRgba(fillCss);
      if (!fill || fill.a * opacity < 0.25) continue;
      const svg = el.ownerSVGElement || el;
      const back = effectiveBackground(svg);
      if (!back.colour) continue;
      const painted = composite(
        { r: fill.r, g: fill.g, b: fill.b, a: fill.a * opacity },
        back.colour,
      );
      const got = ratio(painted, back.colour);
      // 1.2:1 is far below any readability bar on purpose. This is not asking
      // "is this pleasant"; it is asking "is this mark present at all".
      //
      // It started at 1.35 and that was wrong: the muted segment of a donut is
      // `oklch(0.9 0 0)` on white, which measures 1.35 and is plainly there in
      // the crop. Two hundred and forty-two reports of a mark anybody can see
      // is how a gate gets muted, and then the black-on-black it exists for
      // walks through behind it. The specimen it must still catch measures
      // 1.07, so the bar sits between the two rather than on top of one.
      if (got < 1.2) {
        report(
          "ink",
          el,
          `a ${Math.round(box.width)}x${Math.round(box.height)}px mark is ` +
            `${got.toFixed(2)}:1 against its card — effectively invisible`,
          {
            ratio: Number(got.toFixed(2)),
            fill: fillCss,
            background: `rgb(${Math.round(back.colour.r)}, ${Math.round(back.colour.g)}, ${Math.round(back.colour.b)})`,
            area: Math.round(area),
          },
        );
      }
    }
  }

  // ── 7. Clipped and truncated text ───────────────────────────────────
  //
  // Two findings out of one measurement, and the split is the whole value of
  // the gate: text shortened WITH a mark saying so is the design working, and
  // text shortened with nothing saying so is a sentence that ends mid-word.
  // Three things have to be got right for the split to mean anything.
  //
  //   1. Visually-hidden text is not shortened text. It is clipped to a pixel
  //      on purpose so a screen reader gets it and the screen does not, and
  //      reporting it is reporting correct code as a defect.
  //   2. `text-overflow: ellipsis` is not the only deliberate ellipsis in the
  //      product. `line-clamp-*` cuts VERTICALLY and the browser draws the
  //      ellipsis itself — measured as a vertical cut with no `text-overflow`,
  //      which read as the loud finding when it is the quiet one.
  //   3. `text-overflow: ellipsis` on something that WRAPS renders no ellipsis
  //      at all. The declaration is not the behaviour; the single line is.
  {
    for (const el of document.querySelectorAll("body *")) {
      if (ignored(el)) continue;
      let own = "";
      for (const child of el.childNodes) {
        if (child.nodeType === 3) own += child.nodeValue;
      }
      if (!own.trim()) continue;
      const box = paintedBox(el);
      if (!box) continue;
      const cs = getComputedStyle(el);
      if (visuallyHidden(el, cs)) continue;
      const ox = cs.overflowX;
      const oy = cs.overflowY;
      const scrollable =
        ox === "auto" || ox === "scroll" || oy === "auto" || oy === "scroll";
      if (scrollable) continue;
      const hiddenX = ox === "hidden" || ox === "clip";
      const hiddenY = oy === "hidden" || oy === "clip";
      if (!hiddenX && !hiddenY) continue;
      const cutX = hiddenX ? el.scrollWidth - el.clientWidth : 0;
      const cutY = hiddenY ? el.scrollHeight - el.clientHeight : 0;
      if (cutX <= 1 && cutY <= 1) continue;
      const clampRaw = cs.webkitLineClamp || cs.lineClamp || "none";
      const clamp = clampRaw !== "none" ? parseInt(clampRaw, 10) : 0;
      const nowrap = cs.whiteSpace === "nowrap" || cs.whiteSpace === "pre";
      // A single line, declared to ellipsise, cut sideways: the browser draws
      // the mark.
      const singleLineEllipsis =
        cs.textOverflow === "ellipsis" && nowrap && cutX > 1 && cutY <= 1;
      // Clamped to N lines, cut downwards: the browser draws the mark too.
      const clampedEllipsis = clamp > 0 && cutY > 1;
      const ellipsis = singleLineEllipsis || clampedEllipsis;
      report(
        ellipsis ? "truncated" : "clipped",
        el,
        clampedEllipsis
          ? `"${own.trim().slice(0, 40)}" is clamped to ${clamp} line(s) — ` +
            `${cutY}px below the fold of its own box, with an ellipsis`
          : ellipsis
            ? `"${own.trim().slice(0, 40)}" is ellipsised — ${cutX}px hidden`
            : `"${own.trim().slice(0, 40)}" is cut off with no ellipsis — ` +
              `${cutX}px right, ${cutY}px below`,
        {
          cutX,
          cutY,
          clientWidth: el.clientWidth,
          clientHeight: el.clientHeight,
          lineClamp: clamp || undefined,
        },
      );
    }
  }

  // ── 8. Tap targets ──────────────────────────────────────────────────
  //
  // The question is not "how big is this element". It is **how big is the area
  // a finger gets**, which is a different number three times over, and this
  // gate reported the first one for a while and buried its own real findings
  // under eight hundred readings of the wrong box.
  //
  // Three corrections, in the order they apply:
  //
  //   1. **The `::after` hit area.** `.tap-target` hangs an absolutely
  //      positioned pseudo-element with a negative inset under a coarse
  //      pointer, so a 23px glyph is a 41px target. (This was already here and
  //      is why the 30px `.tap-target` control in the calibration fixture stays
  //      quiet — a gate that measured the painted box would call it broken on
  //      every screen in the product.)
  //
  //   2. **The row that forwards the press.** A control inside a `<label>`, or
  //      inside a row that is itself the affordance, is pressed by pressing the
  //      row. A `<label>` forwards by specification and is adopted whatever its
  //      size; anything else is an INFERENCE, so it is adopted only when it is
  //      the control's own padded row (no other target inside it, and no more
  //      than 4x its area) rather than a big card that happens to be clickable.
  //
  //   3. **The free space no other target claims, on ONE axis only.** A 274x20
  //      link that spans its row does not need a finger aimed sideways — only
  //      downwards — and the space above and below it belongs to nothing else,
  //      so the band a press can land in really is 44px. That allowance applies
  //      only to an axis whose PERPENDICULAR extent already clears the floor:
  //      a 32x32 icon button needs aim in two dimensions at once, no amount of
  //      room around it makes the box bigger, and that is exactly the case the
  //      44px floor was written for. It keeps firing, which is the point — the
  //      correction must not be a way of making the number go down.
  if (COARSE) {
    const FLOOR = 43.5;
    const CLICK_PROPS = ["onClick", "onPointerDown", "onMouseDown", "onKeyDown"];
    const ACTIVATES =
      'button, a[href], [role="button"], [role="tab"], [role="switch"], summary, label';

    // Every target on the page first, because two of the three corrections are
    // about a target's relationship to the OTHER targets.
    const targets = [];
    for (const el of document.querySelectorAll(
      'button, a[href], [role="button"], [role="tab"], input:not([type="hidden"]), select, summary, [role="switch"]',
    )) {
      if (ignored(el)) continue;
      const box = paintedBox(el);
      if (!box) continue;
      let w = box.width;
      let h = box.height;
      const after = getComputedStyle(el, "::after");
      if (after && after.content !== "none" && after.position === "absolute") {
        const grow = (v) => {
          const n = parseFloat(v);
          return Number.isFinite(n) && n < 0 ? -n : 0;
        };
        w += grow(after.left) + grow(after.right);
        h += grow(after.top) + grow(after.bottom);
      }
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      targets.push({
        el,
        painted: box,
        hit: {
          left: cx - w / 2,
          right: cx + w / 2,
          top: cy - h / 2,
          bottom: cy + h / 2,
        },
      });
    }

    /** Does pressing this element do something? */
    function activates(el) {
      if (el.matches(ACTIVATES)) return true;
      const key = Object.keys(el).find((k) => k.indexOf("__reactProps$") === 0);
      if (key) {
        const props = el[key] || {};
        for (const h of CLICK_PROPS) if (typeof props[h] === "function") return true;
      }
      return false;
    }

    /**
     * The box a press has to land in to reach this control.
     *
     * A form field is never widened: a text input inside a clickable card is
     * not the card, and pressing the card selects the card rather than putting
     * a caret in the field.
     */
    function reachable(t) {
      let box = { ...t.hit };
      if (t.el.matches("input, select, textarea")) return box;
      const area = (t.hit.right - t.hit.left) * (t.hit.bottom - t.hit.top);
      let node = t.el.parentElement;
      let hops = 0;
      while (node && node !== document.body && hops < 6) {
        // Another target inside means the ancestor's area is shared, so none
        // of it can be attributed to this control.
        if (targets.some((o) => o.el !== t.el && node.contains(o.el))) break;
        if (activates(node)) {
          const r = node.getBoundingClientRect();
          const contains =
            r.left <= box.left + 1 &&
            r.right >= box.right - 1 &&
            r.top <= box.top + 1 &&
            r.bottom >= box.bottom - 1;
          const isLabel = node.tagName === "LABEL";
          if (contains && (isLabel || r.width * r.height <= area * 4)) {
            box = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
          }
        }
        node = node.parentElement;
        hops++;
      }
      return box;
    }

    /**
     * How far the box can grow in one direction before it reaches something a
     * press could be meant for instead. Each of the two targets either side of
     * a gap claims half of it.
     */
    function room(box, t, dir) {
      let nearest = Infinity;
      for (const o of targets) {
        if (o.el === t.el) continue;
        const b = o.hit;
        let d;
        if (dir === "top" || dir === "bottom") {
          if (b.right <= box.left || b.left >= box.right) continue;
          d = dir === "top" ? box.top - b.bottom : b.top - box.bottom;
        } else {
          if (b.bottom <= box.top || b.top >= box.bottom) continue;
          d = dir === "left" ? box.left - b.right : b.left - box.right;
        }
        if (d >= 0 && d < nearest) nearest = d;
      }
      // Sideways, the page edge is a real wall — there is nothing to press out
      // there. Vertically there is not one: a document scrolls.
      const wall =
        dir === "left"
          ? Math.max(0, box.left)
          : dir === "right"
            ? Math.max(0, document.documentElement.clientWidth - box.right)
            : Infinity;
      return Math.min(nearest === Infinity ? Infinity : nearest / 2, wall);
    }

    for (const t of targets) {
      const box = reachable(t);
      const reachW = box.right - box.left;
      const reachH = box.bottom - box.top;
      let w = reachW;
      let h = reachH;
      let free = 0;
      if (reachH >= FLOOR && reachW < FLOOR) {
        const need = (FLOOR - reachW) / 2;
        free =
          Math.min(need, room(box, t, "left")) +
          Math.min(need, room(box, t, "right"));
        w += free;
      } else if (reachW >= FLOOR && reachH < FLOOR) {
        const need = (FLOOR - reachH) / 2;
        free =
          Math.min(need, room(box, t, "top")) +
          Math.min(need, room(box, t, "bottom"));
        h += free;
      }
      if (Math.min(w, h) >= FLOOR) continue;

      // The three numbers are named apart, because a reader who goes looking
      // for a "41x41px" control and finds a 23px glyph will conclude the
      // instrument is lying rather than that the glyph carries a hit area.
      const name = (accessibleName(t.el) || describe(t.el)).slice(0, 40);
      const hitW = t.hit.right - t.hit.left;
      const hitH = t.hit.bottom - t.hit.top;
      const clauses = [];
      if (
        Math.round(hitW) !== Math.round(t.painted.width) ||
        Math.round(hitH) !== Math.round(t.painted.height)
      ) {
        clauses.push(
          `${Math.round(t.painted.width)}x${Math.round(t.painted.height)}px ` +
            `painted, widened by its own \`::after\` hit area`,
        );
      }
      if (Math.round(reachW) !== Math.round(hitW) ||
          Math.round(reachH) !== Math.round(hitH)) {
        clauses.push(
          `measured on the ${Math.round(reachW)}x${Math.round(reachH)}px row ` +
            `that forwards the press to it`,
        );
      }
      if (free > 0.5) {
        clauses.push(
          `including ${Math.round(free)}px of space no other target claims`,
        );
      }
      const how = clauses.length > 0 ? ` — ${clauses.join(", ")}` : "";
      report(
        "tap",
        t.el,
        `"${name}" is ${Math.round(w)}x${Math.round(h)}px of hit area ` +
          `(44 is the floor)${how}`,
        {
          width: Math.round(w),
          height: Math.round(h),
          paintedWidth: Math.round(t.painted.width),
          paintedHeight: Math.round(t.painted.height),
          reachableWidth: Math.round(reachW),
          reachableHeight: Math.round(reachH),
          freeSpace: Math.round(free),
        },
      );
    }
  }

  // ── 9. Controls with nothing behind them ────────────────────────────
  //
  // "A control is present and does nothing" is a rubric cap, and the only way
  // to see it from inside the page is React's own props, which it stamps onto
  // the DOM node. Delegated handlers are real in this app — the customise
  // provider turns a click anywhere on a tile into a selection — so this
  // reports CANDIDATES and says so, and the cap it maps to is marked as
  // needing confirmation. A cap applied on a guess is a cap nobody believes
  // the second time it fires.
  {
    const HANDLERS = [
      "onClick",
      "onPointerDown",
      "onMouseDown",
      "onKeyDown",
      "onChange",
      "onInput",
      "onSubmit",
      "onBlur",
      "onFocus",
      "onTouchStart",
    ];
    const controls = document.querySelectorAll(
      'button, [role="button"], [role="tab"], [role="switch"]',
    );
    for (const el of controls) {
      if (ignored(el)) continue;
      if (!paintedBox(el)) continue;
      if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true")
        continue;
      if (el.getAttribute("type") === "submit" && el.closest("form")) continue;
      const key = Object.keys(el).find((k) => k.indexOf("__reactProps$") === 0);
      // No React props at all means this node was not rendered by React — the
      // gate has nothing to say about it rather than something wrong to say.
      if (!key) continue;
      const props = el[key] || {};
      let handled = false;
      for (const h of HANDLERS) if (typeof props[h] === "function") handled = true;
      if (handled) continue;
      // A delegated handler has to key on something. If an ancestor carries a
      // click handler and this control sits inside it, the press has somewhere
      // to land and this gate stays quiet.
      let anc = el.parentElement;
      let delegated = false;
      while (anc && anc !== document.body) {
        const ak = Object.keys(anc).find((k) => k.indexOf("__reactProps$") === 0);
        if (ak) {
          const ap = anc[ak] || {};
          for (const h of HANDLERS) {
            if (typeof ap[h] === "function") delegated = true;
          }
        }
        if (delegated) break;
        anc = anc.parentElement;
      }
      if (delegated) continue;
      report(
        "inert",
        el,
        `"${(accessibleName(el) || describe(el)).slice(0, 40)}" has no React ` +
          `handler, no ancestor handler and no destination — confirm by pressing it`,
        { tag: el.tagName.toLowerCase() },
      );
    }
  }

  return {
    findings,
    skipped,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      dpr: window.devicePixelRatio,
    },
  };
}
