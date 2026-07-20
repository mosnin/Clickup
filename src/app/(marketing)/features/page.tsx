import type { Metadata } from "next";
import { SITE_NAME } from "@/lib/marketing-nav";
import { FeaturesContent } from "./features-content";

export const metadata: Metadata = {
  title: "Features — operate",
  description:
    "Agents HQ with live presence, a hosted MCP server, approval gates and budgets, four task views, sprints, docs, and signed webhooks — feature by feature.",
  alternates: { canonical: "/features" },
  openGraph: {
    title: "Features — operate",
    description:
      "Live agent presence, MCP tools, approval gates, budgets, sprints, docs, and signed webhooks — the full coordination layer.",
    url: "/features",
    siteName: SITE_NAME,
    type: "website",
  },
};

export default function FeaturesPage() {
  return <FeaturesContent />;
}
