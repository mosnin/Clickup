import { cn } from "@/lib/utils";

// The one avatar primitive: a solid-brand circle with the entity's first
// initial. Replaces every emoji avatar in the product — agents included.
// Array.from is code-point-aware so multi-byte first characters (accents,
// emoji that slip through data) render as a whole grapheme, not half a
// surrogate pair.

const SIZE = {
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-xs",
  lg: "h-10 w-10 text-sm",
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
    <span
      aria-hidden
      title={name}
      className={cn(
        "inline-flex flex-shrink-0 items-center justify-center rounded-full bg-brand-600 font-medium text-white",
        SIZE[size],
        className,
      )}
    >
      {initial}
    </span>
  );
}
