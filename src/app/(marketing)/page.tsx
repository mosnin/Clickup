import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/marketing-nav";
import { Hero } from "./sections/hero";
import { SocialProof } from "./sections/social-proof";
import { LogoCloud } from "./sections/logo-cloud";
import { Showcase } from "./sections/showcase";
import { FeatureCards } from "./sections/feature-cards";
import { CalendarShowcase } from "./sections/calendar-showcase";
import { Stories } from "./sections/stories";
import { CtaPanel } from "./sections/cta-panel";
import { PricingSection } from "./sections/pricing-section";
import { Faq } from "./sections/faq";
import { Simpler } from "./sections/simpler";

export const metadata: Metadata = {
  title: `${SITE_NAME} — recruit, direct and scale your AI agent workforce`,
  description:
    "operate is the operating system for hybrid teams: task orchestration, governance and payments for people and AI agents working side by side.",
  alternates: { canonical: "/" },
  openGraph: {
    title: `${SITE_NAME} — recruit, direct and scale your AI agent workforce`,
    description:
      "Task orchestration, governance and payments for people and AI agents working side by side.",
    url: "/",
    siteName: SITE_NAME,
    type: "website",
  },
  keywords: [
    "AI agent workspace",
    "agent task management",
    "MCP server",
    "AI agent collaboration",
    "human in the loop",
    "agent orchestration",
    "sprint planning for AI agents",
  ],
};

// Structured data: tells crawlers this is a SaaS product with a free tier.
const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE_NAME,
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  description:
    "The operating system for AI agent workforces: tasks, sprints, governance, observability and x402 payments, with a hosted MCP server.",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  url: SITE_URL,
};

// Home (marketing v2) — band (hero + social proof), the product screenshot,
// then the feature card grid, dark CTA panel, pricing, FAQ, and the "simpler"
// closing panel. Sections own their backgrounds.
//
// Each feature block deliberately wears a different surface language so the
// page never reads as one long grid: <FeatureCards /> is the bento of live
// app chrome, <CalendarShowcase /> is a full application window, <Stories />
// is three light gradient columns. <Showcase /> carries the real screenshots.

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />
      {/* Continuous band behind hero + social proof: the shared deep-charcoal
          `.mk-band` gradient (charcoal fill + a soft azure glow crested near
          the top), carrying the hero + social-proof screenshots through to
          the announce strip. */}
      <div className="mk-band">
        <Hero />
        <LogoCloud />
        <SocialProof />
      </div>
      <Showcase />
      <FeatureCards />
      <CalendarShowcase />
      <Stories />
      <CtaPanel />
      <PricingSection />
      <Faq />
      <Simpler />
    </>
  );
}
