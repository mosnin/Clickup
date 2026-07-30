"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  useAppearance,
} from "@/components/appearance/appearance-provider";
import { EASE } from "@/components/motion";
import { animate, animeUtils, morphLayout, scaled } from "@/lib/anime";
import type { SidebarPosition } from "@/lib/appearance";
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

/** Which dock the pointer is over: left third, right third, middle floats. */
function zoneFor(x: number): SidebarPosition {
  const w = window.innerWidth;
  if (x < w * 0.3) return "left";
  if (x > w * 0.7) return "right";
  return "floating";
}

const animeSet = animeUtils.set;

export function SidebarDock() {
  const { appearance, commit } = useAppearance();
  // Which dock the drag is currently over; null = not dragging. This is the
  // only React state — the per-frame transform goes straight to the element.
  const [zone, setZone] = useState<SidebarPosition | null>(null);
  const zoneRef = useRef<SidebarPosition | null>(null);
  const positionRef = useRef(appearance.sidebarPosition);
  positionRef.current = appearance.sidebarPosition;
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    const container = document.querySelector<HTMLElement>(
      '[data-slot="sidebar-container"]',
    );
    if (!container) return;

    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let startX = 0;
    let startY = 0;
    let engaged = false;
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
      animate(container, {
        scale: 0.96,
        duration: scaled(220),
        ease: "outQuad",
      });
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate(8);
      }
      setZoneBoth(positionRef.current);
    };

    const settle = () => {
      container.style.cursor = "";
      animate(container, {
        x: 0,
        scale: 1,
        rotate: 0,
        duration: scaled(360),
        ease: "cubicBezier(0.16, 1, 0.3, 1)",
        onComplete: () => {
          container.style.willChange = "";
          container.style.zIndex = "";
        },
      });
    };

    const cancelHold = () => {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = null;
    };

    const onPointerDown = (e: PointerEvent) => {
      // Left button / primary touch, desktop widths only.
      if (e.button !== 0 || window.innerWidth < 768) return;
      startX = e.clientX;
      startY = e.clientY;
      pointerId = e.pointerId;
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
      // The proxy translation: the sidebar follows the hand with a slight
      // trailing tilt, and the real layout stays put until the drop. Written
      // through anime's transform cache (utils.set), not style.transform —
      // settle() animates the same properties, and a hand-written transform
      // string would leave it animating from stale values.
      animeSet(container, {
        x: dx * 0.85,
        scale: 0.96,
        rotate: Math.max(-2.5, Math.min(2.5, dx * 0.008)),
      });
      const z = zoneFor(e.clientX);
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
    };
  }, []);

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
          <DockGuide side="left" active={zone === "left"} label="Dock left" />
          <DockGuide side="right" active={zone === "right"} label="Dock right" />
          <div
            className={cn(
              "absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-2xl border-2 border-dashed px-8 py-6 text-sm font-medium transition-all duration-150",
              zone === "floating"
                ? "scale-105 border-foreground bg-foreground/5 text-foreground"
                : "border-border text-muted-foreground",
            )}
          >
            Float
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function DockGuide({
  side,
  active,
  label,
}: {
  side: "left" | "right";
  active: boolean;
  label: string;
}) {
  return (
    <div
      className={cn(
        "absolute bottom-6 top-6 flex w-24 items-center justify-center rounded-2xl border-2 border-dashed text-sm font-medium transition-all duration-150",
        side === "left" ? "left-3" : "right-3",
        active
          ? "border-foreground bg-foreground/5 text-foreground"
          : "border-border text-muted-foreground",
      )}
    >
      <span className={cn(side === "right" && "rotate-90", side === "left" && "-rotate-90")}>
        {label}
      </span>
    </div>
  );
}
