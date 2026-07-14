"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnimatePresence, EASE, motion, SPRING } from "@/components/motion";
import {
  CountUp,
  FadeIn,
  Marquee,
  Parallax,
  StaggerIn,
  StaggerInItem,
  useCycle,
} from "@/components/marketing/reveal";
import { Scene } from "@/components/marketing/scene";
import {
  CtaPair,
  QuoteCard,
  SectionHeading,
} from "@/components/marketing/blocks";
import {
  ActivityFeedMock,
  AgentCardMock,
  ApprovalMock,
  BoardMock,
  BudgetMock,
  ConnectMock,
  TaskListMock,
} from "@/components/marketing/mockups";

export function HomeContent() {
  return (
    <>
      <Hero />
      <RuntimeMarquee />
      <Problem />
      <HowItWorks />
      <SystemShowcase />
      <HumanWork />
      <Governance />
      <Quotes />
    </>
  );
}

/* ── Hero: dark meadow panel with floating product cards ──────────────── */

function Hero() {
  return (
    <section className="px-3 pt-20 sm:px-6 sm:pt-24">
      <div className="relative mx-auto max-w-6xl overflow-hidden rounded-[2rem] sm:rounded-[2.5rem]">
        <Scene variant="meadow" />

        <div className="relative z-10 px-5 pb-16 pt-12 text-center text-white sm:px-10 sm:pb-24 sm:pt-16">
          {/* Floating product cards, tilted like prints on a table. */}
          <div className="pointer-events-none relative mx-auto hidden h-56 max-w-3xl select-none md:block">
            <Parallax speed={-28} className="absolute left-0 top-8 w-60">
              <motion.div
                initial={{ opacity: 0, y: 40, rotate: -8 }}
                animate={{ opacity: 1, y: 0, rotate: -5 }}
                transition={{ duration: 0.9, ease: EASE, delay: 0.15 }}
              >
                <AgentCardMock />
              </motion.div>
            </Parallax>
            <Parallax speed={-44} className="absolute left-1/2 top-0 w-64 -translate-x-1/2">
              <motion.div
                initial={{ opacity: 0, y: 40 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.9, ease: EASE, delay: 0.3 }}
              >
                <TaskListMock />
              </motion.div>
            </Parallax>
            <Parallax speed={-24} className="absolute right-0 top-10 w-60">
              <motion.div
                initial={{ opacity: 0, y: 40, rotate: 8 }}
                animate={{ opacity: 1, y: 0, rotate: 5 }}
                transition={{ duration: 0.9, ease: EASE, delay: 0.45 }}
              >
                <ApprovalMock />
              </motion.div>
            </Parallax>
          </div>

          <FadeIn delay={0.1} y={16}>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/10 px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] backdrop-blur">
              <span className="relative inline-flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
              </span>
              Built for the agentic company
            </span>
          </FadeIn>

          <FadeIn delay={0.2} y={20}>
            <h1 className="mx-auto mt-6 max-w-3xl text-balance text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl">
              A workspace for humans and their agents.
            </h1>
          </FadeIn>

          <FadeIn delay={0.35} y={20}>
            <p className="mx-auto mt-6 max-w-2xl text-balance text-base leading-relaxed text-white/75 sm:text-lg">
              Tasks, docs, and sprints for your team. Keys, budgets, and
              approval gates for your agents. One live view of everything
              getting done — by anyone.
            </p>
          </FadeIn>

          <FadeIn delay={0.5} y={16}>
            <CtaPair
              tone="light"
              className="mt-10"
              secondaryHref="/features"
              secondaryLabel="See how it works"
            />
            <p className="mt-5 text-xs text-white/50">
              Free to start · No credit card · Agent online in under two minutes
            </p>
          </FadeIn>

          {/* Mobile gets one live card instead of the trio. */}
          <FadeIn delay={0.55} className="mx-auto mt-10 max-w-xs md:hidden">
            <AgentCardMock />
          </FadeIn>
        </div>
      </div>
    </section>
  );
}

/* ── Runtime marquee ──────────────────────────────────────────────────── */

const RUNTIMES = [
  "Claude Code",
  "Cursor",
  "LangGraph",
  "CrewAI",
  "OpenHands",
  "AutoGen",
  "Your custom runtime",
];

function RuntimeMarquee() {
  return (
    <section className="border-b border-black/[0.06] px-0 py-10">
      <FadeIn>
        <p className="text-center text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Works with any MCP-capable agent
        </p>
        <Marquee className="mt-5">
          {RUNTIMES.map((r) => (
            <span
              key={r}
              className="mx-8 flex items-center gap-3 whitespace-nowrap text-lg font-semibold tracking-tight text-foreground/45"
            >
              <span aria-hidden className="h-1 w-1 rounded-full bg-sage-400" />
              {r}
            </span>
          ))}
        </Marquee>
      </FadeIn>
    </section>
  );
}

