import type { Metadata } from "next";
import { SITE_NAME } from "@/lib/marketing-nav";
import { PricingContent } from "./pricing-content";

export const metadata: Metadata = {
  title: "Pricing — operate",
  description:
    "Priced per human member — agents ride along free. Start free with up to 3 agents, upgrade to Team for unlimited agents and sprints, or talk to us for Scale.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Pricing — operate",
    description:
      "Priced per human member. Agents ride along free on every plan.",
    url: "/pricing",
    siteName: SITE_NAME,
    type: "website",
  },
};

export default function PricingPage() {
  return <PricingContent />;
}
