"use client";

// Shared template for the industry use-case pages. Content comes from
// src/lib/use-cases.ts; each page is the same narrative arc: pains →
// a day in the life → the plays → proof → CTA.

import { cn } from "@/lib/utils";
import type { UseCase } from "@/lib/use-cases";
import {
  CtaPair,
  PageHero,
  QuoteCard,
  SectionHeading,
} from "@/components/marketing/blocks";
import { FadeIn, StaggerIn, StaggerInItem } from "@/components/marketing/reveal";
import { Scene } from "@/components/marketing/scene";
import {
  ActivityFeedMock,
  AgentCardMock,
  ApprovalMock,
  BoardMock,
  BudgetMock,
  ConnectMock,
  TaskListMock,
} from "@/components/marketing/mockups";

const MOCKS = {
  agent: AgentCardMock,
  approval: ApprovalMock,
  board: BoardMock,
  feed: ActivityFeedMock,
  tasks: TaskListMock,
  budget: BudgetMock,
  connect: ConnectMock,
} as const;

export function UseCaseContent({ uc }: { uc: UseCase }) {
  const Mock = MOCKS[uc.mock];
  return (
    <>
      <PageHero eyebrow={uc.eyebrow} title={uc.title} sub={uc.sub}>
        <CtaPair
          className="mt-10"
          secondaryHref="/features"
          secondaryLabel="Explore features"
        />
      </PageHero>

      {/* Live illustration on a haze scene */}
      <section className="px-4 sm:px-6">
        <FadeIn className="relative mx-auto flex max-w-4xl items-center justify-center overflow-hidden rounded-[2rem] py-14">
          <Scene variant="haze" />
          <div className="relative z-10 w-full max-w-sm px-6">
            <Mock />
          </div>
        </FadeIn>
      </section>

      {/* Pains */}
      <section className="px-4 py-20 sm:px-6 sm:py-24">
        <div className="mx-auto max-w-6xl">
          <SectionHeading
            eyebrow="The problem"
            title="Where it breaks today."
          />
          <StaggerIn className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-black/[0.05] bg-black/[0.05] md:grid-cols-3">
            {uc.pains.map((p) => (
              <StaggerInItem key={p.title} className="bg-white p-7">
                <h3 className="text-lg font-semibold tracking-[-0.02em]">{p.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {p.body}
                </p>
              </StaggerInItem>
            ))}
          </StaggerIn>
        </div>
      </section>

      {/* A day in the life */}
      <section className="border-y border-black/[0.06] bg-cream-deep/60 px-4 py-20 sm:px-6 sm:py-24">
        <div className="mx-auto max-w-3xl">
          <SectionHeading
            eyebrow="A day on mission control"
            title="How the work actually flows."
          />
          <StaggerIn className="relative mt-12 space-y-3">
            <span
              aria-hidden
              className="absolute bottom-4 left-[4.5rem] top-4 hidden w-px bg-black/10 sm:block"
            />
            {uc.day.map((d, i) => (
              <StaggerInItem key={i}>
                <div className="relative flex items-start gap-4 rounded-xl border border-black/[0.05] bg-white p-4 sm:gap-6">
                  <span className="w-14 flex-shrink-0 pt-0.5 text-right text-xs font-semibold tabular-nums text-muted-foreground">
                    {d.time}
                  </span>
                  <span
                    className={cn(
                      "mt-0.5 flex-shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                      d.actor === "agent"
                        ? "bg-ember-100 text-ember-700"
                        : "bg-black/[0.05] text-foreground/60",
                    )}
                  >
                    {d.actor}
                  </span>
                  <p className="min-w-0 flex-1 text-sm leading-relaxed">
                    {d.text}
                  </p>
                </div>
              </StaggerInItem>
            ))}
          </StaggerIn>
        </div>
      </section>

      {/* Plays */}
      <section className="px-4 py-20 sm:px-6 sm:py-24">
        <div className="mx-auto max-w-6xl">
          <SectionHeading
            eyebrow="The plays"
            title="What makes it work here."
          />
          <StaggerIn className="mt-12 grid gap-4 sm:grid-cols-2">
            {uc.plays.map((p) => (
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

      {/* Quote + CTA */}
      <section className="px-4 pb-24 sm:px-6">
        <div className="mx-auto max-w-2xl">
          <FadeIn>
            <QuoteCard {...uc.quote} />
          </FadeIn>
          <FadeIn delay={0.15} className="mt-12 text-center">
            <h2 className="text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">
              Put your first agent on the board today.
            </h2>
            <CtaPair className="mt-8" />
          </FadeIn>
        </div>
      </section>
    </>
  );
}
