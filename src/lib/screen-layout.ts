// Screen layouts: which panels a person wants, in what order, at what width.
//
// The pure half, same discipline as src/lib/appearance.ts — a layout is data,
// and every operation on it is a total function that can be tested without a
// browser. The registry of what a widget *is* lives with the components
// (project-screen/widgets.tsx); this module only knows ids and spans.
//
// The rule that shapes everything: **an empty layout is legitimate.** Someone
// who removes every panel wants a blank project screen, not the defaults back.
// So `normalizeLayout` drops what it can't render and clamps what it can, but
// it never helpfully re-adds anything — the only thing that produces the
// default layout is never having customised at all.

/** How many columns of the 3-wide grid a widget occupies. */
export type WidgetSpan = 1 | 2 | 3;

/**
 * How many grid rows tall a widget is.
 *
 * Height used to be a property of the *widget definition* — whoever wrote the
 * panel decided how tall it was, forever, for everyone. That is the wrong
 * owner: how much room a chart deserves on your screen is your judgement, not
 * the judgement of the person who wrote the chart. Absent means "the height
 * the panel was designed at", which is what keeps a layout sparse.
 */
export type WidgetRows = 1 | 2 | 3;

export type ScreenWidget = {
  id: string;
  span: WidgetSpan;
  rows?: WidgetRows;
};

export type ScreenLayout = { widgets: ScreenWidget[] };

const SPANS: WidgetSpan[] = [1, 2, 3];
const ROWS: WidgetRows[] = [1, 2, 3];

function clampSpan(value: unknown, fallback: WidgetSpan = 1): WidgetSpan {
  const n = typeof value === "number" ? Math.round(value) : Number.NaN;
  return (SPANS as number[]).includes(n) ? (n as WidgetSpan) : fallback;
}

/** Undefined stays undefined: absence means "whatever it was designed at". */
function clampRows(value: unknown): WidgetRows | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === "number" ? Math.round(value) : Number.NaN;
  return (ROWS as number[]).includes(n) ? (n as WidgetRows) : undefined;
}

/**
 * Coerce stored or incoming data into a renderable layout.
 *
 * `available` is the set of widget ids this build knows how to render. An id
 * that isn't in it is dropped rather than rendered as a hole — a layout saved
 * by a newer build, or one referencing a widget that has since been removed,
 * has to degrade to "the panels I do understand".
 */
export function normalizeLayout(
  input: unknown,
  available: readonly string[],
): ScreenLayout {
  const known = new Set(available);
  const raw = (input as { widgets?: unknown } | null | undefined)?.widgets;
  if (!Array.isArray(raw)) return { widgets: [] };

  const seen = new Set<string>();
  const widgets: ScreenWidget[] = [];
  for (const entry of raw) {
    const id = (entry as { id?: unknown })?.id;
    if (typeof id !== "string" || !known.has(id) || seen.has(id)) continue;
    seen.add(id);
    const rows = clampRows((entry as { rows?: unknown }).rows);
    widgets.push({
      id,
      span: clampSpan((entry as { span?: unknown }).span),
      // Only carried when it was actually set. A layout that stored every
      // widget's designed height could never track a redesign of that widget.
      ...(rows === undefined ? {} : { rows }),
    });
  }
  return { widgets };
}

/** Is this layout the one a user gets before they have customised anything? */
export function isDefaultLayout(
  layout: ScreenLayout,
  fallback: ScreenLayout,
): boolean {
  if (layout.widgets.length !== fallback.widgets.length) return false;
  return layout.widgets.every(
    (w, i) =>
      w.id === fallback.widgets[i].id && w.span === fallback.widgets[i].span,
  );
}

/** Move a widget to a new index, clamped. Returns a new layout. */
export function moveWidget(
  layout: ScreenLayout,
  from: number,
  to: number,
): ScreenLayout {
  const widgets = [...layout.widgets];
  if (from < 0 || from >= widgets.length) return layout;
  const target = Math.min(Math.max(to, 0), widgets.length - 1);
  if (target === from) return layout;
  const [moved] = widgets.splice(from, 1);
  widgets.splice(target, 0, moved);
  return { widgets };
}

/** Move by id — what a drag-and-drop library hands you. */
export function moveWidgetById(
  layout: ScreenLayout,
  activeId: string,
  overId: string,
): ScreenLayout {
  const from = layout.widgets.findIndex((w) => w.id === activeId);
  const to = layout.widgets.findIndex((w) => w.id === overId);
  if (from === -1 || to === -1) return layout;
  return moveWidget(layout, from, to);
}

export function removeWidget(layout: ScreenLayout, id: string): ScreenLayout {
  return { widgets: layout.widgets.filter((w) => w.id !== id) };
}

/** Append a widget at its natural width, ignoring a duplicate. */
export function addWidget(
  layout: ScreenLayout,
  id: string,
  span: WidgetSpan = 1,
): ScreenLayout {
  if (layout.widgets.some((w) => w.id === id)) return layout;
  return { widgets: [...layout.widgets, { id, span: clampSpan(span) }] };
}

/**
 * Cycle a widget's width, bounded by what it can actually render at.
 *
 * A single control that cycles is the right shape here: three widths is too
 * few to deserve a menu, and a widget that can't go narrower than two columns
 * should skip 1 rather than offer it and snap back.
 */
