"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  useAppearance,
} from "@/components/appearance/appearance-provider";
import { EASE } from "@/components/motion";
import { animate, animeUtils, morphLayout, scaled } from "@/lib/anime";
import type { SidebarPosition } from "@/lib/appearance";
import { dropZoneFor, dropZones } from "@/lib/nav-dock";
import { cn } from "@/lib/utils";

// Grab the shell itself.
//
// The tiles taught the gesture — hold a thing until it admits it can be moved —
// and this applies it to the largest structural element the app has. Hold the
// sidebar for a moment and it lifts; drag it across the screen and the whole
// shell is an object in your hand: throw it at the right edge and it docks
// there, let go in the middle and it tears out into a floating panel. There is
// no setting behind this. The setting IS the drag.
//
// Persistence rides the appearance system: sidebarPosition is a personal key
// stored in Convex, so where you put your nav follows you to every device, and
// no space can override it. The commit runs through morphLayout, so the shell
// reflows as one object moving rather than a cut.
//
// Constraints that keep this honest:
//  - Long-press (~650ms) with slop, so clicking a nav link, scrolling, and
//    dragging never collide. A press that moves is a scroll; a press that
//    ends early is a click; only a held, still press becomes a grab.
//  - Desktop only. Below md the sidebar is a drawer with its own gestures.
//  - The drag is a *proxy* translation of the real element — layout doesn't
//    thrash while you drag; it reflows once, on the drop.

const HOLD_MS = 650;
const HOLD_SLOP = 8;

/** The drawn guides and the hit test, from one source (see `lib/nav-dock`). */
const zoneRects = () => dropZones(window.innerWidth, window.innerHeight);
const zoneFor = (x: number, y: number) =>
  dropZoneFor(x, y, window.innerWidth, window.innerHeight);

const animeSet = animeUtils.set;

