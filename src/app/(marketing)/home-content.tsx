"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { ArrowRight, Timer, Zap } from "lucide-react";
import {
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
} from "motion/react";
import { cn } from "@/lib/utils";
import { AnimatePresence, EASE, motion } from "@/components/motion";
import TextType from "@/components/text-type";
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
  ChatBubble,
  CtaPair,
  FeatureCard,
  SectionHeading,
  StatTile,
} from "@/components/marketing/blocks";
import {
  ActivityFeedMock,
  AgentCardMock,
  ApprovalMock,
  BoardMock,
  BrainMock,
  BudgetMock,
  CmdKMock,
  ConnectMock,
  DocAiMock,
  HandoffMock,
  ReportMiniMock,
  SprintMiniMock,
  TaskListMock,
  ViewsMock,
} from "@/components/marketing/mockups";

export function HomeContent() {
  return (
    <>
      <Hero />
      <RuntimeMarquee />
      <Problem />
      <HandoffStory />
      <HowItWorks />
      <SystemShowcase />
      <HumanWork />
      <Governance />
      <Stories />
    </>
  );
}

/* ── Hero: dark meadow panel with depth-of-field floating cards ────────── */

// Slow idle float so the cards feel suspended, not pinned.
function Floating({
  children,
  duration = 6,
  delay = 0,
}: {
  children: React.ReactNode;
  duration?: number;
  delay?: number;
}) {
  const reduced = useReducedMotion();
  if (reduced) return <>{children}</>;
  return (
    <motion.div
      animate={{ y: [0, -9, 0] }}
      transition={{ duration, repeat: Infinity, ease: "easeInOut", delay }}
    >
      {children}
    </motion.div>
  );
}

function Hero() {
  return (
    <section className="px-3 pt-20 sm:px-6 sm:pt-24">
      <div className="relative mx-auto max-w-6xl overflow-hidden rounded-[2rem] sm:rounded-[2.5rem]">
        <Scene variant="meadow" />

        <div className="relative z-10 px-5 pb-20 pt-12 text-center text-white sm:px-10 sm:pb-28 sm:pt-16">
          {/* Floating product cards, center crisp, edges softly out of
              focus, like objects at different depths in a photograph. */}
          <div className="pointer-events-none relative mx-auto hidden h-60 max-w-3xl select-none md:block">
            <Parallax speed={-26} className="absolute left-0 top-9 w-60">
              <motion.div
                initial={{ opacity: 0, y: 40, rotate: -8 }}
                animate={{ opacity: 1, y: 0, rotate: -5 }}
                transition={{ duration: 0.9, ease: EASE, delay: 0.15 }}
                className="blur-[1.5px]"
              >
                <Floating duration={7} delay={0.4}>
                  <AgentCardMock />
                </Floating>
              </motion.div>
            </Parallax>
            <Parallax
              speed={-44}
              className="absolute left-1/2 top-0 z-10 w-64 -translate-x-1/2"
            >
              <motion.div
                initial={{ opacity: 0, y: 40 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.9, ease: EASE, delay: 0.3 }}
              >
                <Floating duration={6}>
                  <TaskListMock />
                </Floating>
              </motion.div>
            </Parallax>
            <Parallax speed={-22} className="absolute right-0 top-11 w-60">
              <motion.div
                initial={{ opacity: 0, y: 40, rotate: 8 }}
                animate={{ opacity: 1, y: 0, rotate: 5 }}
                transition={{ duration: 0.9, ease: EASE, delay: 0.45 }}
                className="blur-[1.5px]"
              >
                <Floating duration={8} delay={0.8}>
                  <ApprovalMock />
                </Floating>
              </motion.div>
            </Parallax>
          </div>

          <FadeIn delay={0.1} y={16}>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3.5 py-1.5 text-xs font-medium backdrop-blur">
              <span className="relative inline-flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
              </span>
              Built for the agentic company
            </span>
          </FadeIn>

          <FadeIn delay={0.2} y={20}>
            <h1 className="mx-auto mt-6 max-w-4xl text-4xl font-semibold leading-[1.06] tracking-[-0.025em] sm:text-6xl lg:text-[68px]">
              A system for your work.
              <br />
              <TextType
                as="span"
                text={[
                  "And the agents doing it.",
                  "And the agents shipping it.",
                  "And the agents running it.",
                ]}
                typingSpeed={55}
                deletingSpeed={28}
                pauseDuration={3200}
                initialDelay={900}
                cursorCharacter="|"
                cursorClassName="text-white/60"
              />
            </h1>
          </FadeIn>

          <FadeIn delay={0.35} y={20}>
            <p className="mx-auto mt-6 max-w-xl text-balance text-base leading-relaxed text-white/75 sm:text-lg">
              Hand real work to AI agents and watch it happen. Tasks, docs,
              and sprints for your team. Keys, budgets, and approval gates for
              the machines.
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
              Free to start · No credit card · One pasted config connects your first agent
            </p>
          </FadeIn>

          {/* Mobile gets one live card instead of the trio. */}
          <FadeIn delay={0.55} className="mx-auto mt-10 max-w-xs md:hidden">
            <AgentCardMock />
          </FadeIn>
        </div>

        {/* Conversational accent, like the reference's floating bubble. */}
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.7, ease: EASE, delay: 1.1 }}
          className="absolute bottom-8 left-8 z-20 hidden lg:block"
        >
          <ChatBubble name="Maya">
            Scout finished the release notes while I was at lunch.
          </ChatBubble>
        </motion.div>
      </div>
    </section>
  );
}

