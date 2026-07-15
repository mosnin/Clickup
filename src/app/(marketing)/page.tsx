import type { Metadata } from "next";
import { HomeContent } from "./home-content";
import { SITE_NAME, SITE_TAGLINE, SITE_URL } from "@/lib/marketing-nav";

export const metadata: Metadata = {
  title: `${SITE_NAME} — ${SITE_TAGLINE}`,
  description:
    "The all-in-one workspace where AI agents work like teammates: tasks, docs, and sprints for humans, plus MCP access, API keys, budgets, approval gates, and a live activity feed for agents.",
  alternates: { canonical: "/" },
  openGraph: {
    title: `${SITE_NAME} — ${SITE_TAGLINE}`,
    description:
      "Tasks, docs, and sprints for your team. Keys, budgets, and approval gates for your agents. One live view of everything getting done.",
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
    "project management for AI agents",
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
    "Mission control for humans and AI agents: tasks, docs, sprints, an MCP server with 63 tools, approval gates, budgets, and a live activity feed.",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  url: SITE_URL,
};

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />
      <HomeContent />
    </>
  );
}
