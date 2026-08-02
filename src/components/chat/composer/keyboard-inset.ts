"use client";

// How much of the window the on-screen keyboard is covering.
//
// The Chat shell pins the viewport (`h-svh overflow-hidden`) so the transcript
// scrolls and the composer does not walk off the bottom. That is exactly right
// on a desktop and exactly not enough on a phone: iOS does not resize the
// layout viewport when the keyboard opens, it just puts the keyboard on top of
// it. `100svh` still measures the whole screen, so the composer stays where it
// was — underneath the keys somebody is typing on.
//
// The visual viewport is the only thing that knows. The overlap is the layout
// viewport's height minus what is still visible, and the composer pays for it
// with bottom padding: its box stays anchored to the bottom of the screen while
// its contents rise above the keyboard, and the transcript (a `flex-1` sibling)
// gives up the same pixels. No fixed positioning, no scroll hacks, and it
// unwinds by itself the moment the keyboard closes.
//
// Zero everywhere the API is missing — which includes every desktop browser
// worth naming, and jsdom.

import { useEffect, useState } from "react";

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : undefined;
    if (!vv) return;

    function measure() {
      const viewport = window.visualViewport;
      if (!viewport) return;
      // `offsetTop` matters: when the page itself has been scrolled by the
      // keyboard, part of the shortfall is already accounted for and
      // subtracting only the height double-counts it.
      const covered = window.innerHeight - viewport.height - viewport.offsetTop;
      // A pixel or two of rounding is not a keyboard. The threshold keeps a
      // resize storm from re-laying-out the room over sub-pixel noise.
      setInset(covered > 24 ? Math.round(covered) : 0);
    }

    measure();
    vv.addEventListener("resize", measure);
    vv.addEventListener("scroll", measure);
    return () => {
      vv.removeEventListener("resize", measure);
      vv.removeEventListener("scroll", measure);
    };
  }, []);

  return inset;
}
