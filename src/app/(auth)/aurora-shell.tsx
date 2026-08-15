"use client";

import { useEffect, useRef } from "react";
import { auraBorder, auraInstanceOf } from "@/components/marketing/aurora";

// The Aurora Glow frame around the sign-in / sign-up screens: arriving on
// the page lights the border and fires one ripple from the auth card — the
// ambient "AI is active" signal for the door into an agent workspace.
//
// This replaces the BorderBeam that used to trace the same viewport edge:
// two frame effects stacked on one edge read as a glitch, and this is the
// richer of the two. Palette "ocean" keeps the beam's mint/aqua/azure
// identity. The canvas paints its container near-black and OPAQUE (the
// effect's design), so everything inside the shell stacks above it with
// z-index; the shell's own #0a0a0a survives as the no-WebGL fallback.
// Reduced motion is handled inside the vendored function — static states,
// no animation loop.

export function AuroraShell({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    auraBorder(root);
    const instance = auraInstanceOf(root);
    // A beat after mount, so the fade-in and the ripple land on a page the
    // person is already looking at rather than mid-paint.
    const timer = window.setTimeout(() => instance?.setActive(true), 250);
    return () => {
      window.clearTimeout(timer);
      instance?.destroy();
    };
  }, []);

  return (
    <div
      ref={ref}
      data-aura-border
      data-dither-src="https://www.details.so/vault-previews/aurora-glow/_astro/dither.DYfTq7JB.png"
      data-state="off"
      data-palette="ocean"
      className="relative isolate flex min-h-dvh w-full bg-[#0a0a0a] text-white"
    >
      <canvas
        data-aura-canvas
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0 h-full w-full select-none"
      />
      {children}
    </div>
  );
}
