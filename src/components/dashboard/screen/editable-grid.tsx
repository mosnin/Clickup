"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus, X } from "lucide-react";
import {
  RELEASE,
  createDraggable,
  createMagneticField,
  inhale,
  jiggle,
  morphLayout,
  scaled,
  settleDeform,
  tearOut,
  velocityDeform,
  type Draggable,
} from "@/lib/anime";
import {
  centersOf,
  slotForPointer,
  type ScreenLayout,
  type WidgetSpan,
} from "@/lib/screen-layout";
import { cn } from "@/lib/utils";

// The screen, edited the way a phone's home screen is edited.
//
// There is no settings page here and there never should be. Nobody arranges
// their phone by opening a panel of layout options — you hold a thing until the
// screen admits it can be moved, and then you move it. The surface you are
// looking at *is* the editor, which means there is no second model to learn and
// no gap between "what I see" and "what I am configuring".
//
// Three things make that work, and all three are physics rather than
// transitions:
//
//   - **The wobble is the mode.** Desynchronised, sub-degree, and it starts on
//     long-press. It is the only thing that has to be learned, and phones have
//     already taught it to everyone.
//   - **The grid reacts before you commit.** Neighbours lean toward whatever is
//     under your finger and reflow as you cross them, so the consequence of
//     letting go is visible while you can still change your mind.
//   - **Weight.** The dragged tile deforms with its own velocity and releases on
//     a spring. Without that it is a rectangle whose coordinates are changing;
//     with it, it is an object being thrown.
//
// Everything degrades to instant when motion is turned down, and every gesture
// has a keyboard equivalent, because long-press is not an accessible affordance
// on its own.

/** How long a press has to last before the screen becomes editable. */
const LONG_PRESS_MS = 450;
/** Movement that cancels a long-press, so scrolling never enters edit mode. */
const LONG_PRESS_SLOP = 8;

export type EditableTile = {
  id: string;
  span: WidgetSpan;
  title: string;
  minSpan: WidgetSpan;
  maxSpan: WidgetSpan;
  content: React.ReactNode;
};

const SPAN_CLASS: Record<number, string> = {
  1: "lg:col-span-1",
  2: "lg:col-span-2",
  3: "lg:col-span-3",
};

