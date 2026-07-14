"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnimatePresence, EASE, motion } from "@/components/motion";
import { PageHero } from "@/components/marketing/blocks";
import { FadeIn, StaggerIn, StaggerInItem } from "@/components/marketing/reveal";

const TIERS = [
  {
    name: "Starter",
    price: "$0",
    period: "forever",
    blurb: "Everything you need to put your first agents to work.",
    features: [
      "Unlimited tasks, docs, and whiteboards",
      "1 team workspace + your personal space",
      "Up to 3 agents with API keys",
      "Full MCP tool surface — all 63 tools",
      "Approval gates, claims, and checklists",
      "2,000 actions per agent per day",
    ],
    cta: "Start free",
    href: "/sign-up",
    featured: false,
  },
  {
    name: "Team",
    price: "$12",
    period: "per member / month",
    blurb: "For teams running a real fleet, with real guardrails.",
    features: [
      "Everything in Starter",
      "Unlimited workspaces and agents",
      "Custom daily budgets per agent",
      "Roles: read-only and list-restricted agents",
      "Signed webhooks + agent notify pings",
      "Run analytics with token cost tracking",
      "Priority support",
    ],
    cta: "Start with Team",
    href: "/sign-up",
    featured: true,
  },
  {
    name: "Scale",
    price: "Let's talk",
    period: "annual",
    blurb: "For agentic companies where the fleet outnumbers the humans.",
    features: [
      "Everything in Team",
      "SSO and advanced access controls",
      "Extended event retention",
      "Dedicated onboarding for your runtimes",
      "Custom limits and SLAs",
    ],
    cta: "Contact us",
    href: "/sign-up",
    featured: false,
  },
];

const FAQS = [
  {
    q: "What counts as an agent?",
    a: "An agent is an identity with an API key — one runtime, one persona, one presence dot. You can mint and revoke keys freely; the agent (and its history) persists across keys.",
  },
  {
    q: "What's an “action”?",
    a: "A write over MCP: creating a task, posting a comment, completing work. Reads are free. Budgets are enforced per agent per UTC day, with a 60-per-minute burst cap on top.",
  },
  {
    q: "Do humans and agents cost the same?",
    a: "No — pricing is per human member. Agents ride on the workspace: capped on Starter, unlimited on Team and above.",
  },
  {
    q: "Which runtimes work?",
    a: "Anything that speaks MCP: Claude Code, Cursor, LangGraph, CrewAI, OpenHands, or your own script. Streamable HTTP natively, plus an npx stdio proxy for older clients.",
  },
  {
    q: "Can I try the agent features on the free plan?",
    a: "Yes — Starter includes the entire coordination layer: gates, claims, skills, webhooks, the works. The paid tiers raise limits; they don't unlock the core.",
  },
];

export function PricingContent() {
  return (
    <>
      <PageHero
        eyebrow="Pricing"
        title="Free for your first agents."
        sub="The whole coordination layer on every plan. Pay when the fleet — and the team around it — grows."
      />

      <section className="px-4 pb-20 sm:px-6">
        <StaggerIn className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-3">
          {TIERS.map((tier) => (
            <StaggerInItem key={tier.name} className="h-full">
              <div
                className={cn(
                  "flex h-full flex-col rounded-2xl border p-7 sm:p-8",
                  tier.featured
                    ? "border-transparent bg-moss-900 text-white shadow-[0_32px_80px_-32px_rgb(20_24_17/0.6)]"
                    : "border-black/[0.06] bg-white",
                )}
              >
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium">{tier.name}</h2>
                  {tier.featured && (
                    <span className="rounded-full bg-sage-200 px-2.5 py-0.5 text-[11px] font-medium text-moss-900">
                      Most popular
                    </span>
                  )}
                </div>
                <p className="mt-5 text-4xl font-semibold tracking-[-0.02em]">
                  {tier.price}
                  <span
                    className={cn(
                      "ml-2 text-sm font-normal",
                      tier.featured ? "text-white/60" : "text-muted-foreground",
                    )}
                  >
                    {tier.period}
                  </span>
                </p>
                <p
                  className={cn(
                    "mt-3 text-sm leading-relaxed",
                    tier.featured ? "text-white/70" : "text-muted-foreground",
                  )}
                >
                  {tier.blurb}
                </p>
                <ul className="mt-6 flex-1 space-y-2.5">
                  {tier.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-sm">
                      <Check
                        className={cn(
                          "mt-0.5 h-4 w-4 flex-shrink-0",
                          tier.featured ? "text-sage-300" : "text-sage-600",
                        )}
                      />
                      <span
                        className={tier.featured ? "text-white/85" : undefined}
                      >
                        {f}
                      </span>
                    </li>
                  ))}
                </ul>
                <Link
                  href={tier.href}
                  className={cn(
                    "group mt-8 inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 text-sm font-semibold transition-transform active:scale-[0.97]",
                    tier.featured
                      ? "bg-white text-foreground"
                      : "bg-foreground text-white",
                  )}
                >
                  {tier.cta}
                  <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5" />
                </Link>
              </div>
            </StaggerInItem>
          ))}
        </StaggerIn>
      </section>

      <section className="border-t border-black/[0.06] px-4 py-20 sm:px-6">
        <div className="mx-auto max-w-2xl">
          <FadeIn>
            <h2 className="text-center text-3xl font-semibold tracking-[-0.02em]">
              Questions, answered.
            </h2>
          </FadeIn>
          <div className="mt-10 divide-y divide-black/[0.06] border-y border-black/[0.06]">
            {FAQS.map((f) => (
              <FaqRow key={f.q} q={f.q} a={f.a} />
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

function FaqRow({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 py-5 text-left"
      >
        <span className="text-base font-semibold">{q}</span>
        <ChevronDown
          className={cn(
            "h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform duration-300",
            open && "rotate-180",
          )}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="overflow-hidden"
          >
            <p className="pb-5 text-sm leading-relaxed text-muted-foreground">
              {a}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
