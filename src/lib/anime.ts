"use client";

import { useEffect, useRef } from "react";
import {
  animate,
  createLayout,
  createScope,
  createSpring,
  stagger,
  utils,
  type AutoLayout,
  type Scope,
} from "animejs";

// anime.js, with one job each.
//
// This project already has two motion libraries and neither is being replaced:
// `motion/react` animates components in the dashboard, GSAP owns the marketing
// site. anime.js earns its place by doing the two things neither can:
//
//   1. **Interpolating the design tokens themselves.** anime.js animates plain
//      JS objects, so a token set can be tweened and written to
//      `document.documentElement` on each frame. That is how the whole app
//      morphs when someone drags a slider, without a single component
//      re-rendering.
//   2. **FLIP layout transitions** (`createLayout`). When the sidebar moves
//      from the left to the right, or becomes a floating panel, every element
//      in the shell changes box. anime.js records the old boxes, lets React
//      re-layout, and animates the difference — which is the only way that
//      reads as one object moving rather than the screen cutting.
//
// Everything here reads `--ui-motion-scale`, so a user who set motion to 0 gets
// an app that changes state instantly instead of an app with broken
// animations. Reduced-motion at the OS level wins over any stored preference.

/** The one easing, matched to the existing `EASE` in components/motion.tsx. */
export const EASE_OUT = "cubicBezier(0.16, 1, 0.3, 1)";

export const SPRING = createSpring({ stiffness: 180, damping: 20 });

export { animate, createScope, createSpring, stagger, utils };
export type { Scope };

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The user's motion multiplier, read from the live token.
 *
 * Read from CSS rather than passed through React context on purpose: this is
 * called inside animation callbacks that must not re-run when a provider
 * re-renders, and the token is already the single source of truth.
 */
export function motionScale(): number {
  if (typeof document === "undefined") return 1;
  if (prefersReducedMotion()) return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(
    "--ui-motion-scale",
  );
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, 2)) : 1;
}

/** A designed duration, scaled by the user's preference. 0 means instant. */
export function scaled(ms: number): number {
  const scale = motionScale();
  return scale === 0 ? 0 : Math.round(ms * scale);
}

/**
 * Scope anime.js work to a ref and revert it on unmount.
 *
 * `createScope` is what keeps this safe in React: everything created inside
 * the callback is torn down and its inline styles reverted when the scope is
 * disposed, so a component that unmounts mid-animation doesn't leave a
 * half-transformed element behind.
 */
export function useAnimeScope(
  setup: (scope: Scope) => void | (() => void),
  deps: unknown[] = [],
) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const setupRef = useRef(setup);
  setupRef.current = setup;

  useEffect(() => {
    if (!rootRef.current) return;
    const scope = createScope({ root: rootRef.current }).add((self) => {
      if (self) setupRef.current(self);
    });
    return () => scope.revert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return rootRef;
}

// ── Token morphing ──────────────────────────────────────────────────────

type Tokens = Record<string, string>;

/** Split "1.25rem" into its number and unit so it can be interpolated. */
function splitUnit(value: string): { n: number; unit: string } | null {
  const match = /^(-?[\d.]+)([a-z%]*)$/i.exec(value.trim());
  if (!match) return null;
  const n = Number.parseFloat(match[1]);
  return Number.isFinite(n) ? { n, unit: match[2] } : null;
}

function isHex(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value.trim());
}

function hexToRgb(hex: string): [number, number, number] {
  const v = hex.trim().slice(1);
  return [
    Number.parseInt(v.slice(0, 2), 16),
    Number.parseInt(v.slice(2, 4), 16),
    Number.parseInt(v.slice(4, 6), 16),
  ];
}

