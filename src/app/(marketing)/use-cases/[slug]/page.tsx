import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { USE_CASES, getUseCase } from "@/lib/use-cases";
import { UseCaseContent } from "../use-case-content";

export function generateStaticParams() {
  return USE_CASES.map((u) => ({ slug: u.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const uc = getUseCase(slug);
  if (!uc) return {};
  return {
    title: uc.metaTitle,
    description: uc.metaDescription,
    alternates: { canonical: `/use-cases/${uc.slug}` },
    openGraph: {
      title: uc.metaTitle,
      description: uc.metaDescription,
      url: `/use-cases/${uc.slug}`,
      type: "website",
    },
  };
}

export default async function UseCasePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const uc = getUseCase(slug);
  if (!uc) notFound();
  return <UseCaseContent uc={uc} />;
}
