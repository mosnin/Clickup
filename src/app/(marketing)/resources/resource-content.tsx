"use client";

// Shared renderer for /resources pages: guides (structured sections with
// optional code blocks) and the changelog (release timeline).

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { Resource } from "@/lib/resources";
import { RESOURCE_LINKS } from "@/lib/marketing-nav";
import { CtaPair, Eyebrow, PageHero } from "@/components/marketing/blocks";
import { FadeIn, StaggerIn, StaggerInItem } from "@/components/marketing/reveal";

export function ResourceContent({ resource }: { resource: Resource }) {
  return (
    <>
      <PageHero eyebrow={resource.eyebrow} title={resource.title} sub={resource.sub}>
        <p className="mt-6 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {resource.readingTime}
        </p>
      </PageHero>

      <section className="px-4 pb-20 sm:px-6">
        <div className="mx-auto max-w-2xl">
          {resource.kind === "guide" ? (
            <Guide resource={resource} />
          ) : (
            <Changelog resource={resource} />
          )}
        </div>

        {/* More resources */}
        <div className="mx-auto mt-20 max-w-4xl">
          <FadeIn>
            <Eyebrow>Keep reading</Eyebrow>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {RESOURCE_LINKS.filter(
                (l) => l.href !== `/resources/${resource.slug}`,
              ).map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className="lift group rounded-2xl border border-black/[0.06] bg-white p-5"
                >
                  <span className="flex items-center gap-1 text-sm font-semibold">
                    {l.label}
                    <ArrowRight className="h-3 w-3 transition-transform duration-300 group-hover:translate-x-0.5" />
                  </span>
                  <span className="mt-1 block text-xs leading-snug text-muted-foreground">
                    {l.description}
                  </span>
                </Link>
              ))}
            </div>
          </FadeIn>
          <CtaPair className="mt-14" />
        </div>
      </section>
    </>
  );
}

function Guide({ resource }: { resource: Resource }) {
  return (
    <div className="space-y-6">
      {(resource.sections ?? []).map((s) => (
        <FadeIn
          key={s.heading}
          className="rounded-3xl border border-black/[0.06] bg-white p-7 sm:p-9"
        >
          <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
            {s.heading}
          </h2>
          {s.body && (
            <p className="mt-3 text-[15px] leading-relaxed text-foreground/80">
              {s.body}
            </p>
          )}
          {s.bullets && (
            <ul className="mt-4 space-y-2.5">
              {s.bullets.map((b) => (
                <li key={b} className="flex items-start gap-2.5 text-sm leading-relaxed">
                  <span
                    aria-hidden
                    className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-sage-500"
                  />
                  <span className="text-foreground/80">{b}</span>
                </li>
              ))}
            </ul>
          )}
          {s.code && (
            <div className="mt-5 overflow-hidden rounded-2xl bg-moss-950">
              <p className="border-b border-white/10 px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/40">
                {s.code.label}
              </p>
              <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-sage-200">
                {s.code.lines.join("\n")}
              </pre>
            </div>
          )}
        </FadeIn>
      ))}
    </div>
  );
}

function Changelog({ resource }: { resource: Resource }) {
  return (
    <div className="relative">
      <span
        aria-hidden
        className="absolute bottom-6 left-[5px] top-6 w-px bg-black/10"
      />
      <StaggerIn className="space-y-8">
        {(resource.releases ?? []).map((r) => (
          <StaggerInItem key={r.tag} className="relative pl-8">
            <span
              aria-hidden
              className="absolute left-0 top-2 h-[11px] w-[11px] rounded-full border-2 border-cream bg-sage-500"
            />
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-sage-600">
              {r.tag}
            </p>
            <h2 className="mt-1 text-xl font-bold tracking-tight">{r.title}</h2>
            <ul className="mt-3 space-y-2 rounded-3xl border border-black/[0.06] bg-white p-6">
              {r.items.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm leading-relaxed">
                  <span
                    aria-hidden
                    className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-sage-400"
                  />
                  <span className="text-foreground/80">{item}</span>
                </li>
              ))}
            </ul>
          </StaggerInItem>
        ))}
      </StaggerIn>
    </div>
  );
}
