import type { Metadata } from "next";
import { WebsiteStory } from "@/components/marketing/website-story";
export const metadata: Metadata = {
  title: "Separate coordination actions from model spend.",
  description:
    "Operate records and limits actions in its own workspace. The runtime and model provider may have separate costs.",
  alternates: { canonical: "/resources/action-budgets" },
};
export default function Page() {
  return <WebsiteStory slug="resources/action-budgets" />;
}
