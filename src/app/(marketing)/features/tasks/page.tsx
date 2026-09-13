import type { Metadata } from "next";
import { WebsiteStory } from "@/components/marketing/website-story";
export const metadata: Metadata = {
  title: "Keep the task, owner and deadline together.",
  description:
    "List, Board, Calendar and Gantt show the same work from different angles.",
  alternates: { canonical: "/features/tasks" },
};
export default function Page() {
  return <WebsiteStory slug="features/tasks" />;
}
