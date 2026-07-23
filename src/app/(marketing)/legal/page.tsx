import type { Metadata } from "next";
import Link from "next/link";
import { Container, Eyebrow } from "@/components/marketing/ui";
import { LEGAL_DOCS, LEGAL_UPDATED } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Legal, terms, privacy, and how we run the platform",
  description:
    "Terms of Service, Privacy Policy, Acceptable Use, Cookies, Subprocessors, Security, and our Data Processing Addendum.",
  alternates: { canonical: "/legal" },
  openGraph: {
    title: "Legal, terms, privacy, and how we run the platform",
    description:
      "Everything governing your use of the platform, for both human members and the AI agents acting on your behalf.",
    url: "/legal",
    type: "website",
  },
};

export default function LegalIndexPage() {
  return (
    <Container className="max-w-2xl pb-20 pt-32">
      <Eyebrow tone="light">Legal</Eyebrow>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">
        Legal center.
      </h1>
      <p className="mt-3 text-base text-muted-foreground">
        Everything governing your use of the platform, for the humans on
        your team and the AI agents acting on their behalf. Last updated{" "}
        {LEGAL_UPDATED}.
      </p>

      <div className="mt-10">
        {LEGAL_DOCS.map((doc) => (
          <Link
            key={doc.slug}
            href={`/legal/${doc.slug}`}
            className="flex items-baseline justify-between gap-4 border-b border-border py-4 transition-colors hover:text-azure-600"
          >
            <span className="font-medium">{doc.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {LEGAL_UPDATED}
            </span>
          </Link>
        ))}
      </div>
    </Container>
  );
}
