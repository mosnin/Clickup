import { MarketingNav } from "@/components/marketing/nav";
import { MarketingFooter } from "@/components/marketing/footer";
import { Dither } from "@/components/marketing/dither";

// Logged-out shell (marketing v3): dark charcoal canvas with vibrant
// gradient accents + gradient text (see .marketing-shell in globals.css),
// fixed nav that reads over the hero and every band, charcoal footer.
// Same layout as before — only the color scheme changed. Sections own their
// full-bleed backgrounds; pages don't pad for the fixed header — each page's
// hero accounts for it in its own top spacing.

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="marketing-shell relative flex min-h-dvh flex-col text-foreground antialiased">
      {/* Dithered charcoal field behind every logged-out page — the shared
          hero backdrop. Fixed so it never scrolls, opaque charcoal fallback
          so there's no flash before the shader mounts (or if WebGL is off). */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 bg-[#0a0a0d]"
      >
        <Dither />
      </div>
      {/* Progressive enhancement: GSAP reveals start content hidden via
          [data-gs-hidden] (see globals.css). Without JavaScript that
          attribute is never removed — so force everything visible. */}
      <noscript>
        <style>{`.gs-reveal[data-gs-hidden],[data-gs-hidden] .gs-reveal{visibility:visible !important}`}</style>
      </noscript>
      <MarketingNav />
      <main className="flex-1">{children}</main>
      <MarketingFooter />
    </div>
  );
}
