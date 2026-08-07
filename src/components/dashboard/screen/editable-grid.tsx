"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useMeasure from "react-use-measure";
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
  addWidget,
  centersOf,
  hoveredIndex,
  removeWidget,
  slotForPointer,
  MAX_WIDGET_ROWS,
  type ScreenLayout,
  type WidgetSpan,
  type WidgetRows,
} from "@/lib/screen-layout";
import { useScreenSituations } from "@/components/dashboard/screen/situation-arrival";
import { pack, packedRows } from "@/lib/pack";
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

// ── Dragging on a phone ────────────────────────────────────────────────────
//
// There WAS an edge auto-scroller here — hold a tile near the bottom and the
// page pulls itself, so a one-column screen taller than the viewport can be
// rearranged. It is gone, and the reason is worth keeping.
//
// It shipped unproven. The harness run that was supposed to exercise it
// reported `scrolled 0px`, I noted that in an audit as "implemented but not
// observed", and shipped it anyway. It then broke mobile dragging outright:
// scrolling the page mid-gesture moves the draggable's own container, so the
// tile's transform — which anime computes against that container — no longer
// agrees with where the finger is. The tile leaves the finger, and every box
// `hoveredIndex` measures is shifting underneath it at the same time, so the
// reorder thrashes. "The scroll glitches all over the place and the elements
// move all around" is precisely that, and it is worse than the problem it was
// added to solve, because the old failure was "cannot reach the far end of a
// long screen" and the new one was "cannot drag at all".
//
// Doing it properly means compensating the drag transform by the scroll delta
// every frame so the tile stays glued to the finger while the world moves
// underneath. That is real work and it needs a fixture that can prove it — a
// mobile-width screen taller than the viewport, asserting that the tile
// tracks the pointer while the container scrolls. Until that exists this stays
// out, because shipping the same unverifiable fix twice is not a fix.
//
// What survives is the part that was never speculative: the phone behaviours
// that interfere with a direct manipulation (see `data-tile-dragging` in
// globals.css). Those are suppressions of documented platform defaults, not a
// mechanism of our own that has to be watched to be believed.

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
  rows?: WidgetRows;
  content: React.ReactNode;
};

// ── Sizing responds to the GRID's width, never the window's ──
//
// These were `lg:` viewport variants, and that made the resizer provably dead
// for anyone whose browser was under 1024px: the drag computed a new span, the
// write landed, the layout row updated, and the CSS ignored all of it because
// the grid was still one column. Nothing about the write path was wrong, which
// is why fixing the write path did not fix the resizer.
//
// It is also wrong in a subtler way at every width. The grid does not occupy
// the window — it sits inside a shell whose sidebar can be open, collapsed,
// floating, or docked to the bottom. A panel's size should follow the space it
// actually has, so the same screen at the same window size reflows when you
// collapse the nav. That is what `@container` gives and a breakpoint cannot.
/** Most columns the grid ever draws. The one place that number lives. */
const GRID_COLUMNS = 3;

/**
 * How many columns the grid is actually drawing right now.
 *
 * Read from the grid's measured width against the same thresholds the CSS
 * uses, because the drag maths has to agree with what is on screen. Dividing
 * by three while two columns are drawn makes every drag feel like it is
 * fighting you — the pointer moves one panel's width and the panel grows by
 * two thirds of one.
 *
 * The thresholds mirror Tailwind's container sizes: `@md` is 28rem and `@3xl`
 * is 48rem. Stated in pixels here because this is arithmetic, not styling, and
 * a comment is cheaper than a second source of truth.
 */
function columnsFor(gridWidth: number): number {
  const rem = 16;
  if (gridWidth >= 48 * rem) return 3;
  if (gridWidth >= 28 * rem) return 2;
  return 1;
}
/** Tallest a panel can be made. Past this it is a page, not a panel. */
const MAX_ROWS = MAX_WIDGET_ROWS;
/**
 * One grid row and the gap, in px at the root font size.
 *
 * 6rem, roughly halved from 10.5. The old unit was chosen from the tallest
 * thing a screen holds rather than the shortest, so the floor — one row,
 * 168px — was nearly twice the height of a row of stat cards, and the screen
 * everybody opens first shipped with 74px of nothing under every number.
 * There was no way out of it from the UI either: one row was already the
 * minimum.
 *
 * 96px is a stat card with its padding — measured, by scripts/measure-home.mjs,
 * not guessed — which makes the shortest honest tile in the product exactly
 * one unit. MAX_ROWS doubled at the same time so nothing that used to fit
 * stopped fitting. See `WidgetRows`.
 */