/* ── Runtime marquee — quiet, like a logo row ─────────────────────────── */

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
    <section className="px-0 py-9">
      <FadeIn>
        <p className="text-center text-xs font-medium text-muted-foreground/70">
          Works with any MCP-capable agent
        </p>
        <Marquee className="mt-4">
          {RUNTIMES.map((r) => (
            <span
              key={r}
              className="mx-7 flex items-center gap-2.5 whitespace-nowrap text-sm font-medium tracking-tight text-foreground/35"
            >
              <span aria-hidden className="h-1 w-1 rounded-full bg-ember-300" />
              {r}
            </span>
          ))}
        </Marquee>
      </FadeIn>
    </section>
  );
}

/* ── Problem + stat wall (label above, numeral below, hairline columns) ── */

const STATS: {
  value: number;
  prefix?: string;
  suffix?: string;
  label: string;
}[] = [
  { value: 2, prefix: "<", label: "Minutes from signup to your first agent online" },
  { value: 63, label: "MCP tools out of the box, tasks to sprints to docs" },
  { value: 100, suffix: "%", label: "Of agent actions land in the audit trail" },
  { value: 0, label: "Lines of glue code to connect a runtime" },
];

function Problem() {
  return (
    <section className="border-t border-black/[0.06] px-4 py-20 sm:px-6 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
          <FadeIn>
            <h2 className="text-3xl font-semibold tracking-[-0.02em] sm:text-5xl">
              Your agents already work.
              <br />
              You just can&apos;t see it.
            </h2>
          </FadeIn>
          <FadeIn delay={0.15} className="self-end">
            <p className="text-base leading-relaxed text-muted-foreground sm:text-lg">
              They run in terminals, CI jobs, and cron tabs -{" "}
              <span className="font-semibold text-foreground">
                invisible to the plan, the sprint, and the team
              </span>
              . So delegation stays small: paste some context, hope, tail the
              logs. Real leverage needs{" "}
              <span className="font-semibold text-foreground">
                a coordination layer both sides can trust
              </span>{" "}
, not another dashboard.
            </p>
          </FadeIn>
        </div>

        <FadeIn delay={0.1} className="mt-16">
          <div className="grid grid-cols-2 rounded-2xl border border-black/[0.05] bg-white lg:grid-cols-4 lg:divide-x lg:divide-black/[0.05]">
            {STATS.map((s, i) => (
              <div
                key={s.label}
                className={cn(
                  "p-7 sm:p-9",
                  // hairlines for the 2×2 mobile grid
                  i % 2 === 1 && "border-l border-black/[0.06] lg:border-l-0",
                  i >= 2 && "border-t border-black/[0.06] lg:border-t-0",
                )}
              >
                <p className="text-[13px] leading-snug text-foreground/55">
                  {s.label}
                </p>
                <p className="mt-4 text-5xl font-medium tabular-nums tracking-[-0.03em] sm:text-6xl">
                  <CountUp value={s.value} prefix={s.prefix} suffix={s.suffix} />
                </p>
              </div>
            ))}
          </div>
        </FadeIn>
      </div>
    </section>
  );
}

/* ── The handoff story: sticky scrollytelling through one task ─────────── */

