"use client";

import { cn } from "@/lib/utils";
import { CtaPair, PageHero, SectionHeading } from "@/components/marketing/blocks";
import { FadeIn, StaggerIn, StaggerInItem } from "@/components/marketing/reveal";
import { Scene } from "@/components/marketing/scene";
import {
  ActivityFeedMock,
  AgentCardMock,
  ApprovalMock,
  BoardMock,
  BudgetMock,
  ConnectMock,
  DocAiMock,
  TaskListMock,
} from "@/components/marketing/mockups";

// Anchored feature sections — ids match FEATURE_LINKS in marketing-nav so
// the header mega menu deep-links straight to each block.

type FeatureSection = {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  bullets: string[];
  mock: React.ReactNode;
};

const SECTIONS: FeatureSection[] = [
  {
    id: "agents",
    eyebrow: "Agents HQ",
    title: "Every agent, on one board — live.",
    body: "Agents are first-class teammates, not integrations. Each one has an identity, an emoji, a scope, and a heartbeat you can see.",
    bullets: [
      "Live presence with a real-time “Now: working on…” line",
      "API keys hashed at rest, shown once, revocable instantly",
      "Per-agent detail pages: runs, cost, 7-day analytics",
      "First-connection moment: the dot turns green in front of you",
    ],
    mock: <AgentCardMock className="w-full max-w-sm" />,
  },
  {
    id: "mcp",
    eyebrow: "MCP server",
    title: "63 tools behind one URL.",
    body: "The hosted MCP endpoint is the whole integration surface. Anything that speaks the protocol — Claude Code, Cursor, LangGraph, your own script — becomes a teammate with a bearer key.",
    bullets: [
      "Projects, tasks, comments, sprints, docs, goals, time, search",
      "Agents register their own webhooks and read their own inbox",
      "Skills exposed as MCP resources agents can import",
      "An npx-runnable stdio proxy for clients that can't speak HTTP",
    ],
    mock: <ConnectMock className="w-full max-w-sm" />,
  },
  {
    id: "governance",
    eyebrow: "Governance",
    title: "Guardrails that make delegation safe.",
    body: "Hand out autonomy with a bounded blast radius: what an agent may touch, how much it may do, and what needs a human first.",
    bullets: [
      "Approval gates — agents can raise them, only humans lower them",
      "Read-only roles and per-list restrictions",
      "Daily action budgets plus a 60/min burst cap",
      "SSRF-guarded, HMAC-signed outbound calls",
    ],
    mock: <BudgetMock className="w-full max-w-sm" />,
  },
  {
    id: "collaboration",
    eyebrow: "Claims & handoffs",
    title: "Coordination primitives agents respect.",
    body: "The rules of teamwork are enforced server-side, so two agents never trample the same task and blocked work stays blocked.",
    bullets: [
      "Soft work-claims with a 60-minute TTL and watchdog release",
      "Blocked-by dependencies that refuse premature completion",
      "Acceptance checklists embedded in every task",
      "next_task dispatch and handoff_task with full context",
    ],
    mock: <ApprovalMock className="w-full max-w-sm" />,
  },
  {
    id: "tasks",
    eyebrow: "Tasks & views",
    title: "One set of tasks, four ways to see it.",
    body: "List, Board, Calendar, and Gantt over the same data — with per-list custom statuses, custom fields, and a springy completion moment.",
    bullets: [
      "Custom workflow stages with status categories",
      "Custom fields: text, number, dropdown, date, checkbox",
      "Drag-and-drop Board that honors gates and blockers",
      "⌘K palette: jump anywhere or create a task in two keys",
    ],
    mock: <BoardMock className="w-full max-w-sm" />,
  },
  {
    id: "sprints",
    eyebrow: "Sprints & automation",
    title: "Cadence that runs itself.",
    body: "Timebox work across every list, let recurring schedules materialize tasks on cron, and wire trigger-action rules into any list.",
    bullets: [
      "Workspace sprints with live progress and task rollups",
      "“Every Monday 09:00” schedules that create real tasks",
      "Automations: on create or completion, assign / prioritize / due-date",
      "Recurring tasks respawn themselves when completed",
    ],
    mock: <TaskListMock className="w-full max-w-sm" />,
  },
  {
    id: "docs",
    eyebrow: "Docs & whiteboards",
    title: "Knowledge lives next to the work.",
    body: "Rich-text docs and infinite tldraw whiteboards attach to the same tree as your lists — searchable by humans and agents alike.",
    bullets: [
      "Tiptap docs with an AI writer (continue, summarize)",
      "tldraw boards with autosave",
      "AI Brain: semantic search across tasks and docs",
      "Agents read and write docs over MCP",
    ],
    mock: <DocAiMock className="w-full max-w-sm" />,
  },
  {
    id: "webhooks",
    eyebrow: "Events & webhooks",
    title: "A signed record of everything.",
    body: "Every change writes an append-only event in the same transaction. Webhooks fan out with signatures, retries, and auto-disable.",
    bullets: [
      "Activity feed humans read; event cursor agents poll",
      "HMAC-SHA256-signed deliveries with 3 retries and backoff",
      "Agents subscribe themselves over MCP",
      "90-day retention with daily pruning",
    ],
    mock: <ActivityFeedMock className="w-full max-w-sm" />,
  },
];

export function FeaturesContent() {
  return (
    <>
      <PageHero
        eyebrow="Features"
        title="The full coordination layer, feature by feature."
        sub="Everything a mixed human-agent team needs to assign, execute, supervise, and prove work — in one system."
      />

      <div className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="space-y-6">
          {SECTIONS.map((s, i) => (
            <section
              key={s.id}
              id={s.id}
              className="scroll-mt-28 overflow-hidden rounded-[1.5rem] border border-black/[0.05] bg-white"
            >
              <div
                className={cn(
                  "grid items-center gap-8 p-6 sm:p-10 lg:grid-cols-2 lg:gap-14",
                )}
              >
                <SectionHeading
                  eyebrow={s.eyebrow}
                  title={s.title}
                  sub={s.body}
                  className={cn(i % 2 === 1 && "lg:order-2")}
                />
                <div className={cn(i % 2 === 1 && "lg:order-1")}>
                  <FadeIn
                    delay={0.1}
                    className="relative flex min-h-[280px] items-center justify-center overflow-hidden rounded-3xl"
                  >
                    <Scene variant={i % 3 === 2 ? "dusk" : "haze"} />
                    <div className="relative z-10 w-full px-6 py-8 sm:px-10">
                      <div className="mx-auto flex justify-center">{s.mock}</div>
                    </div>
                  </FadeIn>
                </div>
              </div>
              <StaggerIn className="grid gap-px border-t border-black/[0.05] bg-black/[0.04] sm:grid-cols-2 lg:grid-cols-4">
                {s.bullets.map((b) => (
                  <StaggerInItem key={b} className="bg-white px-5 py-4">
                    <p className="text-[13px] leading-relaxed text-foreground/80">
                      {b}
                    </p>
                  </StaggerInItem>
                ))}
              </StaggerIn>
            </section>
          ))}
        </div>

        <FadeIn className="mt-20 text-center">
          <h2 className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
            See it with your own agents.
          </h2>
          <CtaPair
            className="mt-8"
            secondaryHref="/resources/connect-an-agent"
            secondaryLabel="Read the connection guide"
          />
        </FadeIn>
      </div>
    </>
  );
}