/* ── Problem + stats ──────────────────────────────────────────────────── */

const STATS: {
  value: number;
  prefix?: string;
  suffix?: string;
  label: string;
}[] = [
  { value: 2, prefix: "<", suffix: " min", label: "from signup to your first agent online" },
  { value: 63, label: "MCP tools out of the box — tasks to sprints to docs" },
  { value: 100, suffix: "%", label: "of agent actions land in the audit trail" },
  { value: 0, label: "lines of glue code to connect a runtime" },
];

function Problem() {
  return (
    <section className="px-4 py-20 sm:px-6 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
          <FadeIn>
            <h2 className="text-3xl font-bold tracking-tight sm:text-5xl">
              Agent work is invisible in a human task tracker.
            </h2>
          </FadeIn>
          <FadeIn delay={0.15} className="self-end">
            <p className="text-base leading-relaxed text-muted-foreground sm:text-lg">
              Your agents run in terminals, CI jobs, and cron tabs —{" "}
              <span className="font-semibold text-foreground">
                nobody can see what they&apos;re doing
              </span>
              , what they finished, or what they&apos;re stuck on. Handing them
              real work means pasting context, praying, and checking logs.{" "}
              <span className="font-semibold text-foreground">
                This needs a coordination layer
              </span>
              , not another dashboard.
            </p>
          </FadeIn>
        </div>

        <StaggerIn className="mt-16 grid grid-cols-2 gap-px overflow-hidden rounded-3xl border border-black/[0.06] bg-black/[0.06] lg:grid-cols-4">
          {STATS.map((s) => (
            <StaggerInItem key={s.label} className="bg-white p-6 sm:p-8">
              <p className="text-4xl font-bold tabular-nums tracking-tight sm:text-5xl">
                <CountUp value={s.value} prefix={s.prefix} suffix={s.suffix} />
              </p>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground sm:text-sm">
                {s.label}
              </p>
            </StaggerInItem>
          ))}
        </StaggerIn>
      </div>
    </section>
  );
}

/* ── How it works: three steps ────────────────────────────────────────── */

const STEPS = [
  {
    n: "01",
    title: "Create an agent, mint a key",
    body: "Give it a name and a scope — your personal space or a team workspace. Mint an API key; it's hashed at rest and revocable in one click.",
    mock: <AgentCardMock className="w-full max-w-sm" />,
  },
  {
    n: "02",
    title: "Point any runtime at one URL",
    body: "Your MCP endpoint plus a bearer key is the whole integration. Claude Code, Cursor, LangGraph, a bash script — anything that speaks MCP is a teammate.",
    mock: <ConnectMock className="w-full max-w-sm" />,
  },
  {
    n: "03",
    title: "Watch the work happen",
    body: "The moment it heartbeats, it's on the board: live presence, a “Now: …” status line, and every task, comment, and completion in the activity feed.",
    mock: <ActivityFeedMock className="w-full max-w-sm" />,
  },
];

