// Reaction algebra — spec 01 §3.2.
//
// The whole point of this file is one property: **the pill moves before the
// server answers, and it does not move again when the server agrees.** A
// reaction is the cheapest interaction in a chat app and the one people fire
// fastest; a pill that waits ~200ms for a round trip reads as a dropped click,
// and a pill that jumps a second time when the real count lands reads as a bug.
//
// Two functions, both pure, and the second is the subtle one:
//
//   applyOptimisticReaction  what the pills look like the instant you click
//   selectDisplayReactions   whether that guess is still the right thing to show
//
// `selectDisplayReactions` is what makes reconciliation flicker-free without a
// timer or a diff. The overlay captures the *array identity* it was computed
// from; the moment the projector emits a new reactions array — which it does
// exactly when the server's answer has folded in — the overlay is discarded
// wholesale. There is no window in which a stale guess and a fresh truth are
// both on screen, and no case where the guess has to be un-applied by hand.
//
// The rule the helpers must not break: **never re-sort.** Pills are ordered by
// `firstAt` and that ordering belongs to the projector. A helper that sorted
// would shuffle the row under the reader's cursor every time somebody else
// reacted, which is precisely why `ChatReaction` retains the *earliest*
// reaction rather than the latest.

import type { ChatReaction } from "@/lib/buzz/message-types";

/** The reader's own label inside a pill's reactor list. */
export const YOU = "You";

/**
 * An optimistic overlay, tied to the source array it was computed against.
 *
 * Storing the source by reference rather than by value is deliberate: it makes
 * "is this guess still current" an identity check rather than a deep compare,
 * and it cannot disagree with the array the row is actually rendering from.
 */
export type ReactionOverlay = {
  source: readonly ChatReaction[];
  value: ChatReaction[];
};

function normalizeEmoji(emoji: string): string {
  return emoji.trim();
}

/**
 * The pills after the reader toggles `emoji`, before the server has answered.
 *
 * Every branch is a no-op when the toggle would be meaningless (removing a
 * reaction you never gave, adding one you already gave), because a double-fire
 * from a fast double-click must not double-count.
 */
export function applyOptimisticReaction(
  reactions: readonly ChatReaction[],
  emoji: string,
  remove: boolean,
  opts: { emojiUrl?: string; now?: number } = {},
): ChatReaction[] {
  const target = normalizeEmoji(emoji);
  if (!target) return [...reactions];
  const index = reactions.findIndex((r) => normalizeEmoji(r.emoji) === target);

  if (remove) {
    if (index === -1) return [...reactions];
    const pill = reactions[index];
    if (!pill.mine) return [...reactions];
    const count = pill.count - 1;
    if (count <= 0) return reactions.filter((_, i) => i !== index);
    const next = [...reactions];
    next[index] = {
      ...pill,
      count,
      mine: false,
      reactors: pill.reactors.filter((name) => name !== YOU),
    };
    return next;
  }

  if (index !== -1) {
    const pill = reactions[index];
    if (pill.mine) return [...reactions];
    const next = [...reactions];
    next[index] = {
      ...pill,
      count: pill.count + 1,
      mine: true,
      // "You" first, matching how the projector labels a pill the reader is in.
      reactors: [YOU, ...pill.reactors.filter((name) => name !== YOU)],
    };
    return next;
  }

  // A brand-new pill goes on the END. Chronological order is the projector's
  // job and this helper must never pre-empt it — a new pill inserted "in the
  // right place" would land somewhere else the moment the real one arrives.
  return [
    ...reactions,
    {
      emoji: target,
      ...(opts.emojiUrl ? { emojiUrl: opts.emojiUrl } : {}),
      count: 1,
      mine: true,
      reactors: [YOU],
      firstAt: opts.now ?? Date.now(),
    },
  ];
}

/**
 * The pills to draw: the overlay while it is still about the current source,
 * the source itself the moment it is not.
 */
export function selectDisplayReactions(
  overlay: ReactionOverlay | null | undefined,
  source: readonly ChatReaction[],
): readonly ChatReaction[] {
  if (overlay && overlay.source === source) return overlay.value;
  return source;
}

/** Whether the reader may toggle at all — a pending row has no event to react to. */
export function canToggleReaction(message: {
  pending: boolean;
  failed?: boolean;
}): boolean {
  return !message.pending && !message.failed;
}

/**
 * The pill's accessible name.
 *
 * Read aloud as "React with X, N reactions" rather than as a bare glyph and a
 * number, because a screen reader landing on "❤ 1" has been told nothing about
 * what pressing it would do.
 */
export function reactionLabel(reaction: ChatReaction): string {
  const verb = reaction.mine ? "Remove your reaction" : "React with";
  return `${verb} ${reaction.emoji} — ${reaction.count} ${
    reaction.count === 1 ? "reaction" : "reactions"
  }${reaction.reactors.length > 0 ? ` from ${reaction.reactors.join(", ")}` : ""}`;
}

/**
 * The quick-reaction row in the hover toolbar.
 *
 * Four, desktop only, and fixed for now: the recents ledger (spec §3.1) is
 * part of the emoji-picker phase, and a ranking that reorders under the cursor
 * is worse than no ranking at all — which is why Buzz's own recents apply on
 * reload rather than live.
 */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉"] as const;

/**
 * The tray behind the React button until the emoji picker lands.
 *
 * A short, honest palette rather than a stub that opens nothing. It is
 * deliberately small: a control that produces a stub is worse than no control,
 * and 24 emoji a person can actually scan beats a search box over 1.8k that
 * this phase has no index for.
 */
export const REACTION_TRAY = [
  "👍",
  "👎",
  "❤️",
  "😂",
  "🎉",
  "🙌",
  "👀",
  "🔥",
  "✅",
  "❌",
  "🚀",
  "💡",
  "🤔",
  "😅",
  "😍",
  "😮",
  "🙏",
  "💯",
  "⚡",
  "🐝",
  "☕",
  "🧠",
  "🛠️",
  "📌",
] as const;
