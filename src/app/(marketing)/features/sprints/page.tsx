import type { Metadata } from "next";
import { WebsiteStory } from "@/components/marketing/website-story";
export const metadata: Metadata = {
  title: "Turn recurring work into a visible plan.",
  description:
    "Organize a sprint, apply a template and keep recurring tasks on the same board.",
  alternates: { canonical: "/features/sprints" },
};
export default function Page() {
  return <WebsiteStory slug="features/sprints" />;
}
