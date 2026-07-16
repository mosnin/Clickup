import type { Metadata } from "next";
import { ResourcesIndex } from "./resources-index";

export const metadata: Metadata = {
  title: "Resources, guides, playbooks, and release notes",
  description:
    "Getting-started walkthroughs, the MCP connection guide, agent playbook patterns, and the full changelog.",
  alternates: { canonical: "/resources" },
  openGraph: {
    title: "Resources, guides, playbooks, and release notes",
    description:
      "Everything you need to run humans and agents in one workspace.",
    url: "/resources",
    type: "website",
  },
};

export default function ResourcesPage() {
  return <ResourcesIndex />;
}
