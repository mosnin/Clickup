// The two gesture properties, measured with a real pointer.
//
// jsdom cannot drag. It has no layout, no pointer capture, no frames — and a
// vertical resize was "fixed" twice against it and reported broken twice by
// the person actually dragging. So the arbiter is a real cursor in a real
// browser, and what it asserts is the rubric's cap: **a gesture writes once,
// and the thing lands where it was released.**
//
// Both measurements run against the real grid AND against a fixture that is
// deliberately wrong in exactly these ways (`broken.html?defect=gesture`),
// which is what makes a green reading from the real grid worth anything. The
// broken fixture wears the real grid's DOM contract — `[data-tile]`,
// `#write-count`, `#layout-json`, a grip labelled "Resize <title>" — so the
// checker below is the same checker in both runs. A calibration fixture that
// needed its own checker would prove nothing about the checker that ships.

const grip = /^Resize /;

async function writeCount(page) {
  const el = await page.$("#write-count");
  if (!el) return null;
  return Number((await el.innerText()).trim());
}

async function orderOf(page) {
  return page.$$eval("[data-tile]", (els) =>
    els.map((e) => e.getAttribute("data-tile")),
  );
}

async function heightOf(page, id) {
  const box = await page.locator(`[data-tile="${id}"]`).boundingBox();
  return box ? box.height : null;
}

/**
 * Pull the corner down and watch.
 *
 * Three numbers come back and each answers a different way this can be wrong:
 * `steps` (does it follow the finger, or quantise and jump), `writes` (is one
 * intention one write), and `driftAfterRelease` (did the screen correct itself
 * after the pointer let go, which is the screen disagreeing with the gesture).
 */
export async function measureResize(page, tileId = "a") {
  const before = await heightOf(page, tileId);
  const neighbourBefore = await heightOf(page, "b");
  const handle = page.getByLabel(grip).first();
  const box = await handle.boundingBox();
  if (!box) return { reachable: false, why: "no resize grip on the page" };

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  const writesBefore = await writeCount(page);
  await page.mouse.down();
  const heights = [];
  for (let i = 1; i <= 13; i++) {
    await page.mouse.move(cx, cy + i * 20);
    await page.waitForTimeout(16);
    heights.push(Math.round((await heightOf(page, tileId)) ?? 0));
  }
  // The height the pointer was released AT, read before the release, so a
  // correction that happens on mouseup is visible as a difference rather than
  // absorbed into a single reading.
  const atRelease = Math.round((await heightOf(page, tileId)) ?? 0);
  await page.mouse.up();
  await page.waitForTimeout(900);
  const after = Math.round((await heightOf(page, tileId)) ?? 0);
  const writesAfter = await writeCount(page);
  const neighbourAfter = await heightOf(page, "b");

  let committed = null;
  const json = await page.$("#layout-json");
  if (json) {
    try {
      const layout = JSON.parse((await json.innerText()).trim());
      committed = (layout.widgets || []).find((w) => w.id === tileId) ?? null;
    } catch {
      committed = null;
    }
  }

  return {
    reachable: true,
    distinctHeights: new Set(heights).size,
    heights,
    heightBefore: Math.round(before ?? 0),
    heightAtRelease: atRelease,
    heightAfter: after,
    driftAfterRelease: Math.abs(after - atRelease),
    grew: after - Math.round(before ?? 0),
    writes:
      writesBefore === null || writesAfter === null
        ? null
        : writesAfter - writesBefore,
    committed,
    neighbourChanged:
      Math.abs((neighbourAfter ?? 0) - (neighbourBefore ?? 0)) > 2,
  };
}

/**
 * Drag one tile onto another and look TWICE.
 *
 * Once right after the drop and once after another beat: "saves out of place
 * then glitches in" is a late write landing, and a single reading taken at the
 * moment of release cannot see it. That is the bug this measurement exists
 * for, and it is why the two readings are separate fields rather than one.
 */
