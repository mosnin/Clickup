"use client";

// The Work ⇄ Chat transition.
//
// Two shells, no shared React tree — Chat is a sibling of /dashboard with its
// own layout, on purpose. So there is no component that survives the switch and
// therefore nothing for a React animation library to interpolate. The View
// Transitions API is the one mechanism that does not need a shared tree: the
// browser snapshots the old document, runs the DOM change, snapshots the new
// one, and animates between the two by matching `view-transition-name`. That is
// exactly the problem here, which is why this is not built on motion/react like
// the rest of the dashboard.
//
// What it says: the navigation stays and the content moves sideways — Work on
// the left, Chat on the right. Switching should read as walking between two
// rooms of one building rather than launching a different application, and the
// nav persisting through the move is the whole sentence. The two shells' navs
// share one `view-transition-name`, so the browser morphs the Work sidebar into
// the Chat rail rather than cross-fading them.
//
// **It stays a link.** The handler bails out of every gesture that is not a
// plain left click, so ⌘-click, middle-click, "open in new tab" and the back
// button all keep working — hijacking those is the classic way a hand-rolled
// transition quietly breaks navigation. If anything at all is unusual — no
// browser support, motion turned down, a same-mode link — it returns without
// calling preventDefault and the <Link> navigates normally. **The fallback is
// today's hard cut**, which is a real state this has to degrade to rather than
// a hypothetical: Firefox has no View Transitions, and a reader who turned
// motion off has asked for exactly that cut.

import { useCallback, useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { scaled } from "@/lib/anime";
import { MODE_TRANSITION_MS, directionFor } from "@/lib/mode-transition";

/**
 * How long to hold the old frame before giving up on the new route.
 *
 * This guard is not optional. `startViewTransition` freezes the screen on a
 * screenshot until the callback's promise settles, so tying that promise to
 * "the route committed" — which is the only way to sequence it, since
 * `router.push` resolves immediately and tells you nothing — means a slow
 * navigation is a frozen UI for exactly as long as it is slow. On timeout the
 * transition finishes against whatever is on screen: the animation is wrong,
 * and a wrong animation is enormously better than an interface that has
 * stopped responding.
 */
const NAV_TIMEOUT_MS = 600;

type ViewTransition = { finished: Promise<void> };
type DocumentWithViewTransitions = Document & {
  startViewTransition?: (callback: () => void | Promise<void>) => ViewTransition;
};

/**
 * Returns an `onClick` for a link that crosses between the dashboards.
 *
 * Usage is deliberately per-link rather than a global click interceptor on the
 * document: an interceptor has to reason about every anchor on the page, and
 * the set of links that should do this is two.
 */
export function useModeTransition() {
  const router = useRouter();
  const pathname = usePathname();

  // Resolved when the new route commits. A ref rather than state because
  // settling it must not itself cause a render — the render it would cause is
  // the one we are waiting for.
  const commit = useRef<(() => void) | null>(null);

  useEffect(() => {
    commit.current?.();
    commit.current = null;
  }, [pathname]);

  // Nothing may outlive the component: a timer that fires after unmount would
  // resolve a promise for a transition belonging to a page that is gone.
  useEffect(() => {
    return () => {
      commit.current?.();
      commit.current = null;
    };
  }, []);

  return useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>, href: string) => {
      // Every one of these is a gesture whose meaning is "not a normal
      // navigation" — a new tab, a new window, a download, a handler upstream
      // that already decided. None of them should be animated, and none of
      // them should be prevented.
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const direction = directionFor(pathname, href);
      if (!direction) return;

      // One source of truth for "does this person want motion": `scaled`
      // returns 0 for prefers-reduced-motion AND for a motion scale the reader
      // turned down themselves, and reduced-motion always wins over the stored
      // preference (lib/anime).
      const duration = scaled(MODE_TRANSITION_MS);
      if (duration === 0) return;

      const doc = document as DocumentWithViewTransitions;
      if (typeof doc.startViewTransition !== "function") return;

      event.preventDefault();

      // The direction is an attribute on the root rather than a class or an
      // inline style because the view-transition pseudo-elements are children
      // of the root — `:root[data-mode-dir=…]::view-transition-old(…)` is the
      // only selector that can reach them, and CSS owns which way things move.
      const root = document.documentElement;
      root.dataset.modeDir = direction;
      root.style.setProperty("--mode-transition-ms", `${duration}ms`);

      const transition = doc.startViewTransition(() => {
        router.push(href);
        return new Promise<void>((resolve) => {
          commit.current = resolve;
          window.setTimeout(resolve, NAV_TIMEOUT_MS);
        });
      });

      // `.finished` rejects when a transition is skipped — by another
      // transition starting, or by the browser — and an unhandled rejection
      // here would surface as a console error on a perfectly ordinary
      // double-click. Both paths do the same cleanup.
      const done = () => {
        delete root.dataset.modeDir;
        root.style.removeProperty("--mode-transition-ms");
      };
      transition.finished.then(done, done);
    },
    [pathname, router],
  );
}
