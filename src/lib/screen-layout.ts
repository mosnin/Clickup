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

export type ScreenWidget = { id: string; span: WidgetSpan };

export type ScreenLayout = { widgets: ScreenWidget[] };

const SPANS: WidgetSpan[] = [1, 2, 3];

function clampSpan(value: unknown, fallback: WidgetSpan = 1): WidgetSpan {
  const n = typeof value === "number" ? Math.round(value) : Number.NaN;
  return (SPANS as number[]).includes(n) ? (n as WidgetSpan) : fallback;
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
    widgets.push({ id, span: clampSpan((entry as { span?: unknown }).span) });
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
