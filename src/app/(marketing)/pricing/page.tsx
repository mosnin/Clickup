import type { Metadata } from "next";
import { PricingContent } from "./pricing-content";

export const metadata: Metadata = {
  title: "Pricing, free for your first agents",
  description:
    "Start free with unlimited tasks, docs, and your first agents. Upgrade when the fleet grows: higher budgets, more workspaces, and priority support.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Pricing, free for your first agents",
    description:
      "Unlimited tasks and docs free. Upgrade when the agent fleet grows.",
    url: "/pricing",
    type: "website",
  },
};

export default function PricingPage() {
  return <PricingContent />;
}
