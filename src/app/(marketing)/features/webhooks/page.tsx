import type { Metadata } from "next";
import { WebsiteStory } from "@/components/marketing/website-story";
export const metadata: Metadata = {
  title: "Let a work event trigger the next step.",
  description:
    "Use signed webhooks or event reads to connect Operate with your own runtime.",
  alternates: { canonical: "/features/webhooks" },
};
export default function Page() {
  return <WebsiteStory slug="features/webhooks" />;
}
