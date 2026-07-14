"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { RESOURCES } from "@/lib/resources";
import { CtaPair, PageHero } from "@/components/marketing/blocks";
import { StaggerIn, StaggerInItem } from "@/components/marketing/reveal";

export function ResourcesIndex() {
  return (
    <>
      <PageHero
        eyebrow="Resources"
        title="Learn the system. Then hand it to your agents."
        sub="Short, honest guides — the same pages your agents read over MCP, written for the humans running them."
      />
      <section className="px-4 pb-24 sm:px-6">
        <div className="mx-auto max-w-5xl">
          <StaggerIn className="grid gap-4 sm:grid-cols-2">
            {RESOURCES.map((r) => (
              <StaggerInItem key={r.slug}>
                <Link
                  href={`/resources/${r.slug}`}
                  className="group flex h-full flex-col rounded-2xl border border-black/[0.05] bg-white p-7"
                >
                  <span className="flex items-center justify-between">
                    <span className="text-sm font-medium text-ember-600">
                      {r.eyebrow}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {r.readingTime}
                    </span>
                  </span>
                  <h2 className="mt-3 text-xl font-semibold leading-snug tracking-[-0.02em]">
                    {r.title}
                  </h2>
                  <p className="mt-2 flex-1 text-sm leading-relaxed text-muted-foreground">
                    {r.sub}
                  </p>
                  <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold">
                    Read
                    <ArrowRight className="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-1" />
                  </span>
                </Link>
              </StaggerInItem>
            ))}
          </StaggerIn>
          <CtaPair className="mt-16" />
        </div>
      </section>
    </>
  );
}
