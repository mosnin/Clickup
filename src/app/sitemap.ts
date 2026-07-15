import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/marketing-nav";
import { USE_CASES } from "@/lib/use-cases";
import { RESOURCES } from "@/lib/resources";
import { LEGAL_DOCS } from "@/lib/legal";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const staticPages = [
    "",
    "/features",
    "/use-cases",
    "/resources",
    "/pricing",
    "/company",
    "/legal",
  ];
  return [
    ...staticPages.map((p) => ({
      url: `${SITE_URL}${p}`,
      lastModified: now,
      changeFrequency: "weekly" as const,
      priority: p === "" ? 1 : 0.8,
    })),
    ...USE_CASES.map((u) => ({
      url: `${SITE_URL}/use-cases/${u.slug}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
    ...RESOURCES.map((r) => ({
      url: `${SITE_URL}/resources/${r.slug}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
    ...LEGAL_DOCS.map((d) => ({
      url: `${SITE_URL}/legal/${d.slug}`,
      lastModified: now,
      changeFrequency: "yearly" as const,
      priority: 0.4,
    })),
  ];
}
