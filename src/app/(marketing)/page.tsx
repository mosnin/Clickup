import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/marketing-nav";
import { Hero } from "./sections/hero";
import { SocialProof } from "./sections/social-proof";
import { LogoCloud } from "./sections/logo-cloud";
import { Problem } from "./sections/problem";
import { Showcase } from "./sections/showcase";
import { FeatureCards } from "./sections/feature-cards";
import { CalendarShowcase } from "./sections/calendar-showcase";
import { Stories } from "./sections/stories";
import { CtaPanel } from "./sections/cta-panel";
import { PricingSection } from "./sections/pricing-section";
import { Faq } from "./sections/faq";
import { Simpler } from "./sections/simpler";
import { Together } from "./sections/together";
import { AgentAtWork } from "./sections/agent-at-work";
import { SurfacesBar } from "./sections/surfaces-bar";
import { WorkTrail } from "./sections/work-trail";

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
// Order is the argument (see the story note at the top of marketing-content):
// hook, then the villain (<Problem />, the one section that never mentions the
// product), then the shift (<SocialProof />: agents on the same board as your
// team), then evidence, then who it is for, then the close.
//
// Each block also wears a different surface language so the page never reads
// as one long grid: <FeatureCards /> is the bento of live app chrome,
// <CalendarShowcase /> is a full application window, <Stories /> is three
// light gradient columns. <Showcase /> carries the real screenshots.

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />
      {/* Continuous band behind the hero and the logo marquee — the shared
          `.mk-band` fill, so the Unicorn scene, the headline and the logos
          read as one opening surface. */}
      <div className="mk-band">
        <Hero />
        <LogoCloud />
      </div>
      {/* Villain, then the shift. <Problem /> has to land before
          <SocialProof /> or the answer arrives before the question. */}
      <Problem />
      <div className="mk-band">
        <SocialProof />
      </div>
      {/* The claim <SocialProof /> just made, happening. A claim about a
          machine doing your work is answered by showing it working, before any
          screenshot — and one small object on black is the quietest the page
          gets, which is what keeps its middle from reading as one long grid. */}
      <AgentAtWork />
      <Showcase />
      {/* A caption to the screenshots and a lead-in to the grid: the five
          surfaces, named, in one line. Deliberately the smallest section here. */}
      <SurfacesBar />
      <FeatureCards />
      {/* The grid CLAIMS features. Presence is the one that has to be felt
          rather than listed, so it lands directly after as the payoff. */}
      <Together />
      <CalendarShowcase />
      <Stories />
      {/* Last before the close: what all of it leaves behind. */}
      <WorkTrail />
      <CtaPanel />
      <PricingSection />
      <Faq />
      <Simpler />
    </>
  );
}
