import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { BorderBeam } from "@/components/ui/border-beam";

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
          ? "bg-azure-500/15 text-azure-300 ring-1 ring-inset ring-azure-400/25"
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
        <span className="text-gradient">{title}</span>
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
  // Vibrant gradient pill — appears everywhere on the charcoal canvas (nav
  // bar, hero, CTA panel, featured pricing card), so its focus ring can't
  // assume a single background. A white outline plus an azure ring together
  // clear WCAG 1.4.11's 3:1 non-text contrast minimum on charcoal.
  primary:
    "mk-gradient-fill hover:brightness-110 focus-visible:outline-white focus-visible:ring-2 focus-visible:ring-azure-400/60",
  // Same gradient treatment — historically the "light pill on the blue
  // band" variant; on charcoal it reads identically to primary.
  onDark:
    "mk-gradient-fill hover:brightness-110 focus-visible:outline-white focus-visible:ring-2 focus-visible:ring-azure-400/60",
  // Charcoal secondary pill (hero's secondary CTA).
  ghostDark:
    "mk-panel text-foreground hover:bg-white/5 focus-visible:outline-white",
  // Charcoal secondary pill on regular sections.
  ghostLight:
    "mk-panel text-foreground hover:bg-white/5 focus-visible:outline-azure-400",
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
  beam = false,
  className,
}: {
  label: string;
  ratio?: string;
  tone?: "light" | "dark";
  /** Reserve for the one hero-grade instance — draws a slow traveling
   * light around the frame's border. Not for every screenshot on the
   * site (see marketing CLAUDE.md border-beam guidance). */
  beam?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[20px] p-1.5 shadow-2xl mk-panel-2",
        className,
      )}
    >
      <Placeholder label={label} ratio={ratio} className="rounded-[14px]" />
      {beam && (
        <BorderBeam
          size={100}
          duration={8}
          width={1.5}
          from={tone === "dark" ? "var(--color-azure-300)" : undefined}
          to={tone === "dark" ? "var(--color-azure-500)" : undefined}
        />
      )}
    </div>
  );
}

/** Dock-style row of app-icon placeholder tiles (red). */
export function IconDock({
  count = 8,
  label = "Runtime logo",
  items,
  className,
}: {
  count?: number;
  label?: string;
  /** Real runtime logos; falls back to red placeholders when omitted. */
  items?: readonly { name: string; src: string; invert?: boolean }[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-end gap-2 rounded-2xl mk-panel-2 p-2 backdrop-blur",
        className,
      )}
    >
      {items
        ? items.map((it) => (
            <div
              key={it.name}
              title={it.name}
              className="gs-dock-icon flex h-12 w-12 items-center justify-center rounded-xl bg-white/[0.04] ring-1 ring-white/[0.06] sm:h-14 sm:w-14"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={it.src}
                alt={it.name}
                loading="lazy"
                className={cn(
                  "h-7 w-7 object-contain sm:h-8 sm:w-8",
                  it.invert && "brightness-0 invert",
                )}
              />
            </div>
          ))
        : Array.from({ length: count }, (_, i) => (
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
