"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { USE_CASES } from "@/lib/use-cases";
import { CtaPair, PageHero } from "@/components/marketing/blocks";
import { StaggerIn, StaggerInItem } from "@/components/marketing/reveal";

export function UseCasesIndex() {
  return (
    <>
      <PageHero
        eyebrow="Use cases"
        title="One coordination layer. Every kind of team."
        sub="The primitives stay the same — agents, gates, budgets, and a live feed. What changes is the work you hand over."
      />
      <section className="px-4 pb-24 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <StaggerIn className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {USE_CASES.map((uc) => (
              <StaggerInItem key={uc.slug}>
                <Link
                  href={`/use-cases/${uc.slug}`}
                  className="lift group flex h-full flex-col rounded-3xl border border-black/[0.06] bg-white p-7"
                >
                  <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-sage-600">
                    {uc.eyebrow}
                  </span>
                  <h2 className="mt-3 text-xl font-bold leading-snug tracking-tight">
                    {uc.title}
                  </h2>
                  <p className="mt-2 flex-1 text-sm leading-relaxed text-muted-foreground">
                    {uc.sub}
                  </p>
                  <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold">
                    Read the playbook
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
