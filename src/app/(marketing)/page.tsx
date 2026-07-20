import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/marketing-nav";
import { Hero } from "./sections/hero";
import { SocialProof } from "./sections/social-proof";
import { OpsStack } from "./sections/ops-stack";
import { Showcase } from "./sections/showcase";
import { Bento } from "./sections/bento";
import { MiniFeatures } from "./sections/mini-features";
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

// Home (marketing v2) — section order mirrors the reference layout 1:1:
// blue band (hero + social proof), then white ops-stack/showcase/bento
// sections, dark CTA panel, pricing, FAQ, "simpler" closing panel. Copy
// lives in src/lib/marketing-content.ts; sections own their backgrounds.

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />
      {/* Continuous band behind hero + social proof: near-black navy with a
          blue cast through the nav/headline zone, an azure glow that peaks
          at ~55-66% down the band (the hero screenshot sits ~33-55% down,
          so the glow crests right behind/under it before the social-proof
          screenshot picks it back up), then settling back to deep navy
          through social proof ahead of the white announce strip. */}
      <div className="bg-[linear-gradient(180deg,var(--color-navy-950)_0%,var(--color-navy-900)_26%,var(--color-azure-600)_55%,var(--color-azure-500)_66%,var(--color-navy-900)_92%,var(--color-navy-950)_100%)]">
        <Hero />
        <SocialProof />
      </div>
      <OpsStack />
      <Showcase />
      <Bento />
      <MiniFeatures />
      <CtaPanel />
      <PricingSection />
      <Faq />
      <Simpler />
    </>
  );
}
