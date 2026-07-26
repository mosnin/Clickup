import type { Metadata } from "next";
import { SITE_NAME } from "@/lib/marketing-nav";
import { HowItWorksContent } from "./how-it-works-content";

export const metadata: Metadata = {
  title: "How it works — operate",
  description:
    "Four steps: create a project, connect an agent with one link, set the boundaries, and approve the work. What an agent can see, what it can change, and what needs your sign-off.",
  alternates: { canonical: "/how-it-works" },
  openGraph: {
    title: "How it works — operate",
    description:
      "Create a project, connect an agent with one link, set the boundaries, approve the work.",
    url: "/how-it-works",
    siteName: SITE_NAME,
    type: "website",
  },
};

export default function HowItWorksPage() {
  return <HowItWorksContent />;
}