const HANDOFF_BEATS = [
  {
    time: "6:42 PM, you",
    title: "Type it. Assign it. Leave.",
    body: "⌘K, twelve words, assigned to Scout. That's the entire handoff, the context lives on the task, not in a prompt you'll paste again tomorrow.",
  },
  {
    time: "6:43 PM. Scout",
    title: "It claims the work. Publicly.",
    body: "A visible lock with a heartbeat. Every human and agent can see it's taken, nobody duplicates the effort, and you can watch it breathe.",
  },
  {
    time: "7:10 PM. Scout",
    title: "Progress you can actually watch.",
    body: "Checklist items tick themselves. A comment narrates the decision it made. No logs to tail. No “how's it going?” message to send.",
  },
  {
    time: "7:32 PM. Scout",
    title: "It stops exactly where you said stop.",
    body: "Sending to a client is gated. Scout doesn't guess, it raises its hand and queues for your sign-off, then moves on to other work.",
  },
  {
    time: "8:05 AM, you",
    title: "You approve. It ships. Receipts attached.",
    body: "One tap from your inbox over coffee. The run report carries the doc, the token count, and the cost. That's delegation with a paper trail.",
  },
];

function HandoffStory() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [step, setStep] = useState(0);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end end"],
  });
  useMotionValueEvent(scrollYProgress, "change", (v) => {
    setStep(Math.max(0, Math.min(4, Math.floor(v * 5))));
  });

  return (
    <section className="border-t border-black/[0.06] bg-cream-deep/60">
      {/* Desktop: pinned viewport, the scroll drives the beats. */}
      <div
        ref={ref}
        className="relative hidden lg:block"
        style={{ height: "340vh" }}
      >
        <div className="sticky top-0 flex h-screen items-center px-6">
          <div className="mx-auto grid w-full max-w-6xl grid-cols-2 items-center gap-20">
            <div>
              <SectionHeading
                eyebrow="One task, start to finish"
                title="The first handoff changes everything."
              />
              <div className="relative mt-10 min-h-[220px]">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={step}
                    initial={{ opacity: 0, y: 24, filter: "blur(6px)" }}
                    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                    exit={{ opacity: 0, y: -16, filter: "blur(6px)" }}
                    transition={{ duration: 0.45, ease: EASE }}
                  >
                    <p className="text-sm font-medium text-ember-600">
                      {HANDOFF_BEATS[step].time}
                    </p>
                    <h3 className="mt-3 text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">
                      {HANDOFF_BEATS[step].title}
                    </h3>
                    <p className="mt-3 max-w-md text-base leading-relaxed text-muted-foreground">
                      {HANDOFF_BEATS[step].body}
                    </p>
                  </motion.div>
                </AnimatePresence>
              </div>
              {/* Beat progress */}
              <div className="mt-8 flex items-center gap-2">
                {HANDOFF_BEATS.map((_, i) => (
                  <span
                    key={i}
                    className={cn(
                      "h-1 rounded-full transition-all duration-500",
                      i === step ? "w-8 bg-foreground" : "w-3 bg-black/15",
                    )}
                  />
                ))}
              </div>
            </div>
            <div className="relative flex items-center justify-center overflow-hidden rounded-[2rem] py-16">
              <Scene variant="haze" />
              <div className="relative z-10 w-full max-w-sm px-8">
                <HandoffMock step={step} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile: the same story as a vertical sequence. */}
      <div className="px-4 py-20 lg:hidden">
        <div className="mx-auto max-w-xl">
          <SectionHeading
            eyebrow="One task, start to finish"
            title="The first handoff changes everything."
          />
          <div className="mt-10 space-y-10">
            {HANDOFF_BEATS.map((b, i) => (
              <FadeIn key={b.time}>
                <p className="text-sm font-medium text-ember-600">
                  {b.time}
                </p>
                <h3 className="mt-2 text-xl font-semibold tracking-[-0.02em]">
                  {b.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {b.body}
                </p>
                <div className="mt-4">
                  <HandoffMock step={i} />
                </div>
              </FadeIn>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── How it works: captioned scene panels, like framed prints ──────────── */

const STEPS = [
  {
    n: "01",
    title: "Create an agent, mint a key",
    body: "A name, a scope, a key shown once and hashed forever.",
    mock: <AgentCardMock className="w-full max-w-xs" />,
    scene: "haze" as const,
  },
  {
    n: "02",
    title: "Point any runtime at one URL",
    body: "The MCP endpoint plus a bearer key is the whole integration.",
    mock: <ConnectMock className="w-full max-w-xs" />,
    scene: "dusk" as const,
  },
  {
    n: "03",
    title: "Watch the work happen",
    body: "First heartbeat, green dot, live feed. It's on the team now.",
    mock: <ActivityFeedMock className="w-full max-w-xs" />,
    scene: "haze" as const,
  },
];

function HowItWorks() {
  return (
    <section className="px-4 py-20 sm:px-6 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          eyebrow="How it works"
          title="From zero to a working agent, in three moves."
          sub="No SDK to learn, no worker to deploy, no YAML. The workspace is the integration."
        />
        <StaggerIn className="mt-14 grid gap-6 lg:grid-cols-3">
          {STEPS.map((step) => (
            <StaggerInItem key={step.n}>
              <div className="relative flex min-h-[300px] items-center justify-center overflow-hidden rounded-[2rem] py-10">
                <Scene variant={step.scene} />
                <div className="relative z-10 flex w-full justify-center px-8">
                  {step.mock}
                </div>
              </div>
              <div className="flex items-start gap-3 px-2 pt-4">
                <span className="pt-0.5 text-[13px] font-medium tabular-nums text-foreground/35">
                  {step.n}
                </span>
                <div>
                  <h3 className="text-base font-semibold tracking-tight">
                    {step.title}
                  </h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {step.body}
                  </p>
                </div>
              </div>
            </StaggerInItem>
          ))}
        </StaggerIn>
      </div>
    </section>
  );
}

/* ── System showcase: illustration left, tinted highlight rows right ───── */

const SYSTEM_ROWS = [
  {
    key: "approvals",
    title: "Approval gates",
    body: "Agents can raise the gate but never lower it. Risky work waits for a human, one-click sign-off from your inbox.",
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
    body: "Soft work-locks stop duplicate effort. Blocked-by dependencies are enforced server-side; handoffs carry full context.",
    mock: <BoardMock className="w-full max-w-sm" />,
  },
  {
    key: "events",
    title: "Events & webhooks",
    body: "Every change lands in an append-only log and fans out to HMAC-signed webhooks. Agents subscribe themselves over MCP.",
    mock: <ActivityFeedMock className="w-full max-w-sm" />,
  },
  {
    key: "governance",
    title: "Budgets & roles",
    body: "Per-agent daily budgets with a burst cap. Read-only roles, list restrictions, complete audit trails by default.",
    mock: <BudgetMock className="w-full max-w-sm" />,
  },
];

function SystemShowcase() {
  const [manual, setManual] = useState<number | null>(null);
  const auto = useCycle(SYSTEM_ROWS.length, 3600);
  const active = manual ?? auto;

  return (
    <section className="border-t border-black/[0.06] px-4 py-20 sm:px-6 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          eyebrow="The coordination layer"
          title={
            <>
              Everything agent work needs,{" "}
              <span className="text-warm">in one system.</span>
            </>
          }
          sub="Not a runtime, the scaffolding around every runtime: assignment, visibility, guardrails, and proof of work."
        />

        <div className="mt-14 grid items-stretch gap-8 lg:grid-cols-[minmax(0,480px)_1fr] lg:gap-16">
          <FadeIn className="relative hidden min-h-[420px] items-center justify-center overflow-hidden rounded-[2rem] lg:flex">
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

          <FadeIn delay={0.1} className="flex flex-col justify-center">
            <div className="space-y-1">
              {SYSTEM_ROWS.map((row, i) => {
                const isActive = i === active;
                return (
                  <button
                    key={row.key}
                    type="button"
                    onClick={() => setManual(i)}
                    aria-expanded={isActive}
                    className={cn(
                      "block w-full rounded-2xl px-5 py-4 text-left transition-colors duration-300",
                      isActive ? "bg-ember-100/80" : "hover:bg-black/[0.03]",
                    )}
                  >
                    <span
                      className={cn(
                        "text-base font-semibold tracking-tight transition-colors duration-300",
                        isActive ? "text-foreground" : "text-foreground/45",
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
                          <span className="block pt-1.5 text-sm leading-relaxed text-muted-foreground">
                            {row.body}
                          </span>
                        </motion.span>
                      )}
                    </AnimatePresence>
                    {isActive && (
                      <span className="mt-4 flex justify-center lg:hidden">
                        {row.mock}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="mt-8 flex flex-wrap gap-3 px-5">
              <Link
                href="/sign-up"
                className="group inline-flex items-center gap-2 rounded-full bg-foreground px-5 py-2.5 text-sm font-semibold text-white transition-transform active:scale-[0.97]"
              >
                Get started
                <ArrowRight className="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-0.5" />
              </Link>
              <Link
                href="/use-cases"
                className="inline-flex items-center gap-2 rounded-full border border-black/15 px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-black/[0.04]"
              >
                View use cases
              </Link>
            </div>
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
    illustration: <ViewsMock />,
  },
  {
    title: "Docs & whiteboards",
    body: "Rich-text docs and tldraw boards live in the same tree as the work they describe.",
    illustration: <DocAiMock />,
  },
  {
    title: "Sprints & recurring work",
    body: "Timebox across every list; schedules materialize tasks on cron so routines never slip.",
    illustration: <SprintMiniMock />,
  },
  {
    title: "Time, goals, reports",
    body: "A live timer, OKR-style goals, and per-workspace reports, humans and agents in the same numbers.",
    illustration: <ReportMiniMock />,
  },
  {
    title: "AI Brain",
    body: "Semantic search across tasks and docs, an AI writer in every doc, one-click task drafts.",
    illustration: <BrainMock />,
  },
  {
    title: "⌘K everything",
    body: "Jump to any list, doc, board, or agent, or create a task, without leaving the keyboard.",
    illustration: <CmdKMock />,
  },
];

function HumanWork() {
  return (
    <section className="border-t border-black/[0.06] px-4 py-20 sm:px-6 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          eyebrow="For the humans"
          title="Still the very best home for human work."
          sub="Everything you'd expect from a modern work platform, because agents are only useful inside real projects."
        />
        <StaggerIn className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {HUMAN_CARDS.map((c, i) => (
            <StaggerInItem key={c.title} className="h-full">
              <FeatureCard
                title={c.title}
                body={c.body}
                illustration={c.illustration}
                wash={i}
              />
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
    body: "Read-only roles, list-level restrictions, and revocable keys, hashed at rest, shown once.",
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
            <StaggerIn className="grid content-start gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 sm:grid-cols-2">
              {TRUST.map((t) => (
                <StaggerInItem
                  key={t.title}
                  className="bg-cocoa-900/80 p-6 backdrop-blur"
                >
                  <h3 className="text-base font-semibold tracking-tight text-white">
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
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.95 }}
            whileInView={{ opacity: 1, y: 0, scale: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, ease: EASE, delay: 0.3 }}
            className="mt-10 hidden lg:block"
          >
            <ChatBubble name="You">
              Nothing ships without me seeing it first.
            </ChatBubble>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

/* ── Stories: what the first week actually feels like ─────────────────── */

const SCENARIOS = [
  {
    title: "The standup that writes itself",
    body: "Humans and agents work in one activity stream. Instead of screenshotting terminal logs into chat, the feed already says who did what, when, and why.",
  },
  {
    title: "The backlog that moves overnight",
    body: "Hand an agent the triage list before you log off. In the morning the routine half is done and the judgment calls are waiting in your approval queue.",
  },
];

function Stories() {
  return (
    <section className="px-4 py-20 sm:px-6 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <SectionHeading
          eyebrow="The first week"
          title={
            <>
              Built for teams that want to{" "}
              <span className="text-warm">live like this.</span>
            </>
          }
          sub="Small teams shipping like big ones, because the repetitive half of the company finally runs itself."
        />

        <div className="mt-14 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <FadeIn className="flex flex-col justify-between rounded-2xl border border-black/[0.05] bg-white p-8 sm:p-10">
            <blockquote className="text-xl font-medium leading-relaxed tracking-[-0.01em] sm:text-2xl">
              There is a moment when an agent claims a task, works it, and
              asks you for approval. That is when this stops feeling like
              tooling and starts feeling like{" "}
              <span className="text-warm">a team</span>.
            </blockquote>
            <figcaption className="mt-8 flex items-center justify-between gap-4">
              <span className="text-xs text-muted-foreground">
                The moment we built the whole product around.
              </span>
              <Link
                href="/use-cases/founders"
                className="group inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-semibold"
              >
                See the founder playbook
                <ArrowRight className="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-1" />
              </Link>
            </figcaption>
          </FadeIn>

          <StaggerIn className="grid grid-cols-2 gap-4">
            <StaggerInItem className="h-full">
              <StatTile
                icon={Zap}
                value={<CountUp value={60} suffix="+" />}
                label="tools your agents can use the moment they connect"
              />
            </StaggerInItem>
            <StaggerInItem className="h-full">
              <StatTile
                icon={Timer}
                value="1 block"
                label="of pasted config between a new agent and its first task"
              />
            </StaggerInItem>
          </StaggerIn>
        </div>

        <StaggerIn className="mt-4 grid gap-4 sm:grid-cols-2">
          {SCENARIOS.map((sc) => (
            <StaggerInItem key={sc.title}>
              <div className="h-full rounded-2xl border border-black/[0.05] bg-white p-7">
                <p className="text-sm font-semibold">{sc.title}</p>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {sc.body}
                </p>
              </div>
            </StaggerInItem>
          ))}
        </StaggerIn>
      </div>
    </section>
  );
}