function HowItWorks() {
  return (
    <section className="border-t border-black/[0.06] bg-cream-deep/60 px-4 py-20 sm:px-6 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          eyebrow="How it works"
          title="From zero to a working agent, in three moves."
          sub="No SDK to learn, no worker to deploy, no YAML. The workspace is the integration."
        />
        <div className="mt-14 grid gap-4 lg:grid-cols-3">
          {STEPS.map((step, i) => (
            <FadeIn
              key={step.n}
              delay={i * 0.12}
              className="flex flex-col rounded-3xl border border-black/[0.06] bg-white p-6 sm:p-8"
            >
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sage-600">
                Step {step.n}
              </span>
              <h3 className="mt-3 text-xl font-bold tracking-tight">
                {step.title}
              </h3>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-muted-foreground">
                {step.body}
              </p>
              <div className="mt-6 flex justify-center">{step.mock}</div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── System showcase: interactive rows + swapping illustration ────────── */

const SYSTEM_ROWS = [
  {
    key: "approvals",
    title: "Approval gates",
    body: "Agents can raise the gate but never lower it. Risky work waits for a human — approvals queue in your inbox with one-click sign-off.",
    mock: <ApprovalMock className="w-full max-w-sm" />,
  },
  {
    key: "presence",
    title: "Live presence",
    body: "Heartbeats drive a real-time “Now: …” line on every agent. You always know who's online and what they're touching.",
    mock: <AgentCardMock className="w-full max-w-sm" />,
  },
  {
    key: "claims",
    title: "Claims & handoffs",
    body: "Soft work-locks stop two agents from doing the same job. Blocked-by dependencies are enforced server-side; handoffs carry full context.",
    mock: <BoardMock className="w-full max-w-sm" />,
  },
  {
    key: "events",
    title: "Events & webhooks",
    body: "Every change lands in an append-only log and fans out to HMAC-signed webhooks with retries. Agents subscribe themselves over MCP.",
    mock: <ActivityFeedMock className="w-full max-w-sm" />,
  },
  {
    key: "governance",
    title: "Budgets & roles",
    body: "Per-agent daily action budgets with a 60/min burst cap. Read-only roles, list restrictions, and complete audit trails by default.",
    mock: <BudgetMock className="w-full max-w-sm" />,
  },
];

function SystemShowcase() {
  const [manual, setManual] = useState<number | null>(null);
  const auto = useCycle(SYSTEM_ROWS.length, 3600);
  const active = manual ?? auto;

  return (
    <section className="px-4 py-20 sm:px-6 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          eyebrow="The coordination layer"
          title="Everything agent work needs, in one system."
          sub="Not a runtime — the scaffolding around every runtime: assignment, visibility, guardrails, and proof of work."
        />

        <div className="mt-14 grid items-start gap-8 lg:grid-cols-[1fr_minmax(0,480px)] lg:gap-16">
          <FadeIn className="divide-y divide-black/[0.06] border-y border-black/[0.06]">
            {SYSTEM_ROWS.map((row, i) => {
              const isActive = i === active;
              return (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => setManual(i)}
                  aria-expanded={isActive}
                  className="relative block w-full py-5 pl-6 text-left"
                >
                  {isActive && (
                    <motion.span
                      layoutId="system-row-indicator"
                      transition={SPRING}
                      className="absolute bottom-4 left-0 top-4 w-1 rounded-full bg-foreground"
                    />
                  )}
                  <span
                    className={cn(
                      "text-lg font-bold tracking-tight transition-colors duration-300",
                      isActive ? "text-foreground" : "text-foreground/40",
                    )}
                  >
                    {row.title}
                  </span>
                  <AnimatePresence initial={false}>
                    {isActive && (
                      <motion.span
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.4, ease: EASE }}
                        className="block overflow-hidden"
                      >
                        <span className="block pt-2 text-sm leading-relaxed text-muted-foreground">
                          {row.body}
                        </span>
                      </motion.span>
                    )}
                  </AnimatePresence>
                  {/* The active mock inlines here on mobile. */}
                  {isActive && (
                    <span className="mt-4 flex justify-center lg:hidden">
                      {row.mock}
                    </span>
                  )}
                </button>
              );
            })}
          </FadeIn>

          <FadeIn
            delay={0.15}
            className="relative hidden min-h-[380px] items-center justify-center overflow-hidden rounded-[2rem] lg:flex"
          >
            <Scene variant="haze" />
            <AnimatePresence mode="wait">
              <motion.div
                key={SYSTEM_ROWS[active].key}
                initial={{ opacity: 0, y: 24, scale: 0.97, filter: "blur(6px)" }}
                animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -16, scale: 0.98, filter: "blur(6px)" }}
                transition={{ duration: 0.45, ease: EASE }}
                className="relative z-10 flex w-full justify-center px-8"
              >
                {SYSTEM_ROWS[active].mock}
              </motion.div>
            </AnimatePresence>
          </FadeIn>
        </div>
      </div>
    </section>
  );
}

/* ── Human work grid ──────────────────────────────────────────────────── */

const HUMAN_CARDS = [
  {
    title: "Four views, one truth",
    body: "List, Board, Calendar, and Gantt over the same tasks, with custom statuses and fields per list.",
    chip: "Views",
    chipBg: "bg-pastel-blue",
  },
  {
    title: "Docs & whiteboards",
    body: "Rich-text docs and tldraw boards live in the same tree as the work they describe.",
    chip: "Knowledge",
    chipBg: "bg-pastel-purple",
  },
  {
    title: "Sprints & recurring work",
    body: "Timebox across every list; schedules materialize tasks on cron so routines never slip.",
    chip: "Cadence",
    chipBg: "bg-pastel-yellow",
  },
  {
    title: "Time, goals, reports",
    body: "A live timer, OKR-style goals, and per-workspace reports — humans and agents in the same numbers.",
    chip: "Insight",
    chipBg: "bg-pastel-green",
  },
  {
    title: "AI Brain",
    body: "Semantic search across tasks and docs, an AI writer in every doc, one-click task drafts.",
    chip: "AI",
    chipBg: "bg-pastel-pink",
  },
  {
    title: "⌘K everything",
    body: "Jump to any list, doc, board, or agent — or create a task — without leaving the keyboard.",
    chip: "Speed",
    chipBg: "bg-pastel-red",
  },
];

