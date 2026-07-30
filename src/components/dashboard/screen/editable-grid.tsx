"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { SPRING } from "@/components/motion";
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
  hoveredIndex,
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
  /**
   * Height in grid rows (1 or 2). What makes the screen look composed rather
   * than accidental: a home screen works because widgets have real sizes, not
   * whatever height their content happened to be. Omitted = natural height,
   * for surfaces whose panels are genuinely content-shaped.
   */
  rows?: 1 | 2;
  content: React.ReactNode;
};

const SPAN_CLASS: Record<number, string> = {
  1: "lg:col-span-1",
  2: "lg:col-span-2",
  3: "lg:col-span-3",
};

const ROW_CLASS: Record<number, string> = {
  1: "lg:row-span-1",
  2: "lg:row-span-2",
};

export function EditableGrid({
  tiles,
  layout,
  onChange,
  gridId,
  emptyMessage,
  children,
  editing: controlledEditing,
  onEditingChange,
}: {
  tiles: EditableTile[];
  layout: ScreenLayout;
  /** Called with the new layout on every committed change. */
  onChange: (next: ScreenLayout, opts?: { droppedAt?: number }) => void;
  gridId: string;
  emptyMessage?: React.ReactNode;
  /** The tray, rendered below the grid while editing. */
  children?: (editing: boolean) => React.ReactNode;
  /**
   * Controlled mode, for surfaces that already own an edit toggle. The
   * long-press and Escape still work — they report through onEditingChange —
   * and the built-in pill hides so there is one switch, not two.
   */
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [selfEditing, setSelfEditing] = useState(false);
  const controlled = controlledEditing !== undefined;
  const editing = controlled ? controlledEditing : selfEditing;
  const setEditing = useCallback(
    (next: boolean | ((current: boolean) => boolean)) => {
      const value = typeof next === "function" ? next(editing) : next;
      if (controlled) onEditingChange?.(value);
      else setSelfEditing(value);
    },
    [controlled, editing, onEditingChange],
  );
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

          // The bug this shape exists to avoid: measuring "nearest slot" over
          // ALL tiles includes the dragged one, whose box is glued to the
          // pointer at distance zero — so it is always its own nearest target
          // and the grid can never reorder. Exclude self, and test containment
          // rather than proximity: the gaps between tiles belong to nobody,
          // which makes the rule naturally hysteretic.
          const order = orderRef.current;
          const current = order.indexOf(id);
          const boxes = order.map((wid) => {
            const node = grid.querySelector<HTMLElement>(
              `[data-tile="${wid}"]`,
            );
            return node ? node.getBoundingClientRect() : null;
          });
          const over = hoveredIndex(boxes, pointer, current);
          if (over < 0 || over === current) return;

          const next = [...order];
          next.splice(current, 1);
          next.splice(over, 0, id);
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
  }, [editing, setEditing]);

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

  /** Set a width directly — what a drag reports, unlike the +/- delta. */
  function setSpan(id: string, span: WidgetSpan) {
    const tile = tileById.get(id);
    if (!tile) return;
    const clamped = Math.min(
      Math.max(span, tile.minSpan),
      tile.maxSpan,
    ) as WidgetSpan;
    if (layout.widgets.find((w) => w.id === id)?.span === clamped) return;
    morphLayout(gridRef.current ?? `#${gridId}`, () =>
      commit({
        widgets: layout.widgets.map((w) =>
          w.id === id ? { ...w, span: clamped } : w,
        ),
      }),
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

  const sized = tiles.some((t) => t.rows !== undefined);

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
        {!controlled && (
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
        )}
      </div>

      <div
        id={gridId}
        ref={gridRef}
        className={cn(
          "grid grid-cols-1 gap-6 lg:grid-cols-3",
          // Sized tiles get a fixed row height, which is what makes the screen
          // read as composed: every panel is a real size, aligned to a shared
          // grid, instead of whatever its content happened to measure. Only at
          // lg — on a phone the panels stack and natural height is right.
          sized ? "lg:auto-rows-[10.5rem]" : "lg:items-start",
        )}
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
                sized && ROW_CLASS[tile.rows ?? 1],
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
              <div
                data-tile-inner
                className={cn(
                  "relative",
                  // Fill the fixed cell; content that outgrows a real size
                  // scrolls inside it, exactly as a widget does on a phone.
                  sized && "lg:h-full lg:overflow-y-auto lg:[&>*]:h-full",
                )}
              >
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
                      <>
                        {/* Drag the corner to resize — the direct-manipulation
                            path, matching how everything else here works. */}
                        <ResizeGrip
                          label={tile.title}
                          span={w.span}
                          min={tile.minSpan}
                          max={tile.maxSpan}
                          gridId={gridId}
                          onResize={(next: WidgetSpan) => setSpan(w.id, next)}
                        />
                        {/* The same change, reachable without a pointer. */}
                        <div className="absolute -bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-foreground px-1 py-0.5 text-background shadow-lg">
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
                      </>
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

      {/* The way out. A text link at the top of a long screen is not an exit —
          by the time you have dragged three panels you have scrolled past it,
          and a mode you cannot leave is a trap. This floats above everything,
          bottom-centre, wherever you are on the page. */}
      <AnimatePresence>
        {editing && (
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.9 }}
            transition={SPRING}
            className="fixed inset-x-0 bottom-6 z-50 flex justify-center px-4"
          >
            <div className="pointer-events-auto flex items-center gap-3 rounded-full bg-foreground px-4 py-2 text-background shadow-xl">
              <span className="text-xs">
                Hold and drag to move. Drag a corner to resize.
              </span>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-full bg-background px-3 py-1 text-xs font-medium text-foreground"
              >
                Done
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * A panel waiting in the tray, added by dragging it into the grid.
 *
 * The tray is a shelf, not a settings list: you pull a panel out of it and drop
 * it where it should live, and it lands in that slot — one gesture, one
 * animation. Click still works (it appends), because drag-out cannot be the
 * only path any more than long-press can.
 *
 * On release the tile's centre is tested against the grid: over it → insert at
 * the nearest slot; anywhere else → spring back to the shelf, which is how a
 * gesture gets cancelled without a cancel button.
 */
export function TrayTile({
  gridId,
  onDrop,
  onClick,
  children,
  className,
}: {
  gridId: string;
  /** slot is where in the grid order the drop landed. */
  onDrop: (slot: number) => void;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  // Suppress the click that fires after a real drag, so a pull-out doesn't
  // also append a second copy.
  const moved = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const draggable = createDraggable(el, {
      ...RELEASE,
      cursor: false,
      dragThreshold: 6,
      onGrab: () => {
        dragging.current = true;
        moved.current = false;
        el.style.zIndex = "40";
      },
      onDrag: (self) => {
        moved.current = true;
        velocityDeform(el, self.velocity, self.angle);
      },
      onRelease: (self) => {
        dragging.current = false;
        settleDeform(el);
        el.style.zIndex = "";
        if (!moved.current) {
          self.reset();
          return;
        }
        const grid = document.getElementById(gridId);
        const box = el.getBoundingClientRect();
        const center = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        const gridBox = grid?.getBoundingClientRect();
        const overGrid =
          gridBox !== undefined &&
          center.x >= gridBox.left &&
          center.x <= gridBox.right &&
          center.y >= gridBox.top - 40 &&
          center.y <= gridBox.bottom + 40;
        if (grid && overGrid) {
          const tiles = Array.from(grid.querySelectorAll("[data-tile]"));
          const slot =
            tiles.length === 0
              ? 0
              : slotForPointer(centersOf(tiles), center, -1, 0);
          // Snap the ghost home instantly; the real panel appears in the grid.
          self.reset();
          onDrop(Math.max(0, slot));
        } else {
          // Not a drop — a change of mind. Spring back to the shelf.
          self.reset();
        }
      },
    });
    return () => {
      draggable.revert();
    };
  }, [gridId, onDrop]);

  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      onClick={() => {
        if (!moved.current) onClick();
        moved.current = false;
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn("touch-none", className)}
    >
      {children}
    </div>
  );
}


/**
 * Drag the corner to resize.
 *
 * The width is a column count, so the gesture has to translate pixels into
 * columns: measure one column from the grid's own box, then report the span the
 * pointer's total width implies. Reporting on every threshold crossing rather
 * than on release is what makes it feel like resizing rather than like
 * submitting a form — the grid reflows under your hand and you stop when it
 * looks right.
 *
 * The grip does not move with the drag. It is a control being held, not an
 * object being thrown, and animating it away from the corner it labels would
 * break the one thing it is telling you.
 */
function ResizeGrip({
  label,
  span,
  min,
  max,
  gridId,
  onResize,
}: {
  label: string;
  span: WidgetSpan;
  min: WidgetSpan;
  max: WidgetSpan;
  gridId: string;
  onResize: (span: WidgetSpan) => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const spanRef = useRef(span);
  spanRef.current = span;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let startX = 0;
    let startSpan: WidgetSpan = span;
    let column = 0;
    let dragging = false;

    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      startX = e.clientX;
      startSpan = spanRef.current;
      const grid = document.getElementById(gridId);
      // One column, derived from the live grid rather than assumed: the shell
      // is resizable and the sidebar can move, so a hardcoded width would
      // drift out of agreement with what is on screen.
      const gridWidth = grid?.getBoundingClientRect().width ?? 0;
      column = gridWidth > 0 ? gridWidth / 3 : 320;
      el.setPointerCapture(e.pointerId);
      document.body.style.cursor = "ew-resize";
    };

    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      e.preventDefault();
      const columns = Math.round((e.clientX - startX) / column);
      const next = Math.min(
        Math.max(startSpan + columns, min),
        max,
      ) as WidgetSpan;
      if (next !== spanRef.current) onResize(next);
    };

    const onUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = "";
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        // The pointer already went away; nothing to release.
      }
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
    };
  }, [gridId, max, min, onResize, span]);

  return (
    <button
      ref={ref}
      type="button"
      aria-label={`Resize ${label}. ${span} of 3 columns. Drag, or use the plus and minus buttons.`}
      className="absolute -bottom-2.5 -right-2.5 z-20 hidden h-7 w-7 cursor-ew-resize touch-none items-center justify-center rounded-full bg-foreground text-background shadow-lg lg:flex"
    >
      <svg viewBox="0 0 12 12" className="h-3.5 w-3.5" aria-hidden>
        {/* Two corner strokes: the universal "pull me" mark, and it points
            along the axis the drag actually works on. */}
        <path
          d="M11 4v7H4M11 8v3H8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
