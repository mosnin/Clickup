// What the browser actually painted, measured.
//
// Two questions, and they are not the same one — which is the whole reason this
// file exists rather than one function.
//
// **Do any two tiles share a pixel?** `pack` proves that cannot happen in the
// abstract; this checks the claim against what was drawn, because the maths can
// be right while the renderer draws something else. That gap is precisely how
// the overlap shipped: the old suite proved things about a model nothing
// rendered from.
//
// **Is anything painted outside its tile?** The box check above passed while
// every panel on Home overlapped the one below it. The BOXES were right — the
// packer had done its job — but the tile did not clip, so a 458px table inside a
// 168px box painted straight over its neighbour. A gate that measures the
// correct thing can still miss the failure one layer inside it, and "no
// overlapping boxes" is not the property anyone cares about; "nothing is painted
// over anything" is.
//
// Shared rather than copied per harness, because a gate that exists in two
// versions is a gate that will one day pass in one of them.

/** `id overlaps id` for every pair of tiles sharing a pixel. Only ever empty. */
export async function overlapsOn(page) {
  return page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll("[data-tile]")).map(
      (el) => ({ id: el.dataset.tile, ...el.getBoundingClientRect().toJSON() }),
    );
    const hits = [];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        // One pixel of tolerance for sub-pixel rounding on percentage widths.
        if (
          a.left < b.right - 1 &&
          b.left < a.right - 1 &&
          a.top < b.bottom - 1 &&
          b.top < a.bottom - 1
        ) {
          hits.push(`${a.id} overlaps ${b.id}`);
        }
      }
    }
    return hits;
  });
}

/** Content painting past the tile that owns it. Only ever empty. */
export async function spillsOn(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("[data-tile]")) {
      // The CONTENT wrapper only. The edit chrome — the remove control, the
      // resize grip — is deliberately hung on the tile's corner and straddles
      // the edge by design; measuring it reported a spill on every tile on a
      // screen with nothing wrong with it, which is the kind of false alarm
      // that gets a gate switched off.
      const inner = el.querySelector("[data-tile-inner]");
      if (!inner) continue;
      const box = el.getBoundingClientRect();
      const c = inner.getBoundingClientRect();
      const below = Math.round(c.bottom - box.bottom);
      const right = Math.round(c.right - box.right);
      // A few px of slack for shadows and focus rings.
      if (below > 4) {
        out.push(`${el.dataset.tile} content spills ${below}px below its tile`);
      }
      if (right > 4) {
        out.push(`${el.dataset.tile} content spills ${right}px past its right edge`);
      }
    }
    return out;
  });
}
