import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { identityFill } from "@/lib/identity-color";

// The one avatar primitive: a circle with the entity's first initial, filled
// from the shared identity ramp (lib/identity-color) so every teammate —
// human or agent — is a recognisable color instead of one repeated brand
// circle. `seed` pins the color to a stable id when there is one (two agents
// can share a display name); otherwise the name is the seed. Pass
// `brand` to opt back into the flat brand fill for the rare spot that
// represents the product itself rather than a person.
// Array.from is code-point-aware so multi-byte first characters (accents,
// emoji that slip through data) render as a whole grapheme, not half a
// surrogate pair.

const SIZE = {
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-xs",
  lg: "h-10 w-10 text-sm",
} as const;

// Maps our size API 1:1 onto Avatar's own size prop so the root gets the
// exact same physical dimensions as before ("md" has no Avatar equivalent
// name, so it rides Avatar's "default").
const AVATAR_SIZE = {
  sm: "sm",
  md: "default",
  lg: "lg",
} as const;

export function Monogram({
  name,
  seed,
  size = "md",
  brand = false,
  className,
}: {
  name: string;
  seed?: string;
  size?: "sm" | "md" | "lg";
  brand?: boolean;
  className?: string;
}) {
  const initial = (Array.from(name.trim())[0] ?? "?").toUpperCase();
  return (
    <Avatar
      size={AVATAR_SIZE[size]}
      className={cn(SIZE[size], "flex-shrink-0", className)}
    >
      <AvatarFallback
        aria-hidden
        title={name}
        style={brand ? undefined : identityFill(seed ?? name)}
        className={cn(
          "rounded-full font-medium text-white",
          brand && "bg-brand-600",
          SIZE[size].split(" ").filter((c) => c.startsWith("text-")),
        )}
      >
        {initial}
      </AvatarFallback>
    </Avatar>
  );
}
