// "Is the page mid-navigation?" — asked by every animated marketing surface.
//
// The five canvas/DOM pieces on the marketing site all run their own rAF
// loops, and all of them need the same three pauses: offscreen, tab hidden,
// and mid route transition. The first two have browser APIs
// (IntersectionObserver, visibilitychange); the third does not, so it lives
// here rather than five times over.
//
// Why it matters enough to exist: a View Transition holds a SCREENSHOT of the
// old page while the new one mounts. Anything still animating underneath is
// painting frames nobody will ever see, on the main thread, during the one
// moment in a page's life that is already the most expensive. Worse for the
// glow card specifically — its masks are PNGs rebuilt from a measured box, and
// a box measured mid-transition is measured against a frozen snapshot.
//
// Deliberately a tiny observable rather than a hook: the consumers are
// framework-agnostic engine classes, not just React components.

type Listener = (active: boolean) => void;

const listeners = new Set<Listener>();
let active = false;

/** Is a route transition running right now? */
export function isTransitioning(): boolean {
  return active;
}

/**
 * Mark the start/end of a route transition.
 *
 * Called by whatever drives navigation. Idempotent: setting the same value
 * twice notifies nobody, so a caller that cannot track its own state exactly
 * (an unmount racing a completion) cannot leave every animation paused.
 */
export function setTransitioning(next: boolean): void {
  if (next === active) return;
  active = next;
  for (const fn of listeners) fn(active);
}

/**
 * Subscribe. Returns its own unsubscribe, and fires immediately with the
 * current value — a consumer that mounts DURING a transition must not spend
 * that transition animating because it happened to miss the edge.
 */
export function onTransitionChange(fn: Listener): () => void {
  listeners.add(fn);
  fn(active);
  return () => {
    listeners.delete(fn);
  };
}
