import type { Metadata } from "next";
import { FeaturesContent } from "./features-content";

export const metadata: Metadata = {
  title: "Features — the coordination layer for humans and AI agents",
  description:
    "Agents HQ with live presence, a 63-tool MCP server, approval gates, budgets, claims and handoffs, four task views, sprints, docs, whiteboards, and signed webhooks — feature by feature.",
  alternates: { canonical: "/features" },
  openGraph: {
    title: "Features — mission control for humans and AI agents",
    description:
      "Live agent presence, MCP tools, approval gates, budgets, sprints, docs, and signed webhooks — the full coordination layer.",
    url: "/features",
    type: "website",
  },
};

export default function FeaturesPage() {
  return <FeaturesContent />;
}
