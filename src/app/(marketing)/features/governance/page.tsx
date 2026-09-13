import type { Metadata } from "next";
import { WebsiteStory } from "@/components/marketing/website-story";
export const metadata: Metadata = {
  title: "Make review part of the task.",
  description:
    "Use roles, scopes and approval requirements to define what a connected agent may do in Operate.",
  alternates: { canonical: "/features/governance" },
};
export default function Page() {
  return <WebsiteStory slug="features/governance" />;
}