export function SidebarDock() {
  const { appearance, commit } = useAppearance();
  // Which dock the drag is currently over; null = not dragging. This is the
  // only React state — the per-frame transform goes straight to the element.
  const [zone, setZone] = useState<SidebarPosition | null>(null);
  const [guides, setGuides] = useState<ReturnType<typeof zoneRects>>([]);
  const zoneRef = useRef<SidebarPosition | null>(null);
  const position = appearance.sidebarPosition;
  const positionRef = useRef(position);
  positionRef.current = position;
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    // Grab whichever nav is actually on screen.
    //
    // This used to bind unconditionally to the sidebar container, which is
    // `display: none` once the nav becomes a dock — so the gesture that moved
    // it to the bottom stopped existing the moment it succeeded, and there was
    // no way to bring it back. The nav is one object in two costumes; the drag
    // follows the costume that is currently worn.
    const docked = position === "dock";
    const selector = docked
      ? '[data-slot="dock-rail"]'
      : '[data-slot="sidebar-container"]';

    let disposed = false;
    let detach: (() => void) | null = null;

    // The rail and the sidebar are siblings under the provider, so a position
    // change re-renders both — but effect order between siblings is document
    // order, and the costume being put on may not be in the DOM yet when this
    // runs. Wait for it rather than binding to nothing and silently losing the
    // gesture until the next reload.
    let frames = 0;
    const attempt = () => {
      if (disposed) return;
      const found = document.querySelector<HTMLElement>(selector);
      if (!found) {
        if (frames++ < 60) requestAnimationFrame(attempt);
        return;
      }
      detach = bind(found);
    };

    function bind(container: HTMLElement) {
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let startX = 0;
    let startY = 0;
    let engaged = false;
    /** Whether this binding has written a transform that needs undoing. */
    let touched = false;
    let pointerId: number | null = null;
    // The click event arrives AFTER pointerup, by which time the drag state is
    // already cleared — so suppression needs its own flag or the nav link
    // under the finger fires on every drop.
    let suppressClick = false;

    const setZoneBoth = (z: SidebarPosition | null) => {
      zoneRef.current = z;
      setZone(z);
    };

    const lift = () => {
      engaged = true;
      touched = true;
      if (pointerId !== null) {
        try {
          container.setPointerCapture(pointerId);
        } catch {
          // A pointer that vanished between the timer firing and now.
        }
      }
      container.style.willChange = "transform";
      container.style.zIndex = "60";
      container.style.cursor = "grabbing";
      // The floating sidebar carries a CSS `transition: transform` so its
      // collapse animates. Left on during a drag it lags every frame behind the
      // hand by 350ms, which reads as the panel being stuck in treacle.
      container.style.transition = "none";
      // Tell the dock's magnification loop to stand down: items ballooning
      // under the cursor while the whole rail is in your hand is two gestures
      // arguing over one pointer.
      container.dataset.navDragging = "true";
      animate(container, {
        scale: 0.96,
        duration: scaled(220),
        ease: "outQuad",
      });
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate(8);
      }
      setGuides(zoneRects());
      setZoneBoth(positionRef.current);
    };

    /**
     * Put the element back where CSS wants it — instantly.
     *
     * Deliberately not an animation. The drop triggers a layout change through
     * morphLayout, which measures boxes before and after and animates the
     * difference; a spring running on the same element's transform at the same
     * time fights it, and when the new position is "dock" the element is
     * display:none before the spring finishes, leaving a stale transform behind
     * that made the sidebar impossible to put back.
     */
    const settle = () => {
      // Only undo a transform we actually wrote. Writing an identity transform
      // unconditionally looks harmless and is not: an inline
      // `transform: translateX(0)` outranks the stylesheet, and the floating
      // sidebar collapses by way of a CSS `translateX(calc(-100% - 1rem))` —
      // so an untouched sidebar that had merely been re-bound could never
      // slide away again.
      if (!touched) return;
      touched = false;
      container.style.cursor = "";
      animeSet(container, { x: 0, y: 0, scale: 1, rotate: 0 });
      container.style.transform = "";
      container.style.willChange = "";
      container.style.zIndex = "";
      container.style.transition = "";
      delete container.dataset.navDragging;
    };

    const cancelHold = () => {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = null;
    };

    const onPointerDown = (e: PointerEvent) => {
      // Left button / primary touch, desktop widths only.
      if (e.button !== 0 || window.innerWidth < 768) return;
      // Inside the dock, a held item is being *reordered* — that gesture is
      // shorter (400ms) and belongs to the dock. Only the rail itself, between
      // and around its items, moves the whole nav.
      if (
        docked &&
        (e.target as HTMLElement | null)?.closest("[data-dock-item]")
      ) {
        return;
      }
      startX = e.clientX;
      startY = e.clientY;
      pointerId = e.pointerId;

      // The handle drags on contact.
      //
      // The long-press exists to disambiguate a grab from clicking the nav
      // link under your finger. A handle that does nothing else needs no
      // disambiguation — and asking someone to hold 650ms without moving more
      // than 8px on a rail with twelve pixels of padding is not a gesture,
      // it's a lottery. That is why the dock "could not be grabbed".
      if ((e.target as HTMLElement | null)?.closest("[data-nav-grab]")) {
        e.preventDefault();
        lift();
        return;
      }
      holdTimer = setTimeout(lift, HOLD_MS);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!engaged) {
        // Movement during the hold is a scroll or a normal drag-to-select,
        // not a grab. Let it be one.
        if (
          holdTimer &&
          (Math.abs(e.clientX - startX) > HOLD_SLOP ||
            Math.abs(e.clientY - startY) > HOLD_SLOP)
        ) {
          cancelHold();
        }
        return;
      }
      e.preventDefault();
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // The proxy translation: the sidebar follows the hand with a slight
      // trailing tilt, and the real layout stays put until the drop. Written
      // through anime's transform cache (utils.set), not style.transform —
      // settle() animates the same properties, and a hand-written transform
      // string would leave it animating from stale values.
      animeSet(container, {
        x: dx * 0.85,
        // Vertical follow is damped when the nav is a tall column — a sidebar
        // tracking the hand 1:1 downward walks straight out of the viewport —
        // but a dock has to travel the full height of the screen to reach a
        // side rail, so it follows honestly.
        y: dy * (docked ? 0.85 : 0.35),
        scale: 0.96,
        rotate: Math.max(-2.5, Math.min(2.5, dx * 0.008)),
      });
      const z = zoneFor(e.clientX, e.clientY);
      if (z !== zoneRef.current) {
        setZoneBoth(z);
        if (typeof navigator !== "undefined" && navigator.vibrate) {
          navigator.vibrate(4);
        }
      }
    };

    const onPointerUp = () => {
      cancelHold();
      if (!engaged) return;
      engaged = false;
      suppressClick = true;
      const target = zoneRef.current;
      setZoneBoth(null);
      settle();
      if (target && target !== positionRef.current) {
        // The one real layout change, as one movement of the whole shell.
        morphLayout("body", () =>
          commitRef.current({ sidebarPosition: target }, "personal"),
        );
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && engaged) {
        engaged = false;
        cancelHold();
        setZoneBoth(null);
        settle();
      }
    };

    // A drag that engaged must not also fire the link under the finger.
    const onClickCapture = (e: MouseEvent) => {
      if (suppressClick) {
        suppressClick = false;
        e.stopPropagation();
        e.preventDefault();
      }
    };

    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", onPointerUp);
    container.addEventListener("pointercancel", onPointerUp);
    container.addEventListener("click", onClickCapture, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelHold();
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("pointercancel", onPointerUp);
      container.removeEventListener("click", onClickCapture, true);
      window.removeEventListener("keydown", onKeyDown);
      // A drag interrupted by the element going away must not leave a
      // transform on it — that is exactly how the nav got stranded mid-screen.
      settle();
    };
    }

    attempt();
    return () => {
      disposed = true;
      detach?.();
    };
  }, [position]);

  // The docking guides: visible only mid-drag, naming what a drop would do.
  // Without them the gesture is a secret; with them, the first accidental
  // long-press teaches the whole feature.
  return (
    <AnimatePresence>
      {zone !== null && (
        <motion.div
          key="dock-guides"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: EASE }}
          className="pointer-events-none fixed inset-0 z-50"
          aria-hidden
        >
          {/* Drawn from the same rectangles the hit test uses, so the target
              you aim at is the target you hit. */}
          {guides.map(({ id, x, y, width, height, label }) => (
            <div
              key={id}
              style={{ position: "absolute", left: x, top: y, width, height }}
              className={cn(
                "flex items-center justify-center rounded-2xl border-2 border-dashed text-sm font-medium transition-colors duration-150",
                zone === id
                  ? "border-foreground bg-foreground/10 text-foreground"
                  : "border-border/70 text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  id === "left" && "-rotate-90",
                  id === "right" && "rotate-90",
                )}
              >
                {label}
              </span>
            </div>
          ))}

          {/* Not a rectangle, because floating is the absence of a dock: the
              hint sits in the middle where nothing else claims. */}
          <div
            className={cn(
              "absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-2xl px-6 py-4 text-sm font-medium transition-colors duration-150",
              zone === "floating"
                ? "bg-foreground/10 text-foreground"
                : "text-muted-foreground/60",
            )}
          >
            Let go anywhere else to float
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
