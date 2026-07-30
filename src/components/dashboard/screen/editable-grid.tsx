"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
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
  type WidgetRows,
} from "@/lib/screen-layout";
import { cn } from "@/lib/utils";
import {
  customizable,
  useCustomize,
} from "@/components/appearance/customize-provider";

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

/** Columns in the desktop grid. The one place that number lives. */
const GRID_COLUMNS = 3;
/** Tallest a panel can be made. Past three rows it is a page, not a panel. */
const MAX_ROWS = 3;
/** Matches `lg:auto-rows-[10.5rem]`, for the first frame before measuring. */
const ROW_HEIGHT_FALLBACK = 168;

const ROW_CLASS: Record<number, string> = {
  1: "lg:row-span-1",
  2: "lg:row-span-2",
  3: "lg:row-span-3",
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
  // Customise mode makes every tile pointable. The grid does not have to know
  // what happens next — it announces what each tile *is* and the inspector
  // takes it from there.
  const { active: customizing, selection } = useCustomize();
  // The width a resize drag has reached, before it commits. Local only: the
  // tile must move under the finger, but a width is not saved until you let go.
  const [preview, setPreview] = useState<{
    id: string;
    span: WidgetSpan;
    rows: WidgetRows;
  } | null>(null);
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
        // Only the CONTENT starts a drag, never the edit chrome hung off the
        // corners. Those buttons stop propagation in React handlers, which run
        // at the root — long after anime's native listener on the tile has
        // already begun a drag. Scoping the trigger fixes remove, resize and
        // the width buttons in one move rather than three.
        trigger: el.querySelector<HTMLElement>("[data-tile-inner]") ?? el,
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

  /** Set a size directly — what a drag reports, unlike the +/- delta. */
  function setSize(id: string, span: WidgetSpan, rows: WidgetRows) {
    const tile = tileById.get(id);
    if (!tile) return;
    const clampedSpan = Math.min(
      Math.max(span, tile.minSpan),
      tile.maxSpan,
    ) as WidgetSpan;
    const clampedRows = Math.min(Math.max(rows, 1), MAX_ROWS) as WidgetRows;
    const current = layout.widgets.find((w) => w.id === id);
    const currentRows = current?.rows ?? tile.rows ?? 1;
    if (current?.span === clampedSpan && currentRows === clampedRows) return;
    morphLayout(gridRef.current ?? `#${gridId}`, () =>
      commit({
        widgets: layout.widgets.map((w) =>
          w.id === id ? { ...w, span: clampedSpan, rows: clampedRows } : w,
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

  // Sized when *anything* has a height — declared by the panel's author, or
  // set by the reader. Looking only at the tile definitions meant a screen
  // whose panels ship at natural height could never be given fixed rows, so
  // dragging a tile taller did nothing at all: the grid had no rows to span.
  const sized =
    tiles.some((t) => t.rows !== undefined) ||
    layout.widgets.some((w) => w.rows !== undefined);

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
          // A drag in progress shows its own size; everything else shows the
          // saved one, falling back to the height the panel was designed at.
          const live = preview && preview.id === w.id ? preview : null;
          const span = live ? live.span : w.span;
          const rows = live ? live.rows : (w.rows ?? tile.rows ?? 1);
          return (
            <div
              key={w.id}
              data-tile={w.id}
              {...(customizing
                ? {
                    ...customizable({
                      id: `${gridId}:${w.id}`,
                      label: tile.title,
                      screenKey: gridId,
                    }),
                    "data-customize-selected":
                      selection?.id === `${gridId}:${w.id}` ? "true" : undefined,
                  }
                : {})}
              className={cn(
                // `group/tile` is what lets the width control reveal itself on
                // hover without every tile's chrome shouting at once.
                "group/tile relative min-w-0",
                SPAN_CLASS[span] ?? SPAN_CLASS[1],
                sized && (ROW_CLASS[rows] ?? ROW_CLASS[1]),
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
              </div>

              {/* The edit chrome lives OUTSIDE the inner wrapper. A sized
                  tile scrolls its content, and a scroll container clips
                  its overflowing children — badges hung off the corners
                  would simply be invisible on every sized screen. */}
              {/* The edit chrome.

                  It used to be three solid-black blobs hung off every tile —
                  a remove circle, a resize circle and a width pill — which on
                  a four-tile row is twelve black dots reading as holes punched
                  in the screen, and on a dark theme they disappear into it.

                  One control cluster now, on one edge, in the surface colour
                  with a hairline: chrome should look like it sits ON the app
                  rather than like the app is missing pieces. Remove stays
                  permanently visible (it is the one thing you must be able to
                  find); the width control fades up on hover or keyboard focus,
                  and stays up while its own drag is in flight. */}
              {editing && (
                <>
                  {/* One control, not three.

                      The stepper was a number picker hung off every tile —
                      a second way to do what the corner already does, taking
                      up more room than the thing it adjusted and reading as
                      chrome rather than as a handle. Direct manipulation is
                      the whole model here: you drag the corner, the grid
                      reflows under your hand, you stop when it looks right.
                      A number is what you use when you cannot see the result,
                      and here you can.

                      The keyboard path is not lost — it moved onto the tile
                      itself, where +/- resize and arrows reorder (see the
                      key handler above). That is one place to learn instead
                      of a control per axis. */}
                  <div className="pointer-events-none absolute -top-2.5 right-2 z-20 flex items-center gap-1">
                    <button
                      type="button"
                      aria-label={`Remove ${tile.title}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => remove(w.id)}
                      className="tap-target pointer-events-auto flex h-6 w-6 items-center justify-center rounded-full bg-card text-foreground shadow-md ring-1 ring-border hover:bg-muted"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>

                  {tile.minSpan !== tile.maxSpan && (
                    /* Drag the corner to resize — the direct-manipulation
                       path, matching how everything else here works. */
                    <ResizeGrip
                      label={tile.title}
                      span={w.span}
                      rows={rows}
                      min={tile.minSpan}
                      max={tile.maxSpan}
                      gridId={gridId}
                      onResize={(nextSpan, nextRows) =>
                        setSize(w.id, nextSpan, nextRows)
                      }
                      onPreview={(next) =>
                        setPreview(next === null ? null : { id: w.id, ...next })
                      }
                    />
                  )}
                </>
              )}
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
  rows,
  min,
  max,
  gridId,
  onResize,
  onPreview,
}: {
  label: string;
  span: WidgetSpan;
  rows: WidgetRows;
  min: WidgetSpan;
  max: WidgetSpan;
  gridId: string;
  onResize: (span: WidgetSpan, rows: WidgetRows) => void;
  /** Live size during the drag; null when the gesture ends. Never persisted. */
  onPreview: (size: { span: WidgetSpan; rows: WidgetRows } | null) => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  // Everything the drag reads lives in refs. The previous version listed
  // `span` and `onResize` in the effect's dependencies, and both change the
  // instant the first column is crossed — so the effect tore down its own
  // listeners mid-gesture, `dragging` reset to false in the fresh closure, and
  // the drag died after exactly one column. Refs keep one long-lived listener
  // for the whole gesture.
  const spanRef = useRef(span);
  spanRef.current = span;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const boundsRef = useRef({ min, max });
  boundsRef.current = { min, max };
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let startX = 0;
    let startY = 0;
    let startSpan: WidgetSpan = 1;
    let startRows: WidgetRows = 1;
    let column = 0;
    let rowHeight = 0;
    let dragging = false;
    /** The size the drag has reached, or null when nothing has changed. */
    let lastReported: { span: WidgetSpan; rows: WidgetRows } | null = null;

    const onDown = (e: PointerEvent) => {
      // Native listener, and it stops the event here: the tile above is an
      // anime draggable with its own native pointerdown, and letting this
      // bubble means the panel gets thrown across the grid instead of resized.
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startSpan = spanRef.current;
      startRows = rowsRef.current;
      const grid = document.getElementById(gridId);
      // One column and one row, measured from the live grid rather than
      // assumed: the shell is resizable and the sidebar can move or dock, so
      // hardcoded sizes would drift out of agreement with what is on screen.
      const gridWidth = grid?.getBoundingClientRect().width ?? 0;
      column = gridWidth > 0 ? gridWidth / GRID_COLUMNS : 320;
      // The row height comes from the tile being dragged rather than from the
      // grid, because the grid's height is however many rows happen to exist.
      const tileBox = el.closest("[data-tile]")?.getBoundingClientRect();
      rowHeight =
        tileBox && tileBox.height > 0
          ? tileBox.height / Math.max(1, startRows)
          : ROW_HEIGHT_FALLBACK;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // A synthetic or already-released pointer; the window listeners below
        // still carry the gesture.
      }
      document.body.style.cursor = "nwse-resize";
    };

    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      e.preventDefault();
      const columns = Math.round((e.clientX - startX) / column);
      const rowDelta = Math.round((e.clientY - startY) / rowHeight);
      const { min: lo, max: hi } = boundsRef.current;
      const nextSpan = Math.min(
        Math.max(startSpan + columns, lo),
        hi,
      ) as WidgetSpan;
      const nextRows = Math.min(
        Math.max(startRows + rowDelta, 1),
        MAX_ROWS,
      ) as WidgetRows;
      if (
        lastReported &&
        lastReported.span === nextSpan &&
        lastReported.rows === nextRows
      ) {
        return;
      }
      lastReported = { span: nextSpan, rows: nextRows };
      // Preview locally on every threshold crossing — the tile has to move
      // under the finger or this isn't resizing, it's submitting a size.
      onPreviewRef.current(lastReported);
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = "";
      // Commit ONCE, on release.
      //
      // This used to call the real onResize on every column crossed, and on
      // Home each of those is a Convex mutation whose resolution clears the
      // optimistic draft. A drag from one column to three fired two racing
      // writes that fought the local preview, so the tile snapped back and
      // resizing looked broken — while the maths underneath was correct the
      // whole time. One gesture is one intention, so it is one write.
      const settled = lastReported;
      lastReported = null;
      onPreviewRef.current(null);
      if (
        settled !== null &&
        (settled.span !== spanRef.current || settled.rows !== rowsRef.current)
      ) {
        onResizeRef.current(settled.span, settled.rows);
      }
    };

    el.addEventListener("pointerdown", onDown);
    // On the window, not the element: pointer capture can be lost (a re-render
    // that replaces the node, a browser that drops it), and a resize that
    // stops tracking halfway is worse than one that never started.
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
    };
    // Only the grid id: everything else is read through a ref, so this
    // listener survives the whole gesture.
  }, [gridId]);

  return (
    <button
      ref={ref}
      type="button"
      aria-label={`Resize ${label}. ${span} of ${GRID_COLUMNS} columns, ${rows} rows tall. Drag to resize, or use the plus and minus buttons for width.`}
      // A generous invisible hit area with a quiet mark inside it: the target
      // needs to be easy to hit, the graphic does not need to be loud. Sits
      // inside the tile's corner rather than hanging off it, so it can never
      // be clipped by a neighbour or land in the gutter.
      className="absolute bottom-0 right-0 z-20 flex h-9 w-9 cursor-nwse-resize touch-none items-end justify-end rounded-br-2xl p-1.5 text-muted-foreground opacity-60 transition-opacity hover:text-foreground hover:opacity-100 focus-visible:opacity-100 group-hover/tile:opacity-100"
    >
      <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden>
        {/* Two corner strokes: the universal "pull me" mark, pointing along
            the axis the drag actually works on. */}
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
