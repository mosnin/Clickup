import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Marketing v2 primitives — the shared visual grammar of the logged-out
// site. Azure/navy hero band, white content sections, rounded-2xl cards,
// pill buttons. Every raster asset renders as a red Placeholder so
// provided graphics/video slots are unmissable.

export function Container({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-6xl px-5 sm:px-8", className)}>
      {children}
    </div>
  );
}

/** Solid-red stand-in for a screenshot / logo / video slot. */
export function Placeholder({
  label,
  ratio = "16/10",
  className,
}: {
  label: string;
  /** CSS aspect-ratio value, e.g. "16/10", "1/1", "21/9". */
  ratio?: string;
  className?: string;
}) {
  return (
    <div
      role="img"
      aria-label={`Placeholder: ${label}`}
      style={{ aspectRatio: ratio, background: "var(--color-placeholder)" }}
      className={cn(
        "flex w-full items-center justify-center overflow-hidden",
        className,
      )}
    >
      <span className="px-4 text-center text-[11px] font-semibold uppercase tracking-widest text-white/90">
        Placeholder — {label}
      </span>
    </div>
  );
}

/** Tiny uppercase eyebrow pill above section titles. */
export function Eyebrow({
  children,
  tone = "light",
  className,
}: {
  children: ReactNode;
  /** "light" = on white sections, "dark" = on the blue/navy band. */
  tone?: "light" | "dark";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-widest",
        tone === "light"
          ? "bg-azure-100 text-azure-700"
          : "bg-white/10 text-white/80",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  sub,
  tone = "light",
  className,
}: {
  eyebrow?: string;
  title: string;
  sub?: string;
  tone?: "light" | "dark";
  className?: string;
}) {
  return (
    <div className={cn("mx-auto max-w-2xl text-center", className)}>
      {eyebrow && <Eyebrow tone={tone}>{eyebrow}</Eyebrow>}
      <h2
        className={cn(
          "mt-4 text-3xl font-semibold tracking-tight sm:text-4xl",
          tone === "dark" ? "text-white" : "text-foreground",
        )}
      >
        {title}
      </h2>
      {sub && (
        <p
          className={cn(
            "mt-3 text-base sm:text-lg",
            tone === "dark" ? "text-white/70" : "text-muted-foreground",
          )}
        >
          {sub}
        </p>
      )}
    </div>
  );
}

type CtaVariant = "primary" | "onDark" | "ghostDark" | "ghostLight";

const CTA_STYLES: Record<CtaVariant, string> = {
  // Solid azure pill — appears on both white sections and the dark
  // navy/azure bands (nav bar, hero, CTA panel, featured pricing card), so
  // its focus ring can't assume a single background. A tight azure ring
  // reads clearly against light surfaces; an offset white outline reads
  // clearly against dark ones — together at least one ring always clears
  // WCAG 1.4.11's 3:1 non-text contrast minimum, wherever the button lands.
  primary:
    "bg-azure-500 text-white hover:bg-azure-600 focus-visible:outline-white focus-visible:ring-2 focus-visible:ring-azure-700",
  // White pill on the blue band (the hero's primary).
  onDark:
    "bg-white text-navy-900 hover:bg-azure-100 focus-visible:outline-white",
  // Translucent pill on the blue band (the hero's secondary).
  ghostDark:
    "bg-white/10 text-white ring-1 ring-inset ring-white/25 hover:bg-white/20 focus-visible:outline-white",
  // Quiet pill on white sections.
  ghostLight:
    "bg-black/[0.04] text-foreground hover:bg-black/[0.08] focus-visible:outline-azure-500",
};

export function CtaButton({
  href,
  variant = "primary",
  size = "md",
  className,
  children,
}: {
  href: string;
  variant?: CtaVariant;
  size?: "md" | "lg";
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center justify-center rounded-full font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
        size === "lg" ? "h-12 px-7 text-base" : "h-10 px-5 text-sm",
        CTA_STYLES[variant],
        className,
      )}
    >
      {children}
    </Link>
  );
}

/** Rounded frame around a screenshot placeholder, reference-style. */
export function ScreenshotFrame({
  label,
  ratio = "16/10",
  tone = "light",
  className,
}: {
  label: string;
  ratio?: string;
  tone?: "light" | "dark";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[20px] p-1.5 shadow-2xl",
        tone === "dark"
          ? "bg-white/10 ring-1 ring-white/15"
          : "bg-black/[0.04] ring-1 ring-black/[0.06]",
        className,
      )}
    >
      <Placeholder label={label} ratio={ratio} className="rounded-[14px]" />
    </div>
  );
}

/** Dock-style row of app-icon placeholder tiles (red). */
export function IconDock({
  count = 8,
  label = "Runtime logo",
  className,
}: {
  count?: number;
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-end gap-2 rounded-2xl bg-white/10 p-2 ring-1 ring-white/15 backdrop-blur",
        className,
      )}
    >
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className="gs-dock-icon h-10 w-10 overflow-hidden rounded-xl sm:h-12 sm:w-12"
        >
          <Placeholder label={`${label} ${i + 1}`} ratio="1/1" />
        </div>
      ))}
    </div>
  );
}
