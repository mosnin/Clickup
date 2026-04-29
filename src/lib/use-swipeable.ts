"use client";

import { useEffect, useRef, useState } from "react";

// Lightweight horizontal-swipe hook. Tracks touch deltas, reveals an
// action background underneath, and triggers `onSwipeLeft` /
// `onSwipeRight` once the user crosses `threshold` and lifts their
// finger. No external dep — useful when @use-gesture would be too much.
//
// Returns:
//   - `bind`: spread onto the swipeable element
//   - `dx`: current horizontal offset (px), positive = right
//   - `swiping`: true while a touch is in progress
//
// Mouse-only devices ignore the handlers (no `ontouchstart`); the
// element behaves like a normal row.

export function useSwipeable({
  onSwipeLeft,
  onSwipeRight,
  threshold = 80,
  enabled = true,
}: {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  threshold?: number;
  enabled?: boolean;
}) {
  const [dx, setDx] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const directionLockRef = useRef<"horizontal" | "vertical" | null>(null);

  // Reset when disabled mid-swipe.
  useEffect(() => {
    if (!enabled) {
      setDx(0);
      setSwiping(false);
      directionLockRef.current = null;
    }
  }, [enabled]);

  const bind = enabled
    ? {
        onTouchStart: (e: React.TouchEvent) => {
          const t = e.touches[0];
          startXRef.current = t.clientX;
          startYRef.current = t.clientY;
          directionLockRef.current = null;
          setSwiping(true);
        },
        onTouchMove: (e: React.TouchEvent) => {
          const t = e.touches[0];
          const rawDx = t.clientX - startXRef.current;
          const rawDy = t.clientY - startYRef.current;
          // Lock direction the first frame we see significant movement.
          // Vertical-locked gestures pass through to the page (scroll).
          if (directionLockRef.current === null) {
            if (Math.abs(rawDx) > 8 || Math.abs(rawDy) > 8) {
              directionLockRef.current =
                Math.abs(rawDx) > Math.abs(rawDy) ? "horizontal" : "vertical";
            }
          }
          if (directionLockRef.current === "horizontal") {
            // Cap at 1.5 * threshold so the row can't fly off-screen.
            const capped = Math.max(
              -threshold * 1.5,
              Math.min(threshold * 1.5, rawDx),
            );
            setDx(capped);
          }
        },
        onTouchEnd: () => {
          setSwiping(false);
          if (directionLockRef.current === "horizontal") {
            if (dx > threshold) onSwipeRight?.();
            else if (dx < -threshold) onSwipeLeft?.();
          }
          setDx(0);
          directionLockRef.current = null;
        },
        onTouchCancel: () => {
          setSwiping(false);
          setDx(0);
          directionLockRef.current = null;
        },
      }
    : {};

  return { bind, dx, swiping };
}
