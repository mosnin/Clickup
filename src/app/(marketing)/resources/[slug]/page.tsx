import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RESOURCES, getResource } from "@/lib/resources";
import { SITE_NAME } from "@/lib/marketing-nav";
import { ResourceContent } from "../resource-content";

export function generateStaticParams() {
  return RESOURCES.map((r) => ({ slug: r.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const r = getResource(slug);
  if (!r) return {};
  return {
    title: r.metaTitle,
    description: r.metaDescription,
    alternates: { canonical: `/resources/${r.slug}` },
    openGraph: {
      title: r.metaTitle,
      description: r.metaDescription,
      url: `/resources/${r.slug}`,
      siteName: SITE_NAME,
      type: "article",
    },
  };
}

export default async function ResourcePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const r = getResource(slug);
  if (!r) notFound();
  return <ResourceContent resource={r} />;
}
