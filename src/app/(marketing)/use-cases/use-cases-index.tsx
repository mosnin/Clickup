"use client";

// Use-case gallery in the Expo-reference style: each card is a floating
// product illustration on a soft warm wash with a plain title below.

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { USE_CASES } from "@/lib/use-cases";
import { CtaPair, PageHero } from "@/components/marketing/blocks";
import { StaggerIn, StaggerInItem } from "@/components/marketing/reveal";
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

const WASHES = [
  "bg-[linear-gradient(135deg,#fdf1e3_0%,#f9ddc4_100%)]",
  "bg-[linear-gradient(135deg,#fdeee9_0%,#f8d9cd_100%)]",
  "bg-[linear-gradient(135deg,#fdf6e4_0%,#f5e4c2_100%)]",
] as const;

export function UseCasesIndex() {
  return (
    <>
      <PageHero
        eyebrow="Use cases"
        title="One coordination layer. Every kind of team."
        sub="The primitives stay the same, agents, gates, budgets, and a live feed. What changes is the work you hand over."
      />
      <section className="px-4 pb-24 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <StaggerIn className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {USE_CASES.map((uc, i) => {
              const Mock = MOCKS[uc.mock];
              return (
                <StaggerInItem key={uc.slug} className="h-full">
                  <Link
                    href={`/use-cases/${uc.slug}`}
                    className="group flex h-full flex-col overflow-hidden rounded-2xl border border-black/[0.05] bg-white"
                  >
                    <div
                      className={cn(
                        "m-2 flex min-h-[190px] flex-1 items-center justify-center overflow-hidden rounded-xl px-6 py-7",
                        WASHES[i % WASHES.length],
                      )}
                    >
                      <div className="w-full max-w-[250px] transition-transform duration-500 group-hover:scale-[1.03]">
                        <Mock />
                      </div>
                    </div>
                    <div className="flex items-start justify-between gap-3 px-6 pb-6 pt-3">
                      <div>
                        <h2 className="text-base font-semibold tracking-tight">
                          {uc.label}
                        </h2>
                        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                          {uc.title}
                        </p>
                      </div>
                      <ArrowRight className="mt-1 h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform duration-300 group-hover:translate-x-1" />
                    </div>
                  </Link>
                </StaggerInItem>
              );
            })}
          </StaggerIn>
          <CtaPair className="mt-16" />
        </div>
      </section>
    </>
  );
}
