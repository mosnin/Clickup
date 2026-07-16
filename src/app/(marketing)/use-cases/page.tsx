import type { Metadata } from "next";
import { UseCasesIndex } from "./use-cases-index";

export const metadata: Metadata = {
  title: "Use cases, one coordination layer for every kind of team",
  description:
    "How engineering teams, agencies, marketing teams, operations, founders, and solo builders run humans and AI agents in one workspace.",
  alternates: { canonical: "/use-cases" },
  openGraph: {
    title: "Use cases, humans and agents, every kind of team",
    description:
      "Engineering, agencies, marketing, operations, startups, and solo builders, the same coordination layer, tailored per team.",
    url: "/use-cases",
    type: "website",
  },
};

export default function UseCasesPage() {
  return <UseCasesIndex />;
}
