import type { Metadata } from "next";
import { SITE_NAME } from "@/lib/marketing-nav";
import { UseCasesIndex } from "./use-cases-index";

export const metadata: Metadata = {
  title: "Use cases — operate",
  description:
    "How engineering teams, agencies, marketing teams, operations, founders, and solo builders run humans and AI agents in one workspace.",
  alternates: { canonical: "/use-cases" },
  openGraph: {
    title: "Use cases — operate",
    description:
      "Engineering, agencies, marketing, operations, startups, and solo builders — the same coordination layer, tailored per team.",
    url: "/use-cases",
    siteName: SITE_NAME,
    type: "website",
  },
};

export default function UseCasesPage() {
  return <UseCasesIndex />;
}
