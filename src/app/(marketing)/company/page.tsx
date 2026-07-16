import type { Metadata } from "next";
import { CompanyContent } from "./company-content";

export const metadata: Metadata = {
  title: "Company, why we're building mission control for agents",
  description:
    "We believe the next great teams will be part human, part agent, and that the missing piece isn't a smarter model, it's a coordination layer both can trust.",
  alternates: { canonical: "/company" },
  openGraph: {
    title: "Company, why we're building mission control for agents",
    description:
      "The next great teams will be part human, part agent. We're building the coordination layer both can trust.",
    url: "/company",
    type: "website",
  },
};

export default function CompanyPage() {
  return <CompanyContent />;
}
