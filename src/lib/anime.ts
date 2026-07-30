"use client";

import { useEffect, useRef } from "react";
import {
  animate,
  createAnimatable,
  createDraggable,
  createLayout,
  svg,
  createScope,
  createSpring,
  stagger,
  text,
  utils,
  type AnimatableObject,
  type AutoLayout,
  type Draggable,
  type DraggableParams,
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
export function createShellLayout(
  root: string | HTMLElement,
  children?: string,
): AutoLayout {
  return createLayout(root as never, {
    duration: scaled(520),
    ease: EASE_OUT,
    // Boxes and position: what changes when the sidebar swaps sides.
    properties: ["width", "height", "opacity"],
    ...(children ? { children } : {}),
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
  opts?: {
    /**
     * Which children to animate. The one case that needs it: reflowing a grid
     * around a tile that is being dragged, where the dragged tile's transform
     * belongs to the pointer and must not also be animated by the layout — two
     * things writing one transform is a jitter bug that only shows up under
     * the finger.
     */
    children?: string;
  },
): void {
  if (typeof document === "undefined" || scaled(1) === 0) {
    change();
    return;
  }
  let layout: AutoLayout;
  try {
    layout = createShellLayout(root, opts?.children);
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

// ── Direct manipulation ─────────────────────────────────────────────────
//
// The home-screen vocabulary. Nobody configures a phone's home screen through
// a settings page: you hold a thing until it wobbles, then you move it. That is
// the whole model — there is no separate mode to learn, the surface you are
// looking at *is* the editor — and it needs physics rather than transitions,
// which is what `createDraggable` and `createAnimatable` are for.
//
// Every effect below is load-bearing. The wobble is the signifier that the
// screen is editable. The lean shows which neighbours are about to move. The
// skew is the tile's own momentum. The wake shows the grid settling. None of it
// is ornament, and all of it disappears when motion is turned down.

/** iOS-ish release physics: fast, slightly overshooting, never bouncy. */
export const RELEASE = {
  releaseMass: 0.7,
  releaseStiffness: 140,
  releaseDamping: 14,
} satisfies Partial<DraggableParams>;

/**
 * The wobble that means "you can move this".
 *
 * Three things separate a wobble that feels alive from one that reads as a CSS
 * animation, and the first is the one everybody gets wrong:
 *
 * **Amplitude is compensated for size.** Rotation displaces a corner by roughly
 * (width / 2) x sin(angle), so a fixed angle makes a wide card flap while a
 * small tile barely stirs. Phones get away with one angle because every icon is
 * the same size; a grid of 1-, 2- and 3-column panels does not. So the angle is
 * solved backwards from a constant corner displacement — every panel, whatever
 * its width, moves its corners the same ~2px, which is what makes a mixed grid
 * look like one material rather than several.
 *
 * **The motion is quasi-periodic.** Rotation, x and y each run on a different
 * period, so the composite never exactly repeats. A single sine is a metronome;
 * three incommensurate ones read as something idling under its own power.
 *
 * **Phases are desynchronised.** A grid rocking in step looks like the page is
 * vibrating, which is alarming rather than inviting.
 *
 * Returns a stop function; calling it settles every element back to rest rather
 * than freezing it mid-tilt.
 */

/** How far a corner should travel, in px, regardless of panel size. */
const WOBBLE_CORNER_PX = 2.1;

export function jiggle(elements: Element[]): () => void {
  if (elements.length === 0 || scaled(1) === 0) return () => {};

  const animations = elements.flatMap((el, i) => {
    const width = (el as HTMLElement).offsetWidth || 240;
    // Solve the angle that moves a corner WOBBLE_CORNER_PX for this width, then
    // clamp: a very narrow tile shouldn't spin, a very wide one still needs to
    // register at all.
    const radians = Math.asin(
      Math.min(1, WOBBLE_CORNER_PX / Math.max(width / 2, 1)),
    );
    const degrees = utils.clamp((radians * 180) / Math.PI, 0.16, 1.05);

    // Deterministic per-element jitter — same tile, same character every time,
    // so entering edit mode twice doesn't look like two different screens.
    const seed = (i * 2654435761) % 1000;
    const vary = (base: number, spread: number) =>
      base + ((seed % 97) / 97) * spread;

    return [
      animate(el, {
        rotate: [-degrees, degrees],
        duration: scaled(vary(270, 70)),
        loop: true,
        alternate: true,
        ease: "inOutSine",
        delay: (seed % 180),
      }),
      animate(el, {
        // Translation carries the weight rotation can't on a wide panel, and
        // on its own period so the pair never phase-locks.
        x: [-1.1, 1.1],
        duration: scaled(vary(340, 90)),
        loop: true,
        alternate: true,
        ease: "inOutSine",
        delay: (seed % 130),
      }),
      animate(el, {
        y: [-0.8, 0.8],
        duration: scaled(vary(410, 110)),
        loop: true,
        alternate: true,
        ease: "inOutSine",
        delay: (seed % 220),
      }),
    ];
  });

  return () => {
    for (const a of animations) a.pause();
    animate(elements, {
      rotate: 0,
      x: 0,
      y: 0,
      duration: scaled(240),
      ease: EASE_OUT,
    });
  };
}

/**
 * The screen making room.
 *
 * Entering edit mode shrinks every tile a few percent. It is not decoration: it
 * is the moment the surface stops being a document and becomes a set of objects,
 * and a scale change is the cheapest way to say "these are now things rather
 * than content". Leaving reverses it.
 */
export function inhale(elements: Element[], entering: boolean): void {
  if (elements.length === 0) return;
  animate(elements, {
    scale: entering ? 0.965 : 1,
    duration: scaled(entering ? 320 : 260),
    ease: entering ? SPRING : EASE_OUT,
    delay: stagger(scaled(12), { from: "center" }),
  });
}

/**
 * Neighbours leaning toward whatever is being dragged.
 *
 * The strange one, and the most useful. A tile under the finger has mass, and
 * the tiles it is passing lean a few pixels toward it — so before you let go you
 * can already see which ones are about to be displaced. Falls off with distance,
 * so the effect stays local instead of the whole grid drifting.
 *
 * Built on `createAnimatable` rather than `animate` because this is driven by a
 * pointer, not by a timeline: every frame sets a new target and the animatable
 * eases toward it, which is what makes it feel like weight instead of a series
 * of tweens fighting each other.
 */
export function createMagneticField(elements: Element[]): {
  pull: (x: number, y: number, exclude?: Element | null) => void;
  release: () => void;
  revert: () => void;
} {
  if (scaled(1) === 0) {
    return { pull: () => {}, release: () => {}, revert: () => {} };
  }
  const handles: { el: Element; anim: AnimatableObject }[] = elements.map(
    (el) => ({
      el,
      anim: createAnimatable(el, {
        x: scaled(260),
        y: scaled(260),
        ease: "outQuad",
      }),
    }),
  );

  /** Beyond this many pixels a tile is not a neighbour and shouldn't move. */
  const REACH = 260;
  /** How far a tile is willing to lean, at most. */
  const MAX_LEAN = 10;

  return {
    pull(x, y, exclude) {
      for (const { el, anim } of handles) {
        if (el === exclude) continue;
        const box = el.getBoundingClientRect();
        const dx = x - (box.left + box.width / 2);
        const dy = y - (box.top + box.height / 2);
        const distance = Math.hypot(dx, dy);
        if (distance > REACH || distance === 0) {
          anim.x(0);
          anim.y(0);
          continue;
        }
        // Inverse falloff, clamped: close tiles lean noticeably, far ones don't.
        const strength = (1 - distance / REACH) ** 2 * MAX_LEAN;
        anim.x(utils.clamp((dx / distance) * strength, -MAX_LEAN, MAX_LEAN));
        anim.y(utils.clamp((dy / distance) * strength, -MAX_LEAN, MAX_LEAN));
      }
    },
    release() {
      for (const { anim } of handles) {
        anim.x(0);
        anim.y(0);
      }
    },
    revert() {
      for (const { anim } of handles) anim.revert();
    },
  };
}

/**
 * A tile's own momentum, as shape.
 *
 * Anything with mass deforms slightly when it is thrown. Skewing the dragged
 * tile against its velocity is what separates "an element whose left and top
 * are changing" from "an object being moved", and it costs one transform.
 */
export function velocityDeform(el: Element, velocity: number, angle: number) {
  if (scaled(1) === 0) return;
  const amount = utils.clamp(velocity * 0.5, 0, 7);
  utils.set(el, {
    rotate: `${Math.cos(angle) * amount * 0.35}deg`,
    skewX: `${Math.cos(angle) * amount * -0.5}deg`,
    skewY: `${Math.sin(angle) * amount * -0.5}deg`,
  });
}

/** Put a deformed tile back to rest. */
export function settleDeform(el: Element) {
  animate(el, {
    rotate: 0,
    skewX: 0,
    skewY: 0,
    duration: scaled(420),
    ease: SPRING,
  });
}

/**
 * The grid settling after something lands.
 *
 * A ripple of scale spreading outward from where a tile was dropped, in grid
 * order. What it buys is confirmation: the drop registered, and *these* are the
 * tiles that moved because of it. A single bounce on the dropped tile alone
 * would confirm the drop but say nothing about the consequences.
 */
export function wake(elements: Element[], fromIndex: number): void {
  if (elements.length === 0 || scaled(1) === 0) return;
  animate(elements, {
    scale: [
      { to: 1.022, duration: scaled(130), ease: "outQuad" },
      { to: 1, duration: scaled(320), ease: SPRING },
    ],
    delay: stagger(scaled(26), { from: Math.max(0, fromIndex) }),
  });
}

/**
 * Removing a tile: stretch, then gone.
 *
 * Scaling to zero is a tile disappearing. Stretching it first makes it a tile
 * being *pulled out*, which is the difference between "it vanished" and "I did
 * that" — and the distinction matters most for the one action people fear.
 */
export function tearOut(el: Element, done: () => void): void {
  if (scaled(1) === 0) {
    done();
    return;
  }
  animate(el, {
    scale: [
      { to: 1.06, duration: scaled(110), ease: "outQuad" },
      { to: 0.72, duration: scaled(200), ease: "inQuad" },
    ],
    opacity: { to: 0, duration: scaled(240), ease: "inQuad" },
    onComplete: done,
  });
}

/**
 * A value resolving into place, character by character.
 *
 * For numbers and labels that change because something *happened* — an agent
 * completed work, a rollup moved. A number that silently becomes a different
 * number is a number nobody notices changed; scrambling it for a fifth of a
 * second is the smallest possible way to say "this is new", and it reads as the
 * value settling rather than as an effect being applied to it.
 */
export function scrambleTo(el: Element, value: string): void {
  if (scaled(1) === 0) {
    el.textContent = value;
    return;
  }
  animate(el, {
    duration: scaled(560),
    ease: "outQuad",
    text: text.scrambleText({ text: value, chars: "0-9" }),
  });
}

/**
 * A line running the perimeter of a panel.
 *
 * For a surface an agent is currently inside. A pulsing dot says "something is
 * happening somewhere"; a line travelling the edge of *this* panel says the
 * machine is working in here. Uses the SVG drawable so the stroke is drawn
 * rather than faded, which is why it reads as travel instead of a glow.
 *
 * Returns a stop function.
 */
export function traceEdge(svgPath: SVGGeometryElement): () => void {
  if (scaled(1) === 0) return () => {};
  const [drawable] = svg.createDrawable(svgPath, 0, 0.18);
  const running = animate(drawable, {
    draw: ["0 0.18", "0.82 1"],
    duration: scaled(2600),
    loop: true,
    ease: "linear",
  });
  return () => running.revert();
}

/** Re-exported so callers build draggables through this module's tuning. */
export { createDraggable, utils as animeUtils };
export type { Draggable };
