import { MarketingNav } from "@/components/marketing/nav";
import { MarketingFooter } from "@/components/marketing/footer";
import { ChatbaseWidget } from "@/components/marketing/chatbase";

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
    <div className="marketing-shell relative flex min-h-dvh flex-col overflow-x-clip text-foreground antialiased">
      {/* Flat black canvas behind every logged-out page. This used to be a
          WebGL dithered wave field tinted charcoal grey — that grey is what
          read as a washed-out band under the hero, so the shader is gone and
          the page sits on pure black. Fixed and sized to the LARGEST viewport
          (h-lvh, not inset-0) so a collapsing mobile URL bar can never resize
          it mid-scroll. */}
      <div
        aria-hidden
        className="pointer-events-none fixed left-0 top-0 -z-10 h-lvh w-screen bg-black"
      />
      {/* Progressive enhancement: GSAP reveals start content hidden via
          [data-gs-hidden] (see globals.css). Without JavaScript that
          attribute is never removed — so force everything visible. */}
      <noscript>
        <style>{`.gs-reveal[data-gs-hidden],[data-gs-hidden] .gs-reveal{visibility:visible !important}`}</style>
      </noscript>
      <MarketingNav />
      <main className="flex-1">{children}</main>
      <MarketingFooter />
      {/* Chatbase support launcher, bottom-right — logged-out pages only. */}
      <ChatbaseWidget />
    </div>
  );
}
