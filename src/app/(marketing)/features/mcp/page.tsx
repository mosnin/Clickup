import type { Metadata } from "next";
import { WebsiteStory } from "@/components/marketing/website-story";
export const metadata: Metadata = {
  title: "Connect your agent to a shared project workspace.",
  description:
    "MCP gives compatible tools access to supported Operate tasks, documents and coordination actions.",
  alternates: { canonical: "/features/mcp" },
};
export default function Page() {
  return <WebsiteStory slug="features/mcp" />;
}
