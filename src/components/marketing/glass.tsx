import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Glass surface — the second card language on the marketing site, alongside
// the flat charcoal cards in sections/feature-cards.tsx. Where those are
// opaque panels on black, this one is frosted: the page reads through it.
//
// Four stacked layers make the glass, and each one earns its place:
//   1. the fill — a white gradient at low alpha over `backdrop-filter: blur`,
//      so whatever sits behind bleeds through as colour rather than detail;
//   2. a bright hairline masked to the top-left, where light would catch;
//   3. a dimmer hairline masked to the opposite corner, so the edge doesn't
//      simply vanish on the shadow side;
//   4. a soft bloom bleeding a pixel past the border at the top.
// A single ring-1 would flatten all of that into one even outline, which is
// exactly what makes a glass card look printed on.

export function GlassPanel({
  className,
  radius = "1.2em",
  /** Accent used by the top bloom. Defaults to the brand blue. */
  bloom = "rgba(59,130,246,0.14)",
  children,
}: {
  className?: string;
  radius?: string;
  bloom?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden bg-gradient-to-br from-white/[0.14] to-white/[0.04]",
        className,
      )}
      style={{
        borderRadius: radius,
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 border border-white/25"
        style={{
          borderRadius: radius,
          maskImage: "linear-gradient(135deg, white, transparent 60%)",
          WebkitMaskImage: "linear-gradient(135deg, white, transparent 60%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 border border-white/10"
        style={{
          borderRadius: radius,
          maskImage: "linear-gradient(135deg, transparent 60%, white)",
          WebkitMaskImage: "linear-gradient(135deg, transparent 60%, white)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-px"
        style={{
          borderRadius: `calc(${radius} + 1px)`,
          background: `radial-gradient(80% 60% at 50% 0%, ${bloom}, transparent 60%)`,
        }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}

/** Hairline that fades in from both ends — a divider inside glass. */
export function GlassRule({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "h-px w-full bg-gradient-to-r from-transparent via-white/25 to-transparent",
        className,
      )}
    />
  );
}

/** Vertical version of {@link GlassRule}, for separating stat columns. */
export function GlassDivider() {
  return (
    <div
      aria-hidden
      className="my-auto h-12 w-px bg-gradient-to-b from-transparent via-white/35 to-transparent"
    />
  );
}

/** A stat column: big gradient number over a small uppercase label. */
export function GlassStat({
  value,
  suffix,
  label,
}: {
  value: string;
  suffix?: string;
  label: string;
}) {
  return (
    <div className="rounded-lg px-2 py-2 text-center transition-transform duration-300 hover:-translate-y-0.5 hover:bg-white/5">
      <div className="bg-gradient-to-r from-white/95 to-neutral-200/80 bg-clip-text text-2xl font-medium leading-tight text-transparent">
        {value}
        {suffix ? <span className="text-sm">{suffix}</span> : null}
      </div>
      <div className="text-tiny uppercase tracking-wide text-white/60">
        {label}
      </div>
    </div>
  );
}

/** Tinted pill used for an agent's governance flags. */
export function GlassChip({
  tone,
  children,
}: {
  tone: "blue" | "cyan" | "emerald";
  children: ReactNode;
}) {
  const tones = {
    blue: "border-blue-500/25 bg-blue-500/10 text-blue-200",
    cyan: "border-cyan-500/25 bg-cyan-500/10 text-cyan-200",
    emerald: "border-emerald-500/25 bg-emerald-500/10 text-emerald-200",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-1 text-tiny uppercase tracking-wide transition-transform duration-300 hover:-translate-y-px",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}
