// Which room you are walking into, and which way that reads.
//
// Work and Chat are two shells over one workspace (see components/chat/
// mode-switcher.tsx). Crossing between them is the only navigation in the
// product that swaps the entire chrome, so it is the only one that gets a
// directional transition: everything else is a page changing inside a shell
// that stays put.
//
// Pure and separate from the hook that uses it because the interesting part is
// a *classification* — "is this path Chat" — and that is exactly the kind of
// thing that is wrong in a way no screenshot reveals. See tests/mode-
// transition.test.ts.

/** The two dashboards. */
export type Mode = "work" | "chat";

/** Which way the content slides. Named for the destination, not the origin. */
export type ModeDirection = "to-chat" | "to-work";

/**
 * The designed duration. Long enough to read as one object moving, short
 * enough that somebody switching modes repeatedly is not waiting on it.
 *
 * Callers must put this through `scaled()` from lib/anime — a person who has
 * turned motion down, or off, has said something about every animation in the
 * product and this one is not an exception.
 */
export const MODE_TRANSITION_MS = 320;

/**
 * Which dashboard a path belongs to.
 *
 * Segment-exact rather than `startsWith("/chat")`, which also claims
 * `/chatter` — there is no such route today, and that is precisely why it
 * would be a quiet bug rather than a loud one when somebody adds one. Work is
 * the default because everything that is not Chat is Work, including
 * `/dashboard`, `/onboarding` and any surface added later.
 */
export function modeOf(path: string): Mode {
  return path === "/chat" || path.startsWith("/chat/") ? "chat" : "work";
}

/**
 * The direction to animate, or `null` when this navigation does not cross
 * between the two dashboards.
 *
 * `null` is the common case and the important one: it is what keeps every
 * ordinary link — a task, a channel, a page — on the browser's own plain
 * navigation instead of dragging it through a transition it did not ask for.
 */
export function directionFor(from: string, to: string): ModeDirection | null {
  const origin = modeOf(from);
  const destination = modeOf(to);
  if (origin === destination) return null;
  return destination === "chat" ? "to-chat" : "to-work";
}
