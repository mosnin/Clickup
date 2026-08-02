"use client";

// The identity mark: a face, or the two letters standing in for one.
//
// Local rather than reaching for the dashboard's `ActorGlyph` — that component
// belongs to the concurrent dynamic-UI build and is off limits — and local
// rather than `ui/avatar.tsx` because this one has a job that primitive does
// not: it says whether the principal is an agent, in the same mark, at 24px.
//
// The tint is derived from the pubkey rather than picked. Two consequences,
// both wanted: the same person is the same colour in every room without
// storing a preference, and a room of strangers is legible before anybody has
// uploaded a photo.

import { cn } from "@/lib/utils";
import { initials } from "./thread-summary";

/** Six pastel fills from the brand's own set. Meaning is carried elsewhere. */
const TINTS = [
  "var(--color-pastel-blue, #dbeafe)",
  "var(--color-pastel-green, #dcfce7)",
  "var(--color-pastel-amber, #fef3c7)",
  "var(--color-pastel-pink, #fce7f3)",
  "var(--color-pastel-purple, #ede9fe)",
  "var(--color-pastel-teal, #ccfbf1)",
];

function tintFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return TINTS[Math.abs(hash) % TINTS.length];
}

export function ActorAvatar({
  label,
  pubkey,
  avatarUrl,
  isAgent,
  size = 36,
  className,
}: {
  label: string;
  pubkey: string;
  avatarUrl?: string;
  isAgent?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <span
      // `title` and not an aria-label: the name is already in the row's header
      // beside it, and a second announcement of the same word is noise to a
      // screen reader rather than help.
      title={label}
      aria-hidden
      data-agent={isAgent ? "true" : "false"}
      style={{
        width: size,
        height: size,
        // An agent gets a squircle, a person a circle. One shape difference,
        // no glyph: the room says which is which without spending an icon on
        // it, and it reads at 20px where a bot mark does not.
        borderRadius: isAgent ? size * 0.3 : "9999px",
        background: avatarUrl ? undefined : tintFor(pubkey || label),
        // Dark ink, fixed — NOT the theme's foreground. The fill is a light
        // pastel in both themes, so a colour that follows the theme paints
        // near-white letters on a near-white tile and the initials vanish in
        // dark mode. Same rule the brand already applies to status chips:
        // pastel fill, dark ink on top.
        color: avatarUrl ? undefined : "rgb(16 16 16 / 0.72)",
        fontSize: Math.max(9, Math.round(size * 0.34)),
      }}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center overflow-hidden font-semibold",
        className,
      )}
    >
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatarUrl} alt="" className="size-full object-cover" />
      ) : (
        initials(label)
      )}
    </span>
  );
}
