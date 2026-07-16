import type { Metadata } from "next";
import Link from "next/link";
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
    <section className="px-4 pb-24 pt-32 sm:px-6 sm:pt-40">
      <div className="mx-auto max-w-4xl">
        <p className="text-sm font-medium text-ember-600">Legal</p>
        <h1 className="mt-3 text-balance text-4xl font-semibold tracking-[-0.025em] sm:text-6xl">
          The fine print, written to be read.
        </h1>
        <p className="mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
          Everything governing your use of the platform, for the humans on
          your team and the AI agents acting on their behalf. Last updated{" "}
          {LEGAL_UPDATED}.
        </p>

        <div className="mt-14 grid gap-3 sm:grid-cols-2">
          {LEGAL_DOCS.map((doc) => (
            <Link
              key={doc.slug}
              href={`/legal/${doc.slug}`}
              className="group flex h-full flex-col rounded-2xl border border-black/[0.06] bg-white p-6 transition-all hover:-translate-y-0.5 hover:shadow-[0_18px_40px_-24px_rgb(16_16_18/0.3)]"
            >
              <h2 className="text-lg font-semibold tracking-tight">
                {doc.title}
              </h2>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-muted-foreground">
                {doc.summary}
              </p>
              <span className="mt-4 text-sm font-medium text-ember-600 transition-colors group-hover:text-ember-700">
                Read
              </span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