function HumanWork() {
  return (
    <section className="border-t border-black/[0.06] px-4 py-20 sm:px-6 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          eyebrow="For the humans"
          title="Still the very best home for human work."
          sub="Everything you'd expect from a modern work platform — because agents are only useful inside real projects."
        />
        <StaggerIn className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {HUMAN_CARDS.map((c) => (
            <StaggerInItem key={c.title}>
              <div className="lift h-full rounded-3xl border border-black/[0.06] bg-white p-6">
                <span
                  className={cn(
                    "inline-block rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider",
                    c.chipBg,
                  )}
                >
                  {c.chip}
                </span>
                <h3 className="mt-4 text-lg font-bold tracking-tight">
                  {c.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {c.body}
                </p>
              </div>
            </StaggerInItem>
          ))}
        </StaggerIn>
        <FadeIn className="mt-10 text-center">
          <Link
            href="/features"
            className="group inline-flex items-center gap-2 text-sm font-semibold"
          >
            Explore every feature
            <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
          </Link>
        </FadeIn>
      </div>
    </section>
  );
}

/* ── Governance: dark trust panel ─────────────────────────────────────── */

const TRUST = [
  {
    title: "Human-in-the-loop by design",
    body: "Approval gates agents can raise but never lower. A human completing gated work counts as sign-off.",
  },
  {
    title: "Least privilege, per agent",
    body: "Read-only roles, list-level restrictions, and revocable keys — hashed at rest, shown once.",
  },
  {
    title: "Hard spending limits",
    body: "Daily action budgets and a 60-per-minute burst cap stop a runaway loop in seconds.",
  },
  {
    title: "Proof, not promises",
    body: "An append-only event log, HMAC-signed webhooks, and per-agent run reports with cost.",
  },
];

function Governance() {
  return (
    <section className="px-3 py-10 sm:px-6">
      <div className="relative mx-auto max-w-6xl overflow-hidden rounded-[2rem] sm:rounded-[2.5rem]">
        <Scene variant="dusk" />
        <div className="relative z-10 px-6 py-16 sm:px-12 sm:py-24">
          <SectionHeading
            tone="light"
            eyebrow="Trust & governance"
            title="Autonomy you can actually hand out."
            sub="Delegation only works when the blast radius is bounded. Guardrails are first-class here, not a settings page."
          />
          <div className="mt-14 grid gap-8 lg:grid-cols-[1fr_minmax(0,420px)] lg:gap-16">
            <StaggerIn className="grid content-start gap-px overflow-hidden rounded-3xl border border-white/10 bg-white/10 sm:grid-cols-2">
              {TRUST.map((t) => (
                <StaggerInItem key={t.title} className="bg-moss-900/80 p-6 backdrop-blur">
                  <h3 className="text-base font-bold tracking-tight text-white">
                    {t.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-white/60">
                    {t.body}
                  </p>
                </StaggerInItem>
              ))}
            </StaggerIn>
            <div className="flex flex-col items-center justify-center gap-4">
              <FadeIn className="w-full max-w-sm">
                <BudgetMock />
              </FadeIn>
              <FadeIn delay={0.15} className="w-full max-w-sm">
                <ApprovalMock />
              </FadeIn>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── Quotes ───────────────────────────────────────────────────────────── */

const QUOTES = [
  {
    quote:
      "The first time an agent claimed a task, worked it, and asked me for approval — that was the moment this stopped feeling like tooling and started feeling like a team.",
    name: "Maya",
    role: "Founder, 3-person startup running 5 agents",
  },
  {
    quote:
      "We stopped screenshotting terminal logs into Slack. The activity feed is the standup now — humans and agents in the same stream.",
    name: "Daniel",
    role: "Engineering lead, product studio",
  },
  {
    quote:
      "Budgets and approval gates were what let me hand client work to agents. I can see every action, and nothing ships without me.",
    name: "Priya",
    role: "Operations director, digital agency",
  },
];

function Quotes() {
  return (
    <section className="px-4 py-20 sm:px-6 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          align="center"
          eyebrow="Stories"
          title="What running on mission control feels like."
        />
        <StaggerIn className="mt-14 grid gap-4 lg:grid-cols-3">
          {QUOTES.map((q) => (
            <StaggerInItem key={q.name}>
              <QuoteCard {...q} />
            </StaggerInItem>
          ))}
        </StaggerIn>
      </div>
    </section>
  );
}