function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((c) => Math.round(Math.min(Math.max(c, 0), 255)).toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * Animate the root's custom properties from wherever they are to `next`.
 *
 * anime.js drives a single `{ t: 0 → 1 }` object and every frame writes the
 * interpolated tokens. Doing it in one animation rather than one per token
 * matters: nine concurrent animations writing to the same element is nine
 * style recalculations per frame, and the radius and the padding would arrive
 * at slightly different times, which looks like a glitch rather than a change.
 *
 * Anything that can't be interpolated — a box-shadow, a border — is swapped at
 * the midpoint, where the change is least visible.
 */
export function morphTokens(next: Tokens, opts?: { duration?: number }): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const duration = opts?.duration ?? scaled(420);

  if (duration === 0) {
    applyTokens(next);
    return;
  }

  const computed = getComputedStyle(root);
  const numeric: { name: string; from: number; to: number; unit: string }[] = [];
  const colors: { name: string; from: [number, number, number]; to: [number, number, number] }[] =
    [];
  const swaps: Tokens = {};

  for (const [name, target] of Object.entries(next)) {
    const current = (root.style.getPropertyValue(name) ||
      computed.getPropertyValue(name)).trim();

    if (isHex(target) && isHex(current)) {
      colors.push({ name, from: hexToRgb(current), to: hexToRgb(target) });
      continue;
    }
    const a = splitUnit(current);
    const b = splitUnit(target);
    if (a && b && a.unit === b.unit) {
      numeric.push({ name, from: a.n, to: b.n, unit: b.unit });
      continue;
    }
    swaps[name] = target;
  }

  let swapped = false;
  animate(
    { t: 0 },
    {
      t: 1,
      duration,
      ease: EASE_OUT,
      onUpdate: (self) => {
        const t = (self.targets[0] as { t: number }).t;
        for (const token of numeric) {
          root.style.setProperty(
            token.name,
            `${(token.from + (token.to - token.from) * t).toFixed(4)}${token.unit}`,
          );
        }
        for (const token of colors) {
          root.style.setProperty(
            token.name,
            rgbToHex([
              token.from[0] + (token.to[0] - token.from[0]) * t,
              token.from[1] + (token.to[1] - token.from[1]) * t,
              token.from[2] + (token.to[2] - token.from[2]) * t,
            ]),
          );
        }
        if (!swapped && t >= 0.5) {
          swapped = true;
          for (const [name, value] of Object.entries(swaps)) {
            root.style.setProperty(name, value);
          }
        }
      },
      onComplete: () => applyTokens(next),
    },
  );
}

/** Write tokens with no animation — the first paint, and motionScale 0. */
export function applyTokens(tokens: Tokens): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(tokens)) {
    root.style.setProperty(name, value);
  }
}

// ── Layout morphing ─────────────────────────────────────────────────────

/**
 * FLIP-animate a structural change.
 *
 * `record()` captures every child's box, the callback performs the change
 * (usually a React state update that re-parents or resizes things), and
 * anime.js animates each element from where it was to where it ended up.
 *
 * Used for the one change that genuinely rearranges the app: moving the
 * sidebar. Without this, going from left to floating is a hard cut, and a hard
 * cut reads as "the page reloaded" rather than "that panel moved".
 */
export function createShellLayout(root: string | HTMLElement): AutoLayout {
  return createLayout(root as never, {
    duration: scaled(520),
    ease: EASE_OUT,
    // Boxes and position: what changes when the sidebar swaps sides.
    properties: ["width", "height", "opacity"],
  });
}

/**
 * Run a layout change through anime.js, or straight through if motion is off.
 *
 * The `requestAnimationFrame` is load-bearing: React has to have committed the
 * new layout before anime.js measures the end state, and `update`'s callback
 * runs synchronously.
 */
export function morphLayout(
  root: string | HTMLElement,
  change: () => void,
): void {
  if (typeof document === "undefined" || scaled(1) === 0) {
    change();
    return;
  }
  let layout: AutoLayout;
  try {
    layout = createShellLayout(root);
  } catch {
    // A root that isn't in the document yet is not worth throwing over.
    change();
    return;
  }
  layout.record();
  change();
  requestAnimationFrame(() => {
    try {
      layout.animate();
    } catch {
      // The change landed either way; only the transition is lost.
    }
  });
}