export function EditableGrid({
  tiles,
  layout,
  onChange,
  gridId,
  emptyMessage,
  children,
}: {
  tiles: EditableTile[];
  layout: ScreenLayout;
  /** Called with the new layout on every committed change. */
  onChange: (next: ScreenLayout, opts?: { droppedAt?: number }) => void;
  gridId: string;
  emptyMessage?: React.ReactNode;
  /** The tray, rendered below the grid while editing. */
  children?: (editing: boolean) => React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const draggables = useRef<Draggable[]>([]);
  const stopJiggle = useRef<(() => void) | null>(null);
  const field = useRef<ReturnType<typeof createMagneticField> | null>(null);
  // The order being dragged into, which the pointer updates far more often than
  // React should re-render. Held in a ref and only pushed out on a real change.
  const orderRef = useRef<string[]>(layout.widgets.map((w) => w.id));
  orderRef.current = layout.widgets.map((w) => w.id);

  const tileById = useMemo(
    () => new Map(tiles.map((t) => [t.id, t])),
    [tiles],
  );

  const commit = useCallback(
    (next: ScreenLayout, opts?: { droppedAt?: number }) => onChange(next, opts),
    [onChange],
  );

  // ── Entering and leaving edit mode ──
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const elements = Array.from(grid.querySelectorAll<HTMLElement>("[data-tile]"));
    const inners = elements
      .map((el) => el.querySelector<HTMLElement>("[data-tile-inner]"))
      .filter((el): el is HTMLElement => el !== null);

    inhale(elements, editing);
    // The wobble rides the inner wrapper, so it never fights the drag transform
    // on the outer one — two libraries writing the same transform is a jitter
    // bug that only appears under the finger.
    stopJiggle.current?.();
    stopJiggle.current = editing ? jiggle(inners) : null;

    return () => {
      stopJiggle.current?.();
      stopJiggle.current = null;
    };
  }, [editing, layout.widgets.length]);

  // ── Dragging ──
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || !editing) return;

    const elements = Array.from(grid.querySelectorAll<HTMLElement>("[data-tile]"));
    field.current = createMagneticField(elements);

    draggables.current = elements.map((el) => {
      const id = el.dataset.tile!;
      return createDraggable(el, {
        // Free movement; the grid decides where it lands, not an axis lock.
        container: grid,
        containerFriction: 0.35,
        ...RELEASE,
        cursor: false,
        onGrab: () => {
          el.dataset.dragging = "true";
          el.style.zIndex = "30";
          // The grabbed tile stops wobbling: it is no longer *offering* to be
          // moved, it is being moved.
          el.querySelector<HTMLElement>("[data-tile-inner]")?.style.setProperty(
            "transform",
            "none",
          );
        },
        onDrag: (self) => {
          const box = el.getBoundingClientRect();
          const pointer = {
            x: box.left + box.width / 2,
            y: box.top + box.height / 2,
          };
          velocityDeform(el, self.velocity, self.angle);
          field.current?.pull(pointer.x, pointer.y, el);

          const others = Array.from(
            grid.querySelectorAll<HTMLElement>("[data-tile]"),
          );
          const current = orderRef.current.indexOf(id);
          const slot = slotForPointer(centersOf(others), pointer, current);
          if (slot === current || slot < 0) return;

          const next = [...orderRef.current];
          next.splice(current, 1);
          next.splice(slot, 0, id);
          orderRef.current = next;
          // Reflow everything except the tile under the finger — that one is
          // already where the pointer says it is.
          morphLayout(
            grid,
            () =>
              commit({
                widgets: next.map((wid) => ({
                  id: wid,
                  span:
                    layout.widgets.find((w) => w.id === wid)?.span ??
                    tileById.get(wid)?.span ??
                    1,
                })),
              }),
            { children: '[data-tile]:not([data-dragging="true"])' },
          );
        },
        onRelease: (self) => {
          delete el.dataset.dragging;
          settleDeform(el);
          field.current?.release();
          // Back to the slot the grid has already made for it, rather than
          // wherever the finger stopped.
          self.animateInView?.(scaled(320));
          self.reset();
          el.style.zIndex = "";
          commit(
            { widgets: layout.widgets },
            { droppedAt: orderRef.current.indexOf(id) },
          );
        },
      });
    });

    return () => {
      for (const d of draggables.current) d.revert();
      draggables.current = [];
      field.current?.revert();
      field.current = null;
    };
    // Rebuilt when the set of tiles changes: a draggable bound to a removed
    // element is a draggable holding a detached node.
  }, [commit, editing, layout.widgets, tileById]);

  // ── Long press to enter ──
  const press = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    x: number;
    y: number;
  }>({ timer: null, x: 0, y: 0 });

  const cancelPress = useCallback(() => {
    if (press.current.timer) clearTimeout(press.current.timer);
    press.current.timer = null;
  }, []);

  useEffect(() => cancelPress, [cancelPress]);

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditing(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing]);

  function reorderBy(id: string, delta: number) {
    const from = layout.widgets.findIndex((w) => w.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= layout.widgets.length) return;
    const widgets = [...layout.widgets];
    const [moved] = widgets.splice(from, 1);
    widgets.splice(to, 0, moved);
    morphLayout(gridRef.current ?? `#${gridId}`, () =>
      commit({ widgets }, { droppedAt: to }),
    );
  }

  function resize(id: string, delta: number) {
    const tile = tileById.get(id);
    if (!tile) return;
    const widgets = layout.widgets.map((w) => {
      if (w.id !== id) return w;
      const next = Math.min(
        Math.max(w.span + delta, tile.minSpan),
        tile.maxSpan,
      ) as WidgetSpan;
      return { ...w, span: next };
    });
    morphLayout(gridRef.current ?? `#${gridId}`, () => commit({ widgets }));
  }

  function remove(id: string) {
    const el = gridRef.current?.querySelector<HTMLElement>(
      `[data-tile="${id}"]`,
    );
    const drop = () =>
      morphLayout(gridRef.current ?? `#${gridId}`, () =>
        commit({ widgets: layout.widgets.filter((w) => w.id !== id) }),
      );
    if (el) tearOut(el, drop);
    else drop();
  }

  return (
    <div className="space-y-4">
      {/* The only chrome in reading mode: nothing. Editing announces itself with
          the wobble, and this bar is the way out plus the keyboard entrance. */}
      <div className="flex items-center justify-between gap-2">
        <span
          aria-live="polite"
          className="text-[11px] uppercase tracking-wider text-muted-foreground"
        >
          {editing ? "Hold and drag to rearrange" : ""}
        </span>
        <button
          type="button"
          aria-pressed={editing}
          onClick={() => setEditing((e) => !e)}
          className={cn(
            "rounded-full px-3 py-1 text-xs transition-colors",
            editing
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {editing ? "Done" : "Arrange"}
        </button>
      </div>

      <div
        id={gridId}
        ref={gridRef}
        className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start"
      >
        {layout.widgets.map((w) => {
          const tile = tileById.get(w.id);
          if (!tile) return null;
          return (
            <div
              key={w.id}
              data-tile={w.id}
              className={cn(
                "relative min-w-0",
                SPAN_CLASS[w.span] ?? SPAN_CLASS[1],
                editing && "touch-none select-none",
              )}
              onPointerDown={(e) => {
                if (editing) return;
                press.current.x = e.clientX;
                press.current.y = e.clientY;
                press.current.timer = setTimeout(() => {
                  setEditing(true);
                  // Phones buzz here. This is the closest honest equivalent.
                  if (typeof navigator !== "undefined" && navigator.vibrate) {
                    navigator.vibrate(8);
                  }
                }, LONG_PRESS_MS);
              }}
              onPointerMove={(e) => {
                if (
                  press.current.timer &&
                  (Math.abs(e.clientX - press.current.x) > LONG_PRESS_SLOP ||
                    Math.abs(e.clientY - press.current.y) > LONG_PRESS_SLOP)
                ) {
                  cancelPress();
                }
              }}
              onPointerUp={cancelPress}
              onPointerCancel={cancelPress}
              onKeyDown={(e) => {
                // The accessible path. Long-press cannot be the only way in,
                // and arrow-dragging cannot be the only way to move something.
                if (!editing) return;
                const step = e.shiftKey ? -1 : 1;
                if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                  e.preventDefault();
                  reorderBy(w.id, 1);
                } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                  e.preventDefault();
                  reorderBy(w.id, -1);
                } else if (e.key === "+" || e.key === "=") {
                  e.preventDefault();
                  resize(w.id, 1);
                } else if (e.key === "-") {
                  e.preventDefault();
                  resize(w.id, -1);
                } else if (e.key === "Backspace" || e.key === "Delete") {
                  e.preventDefault();
                  remove(w.id);
                } else if (e.key === " ") {
                  e.preventDefault();
                  reorderBy(w.id, step);
                }
              }}
              tabIndex={editing ? 0 : -1}
              role={editing ? "button" : undefined}
              aria-label={
                editing
                  ? `${tile.title}. Arrow keys move it, plus and minus resize it, delete removes it.`
                  : undefined
              }
            >
              <div data-tile-inner className="relative">
                {tile.content}

                {editing && (
                  <>
                    {/* Badges, phone-style: on the tile, not in a panel. */}
                    <button
                      type="button"
                      aria-label={`Remove ${tile.title}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => remove(w.id)}
                      className="absolute -left-2 -top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-foreground text-background shadow-lg"
                    >
                      <X className="h-3 w-3" />
                    </button>
                    {tile.minSpan !== tile.maxSpan && (
                      <div className="absolute -bottom-2 -right-2 z-10 flex items-center gap-0.5 rounded-full bg-foreground px-1 py-0.5 text-background shadow-lg">
                        <button
                          type="button"
                          aria-label={`Make ${tile.title} narrower`}
                          disabled={w.span <= tile.minSpan}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => resize(w.id, -1)}
                          className="flex h-5 w-5 items-center justify-center rounded-full disabled:opacity-40"
                        >
                          <Minus className="h-3 w-3" />
                        </button>
                        <span className="px-0.5 text-[10px] tabular-nums">
                          {w.span}
                        </span>
                        <button
                          type="button"
                          aria-label={`Make ${tile.title} wider`}
                          disabled={w.span >= tile.maxSpan}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => resize(w.id, 1)}
                          className="flex h-5 w-5 items-center justify-center rounded-full disabled:opacity-40"
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {layout.widgets.length === 0 && !editing && emptyMessage}

      {children?.(editing)}
    </div>
  );
}
