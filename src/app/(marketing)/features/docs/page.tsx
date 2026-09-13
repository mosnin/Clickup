import type { Metadata } from "next";
import { WebsiteStory } from "@/components/marketing/website-story";
export const metadata: Metadata = {
  title: "Put project instructions beside the work they explain.",
  description:
    "Keep documents and whiteboards in the workspace where tasks are planned and reviewed.",
  alternates: { canonical: "/features/docs" },
};
export default function Page() {
  return <WebsiteStory slug="features/docs" />;
}
