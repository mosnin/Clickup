import type { Metadata } from "next";
import { WebsiteStory } from "@/components/marketing/website-story";
export const metadata: Metadata = {
  title: "Write an acceptance checklist before assigning the task.",
  description:
    "Define what a reviewer should inspect so a finished-looking artifact is not mistaken for an accepted result.",
  alternates: { canonical: "/resources/approval-checklist" },
};
export default function Page() {
  return <WebsiteStory slug="resources/approval-checklist" />;
}
