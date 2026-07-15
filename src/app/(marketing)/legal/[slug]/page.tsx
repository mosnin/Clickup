import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LEGAL_DOCS, getLegalDoc } from "@/lib/legal";
import { LegalDocPage } from "../legal-doc";

export function generateStaticParams() {
  return LEGAL_DOCS.map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const doc = getLegalDoc(slug);
  if (!doc) return {};
  return {
    title: `${doc.title} — legal`,
    description: doc.summary,
    alternates: { canonical: `/legal/${doc.slug}` },
    openGraph: {
      title: `${doc.title} — legal`,
      description: doc.summary,
      url: `/legal/${doc.slug}`,
      type: "article",
    },
  };
}

export default async function LegalSlugPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const doc = getLegalDoc(slug);
  if (!doc) notFound();
  return <LegalDocPage doc={doc} />;
}
