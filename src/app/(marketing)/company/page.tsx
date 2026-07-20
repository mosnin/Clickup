import type { Metadata } from "next";
import { SITE_NAME } from "@/lib/marketing-nav";
import { CompanyContent } from "./company-content";

export const metadata: Metadata = {
  title: "Company — operate",
  description:
    "operate is the shared operating layer for hybrid teams — where people and their AI agents plan, work and stay accountable, with humans keeping the keys.",
  alternates: { canonical: "/company" },
  openGraph: {
    title: "Company — operate",
    description:
      "The shared operating layer for hybrid teams. Humans keep the keys.",
    url: "/company",
    siteName: SITE_NAME,
    type: "website",
  },
};

export default function CompanyPage() {
  return <CompanyContent />;
}
