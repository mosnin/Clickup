// Real ink bounds for a word, glyph by glyph.
//
// Authored here rather than supplied with the rest of design-tiles: `engine.ts`
// imports it, so its contract is fixed by that file — `measureWord`, `REF_FS`,
// `BASELINE_Y`, `WordMetrics` — and everything below exists to satisfy exactly
// those four.
//
// Why measurement at all, when a coloured box behind a word is a `<span>` with
// a background: because these boxes are butted EDGE TO EDGE with no gap, and a
// box sized by CSS padding is sized to the font's line box, not to its ink. The
// letters would then float in a band of uniform height and the bar would read as
// a row of tags. Sizing each rect to the glyph it covers is what makes the strip
// read as one solid shape that happens to have letters cut out of it — and that
// only works if the numbers are the LIVE font's, not a ratio assumed from one.
//
// Everything is expressed against a reference em (`REF_FS`) and then scaled by
// the SVG viewBox, so a resize is a viewBox change and never a re-measure.

/** The em the metrics are expressed in. The SVG viewBox scales from here. */
export const REF_FS = 100;

/**
 * Where the baseline sits in that space.
 *
 * Chosen so a normal face's ascenders and descenders both land inside the band
 * `engine.ts` clamps to (`BASELINE_Y - 82` … `BASELINE_Y + 26`): at a 100px em a
 * grotesque ascends ~75 and descends ~21, so nothing ordinary touches the clamp
 * and the clamp only catches a face with unusual extremes.
 */
export const BASELINE_Y = 100;

export interface Glyph {
  ch: string;
  /** Pen position — the left edge of this glyph's advance. */
  x: number;
  /** Advance width. `engine.ts` prefers the next glyph's `x` where there is one. */
  w: number;
  /** Ink top, baseline-relative already resolved against `BASELINE_Y`. */
  top: number;
  /** Ink bottom, same space. */
  bottom: number;
}

export interface WordMetrics {
  /** Total advance of the word. */
  width: number;
  glyphs: Glyph[];
}

// One canvas for the life of the page. Measuring is the only thing it does.
let ctx: CanvasRenderingContext2D | null | undefined;

function context(): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx;
  if (typeof document === "undefined") {
    ctx = null;
    return ctx;
  }
  ctx = document.createElement("canvas").getContext("2d");
  return ctx;
}

// Keyed on everything that can change an answer. The word set is tiny and the
// font changes once (at `document.fonts.ready`), so this settles immediately —
// but `engine.ts` re-measures on every resize, and re-measuring six words per
// resize frame is work nobody asked for.
const cache = new Map<string, WordMetrics | null>();

/**
 * Measure one word in the given face.
 *
 * Returns `null` when there is nothing to measure against — no document, no 2D
 * context, or a face that reports zero width. `engine.ts` draws its fallback
 * block in that case, which is deliberately not an approximation: a guessed
 * metric is a hairline gap between two rects that are supposed to touch, and a
 * visibly wrong bar is easier to catch than a subtly wrong one.
 */
export function measureWord(
  word: string,
  fontFamily: string,
  weight: string,
): WordMetrics | null {
  const key = `${weight}|${REF_FS}|${fontFamily}|${word}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const c = context();
  if (!c) return null;

  c.font = `${weight} ${REF_FS}px ${fontFamily}`;

  const total = c.measureText(word).width;
  if (!(total > 0)) {
    cache.set(key, null);
    return null;
  }

  const chars = Array.from(word);
  const glyphs: Glyph[] = [];

  // Pen positions come from PREFIX widths rather than from summing per-character
  // advances: the difference between the two is kerning, and kerning is exactly
  // the amount by which a rect would sit off its letter.
  let x = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const nextX =
      i === chars.length - 1
        ? total
        : c.measureText(chars.slice(0, i + 1).join("")).width;

    const m = c.measureText(ch);
    // Ink bounds, not the line box. A space has no ink and reports zero for
    // both, which is right — `engine.ts` skips it rather than drawing a rect.
    const ascent = m.actualBoundingBoxAscent ?? 0;
    const descent = m.actualBoundingBoxDescent ?? 0;

    glyphs.push({
      ch,
      x,
      w: Math.max(0, nextX - x),
      top: BASELINE_Y - ascent,
      bottom: BASELINE_Y + descent,
    });
    x = nextX;
  }

  const metrics: WordMetrics = { width: total, glyphs };
  cache.set(key, metrics);
  return metrics;
}
