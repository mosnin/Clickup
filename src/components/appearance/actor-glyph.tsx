"use client";

import { Bot } from "lucide-react";
import { useAppearance } from "@/components/appearance/appearance-provider";
import { Monogram } from "@/components/dashboard/monogram";
import { Orb } from "@/components/dashboard/orb";
import { identityFill } from "@/lib/identity-color";
import { cn } from "@/lib/utils";

// How a teammate is pictured.
//
// The app already had two answers to this and no way to choose between them:
// `Orb` (a living gradient) and `Monogram` (an initial in a filled circle).
// Which one is right is a taste question about a mark that appears hundreds of
// times on a busy screen — a room full of glowing orbs is delightful at eight
// agents and noisy at eighty — so it belongs to the space, with a personal
// override, like the rest of the room's visual language.
//
// Four answers rather than two, because the interesting ones are at the ends:
// `dot` is a coloured pip and nothing else, for people who want the names to
// carry the screen, and `glyph` marks agents as machines rather than as people
// with initials, which some teams want to be able to see at a glance.

const DOT_SIZE = { xs: "h-2 w-2", sm: "h-2.5 w-2.5", md: "h-3 w-3", lg: "h-3.5 w-3.5" };
const BOX_SIZE = { xs: "h-6 w-6", sm: "h-8 w-8", md: "h-10 w-10", lg: "h-12 w-12" };
const GLYPH_SIZE = { xs: "h-3 w-3", sm: "h-4 w-4", md: "h-5 w-5", lg: "h-6 w-6" };
/** Orb and Monogram size their own boxes; these map our scale onto theirs. */
const MONOGRAM_SIZE = { xs: "sm", sm: "sm", md: "md", lg: "lg" } as const;

export type GlyphSize = "xs" | "sm" | "md" | "lg";

export function ActorGlyph({
  name,
  seed,
  size = "sm",
  /** Agents can be marked as machines; people never are. */
  isAgent = false,
  className,
}: {
  name: string;
  seed?: string;
  size?: GlyphSize;
  isAgent?: boolean;
  className?: string;
}) {
  const { appearance } = useAppearance();
  const style = appearance.agentIcon;
  const key = seed ?? name;

  if (style === "dot") {
    return (
      <span
        aria-hidden
        title={name}
        style={identityFill(key)}
        className={cn("inline-block flex-shrink-0 rounded-full", DOT_SIZE[size], className)}
      />
    );
  }

  // The machine mark only means anything if people don't get it too — an icon
  // every row wears says nothing. A human under this setting falls back to the
  // initial, which is the closest neutral answer.
  if (style === "glyph" && isAgent) {
    return (
      <span
        aria-hidden
        title={name}
        style={identityFill(key)}
        className={cn(
          "inline-flex flex-shrink-0 items-center justify-center rounded-full text-white",
          BOX_SIZE[size],
          className,
        )}
      >
        <Bot className={GLYPH_SIZE[size]} />
      </span>
    );
  }

  if (style === "monogram" || style === "glyph") {
    return (
      <Monogram
        name={name}
        seed={seed}
        size={MONOGRAM_SIZE[size]}
        className={cn(BOX_SIZE[size], className)}
      />
    );
  }

  return <Orb seed={key} size={size} label={name} className={className} />;
}
