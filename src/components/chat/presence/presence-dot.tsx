"use client";

// The dot, the pill, and the emoji beside a name.
//
// Three tiny components rather than three copies of the same conditional,
// because presence is drawn in five places (the member list, a DM row, the
// profile card, a message avatar, the roster) and the one thing that must not
// happen is amber meaning "away" in four of them and something else in the
// fifth. The colours come from 01-core-comms §5.1 and are the only place in
// Chat that uses a saturated fill: a status dot is not decoration, it is the
// single fact the surface exists to carry.
//
// `PresenceDot` is `aria-hidden` on purpose. It is redundant with the name it
// sits beside for anyone reading the row aloud, and a screen reader announcing
// "online" between every name in a member list is noise. Where the status is
// the *point* — the profile card, the roster — `PresenceBadge` carries the
// word itself.

import { cn } from "@/lib/utils";
import {
  PRESENCE_LABEL,
  isEmojiShortcode,
  presenceChipClass,
  presenceDotClass,
  type PresenceStatus,
} from "@/lib/buzz/presence";

export function PresenceDot({
  status,
  className,
}: {
  status: PresenceStatus;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-presence={status}
      className={cn("inline-block size-2.5 shrink-0 rounded-full", presenceDotClass(status), className)}
    />
  );
}

/**
 * A dot pinned to the corner of an avatar.
 *
 * A ring in the surface colour, not a gap: the dot sits on top of a face, and
 * without the ring a dark avatar swallows the muted grey of "offline" entirely
 * — which reads as "no dot", which reads as "we do not know", which is a
 * different claim.
 */
export function PresenceAvatarDot({
  status,
  className,
}: {
  status: PresenceStatus;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-presence={status}
      className={cn(
        "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-[var(--color-page)]",
        presenceDotClass(status),
        className,
      )}
    />
  );
}

export function PresenceBadge({
  status,
  className,
}: {
  status: PresenceStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium",
        presenceChipClass(status),
        className,
      )}
    >
      <PresenceDot status={status} className="size-1.5" />
      {PRESENCE_LABEL[status]}
    </span>
  );
}

/**
 * A stored status emoji.
 *
 * Unlike a reaction, a status emoji is a bare string with no companion URL, so
 * a shortcode has to be resolved against the community palette at render time.
 * Every display site goes through this component for exactly that reason —
 * five call sites each doing their own `startsWith(":")` is five places for
 * the resolution to drift, which is how a shortcode ends up rendering as
 * `:shipit:` in the one surface nobody checked.
 *
 * `resolve` is a prop rather than a hook so this component stays drawable in a
 * test and in the composer's preview, where there is no palette to consult.
 */
export function StatusEmoji({
  emoji,
  resolve,
  className,
}: {
  emoji: string;
  resolve?: (shortcode: string) => string | null;
  className?: string;
}) {
  if (!emoji) return null;
  const shortcode = isEmojiShortcode(emoji) ? emoji.slice(1, -1) : null;
  const url = shortcode && resolve ? resolve(shortcode) : null;
  if (url) {
    return (
      // A custom emoji is a ~20px image on an arbitrary community-supplied
      // host; `next/image` would add an optimizer hop and a domain allowlist
      // for something already smaller than the request that fetched it.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={emoji}
        className={cn("inline-block size-4 shrink-0 align-[-0.2em] object-contain", className)}
      />
    );
  }
  // An unresolved shortcode renders as its own text rather than as nothing:
  // "`:on-call:`" tells you somebody meant something; an empty span does not.
  return (
    <span aria-hidden={false} className={cn("shrink-0", className)}>
      {emoji}
    </span>
  );
}
