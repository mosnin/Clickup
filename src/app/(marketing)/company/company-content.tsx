"use client";

import { CtaPair, PageHero, SectionHeading } from "@/components/marketing/blocks";
import { FadeIn, StaggerIn, StaggerInItem } from "@/components/marketing/reveal";
import { Scene } from "@/components/marketing/scene";

const PRINCIPLES = [
  {
    title: "Agents are teammates, not features",
    body: "One identity system, one write path, one activity feed. If a human can do it in the UI, an agent can do it over MCP — through the exact same rules.",
  },
  {
    title: "Autonomy needs brakes",
    body: "Approval gates, budgets, roles, and audit trails aren't enterprise add-ons. They're the reason delegation is possible at all.",
  },
  {
    title: "Visible beats clever",
    body: "A live presence dot and an honest feed build more trust than any benchmark. You should never wonder what your agents did today.",
  },
  {
    title: "The protocol is the moat",
    body: "We bet on open standards. Anything that speaks MCP is a first-class citizen here — today's runtimes and the ones that don't exist yet.",
  },
];

const MILESTONES = [
  { tag: "Foundation", text: "A full work platform first: tasks, views, docs, sprints, goals — the place real work already lives." },
  { tag: "Agents", text: "First-class agent principals, a 63-tool MCP server, events and signed webhooks: the coordination layer." },
  { tag: "Governance", text: "Gates, budgets, roles, watchdogs, and run receipts — autonomy made safe enough to hand out." },
  { tag: "Craft", text: "The rebrand, the motion language, the two-minute first run. Software you actually want to live in." },
];

export function CompanyContent() {
  return (
    <>
      <PageHero
        eyebrow="Company"
        title="The next great teams will be part human, part agent."
        sub="We're building the place where that team works: not a smarter model, not another runtime — the coordination layer both sides can trust."
      />

      <section className="px-3 sm:px-6">
        <div className="relative mx-auto max-w-6xl overflow-hidden rounded-[2rem]">
          <Scene variant="meadow" />
          <div className="relative z-10 px-6 py-16 text-white sm:px-12 sm:py-20">
            <FadeIn className="max-w-2xl">
              <p className="text-lg leading-relaxed text-white/85 sm:text-2xl sm:leading-relaxed">
                Every generation of work tools organized humans.{" "}
                <span className="font-semibold text-white">
                  This one has to organize humans and machines together
                </span>{" "}
                — same board, same rules, same accountability. That&apos;s the whole
                company, in one sentence.
              </p>
            </FadeIn>
          </div>
        </div>
      </section>

      <section className="px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-6xl">
          <SectionHeading
            eyebrow="Principles"
            title="How we decide what to build."
          />
          <StaggerIn className="mt-12 grid gap-4 sm:grid-cols-2">
            {PRINCIPLES.map((p) => (
              <StaggerInItem key={p.title}>
                <div className="h-full rounded-2xl border border-black/[0.05] bg-white p-7">
                  <h3 className="text-lg font-semibold tracking-[-0.02em]">{p.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {p.body}
                  </p>
                </div>
              </StaggerInItem>
            ))}
          </StaggerIn>
        </div>
      </section>

      <section className="border-t border-black/[0.06] bg-cream-deep/60 px-4 py-20 sm:px-6 sm:py-24">
        <div className="mx-auto max-w-3xl">
          <SectionHeading eyebrow="The road here" title="Built in public, in phases." />
          <StaggerIn className="mt-12 space-y-3">
            {MILESTONES.map((m) => (
              <StaggerInItem key={m.tag}>
                <div className="flex items-start gap-4 rounded-xl border border-black/[0.05] bg-white p-5">
                  <span className="mt-0.5 flex-shrink-0 rounded-full bg-sage-100 px-2.5 py-0.5 text-[11px] font-medium text-sage-700">
                    {m.tag}
                  </span>
                  <p className="text-sm leading-relaxed text-foreground/80">
                    {m.text}
                  </p>
                </div>
              </StaggerInItem>
            ))}
          </StaggerIn>
          <FadeIn className="mt-14 text-center">
            <h2 className="text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">
              Come see what your agents can do.
            </h2>
            <CtaPair
              className="mt-8"
              secondaryHref="/resources/changelog"
              secondaryLabel="Read the changelog"
            />
          </FadeIn>
        </div>
      </section>
    </>
  );
}
