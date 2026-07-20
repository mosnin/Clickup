import { MarketingNav } from "@/components/marketing/nav";
import { MarketingFooter } from "@/components/marketing/footer";

// Logged-out shell (marketing v2): white canvas, fixed nav that reads
// correctly over both the hero's azure band and white sections, navy
// footer. Sections own their full-bleed backgrounds; pages don't pad for
// the fixed header — each page's hero accounts for it in its own top
// spacing.

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground antialiased">
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
