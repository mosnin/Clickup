import type { SidebarPosition } from "@/lib/appearance";

// Where the navigation can be put down.
//
// This is pure geometry on purpose. The bug it exists to prevent was not a
// physics bug or an animation bug — it was two descriptions of the same target
// disagreeing: the hit test asked whether the pointer was below 78% of the
// viewport height while the guide drawn on screen was an 80px bar at the very
// bottom. You aimed at the thing you could see, landed in the gap between the
// two answers, and got "floating" — the nav torn loose in the middle of the
// screen. One function now answers both questions, and `dropZoneFor` is tested
// against the centre and corners of every rectangle `dropZones` returns.

export type DropZone = {
  id: SidebarPosition;
  label: string;
  /** Viewport coordinates, CSS pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Distance the dock zone stands off the bottom edge. */
const PAD = 12;
/** How tall the bottom target is — roughly a dock plus breathing room. */
const DOCK_HEIGHT = 96;

/**
 * The three docks, as rectangles.
 *
 * "floating" is deliberately absent: it is not a place, it is the absence of
 * one. Everything outside these rectangles means "leave it loose", which is
 * why the middle of the screen needs no rectangle to claim it.
 */
export function dropZones(viewportWidth: number, viewportHeight: number): DropZone[] {
  const w = Math.max(1, viewportWidth);
  const h = Math.max(1, viewportHeight);
  const railWidth = Math.min(140, w * 0.18);
  // The side rails stop short of the dock so the corners belong to exactly one
  // zone. Overlapping targets are how a drop becomes a coin flip.
  const railHeight = Math.max(1, h - DOCK_HEIGHT - PAD * 3);

  return [
    {
      id: "dock",
      label: "Dock at the bottom",
      x: w * 0.2,
      y: h - DOCK_HEIGHT - PAD,
      width: w * 0.6,
      height: DOCK_HEIGHT,
    },
    {
      id: "left",
      label: "Dock left",
      x: PAD,
      y: PAD,
      width: railWidth,
      height: railHeight,
    },
    {
      id: "right",
      label: "Dock right",
      x: w - railWidth - PAD,
      y: PAD,
      width: railWidth,
      height: railHeight,
    },
  ];
}

/** Whether a point falls inside a zone, edges included. */
export function zoneContains(zone: DropZone, x: number, y: number): boolean {
  return (
    x >= zone.x &&
    x <= zone.x + zone.width &&
    y >= zone.y &&
    y <= zone.y + zone.height
  );
}

/**
 * What a drop at this point would do.
 *
 * Reads the same rectangles that get drawn, in the same order, so a pointer
 * inside a visible guide always returns that guide's zone.
 */
export function dropZoneFor(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
): SidebarPosition {
  for (const zone of dropZones(viewportWidth, viewportHeight)) {
    if (zoneContains(zone, x, y)) return zone.id;
  }
  return "floating";
}
