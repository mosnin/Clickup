import type { Metadata } from "next";
import { SITE_NAME } from "@/lib/marketing-nav";
import { PricingContent } from "./pricing-content";

export const metadata: Metadata = {
  title: "Pricing — operate",
  description:
    "Proposed workspace plans: Starter $0, Team $49/month and Scale $149/month, with clear member, agent and write allowances.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Pricing — operate",
    description:
      "Proposed plans for coordinating people and connected agents. Runtime and model costs are separate.",
    url: "/pricing",
    siteName: SITE_NAME,
    type: "website",
  },
};

export default function PricingPage() {
  return <PricingContent />;
}
