import type { Metadata } from "next";
import { ResourcesIndex } from "./resources-index";
import { SITE_NAME } from "@/lib/marketing-nav";

export const metadata: Metadata = {
  title: "Resources — operate",
  description:
    "Getting-started walkthroughs, the MCP connection guide, agent playbook patterns, and the full changelog.",
  alternates: { canonical: "/resources" },
  openGraph: {
    title: "Resources — operate",
    description:
      "Short, honest guides for connecting agents, teaching them your process, and everything we've shipped.",
    url: "/resources",
    siteName: SITE_NAME,
    type: "website",
  },
};

export default function ResourcesPage() {
  return <ResourcesIndex />;
}
