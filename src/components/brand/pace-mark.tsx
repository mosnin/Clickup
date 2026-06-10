import { cn } from "@/lib/utils";

// Pace mark: a forward slash with a leading dot. The whole identity is
// motion — sustainable speed — so the mark is one decisive stroke and a
// glint of amber at the leading edge. Used in the pill header, pill
// footer, sidebar, auth, and onboarding so the brand is consistent.
export function PaceMark({
  size = 24,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden
      className={cn("inline-block", className)}
    >
      <rect width="32" height="32" rx="6" fill="#059669" />
      <path
        d="M10.5 24 L21.5 10.5"
        stroke="white"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <circle cx="21.5" cy="10.5" r="2" fill="#fbbf24" />
    </svg>
  );
}

export function PaceWordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-sm font-semibold tracking-tight",
        className,
      )}
    >
      <PaceMark size={22} />
      <span>Pace</span>
    </span>
  );
}
