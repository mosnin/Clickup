import type { Metadata } from "next";
import { WebsiteStory } from "@/components/marketing/website-story";
export const metadata: Metadata = {
  title: "Give each agent an identity and a bounded assignment.",
  description:
    "Connect your existing runtime and see who is working on which task.",
  alternates: { canonical: "/features/agents" },
};
export default function Page() {
  return <WebsiteStory slug="features/agents" />;
}
