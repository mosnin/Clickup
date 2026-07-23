import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

// The one avatar primitive: a solid-brand circle with the entity's first
// initial. Replaces every emoji avatar in the product — agents included.
// Array.from is code-point-aware so multi-byte first characters (accents,
// emoji that slip through data) render as a whole grapheme, not half a
// surrogate pair. Built on the vendored Avatar shell for grammar
// consistency; the deterministic solid-brand fill and size steps are ours
// and stay pixel-identical regardless of the shell's own defaults.

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
  size = "md",
  className,
}: {
  name: string;
  size?: "sm" | "md" | "lg";
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
        className={cn(
          "rounded-full bg-brand-600 font-medium text-white",
          SIZE[size].split(" ").filter((c) => c.startsWith("text-")),
        )}
      >
        {initial}
      </AvatarFallback>
    </Avatar>
  );
}