export function cycleSpan(
  layout: ScreenLayout,
  id: string,
  bounds: { min: WidgetSpan; max: WidgetSpan },
): ScreenLayout {
  const options = SPANS.filter((s) => s >= bounds.min && s <= bounds.max);
  if (options.length === 0) return layout;
  return {
    widgets: layout.widgets.map((w) => {
      if (w.id !== id) return w;
      const at = options.indexOf(w.span);
      const next = options[(at + 1) % options.length];
      return { ...w, span: next };
    }),
  };
}

/** Widget ids the user hasn't placed, in registry order. */
export function unusedWidgets(
  layout: ScreenLayout,
  available: readonly string[],
): string[] {
  const placed = new Set(layout.widgets.map((w) => w.id));
  return available.filter((id) => !placed.has(id));
}

/**
 * The key a layout is stored under.
 *
 * Prefixed by kind so this generalises past projects without a migration: a
 * space screen, a list screen and a home screen are all just another key.
 */
export function screenKey(kind: "project" | "space" | "home", id: string): string {
  return `${kind}:${id}`;
}

// ── Direct manipulation ─────────────────────────────────────────────────

export type Point = { x: number; y: number };

/**
 * Which slot a dragged tile should occupy, given where the pointer is.
 *
 * Nearest centre wins, but only if it wins by enough. Without the hysteresis
 * band a pointer resting near a boundary flips between two slots on sub-pixel
 * movement, and every flip reorders the grid — so the tiles under your finger
 * shudder back and forth and the drop lands wherever the jitter happened to
 * leave things. Requiring the new slot to be meaningfully closer makes the
 * reorder feel decisive, which is the same reason a real home screen only
 * displaces an icon once you are properly over its neighbour.
 *
 * Pure so the rule can be tested without a browser: this is arithmetic about
 * boxes, not a question about React.
 */
export function slotForPointer(
  centers: readonly Point[],
  pointer: Point,
  current: number,
  hysteresis = 16,
): number {
  if (centers.length === 0) return current;
  const distanceTo = (i: number) =>
    Math.hypot(centers[i].x - pointer.x, centers[i].y - pointer.y);

  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < centers.length; i += 1) {
    const d = distanceTo(i);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  if (best === current) return current;

  // Staying put is the default, so the challenger has to earn the swap.
  const currentDistance =
    current >= 0 && current < centers.length
      ? distanceTo(current)
      : Number.POSITIVE_INFINITY;
  return currentDistance - bestDistance > hysteresis ? best : current;
}

/** Centres of a set of tiles, in document coordinates. */
export function centersOf(elements: readonly Element[]): Point[] {
  return elements.map((el) => {
    const box = el.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  });
}

/**
 * Insert a widget at a specific slot — what dragging out of the tray needs.
 *
 * Appending and then moving would fire two layout changes and two animations
 * for one gesture; landing it directly where the pointer let go is one.
 */
export function insertWidget(
  layout: ScreenLayout,
  id: string,
  span: WidgetSpan,
  at: number,
): ScreenLayout {
  if (layout.widgets.some((w) => w.id === id)) return layout;
  const widgets = [...layout.widgets];
  const slot = Math.min(Math.max(at, 0), widgets.length);
  widgets.splice(slot, 0, { id, span: clampSpan(span) });
  return { widgets };
}


/**
 * What a proposed layout would change, in words a banner can use.
 *
 * The diff is the consent surface: "Accept" is only meaningful if the person
 * can see what they are accepting without playing spot-the-difference between
 * two grids. Compared over the ids both sides know; a proposal is judged on
 * what it does, not on panels this build can't render anyway.
 */
export function describeLayoutChange(
  current: ScreenLayout,
  proposed: ScreenLayout,
): { added: string[]; removed: string[]; resized: string[]; reordered: boolean } {
  const currentById = new Map(current.widgets.map((w) => [w.id, w]));
  const proposedById = new Map(proposed.widgets.map((w) => [w.id, w]));

  const added = proposed.widgets
    .filter((w) => !currentById.has(w.id))
    .map((w) => w.id);
  const removed = current.widgets
    .filter((w) => !proposedById.has(w.id))
    .map((w) => w.id);
  const resized = proposed.widgets
    .filter((w) => {
      const before = currentById.get(w.id);
      return before !== undefined && before.span !== w.span;
    })
    .map((w) => w.id);

  const sharedBefore = current.widgets
    .filter((w) => proposedById.has(w.id))
    .map((w) => w.id);
  const sharedAfter = proposed.widgets
    .filter((w) => currentById.has(w.id))
    .map((w) => w.id);
  const reordered = sharedBefore.join(" ") !== sharedAfter.join(" ");

  return { added, removed, resized, reordered };
}


/** An axis-aligned box, as getBoundingClientRect gives it. */
export type Box = { left: number; top: number; right: number; bottom: number };

/**
 * Which OTHER tile the pointer is inside, for drag reordering.
 *
 * The subtle bug this exists to prevent: computing "nearest slot" over ALL
 * tiles includes the dragged tile itself, whose centre is glued to the pointer
 * at distance zero — so it is always its own nearest slot and no reorder can
 * ever happen. The dragged tile must be excluded, and containment (not
 * nearest-centre) is the right test between non-overlapping boxes: it is
 * naturally hysteretic, because the gaps between tiles belong to nobody.
 */
export function hoveredIndex(
  boxes: readonly (Box | null)[],
  pointer: Point,
  exclude: number,
): number {
  for (let i = 0; i < boxes.length; i += 1) {
    if (i === exclude) continue;
    const b = boxes[i];
    if (!b) continue;
    if (
      pointer.x >= b.left &&
      pointer.x <= b.right &&
      pointer.y >= b.top &&
      pointer.y <= b.bottom
    ) {
      return i;
    }
  }
  return -1;
}
