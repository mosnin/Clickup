// Where every tile actually is.
//
// The canvas ran two layout models at once and they disagreed. CSS Grid placed
// tiles into tracks it computed, while the tiles themselves carried explicit
// pixel heights and column spans. When a tile's height exceeded the track Grid
// had assigned it, the tile spilled — and the tiles below were already placed,
// so they did not move. That is where the overlapping panels came from, and it
// is why eight consecutive fixes at the call sites each moved the failure
// somewhere else rather than ending it: nothing in the system owned where a
// tile was.
//
// This owns it. `pack` is the only thing that decides geometry, it is pure, and
// everything else draws what it returns.
//
// **Overlap is impossible by construction rather than prevented.** The
// occupancy grid is consulted before a tile is placed and marked after, so
// there is no ordering of inputs — no drag, no resize, no race with a
// subscription — that can produce two tiles in one cell. That is a different
// claim from "we fixed the overlap", and it is the reason this is worth
// rebuilding rather than patching.
//
// **The input is the layout we already store.** `ScreenLayout` is an ordered
// list of `{id, span, rows}`; that is already an order plus sizes, which is
// exactly what a packer needs. Dragging reorders the list, resizing changes a
// size, and geometry falls out. No migration, no second source of truth.
//
// **Everything is in grid units.** Pixels belong to the renderer, which knows
// the column width and the row height. Keeping this in units is what lets the
// same function answer for a phone (one column) and a desktop (three) without
// a second code path — the failure mode that made mobile its own bug surface.

/** A tile asking for space, in grid units. */
export type PackItem = {
  id: string;
  /** Columns wide. Clamped into the grid — a tile can never be wider. */
  w: number;
  /** Rows tall. */
  h: number;
};

/** Where a tile ended up. Origin is top-left, in grid units. */
export type Rect = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

/**
 * Lay items out in reading order, first fit, compacted upward.
 *
 * First fit rather than best fit on purpose. Best fit produces a denser sheet
 * and an unpredictable one: moving a tile can pull an unrelated tile from three
 * rows below into the hole it left, which reads as the screen rearranging
 * itself behind your back. First fit in the list's own order means the order
 * you can see is the order it lays out, so a drag has a consequence you could
 * have predicted before you let go.
 */
export function pack(items: readonly PackItem[], columns: number): Rect[] {
  const cols = Math.max(1, Math.floor(columns));
  // Row-major occupancy. Rows are grown on demand, so a tall tile at the
  // bottom cannot run off the end of a fixed-size grid.
  const filled: boolean[][] = [];
  const out: Rect[] = [];

  const rowAt = (y: number): boolean[] => {
    while (filled.length <= y) filled.push(new Array(cols).fill(false));
    return filled[y]!;
  };

  const free = (x: number, y: number, w: number, h: number): boolean => {
    for (let dy = 0; dy < h; dy += 1) {
      const row = rowAt(y + dy);
      for (let dx = 0; dx < w; dx += 1) if (row[x + dx]) return false;
    }
    return true;
  };

  for (const item of items) {
    // Clamped, never rejected: a tile asking for four columns in a
    // three-column grid is a tile that wants to be as wide as possible, and
    // dropping it would make a panel vanish on a narrow screen.
    const w = Math.min(Math.max(1, Math.floor(item.w)), cols);
    const h = Math.max(1, Math.floor(item.h));

    let placed = false;
    for (let y = 0; !placed; y += 1) {
      for (let x = 0; x + w <= cols; x += 1) {
        if (!free(x, y, w, h)) continue;
        for (let dy = 0; dy < h; dy += 1) {
          const row = rowAt(y + dy);
          for (let dx = 0; dx < w; dx += 1) row[x + dx] = true;
        }
        out.push({ id: item.id, x, y, w, h });
        placed = true;
        break;
      }
    }
  }

  return out;
}

/** How many rows the packed sheet occupies. What the renderer sizes to. */
export function packedRows(rects: readonly Rect[]): number {
  let rows = 0;
  for (const r of rects) rows = Math.max(rows, r.y + r.h);
  return rows;
}

/**
 * Move one tile to the slot nearest a point, and return the new ORDER.
 *
 * Order rather than geometry, because the order is what gets stored and what
 * `pack` reads — returning rects here would mean two representations of one
 * arrangement, which is the mistake this file exists to undo.
 *
 * The slot is chosen by which packed rect contains the point, falling back to
 * the nearest by centre so a drop into a gap between tiles still lands
 * somewhere rather than being ignored.
 */
export function orderAfterMove(
  items: readonly PackItem[],
  columns: number,
  id: string,
  point: { x: number; y: number },
): string[] {
  const ids = items.map((i) => i.id);
  const from = ids.indexOf(id);
  if (from < 0) return ids;

  const rects = pack(items, columns);
  const hit =
    rects.find(
      (r) =>
        r.id !== id &&
        point.x >= r.x &&
        point.x < r.x + r.w &&
        point.y >= r.y &&
        point.y < r.y + r.h,
    ) ??
    nearest(
      rects.filter((r) => r.id !== id),
      point,
    );
  if (!hit) return ids;

  const to = ids.indexOf(hit.id);
  if (to < 0 || to === from) return ids;

  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

function nearest(rects: readonly Rect[], point: { x: number; y: number }) {
  let best: Rect | null = null;
  let bestD = Infinity;
  for (const r of rects) {
    const dx = r.x + r.w / 2 - point.x;
    const dy = r.y + r.h / 2 - point.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}

/** Do any two of these rectangles share a cell? Only ever false. */
export function anyOverlap(rects: readonly Rect[]): boolean {
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i]!;
      const b = rects[j]!;
      if (
        a.x < b.x + b.w &&
        b.x < a.x + a.w &&
        a.y < b.y + b.h &&
        b.y < a.y + a.h
      ) {
        return true;
      }
    }
  }
  return false;
}
