"use client";

import AgentAvatar from "@/components/smoothui/agent-avatar";
import { identityFill } from "@/lib/identity-color";
import { cn } from "@/lib/utils";

// A person's face, or the preset that stands in for one.
//
// The rule this primitive exists to hold: **a saved photo always wins, and
// everybody else gets a generated mark rather than a letter.** Initials are
// the honest minimum and they are also the reason a members list reads as a
// wall of grey circles — "A", "A", "A" for three different Alexes. The preset
// (`smoothui/agent-avatar`, a 6x6 pixel field seeded by a hash) is
// deterministic, so the same person is the same picture on every screen and
// every machine, with no asset to store and nothing to migrate.
//
// The branch lives HERE and not at the call sites, the same way `AnimatedBar`
// owns the chart-style branch: a fallback that reached only the chat rail
// would be a fallback in name only.
//
// Three decisions worth keeping:
//
// **Still by default.** The upstream component animates — a per-cell pulse
// plus a sparkle pass, each frame drawing 36 shadow-blurred rects. That is a
// delight on one hero avatar and a fan on a members list of eighty, which is
// the same objection this codebase already made to a room full of orbs. An
// identity mark is a picture of somebody, not a living thing, so it is drawn
// once; `animated` is there for the rare hero spot that wants it.
//
// **It is never a hole.** The canvas paints in an effect, so between mount
// and first frame it is transparent — and in a list, transparent circles read
// as broken chrome rather than as loading. The wrapper carries the seeded
// identity fill underneath, so the mark is a plausible colour immediately and
// the canvas paints its own opaque field over it. That also means a browser
// with no 2D context degrades to the colour rather than to nothing.
//
// **It is decoration, not a label.** The name is beside this mark at every
// call site, so the picture is `aria-hidden` with a `title` — the convention
// the rest of the app's avatars already follow. The upstream default would
// announce "Avatar for user_2abc…" to a screen reader, which is an id read
// aloud.

const PX = { sm: 24, md: 32, lg: 40 } as const;

export type UserAvatarSize = keyof typeof PX;

export function UserAvatar({
  name,
  seed,
  imageUrl,
  size = "md",
  animated = false,
  className,
}: {
  name: string;
  /** A stable id (clerkId, agent id). Falls back to the name. */
  seed?: string;
  /** The saved profile photo. When present, nothing is generated. */
  imageUrl?: string | null;
  /** A step on the shared scale, or an exact diameter in px. */
  size?: UserAvatarSize | number;
  animated?: boolean;
  className?: string;
}) {
  const px = typeof size === "number" ? size : PX[size];
  const key = seed || name;

  return (
    <span
      aria-hidden
      title={name}
      style={{ width: px, height: px, ...(imageUrl ? {} : identityFill(key)) }}
      className={cn(
        "inline-flex flex-shrink-0 items-center justify-center overflow-hidden rounded-full",
        className,
      )}
    >
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt="" className="size-full object-cover" />
      ) : (
        <AgentAvatar
          seed={key}
          size={px}
          animated={animated}
          aria-hidden
          role={undefined}
          aria-label={undefined}
        />
      )}
    </span>
  );
}