const ROW_UNIT = 6 * 16;
const ROW_GAP = 1.5 * 16;
/** Matches the grid's `auto-rows`, for the first frame before measuring. */
const ROW_HEIGHT_FALLBACK = ROW_UNIT;

/**
 * How wide a panel arrives at when a condition brings it.
 *
 * Two columns rather than one, and the same number for the preview and for
 * keeping it: a panel that arrived because something happened is a thing
 * somebody was asked to READ, and a preview that resizes at the moment you
 * accept it is a preview that was lying about what you were accepting.
 */
const ARRIVAL_SPAN = 2 as const;

export function EditableGrid({
  tiles,
  layout,
  onChange,
  gridId,
  screenKey,
  layoutIsProvisional,
  emptyMessage,
  children,
  editing: controlledEditing,
  onEditingChange,
}: {
  /**
   * Every tile this screen can draw — not only the placed ones.
   *
   * The layout decides what is SHOWN; this decides what CAN be. The difference
   * used to be invisible because both callers derived tiles from their layout,
   * and it stopped being invisible the moment the grid had to draw a panel the
   * layout did not yet contain: a condition offering a panel can only preview
   * it if the surface can already say what it looks like. Passing the whole set
   * costs nothing — an unplaced tile's `content` is an element that is never
   * mounted — and it is what lets the grid answer "would this draw anything"
   * without asking its caller.
   */
  tiles: EditableTile[];
  layout: ScreenLayout;
  /** Called with the new layout on every committed change. */
  onChange: (next: ScreenLayout, opts?: { droppedAt?: number }) => void;
  gridId: string;
  /**
   * Which SCREEN this is, as everything that stores per-screen state names it
   * — `screenKey("project", id)`, not the grid's DOM id.
   *
   * The two are different on purpose and the difference matters exactly once,
   * here. A grid id identifies the element (`project-screen-grid`) and is the
   * same string on every project; a screen key identifies the screen
   * (`project:<id>`) and is what `screenLayouts`, `screenProposals` and
   * `panelSituations` are all keyed by. Announcing the grid id to the
   * inspector meant a condition set on one project's panel was the same row as
   * a condition on another's. Defaults to the grid id so a surface that has no
   * stored screen state does not have to invent one.
   */
  screenKey?: string;
  /**
   * True while `layout` is somebody else's suggestion rather than the reader's
   * own arrangement — an agent's screen proposal being previewed.
   *
   * The grid already refuses to write in that state; this tells it to stay
   * quiet as well. Offering a panel against a layout that is not yours would
   * place it into that layout, and the write would be refused — leaving
   * somebody having answered a question whose answer went nowhere.
   */
  layoutIsProvisional?: boolean;
  /**
   * What a screen with nothing on it says.
   *
   * The function form is handed the way back in. An emptied screen is a
   * legitimate destination here — `normalizeLayout` never helpfully re-adds
   * anything — which makes it the one state where the reader has no panel left
   * to long-press, so the gesture that is normally the entrance is unavailable
   * exactly when it is needed. A message that NAMES a control ("Arrange to put
   * something back") without carrying it is an instruction to go looking; the
   * function form lets the empty state hold the door itself.
   *
   * A plain node still works, because `React.ReactNode` cannot be a function
   * and the two are therefore told apart by `typeof` alone.
   */
  emptyMessage?:
    | React.ReactNode
    | ((startArranging: () => void) => React.ReactNode);
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

  // The floating "hold and drag" bar reserves no space of its own — it is
  // `fixed`, so the document never knows it is there — which means whatever
  // scrolls to the bottom while editing parks right where a thumb cannot
  // reach it. Measured rather than guessed, because a guessed constant drifts
  // the moment the pill's own copy or padding changes and nobody remembers to
  // update a number two components away.
  const [helperBarRef, helperBarBox] = useMeasure();
  /** Matches `bottom-6` on the bar itself. */
  const HELPER_BAR_OFFSET = 24;
  /** Daylight between the last tile and the bar sitting over it. */
  const HELPER_BAR_CLEARANCE = 16;
  const helperBarReserve =
    editing && helperBarBox.height > 0
      ? Math.ceil(helperBarBox.height) + HELPER_BAR_OFFSET + HELPER_BAR_CLEARANCE
      : 0;

  // ── A panel arriving because a condition became true ──
  //
  // It lives here rather than beside each caller, and that placement is the
  // whole point. This was wired into the project screen only, which meant the
  // app's main surface could AUTHOR a condition it could never hear fire —
  // half a loop, and precisely the failure "a feature that can only be
  // configured from one special screen has not been built dynamically" names.
  //
  // Everything the offer needs, the grid already has: which screen this is
  // (`screenKey`), what it can draw (`tiles`), what is placed (`layout`), and
  // how to save (`onChange`). So a surface gets arrivals by rendering a grid,
  // and the next one costs nothing at all.
  const available = useMemo(() => tiles.map((t) => t.id), [tiles]);
  const situations = useScreenSituations({
    screenKey: screenKey ?? gridId,
    gridId,
    // The reader's own arrangement, deliberately without the preview below —
    // otherwise previewing a panel would make it look already-placed and the
    // banner offering it would vanish under the reader's hand.
    layout,
    available,
    enabled: !layoutIsProvisional,
    // Built from `layout` rather than from what is drawn, and sent straight to
    // `onChange` rather than through `commit`: keeping a panel is the one edit
    // that is allowed to happen while the grid is showing an offer, because it
    // is the act that ends the offer.
    onPlace: (panelId) =>
      onChange(addWidget(layout, panelId, ARRIVAL_SPAN), {
        droppedAt: layout.widgets.length,
      }),
    onRemove: (panelId) => onChange(removeWidget(layout, panelId)),
  });

  /**
   * What the grid draws: the reader's arrangement, plus whatever is being
   * offered.
   *
   * An ordinary entry in an ordinary layout, so `pack` places it exactly as it
   * places everything else. Nothing here knows a pixel, which is what makes
   * "an arriving panel cannot displace anything" true by construction rather
   * than by care.
   */
  const shown = situations.previewPanelId
    ? addWidget(layout, situations.previewPanelId, ARRIVAL_SPAN)
    : layout;

  // The width a resize drag has reached, before it commits. Local only: the
  // tile must move under the finger, but a width is not saved until you let go.
  const [preview, setPreview] = useState<{
    id: string;
    span: WidgetSpan;
    rows: WidgetRows;
    /** False until the drag crosses a row threshold — a width drag must not
        preview a height it is never going to commit. */
    heightTouched: boolean;
    /** The unrounded size under the pointer, drawn for the duration of the
        gesture so the tile tracks the finger instead of jumping a cell at a
        time. Absent on release, which is what makes the snap happen. */
    exact?: { width: number; height: number };
  } | null>(null);
  const draggables = useRef<Draggable[]>([]);
  const stopJiggle = useRef<(() => void) | null>(null);
  const field = useRef<ReturnType<typeof createMagneticField> | null>(null);
  // The order being dragged into, which the pointer updates far more often than
  // React should re-render. Held in a ref and only pushed out on a real change.
  const orderRef = useRef<string[]>(shown.widgets.map((w) => w.id));
  /**
   * The order a drag has reached, before it is saved. Local only — the same
   * contract the resize preview above has, and for the same reason.
   *
   * It used to be no contract at all: `onDrag` called the real `commit` on
   * every slot crossing, which is a server write per crossing while the finger
   * is still down. That produced all three of the reported symptoms at once —
   * racing writes resolving out of order so the grid snapped to a stale
   * arrangement after the drop, a FLIP transition measuring against a layout
   * the async write had not applied yet, and worst, the draggable-building
   * effect (which listed `layout.widgets`) tearing down and recreating the
   * anime draggable *under the finger* several times a second, which is where
   * the overlapping and glitching came from.
   *
   * The resize path twenty lines below already fixed exactly this and wrote
   * down the rule: one gesture is one intention, so it is one write.
   */
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  // Synced from the layout only while nothing is being dragged. Doing it on
  // every render is how a drop got overwritten by the pre-drop order arriving
  // one subscription tick later.
  if (dragOrder === null) orderRef.current = shown.widgets.map((w) => w.id);

  const tileById = useMemo(
    () => new Map(tiles.map((t) => [t.id, t])),
    [tiles],
  );

  // The saved layout, readable from inside a live gesture without making the
  // gesture depend on it. Same device the resize grip uses, same reason.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // Which tiles exist, independent of the order they are in. Sorted, so a
  // reorder produces the same key and cannot retrigger the drag effect.
  const tileKey = useMemo(
    () =>
      shown.widgets
        .map((w) => w.id)
        .slice()
        .sort()
        .join("|"),
    [shown.widgets],
  );

  /**
   * Save an arrangement — unless the grid is showing one that is not yours.
   *
   * The guard used to live in the project screen, restated per caller, which is
   * the shape that guarantees the next surface forgets it. It belongs here: the
   * grid is the only thing that knows a panel has been OFFERED and not yet
   * accepted, so a drag or a resize while an offer is on the canvas would
   * silently save the offered panel as part of the reader's screen. Keeping it
   * is the only way an offered panel becomes theirs.
   */
  const offering = situations.previewPanelId !== null;
  const offeringRef = useRef(offering);
  offeringRef.current = offering;
  const commit = useCallback(
    (next: ScreenLayout, opts?: { droppedAt?: number }) => {
      if (offeringRef.current) return;
      onChange(next, opts);
    },
    [onChange],
  );

  // What the grid actually draws: the dragged-into order while a gesture is
  // live, the saved order otherwise.
  // The canvas measures itself, so the packer's column count and what is drawn
  // can never disagree — a whole class of "the drag computed a new span and
  // the CSS ignored it" bugs that came from two places deciding separately.
  const [measureRef, { width: canvasWidth }] = useMeasure();
  const columns = columnsFor(canvasWidth || 1024);

  const savedWidgets = shown.widgets;
  const rendered = useMemo(() => {
    if (!dragOrder) return savedWidgets;
    const byId = new Map(savedWidgets.map((w) => [w.id, w]));
    const out = dragOrder
      .map((id) => byId.get(id))
      .filter((w): w is ScreenLayout["widgets"][number] => w !== undefined);
    // Anything the drag order has not heard of yet (a panel that arrived from
    // another tab mid-gesture) still gets drawn — dropping it would make a
    // teammate's panel vanish for as long as you hold the mouse down.
    for (const w of savedWidgets) {
      if (!dragOrder.includes(w.id)) out.push(w);
    }
    return out;
  }, [dragOrder, savedWidgets]);

  // Let go of the preview only once the saved layout agrees with it. Clearing
  // on release instead means the grid renders the *pre-drop* order for the one
  // round trip it takes the write to land — the tile visibly springs back to
  // where it came from and then jumps forward again, which is the "saves out
  // of place then glitches in" that got reported.
  const dragOrderKey = dragOrder?.join("|") ?? null;
  const savedOrderKey = shown.widgets.map((w) => w.id).join("|");
  useEffect(() => {
    if (dragOrderKey !== null && dragOrderKey === savedOrderKey) {
      setDragOrder(null);
    }
  }, [dragOrderKey, savedOrderKey]);

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
  }, [editing, shown.widgets.length]);

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
          // Tells the document a gesture is live. The stylesheet uses it to
          // suppress the things a phone does to a long press that have nothing
          // to do with this app — iOS's selection callout and magnifier,
          // pull-to-refresh, and the rubber-band overscroll that makes a drag
          // near the top of the screen feel like the page is being torn.
          document.documentElement.dataset.tileDragging = "true";
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
          // already where the pointer says it is. Local state, never a write:
          // the neighbours part now, and the arrangement is saved once, when
          // the gesture ends.
          morphLayout(grid, () => setDragOrder(next), {
            children: '[data-tile]:not([data-dragging="true"])',
          });
        },
        onRelease: (self) => {
          delete el.dataset.dragging;
          delete document.documentElement.dataset.tileDragging;
          settleDeform(el);
          field.current?.release();
          // Back to the slot the grid has already made for it, rather than
          // wherever the finger stopped.
          self.animateInView?.(scaled(320));
          self.reset();
          el.style.zIndex = "";
          // The one write. Built from the order the gesture actually reached
          // — the closure's `layout.widgets` is the arrangement from before
          // the drag started, and committing that was how a drop could save
          // the old order over the new one.
          const order = orderRef.current;
          const saved = layoutRef.current.widgets;
          commit(
            {
              widgets: order.map((wid) => {
                const was = saved.find((w) => w.id === wid);
                return {
                  id: wid,
                  span: was?.span ?? tileById.get(wid)?.span ?? 1,
                  ...(was?.rows === undefined ? {} : { rows: was.rows }),
                };
              }),
            },
            { droppedAt: order.indexOf(id) },
          );
        },
      });
    });

    return () => {
      for (const d of draggables.current) d.revert();
      draggables.current = [];
      field.current?.revert();
      field.current = null;
      // A gesture interrupted by a route change must not strand the document
      // with scrolling suppressed.
      delete document.documentElement.dataset.tileDragging;
    };
    // Rebuilt when the SET of tiles changes — a draggable bound to a removed
    // element is a draggable holding a detached node — and deliberately not
    // when their ORDER changes. `layout.widgets` was the dependency, and a
    // reorder is a new array every time, so the effect tore down and rebuilt
    // the draggable the user was holding, mid-gesture, on every slot crossing.
    // The sorted key changes on add and remove and stays put through a
    // reorder, which is exactly the distinction that keeps one gesture alive
    // from grab to release. Everything the handlers read that can change
    // during a drag is behind a ref, the same way `ResizeGrip` does it.
  }, [commit, editing, tileKey, tileById]);

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

  /**
   * Set a size directly — what a drag reports, unlike the +/- delta.
   *
   * `rows` is undefined when the gesture never moved vertically. That absence
   * is load-bearing: writing `rows: 1` on a horizontal drag is what used to
   * flip a natural screen into fixed-height mode, and "you widened one card
   * so every card changed shape" is the bug, not a quirk.
   */
  function setSize(id: string, span: WidgetSpan, rows: WidgetRows | undefined) {
    const tile = tileById.get(id);
    if (!tile) return;
    const clampedSpan = Math.min(
      Math.max(span, tile.minSpan),
      tile.maxSpan,
    ) as WidgetSpan;
    const current = layout.widgets.find((w) => w.id === id);
    const clampedRows =
      rows === undefined
        ? current?.rows
        : (Math.min(Math.max(rows, 1), MAX_ROWS) as WidgetRows);
    if (current?.span === clampedSpan && current?.rows === clampedRows) return;
    morphLayout(gridRef.current ?? `#${gridId}`, () =>
      commit({
        widgets: layout.widgets.map((w) =>
          w.id === id
            ? {
                ...w,
                span: clampedSpan,
                ...(clampedRows === undefined ? {} : { rows: clampedRows }),
              }
            : w,
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

  // Two kinds of screen, and the difference is who decided the heights.
  //
  // A *composed* screen (any tile DECLARES rows — the project screen) puts
  // every panel on a fixed row track, and resizing spans rows on that track.
  //
  // A *natural* screen (Home) lets every panel be its content's height — and
  // this is where vertical resize used to be broken twice over. Dragging gave
  // no feedback, because the row-span classes were gated on `sized` and the
  // preview could not make a screen sized. Worse, releasing stamped `rows`
  // onto the layout even for a purely horizontal drag, at which point `sized`
  // flipped and EVERY panel on the page snapped to a fixed 10.5rem row —
  // short ones stretched over holes, tall ones crushed into scrollboxes. One
  // width-drag reshaped a whole screen nobody asked to reshape.
  //
  // So: `sized` is now the author's call alone, and on a natural screen a
  // panel the reader resizes gets an *explicit height* of its own (see
  // `rowsToHeight`) while its neighbours keep their natural height. Height
  // becomes a per-panel fact, the way width always was.
  const sized = tiles.some((t) => t.rows !== undefined);

  // The one place geometry is decided. A live resize feeds its in-progress
  // size straight in, so neighbours part around the tile being dragged rather
  // than after it lands.
  const packed = useMemo(() => {
    const items = rendered.map((w) => {
      const tile = tileById.get(w.id);
      const live = preview && preview.id === w.id ? preview : null;
      return {
        id: w.id,
        w: live ? live.span : w.span,
        h: live ? live.rows : (w.rows ?? tile?.rows ?? 1),
      };
    });
    return pack(items, columns);
  }, [rendered, tileById, preview, columns]);

  const rectById = useMemo(
    () => new Map(packed.map((r) => [r.id, r])),
    [packed],
  );
  const canvasHeight = packedRows(packed) * (ROW_UNIT + ROW_GAP) - ROW_GAP;

  return (
    <div
      className="space-y-4"
      // The bar's exact footprint, added back as space nothing else claims —
      // see `helperBarReserve` above. `undefined` rather than `0` while not
      // editing, so this never fights the `space-y-4` gap with an inline 0.
      style={{ paddingBottom: helperBarReserve || undefined }}
    >
      {/* The only chrome in reading mode: nothing. Editing announces itself with
          the wobble, and this bar is the way out plus the keyboard entrance. */}
      <div className="flex items-center justify-between gap-2">
        <span
          aria-live="polite"
          className="text-tiny uppercase tracking-wider text-muted-foreground"
        >
          {editing ? "Hold and drag to rearrange" : ""}
        </span>
        {!controlled && (
          <button
            type="button"
            aria-pressed={editing}
            onClick={() => setEditing((e) => !e)}
            className={cn(
              // `.tap-target` because this pill is the entrance to authorship
              // on a touch screen AND the only way back out of a screen
              // somebody has emptied — at which point there is no panel left to
              // long-press, so it is the sole affordance on the surface.
              "tap-target rounded-full px-3 py-1.5 text-xs transition-colors",
              editing
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {editing ? "Done" : "Arrange"}
          </button>
        )}
      </div>

      {/* A condition that has become true, offering the panel it governs.
          Above the canvas rather than inside it, because it is a question
          about the screen and not a part of it — and because a tile that were
          sometimes a banner would have to be packed, which is exactly the
          confusion `pack` exists to end. */}
      {situations.banner}

      {/* The canvas draws what `pack` says, and nothing else places anything.
          It used to be a CSS Grid whose tracks the browser computed, while the
          tiles carried their own pixel heights — two models, each believing it
          owned placement, which is exactly where the overlapping panels came
          from. Every tile is now absolutely positioned from a rectangle that
          is provably non-overlapping before it reaches the DOM. */}
      <div
        id={gridId}
        ref={(node) => {
          gridRef.current = node;
          measureRef(node);
        }}
        className="@container relative w-full"
        style={{ height: canvasHeight }}
      >
        {rendered.map((w) => {
          const tile = tileById.get(w.id);
          if (!tile) return null;
          // A drag in progress shows its own size; everything else shows the
          // saved one, falling back to the height the panel was designed at.
          const live = preview && preview.id === w.id ? preview : null;
          const span = live ? live.span : w.span;
          const rows = live ? live.rows : (w.rows ?? tile.rows ?? 1);
          // While the grip is held, the tile is exactly the size of the
          // pointer — not the nearest cell. Overriding the grid's own column
          // and row tracks for the duration of the gesture is what makes the
          // edge track the finger; dropping the override on release is what
          // makes it snap, once, into the cell it will actually be saved at.
          const exact = live?.exact ?? null;
          // Absent only in the frame before the first pack, and a tile with no
          // rectangle must still be somewhere rather than stacked at the
          // origin on top of its neighbours.
          const rect = rectById.get(w.id) ?? { x: 0, y: 0, w: span, h: rows };
          return (
            <div
              key={w.id}
              data-tile={w.id}
              // The packed rectangle, readable without parsing CSS. jsdom
              // discards `calc()` from inline styles, so a test that asserted
              // the width string could only ever pass in a real browser — and
              // the harness wants the units anyway, to check the drawn box
              // against what the packer decided.
              data-col={rect.x}
              data-row={rect.y}
              data-w={rect.w}
              data-h={rect.h}
              {...(customizing
                ? {
                    ...customizable({
                      id: `${gridId}:${w.id}`,
                      label: tile.title,
                      screenKey: screenKey ?? gridId,
                    }),
                    "data-customize-selected":
                      selection?.id === `${gridId}:${w.id}` ? "true" : undefined,
                  }
                : {})}
              className={cn(
                // `group/tile` is what lets the width control reveal itself on
                // hover without every tile's chrome shouting at once.
                "group/tile absolute min-w-0",
                editing && "touch-none select-none",
              )}
              style={{
                // Every number here comes from the packed rectangle. There is
                // no second opinion: the browser is told exactly where this
                // tile goes, so two tiles cannot disagree about a row the way
                // they did when CSS Grid computed tracks under tiles that
                // carried their own heights.
                //
                // Columns are a percentage so the canvas stays fluid — the
                // shell's sidebar can open, collapse, float or dock, and the
                // arithmetic follows without measuring again. Rows are pixels
                // because a row IS a fixed height; that is what makes a screen
                // look composed rather than accidental.
                left: `calc((100% + ${ROW_GAP}px) / ${columns} * ${rect.x})`,
                top: rect.y * (ROW_UNIT + ROW_GAP),
                width: exact
                  ? exact.width
                  : `calc((100% + ${ROW_GAP}px) / ${columns} * ${rect.w} - ${ROW_GAP}px)`,
                height: exact
                  ? exact.height
                  : rect.h * (ROW_UNIT + ROW_GAP) - ROW_GAP,
                // Mid-gesture the tile is the size of the pointer, and nothing
                // may animate it there — the snap happens once, on release.
                ...(exact ? { transition: "none" } : null),
              }}
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
                  // Fill the box and scroll inside it — unconditionally,
                  // because since the packer took over EVERY tile has a real
                  // box, at every width.
                  //
                  // This was gated on `sized`, meaning "some tile declared
                  // rows on the tile itself". Home declares its rows in
                  // `layout.widgets` instead, so `sized` was false for Home —
                  // and the gate that makes a fixed box safe never applied to
                  // the one screen people actually open. The box was 168px,
                  // the Projects table inside it was 458px, and the surplus
                  // painted straight over the panel below. Every panel on
                  // Home overlapped the next one, at both widths, in both
                  // themes.
                  //
                  // The browser overlap gate could not see it: it measures
                  // `[data-tile]` boxes, and the BOXES were correct — the
                  // packer had done its job. What overflowed was content out
                  // of a box that never clipped. A gate that measures the
                  // right thing can still miss the failure one layer inside
                  // it, which is why the gate now also checks content (see
                  // scripts/verify-resize.mjs).
                  "h-full overflow-y-auto [&>*]:h-full",
                  // The card drawn inside (`StyledSurface`) clips to its OWN
                  // rounded corner but is deliberately given `overflow-visible`
                  // by `Panel` — see the comment on its root, guarded by
                  // tests/ui/panel-fit.test.tsx — so a chart's end labels are
                  // never sliced. That leaves THIS box as the only thing that
                  // still clips, and until now it clipped to a plain
                  // rectangle: content that overflowed the card's rounded
                  // corner (a loading skeleton, a stray row) painted past it,
                  // square, onto the bare canvas below. Rounding this box to
                  // the same `--ui-radius-card` the card's own default corner
                  // resolves to makes the two edges coincide for the shipped
                  // look; `getBoundingClientRect()` — what the fit and overlap
                  // gates measure — is unaffected by `border-radius`, so
                  // nothing that gate guards changes.
                  "rounded-[var(--ui-radius-card)]",
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
                  {/* Straddling the corner, which is the only place it can go.
                      Two wrong answers were tried first: `-top-2.5 right-2`
                      put it in the gap ABOVE the card, a white circle floating
                      between two panels and attached to neither; moving it
                      inside to `top-2 right-2` attached it and immediately
                      landed it on top of the card's own header — over the
                      icon well on a stat panel, over "11 projects" on a table.
                      A control that covers the content it belongs to is worse
                      than one that floats.

                      On the corner it overlaps only the card's rounded edge,
                      where by construction there is nothing to cover, and it
                      still reads as attached — which is exactly where a phone
                      puts a delete badge, for the same reason. */}
                  {/* `data-tile-chrome` raises this badge's tap floor: the
                      tile around it is scaled to 0.965 while arrange mode is
                      on, so a 44px hit area is 42.5 under the finger. See the
                      rule in globals.css. */}
                  <div
                    data-tile-chrome
                    className="pointer-events-none absolute -right-2 -top-2 z-20 flex items-center gap-1"
                  >
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
                      // The SAVED rows, never the live preview. The grip's
                      // release guard asks "did the drag change what is
                      // stored", and feeding it the preview answers "no" the
                      // moment the preview flushes — which a real browser
                      // does mid-gesture and jsdom does not. That one
                      // difference is why height commits passed every test
                      // and failed every actual drag, while width — wired to
                      // `w.span`, the stored value — worked all along.
                      rows={w.rows ?? tile.rows ?? 1}
                      min={tile.minSpan}
                      max={tile.maxSpan}
                      natural={!sized && w.rows === undefined}
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

      {shown.widgets.length === 0 &&
        !editing &&
        (typeof emptyMessage === "function"
          ? emptyMessage(() => setEditing(true))
          : emptyMessage)}

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
            <div
              className="pointer-events-auto flex items-center gap-3 rounded-full bg-foreground px-4 py-2 text-background shadow-xl"
              ref={helperBarRef}
            >
              <span className="text-xs">
                Hold and drag to move. Drag a corner to resize.
              </span>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="tap-target rounded-full bg-background px-3 py-1 text-xs font-medium text-foreground"
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
  natural,
  gridId,
  onResize,
  onPreview,
}: {
  label: string;
  span: WidgetSpan;
  rows: WidgetRows;
  min: WidgetSpan;
  max: WidgetSpan;
  /** True when this panel currently has no chosen height (natural screen). */
  natural: boolean;
  gridId: string;
  /** `rows` is undefined when the gesture never moved vertically. */
  onResize: (span: WidgetSpan, rows: WidgetRows | undefined) => void;
  /** Live size during the drag; null when the gesture ends. Never persisted. */
  onPreview: (
    size:
      | {
          span: WidgetSpan;
          rows: WidgetRows;
          heightTouched: boolean;
          /** Where the pointer actually is, in px. Drawn during the gesture;
              never saved — the committed size is `span`/`rows`. */
          exact?: { width: number; height: number };
        }
      | null,
  ) => void;
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
  const naturalRef = useRef(natural);
  naturalRef.current = natural;
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
    /** Whether the pointer has crossed a row threshold at least once. Until
        it has, the gesture is a width drag and must not claim a height. */
    let heightTouched = false;
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
      // Divide by the columns actually drawn, not by the maximum. Otherwise
      // the drag and the layout disagree at every width but the widest.
      column = gridWidth > 0 ? gridWidth / columnsFor(gridWidth) : 320;
      heightTouched = false;
      // The row height comes from the tile being dragged rather than from the
      // grid, because the grid's height is however many rows happen to exist.
      const tileBox = el.closest("[data-tile]")?.getBoundingClientRect();
      rowHeight =
        tileBox && tileBox.height > 0
          ? tileBox.height / Math.max(1, startRows)
          : ROW_HEIGHT_FALLBACK;
      // On a natural screen the tile's height is its content's, which can be
      // far from `startRows × unit`. Starting the ladder from the rung
      // nearest the real height keeps the first threshold a small movement
      // away in either direction — measured against the unit the committed
      // height will actually use, so the preview and the result agree.
      if (naturalRef.current && tileBox && tileBox.height > 0) {
        startRows = Math.min(
          Math.max(Math.round(tileBox.height / (ROW_UNIT + ROW_GAP)), 1),
          MAX_ROWS,
        ) as WidgetRows;
        rowHeight = ROW_UNIT + ROW_GAP;
      }
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
      const { min: lo, max: hi } = boundsRef.current;

      // ── The size the pointer is literally at, unrounded ──
      //
      // This used to round to whole columns and rows and only repaint when the
      // rounded number changed. So the tile did not follow your finger: it sat
      // still for most of a column's width and then jumped the whole ~300px at
      // once — and because the tile also carries a spring transition, every
      // jump animated on top of the jump. That is the whole of "not fluid,
      // then snaps into place, extremely choppy". The maths was right and the
      // feel was wrong, which is why no amount of fixing the write path
      // touched it.
      //
      // Direct manipulation means the edge is under the pointer at all times,
      // and the snap happens once, when you let go.
      const exactSpan = startSpan + (e.clientX - startX) / column;
      const exactRows = startRows + (e.clientY - startY) / rowHeight;
      const width = Math.min(Math.max(exactSpan, lo), hi) * column;
      const heightRows = Math.min(Math.max(exactRows, 1), MAX_ROWS);

      // The rounded size is still tracked, because that is what will be saved
      // and what the grid has to make room for.
      const nextSpan = Math.min(
        Math.max(Math.round(exactSpan), lo),
        hi,
      ) as WidgetSpan;
      const nextRows = Math.min(
        Math.max(Math.round(exactRows), 1),
        MAX_ROWS,
      ) as WidgetRows;
      if (nextRows !== startRows) heightTouched = true;
      lastReported = { span: nextSpan, rows: nextRows };
      onPreviewRef.current({
        ...lastReported,
        heightTouched,
        // Pixels for the frame, cells for the commit.
        exact: {
          width,
          height: heightRows * ROW_UNIT + (heightRows - 1) * ROW_GAP,
        },
      });
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
        (settled.span !== spanRef.current ||
          (heightTouched && settled.rows !== rowsRef.current))
      ) {
        onResizeRef.current(
          settled.span,
          heightTouched ? settled.rows : undefined,
        );
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
      data-resize-grip
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