export async function measureReorder(page, fromId = "a", toId = "b") {
  const from = await page.locator(`[data-tile="${fromId}"]`).boundingBox();
  const to = await page.locator(`[data-tile="${toId}"]`).boundingBox();
  if (!from || !to) return { reachable: false, why: "tiles not on the page" };

  const before = await orderOf(page);
  const writesBefore = await writeCount(page);
  await page.mouse.move(from.x + from.width / 2, from.y + 40);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(
      from.x + from.width / 2 + ((to.x - from.x) * i) / 20,
      from.y + 40 + ((to.y - from.y) * i) / 20,
    );
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(500);
  const atDrop = await orderOf(page);
  await page.waitForTimeout(900);
  const settled = await orderOf(page);
  const writesAfter = await writeCount(page);

  return {
    reachable: true,
    before,
    atDrop,
    settled,
    correctedAfterDrop: atDrop.join(",") !== settled.join(","),
    writes:
      writesBefore === null || writesAfter === null
        ? null
        : writesAfter - writesBefore,
  };
}

/**
 * The rubric's cap, stated over the two measurements.
 *
 * Returns findings in the audit's own shape so the runner does not have to
 * know what a gesture is — it only has to know that a gate fired.
 */
export function gestureFindings(surface, resize, reorder) {
  const out = [];
  const add = (message, numbers) =>
    out.push({ gate: "gesture", message, numbers, element: null, auditId: null });

  if (resize && resize.reachable) {
    if (resize.writes !== null && resize.writes > 1) {
      add(
        `one resize gesture produced ${resize.writes} writes — racing writes ` +
          `rebuild the draggable under the finger`,
        { writes: resize.writes },
      );
    }
    // ── What "landed where it was released" has to mean here ──
    //
    // The naive rule — the height after release equals the height at release —
    // is WRONG for this grid, and getting that wrong is how a gate ends up
    // muted. A tile's committed size is quantised to whole rows on purpose, so
    // a settle of up to half a row is the design working, not a disagreement.
    // Measured against the real grid it is about 74px, and reporting that as a
    // cap-hitting defect would be a false alarm on a screen with nothing wrong
    // with it.
    //
    // What is unambiguous, and needs no knowledge of the row ladder: the
    // settle must not carry the tile back PAST where the gesture started. If
    // you pull a tile down and it ends up no taller than before you touched
    // it, the screen threw the gesture away — which is exactly the defect that
    // was reported by a person twice and passed by jsdom twice.
    const pulled = resize.heightAtRelease - resize.heightBefore;
    const kept = resize.heightAfter - resize.heightBefore;
    if (pulled > 60 && kept <= 8) {
      add(
        `the tile was pulled to ${resize.heightAtRelease}px and settled back ` +
          `to ${resize.heightAfter}px — no taller than the ${resize.heightBefore}px ` +
          `it started at. The gesture was thrown away after release`,
        {
          heightBefore: resize.heightBefore,
          heightAtRelease: resize.heightAtRelease,
          heightAfter: resize.heightAfter,
        },
      );
    }
    if (resize.distinctHeights < 8) {
      add(
        `the resize moved in ${resize.distinctHeights} jumps over 13 pointer ` +
          `moves — it is quantising during the gesture instead of following ` +
          `the pointer`,
        { distinctHeights: resize.distinctHeights },
      );
    }
    if (resize.neighbourChanged) {
      add("resizing one tile changed the height of its neighbour", {});
    }
  }

  if (reorder && reorder.reachable) {
    if (reorder.writes !== null && reorder.writes > 1) {
      add(`one reorder gesture produced ${reorder.writes} writes`, {
        writes: reorder.writes,
      });
    }
    if (reorder.correctedAfterDrop) {
      add(
        `the arrangement changed after the drop ` +
          `(${reorder.atDrop.join(",")} -> ${reorder.settled.join(",")}) — ` +
          `that is "saves out of place then glitches in"`,
        { atDrop: reorder.atDrop, settled: reorder.settled },
      );
    }
  }

  for (const f of out) f.surface = surface;
  return out;
}
