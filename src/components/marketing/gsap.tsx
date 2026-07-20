"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { ScrollToPlugin } from "gsap/ScrollToPlugin";
import { cn } from "@/lib/utils";

// Marketing v2 motion kit — every logged-out animation goes through GSAP
// with one shared vocabulary. Rules:
//   - EASE_OUT / DUR are the only timing values; don't invent new ones.
//   - Everything respects prefers-reduced-motion: with it set, elements
//     jump to their final state and ScrollTriggers never register.
//   - Wrap imperative timelines in useGsap(); it scopes selectors to the
//     ref and reverts cleanly on unmount (React 18 strict-mode safe).
//     Confirmed against the installed gsap (ScrollTrigger.js registers
//     every instance with the active gsap.context() at creation time),
//     so ctx.revert() kills ScrollTriggers created inside the callback
//     too — no separate ScrollTrigger.kill() bookkeeping needed.

gsap.registerPlugin(ScrollTrigger, ScrollToPlugin);

export const EASE_OUT = "power3.out";
const EASE_IN_OUT = "power2.inOut";
export const DUR = { fast: 0.4, base: 0.7, slow: 1.1 } as const;

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The single sanctioned place for scroll-to-anchor logic. Scrolls the
 * window to `hash` (e.g. "#pricing") using the shared DUR.base /
 * EASE_IN_OUT vocabulary, falling back to an instant jump under
 * prefers-reduced-motion. `opts.onComplete` fires either way (immediately
 * for the instant fallback, on tween completion otherwise) so callers can
 * do post-scroll bookkeeping like `history.replaceState`.
 */
export function scrollToAnchor(
  hash: string,
  opts: { offsetY?: number; onComplete?: () => void } = {},
) {
  const { offsetY = 80, onComplete } = opts;
  if (typeof window === "undefined") return;
  if (prefersReducedMotion()) {
    const target = document.querySelector(hash);
    if (target) target.scrollIntoView({ behavior: "auto", block: "start" });
    onComplete?.();
    return;
  }
  return gsap.to(window, {
    duration: DUR.base,
    scrollTo: { y: hash, offsetY },
    ease: EASE_IN_OUT,
    onComplete,
  });
}

/**
 * True when the primary input can hover (mouse/trackpad); false on
 * touch/coarse pointers. A plain matchMedia check in the same style as
 * prefersReducedMotion — SSR-safe and callable anywhere (render, event
 * handlers, effects). A plain predicate, not a React hook, despite
 * consumers formerly working around the misleading `use` prefix with
 * eslint-disable comments.
 */
export function isHoverCapable(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(hover: hover)").matches
  );
}

/**
 * Scoped GSAP context. `fn` runs inside gsap.context(ref) after mount —
 * use selector strings freely; they're scoped to the wrapper. Skipped
 * entirely (with `reduced` fallback applied) under reduced motion.
 */
export function useGsap(
  fn: (ctx: { root: HTMLElement }) => void,
  deps: unknown[] = [],
) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    // Pre-hydration, [data-gs-hidden] keeps reveal targets invisible (see
    // globals.css) so there's no flash before the animation takes over.
    // Either way the attribute comes off here: reduced motion shows the
    // final state; the animated path hands control to inline GSAP styles.
    const unhide = () => {
      if (root.hasAttribute("data-gs-hidden")) {
        root.removeAttribute("data-gs-hidden");
      }
      root
        .querySelectorAll<HTMLElement>("[data-gs-hidden]")
        .forEach((el) => el.removeAttribute("data-gs-hidden"));
    };
    if (prefersReducedMotion()) {
      unhide();
      return;
    }
    const ctx = gsap.context(() => {
      fn({ root });
      unhide();
    }, root);
    return () => ctx.revert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

/**
 * Fade + rise + un-blur on scroll into view. Children marked with
 * `data-gs-hidden` start invisible (CSS, so no flash) and animate in.
 * With `stagger`, direct children animate as a cascade instead.
 */
export function GsapReveal({
  children,
  className,
  stagger = false,
  y = 28,
  delay = 0,
  once = true,
}: {
  children: ReactNode;
  className?: string;
  /** Animate direct children as a 0.08s cascade instead of one block. */
  stagger?: boolean;
  y?: number;
  delay?: number;
  once?: boolean;
}) {
  const ref = useGsap(({ root }) => {
    const targets = stagger ? Array.from(root.children) : [root];
    // will-change hints the compositor right before the tween starts and
    // is stripped again once it lands (clearProps below) — set it here
    // rather than in CSS so idle, off-screen reveal targets never carry
    // the promotion hint.
    gsap.set(targets, { willChange: "transform, opacity, filter" });
    gsap.fromTo(
      targets,
      { autoAlpha: 0, y, filter: "blur(6px)" },
      {
        autoAlpha: 1,
        y: 0,
        filter: "blur(0px)",
        duration: DUR.base,
        ease: EASE_OUT,
        delay,
        stagger: stagger ? 0.08 : 0,
        // transform must clear too: a leftover inline translate(0,0) would
        // permanently override Tailwind hover:-translate-* lifts on cards.
        clearProps: "filter,willChange,transform",
        scrollTrigger: {
          trigger: root,
          start: "top 85%",
          once,
          // Re-measures trigger start/end and any layout-derived from()
          // values on resize/orientation-change — cheap insurance for
          // callers that pass function-based y/x values off of layout.
          invalidateOnRefresh: true,
        },
      },
    );
  });
  return (
    <div ref={ref} className={cn("gs-reveal", className)} data-gs-hidden="">
      {children}
    </div>
  );
}

/** Scroll-linked vertical parallax; `speed` in px of drift per viewport. */
export function GsapParallax({
  children,
  className,
  speed = 60,
}: {
  children: ReactNode;
  className?: string;
  speed?: number;
}) {
  const ref = useGsap(({ root }) => {
    gsap.set(root, { willChange: "transform" });
    gsap.fromTo(
      root,
      { y: speed / 2 },
      {
        y: -speed / 2,
        ease: "none",
        // Scrubbed tweens still fire onComplete once progress reaches 1
        // (i.e. the trigger's "end" is crossed), so clearProps still
        // strips the hint when the element scrolls out of range.
        clearProps: "willChange",
        scrollTrigger: {
          trigger: root,
          start: "top bottom",
          end: "bottom top",
          scrub: true,
          invalidateOnRefresh: true,
        },
      },
    );
  });
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
