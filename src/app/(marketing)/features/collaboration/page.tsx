import type { Metadata } from "next";
import { WebsiteStory } from "@/components/marketing/website-story";
export const metadata: Metadata = {
  title: "Hand off work without losing the next step.",
  description:
    "Claims, dependencies and comments help people and agents coordinate on a shared task.",
  alternates: { canonical: "/features/collaboration" },
};
export default function Page() {
  return <WebsiteStory slug="features/collaboration" />;
}
