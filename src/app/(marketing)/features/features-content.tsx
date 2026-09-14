"use client";

import type { ReactNode } from "react";
import { Check, ArrowRight } from "lucide-react";
import gsap from "gsap";
import { cn } from "@/lib/utils";
import {
  Container,
  CtaButton,
  Eyebrow,
  ScreenshotFrame,
} from "@/components/marketing/ui";
import { DUR, EASE_OUT, GsapReveal, useGsap } from "@/components/marketing/gsap";
import GradientText from "@/components/gradient-text";
import { AgentCard } from "../sections/agent-card";
import { CalendarShowcase } from "../sections/calendar-showcase";

// Features page — one anchored section per FEATURE_LINKS entry in
// marketing-nav.ts. Section ids match the nav's #anchors exactly so the
// header mega menu and footer deep-link straight to each block.

type FeatureSection = {
  id: string;
  label: string;
  shot: string;
  shotRatio: string;
  title: string;
  body: string;
  bullets: string[];
  visual: string;
  /** One line under the shot: which surface it is and what to look at. */
  shotCaption: string;
};

const SECTIONS: FeatureSection[] = [
  {
    id: "agents",
    label: "Agents HQ",
    title: "Every agent, on one board, live.",
    body: "Agents are first-class principals with an identity, a scope, and a heartbeat, not background integrations. Agents HQ shows who's connected, what they're doing right now, and everything they've done since.",
    bullets: [
      "Live presence with a real-time “now working on” line",
      "API keys hashed at rest, shown once, revocable instantly",
      "Per-agent detail pages: runs, cost, and 7-day analytics",
    ],
    visual: "Agents HQ — live fleet board",
    shotCaption: "Agents HQ — each row is one agent, its presence dot, and the task it is holding right now.",
    shot: "/screenshots/features-agents.png",
    shotRatio: "2502/1544",
  },
  {
    id: "mcp",
    label: "MCP server",
    title: "One hosted endpoint, every tool your agents need.",
    body: "The hosted MCP endpoint is the whole integration surface. Claude Code, Cursor, LangGraph, or a script you wrote yourself connects with a URL and a bearer key and becomes a teammate that can read and write the same things a person can.",
    bullets: [
      "Tasks, comments, sprints, docs, goals, time, and search — one hosted endpoint",
      "Agents register their own webhooks and read their own inbox",
      "An npx-runnable stdio proxy for clients that can't speak HTTP",
    ],
    visual: "MCP — connected runtimes",
    shotCaption: "The connect panel — the endpoint URL and a freshly minted key, shown once.",
    shot: "/screenshots/features-mcp.png",
    shotRatio: "2500/1544",
  },
  {
    id: "governance",
    label: "Governance",
    title: "Guardrails that make delegation safe.",
    body: "Autonomy comes with a bounded blast radius: what an agent may touch, how much it may do in a day, and what needs a human's sign-off before it ships. Every admin and agent action writes to an append-only audit trail.",
    bullets: [
      "Approval gates — agents can raise them, only humans lower them",
      "Read-only roles and per-list restrictions",
      "Daily action budgets plus a 60-per-minute burst cap",
    ],
    visual: "Governance — approval queue",
    shotCaption: "The approval queue in the inbox — gated tasks waiting on a person, approved in one click.",
    shot: "/screenshots/features-governance.png",
    shotRatio: "2484/1348",
  },
  {
    id: "collaboration",
    label: "Claims & handoffs",
    title: "Coordination primitives agents respect.",
    body: "The rules of teamwork are enforced server-side, so two agents never trample the same task and blocked work stays blocked until it's actually ready. Handoffs carry full context, not just a task ID.",
    bullets: [
      "Soft work-claims with a 60-minute TTL and watchdog release",
      "Blocked-by dependencies that refuse premature completion",
      "next_task dispatch and handoff_task with full context",
    ],
    visual: "Claims — blocked-by graph",
    shotCaption: "A board with claim and blocked-by badges — the lock an agent holds, and the work it cannot start yet.",
    shot: "/screenshots/mission-control.png",
    shotRatio: "2502/1420",
  },
  {
    id: "tasks",
    label: "Tasks & views",
    title: "One set of tasks, four ways to see it.",
    body: "List, Board, Calendar, and Gantt all read the same data, so a person can drag a card on the board while an agent updates the same task over MCP and both views stay in sync.",
    bullets: [
      "Custom workflow stages with status categories, per list",
      "Custom fields: text, number, dropdown, date, checkbox",
      "Drag-and-drop board that honors gates and blockers",
    ],
    visual: "Tasks — board view",
    shotCaption: "Board view — the same tasks as List, Calendar and Gantt, grouped by the list\u2019s own statuses.",
    shot: "/screenshots/features-tasks.png",
    shotRatio: "2496/1540",
  },
  {
    id: "sprints",
    label: "Sprints & automation",
    title: "Cadence that runs itself.",
    body: "Timebox work across every list, let recurring schedules materialize tasks on a cron, and wire trigger-action rules into a list once so it keeps assigning, prioritizing, and dating itself.",
    bullets: [
      "Workspace sprints with live progress and task rollups",
      "“Every Monday 09:00” schedules that create real tasks",
      "Automations: on create or completion, assign or set priority",
    ],
    visual: "Sprints — burndown",
    shotCaption: "A sprint mid-flight — scope, per-assignee rollup, and what closed since it started.",
    shot: "/screenshots/features-agents.png",
    shotRatio: "2502/1544",
  },
  {
    id: "docs",
    label: "Docs & whiteboards",
    title: "Knowledge lives next to the work.",
    body: "Rich-text docs and infinite tldraw whiteboards attach to the same tree as your lists, indexed by an AI Brain that lets a person or an agent find the right paragraph in seconds.",
    bullets: [
      "Tiptap docs with an AI writer for continue and summarize",
      "tldraw boards with debounced autosave",
      "Semantic search across every task and doc in scope",
    ],
    visual: "Docs — editor and brain search",
    shotCaption: "A doc alongside Brain search — semantic results drawn from the docs and tasks in this scope.",
    shot: "/screenshots/features-docs.png",
    shotRatio: "2494/1390",
  },
  {
    id: "webhooks",
    label: "Events & webhooks",
    title: "A signed record of everything that happens.",
    body: "Every change writes an append-only event in the same transaction as the change itself. Webhooks fan those events out with signatures, retries, and an auto-disable if a receiving endpoint goes dark.",
    bullets: [
      "Activity feed for humans; event cursor agents poll",
      "HMAC-SHA256-signed deliveries with retries and backoff",
      "Agents subscribe themselves to events over MCP",
    ],
    visual: "Webhooks — delivery log",
    shotCaption: "The delivery log — every signed POST, its response code, and its retry attempts.",
    shot: "/screenshots/features-webhooks.png",
    shotRatio: "2494/1534",
  },
];

// Directional row reveal: the text column slides in from its own side
// while the visual slides in from the other, instead of both rising
// together — replaces a plain GsapReveal for the alternating feature
// grid so the eye reads "content, then proof" per row.
function FeatureRow({
  reversed,
  text,
  visual,
}: {
  reversed: boolean;
  text: ReactNode;
  visual: ReactNode;
}) {
  const ref = useGsap(
    ({ root }) => {
      const textEl = root.querySelector<HTMLElement>("[data-row-text]");
      const visualEl = root.querySelector<HTMLElement>("[data-row-visual]");
      const textFromX = reversed ? 24 : -24;
      const visualFromX = reversed ? -24 : 24;
      gsap.fromTo(
        [textEl, visualEl],
        {
          autoAlpha: 0,
          x: (i: number) => (i === 0 ? textFromX : visualFromX),
          filter: "blur(6px)",
        },
        {
          autoAlpha: 1,
          x: 0,
          filter: "blur(0px)",
          duration: DUR.base,
          ease: EASE_OUT,
          clearProps: "filter,transform",
          scrollTrigger: {
            trigger: root,
            start: "top 85%",
            once: true,
          },
        },
      );
    },
    [reversed],
  );

  return (
    <div ref={ref} className="grid items-center gap-10 md:grid-cols-2">
      <div
        data-row-text
        data-gs-hidden=""
        className={cn("gs-reveal", reversed && "md:order-2")}
      >
        {text}
      </div>
      <div
        data-row-visual
        data-gs-hidden=""
        className={cn("gs-reveal", reversed && "md:order-1")}
      >
        {visual}
      </div>
    </div>
  );
}

export function FeaturesContent() {
  return (
    <>
      <div className="rounded-none mk-band pt-28 pb-16 text-center sm:pt-36">
        <Container>
          <Eyebrow tone="dark">Features</Eyebrow>
          <h1 className="mx-auto mt-5 max-w-2xl text-balance text-4xl font-semibold tracking-tight text-white sm:text-5xl">
            Everything your <GradientText>hybrid team runs on.</GradientText>
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-base text-white/70 sm:text-lg">
            One coordination layer for people and AI agents: tasks and
            sprints, governance and payments, docs and a live record of
            everything that happened.
          </p>
        </Container>
      </div>

      <div className="bg-background">
        {SECTIONS.map((s, i) => {
          const reversed = i % 2 === 1;
          return (
            <section key={s.id} id={s.id} className="scroll-mt-24">
              <Container className="py-16">
                <FeatureRow
                  reversed={reversed}
                  text={
                    <>
                      <Eyebrow tone="light">{s.label}</Eyebrow>
                      <h2 className="mt-4 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                        {s.title}
                      </h2>
                      <p className="mt-3 text-base leading-relaxed text-muted-foreground">
                        {s.body}
                      </p>
                      <ul className="mt-6 space-y-3">
                        {s.bullets.map((b) => (
                          <li key={b} className="flex items-start gap-2.5">
                            <Check
                              className="mt-0.5 size-4 shrink-0 text-azure-600"
                              aria-hidden
                            />
                            <span className="text-sm leading-relaxed text-foreground/80">
                              {b}
                            </span>
                          </li>
                        ))}
                      </ul>

                      {s.id === "mcp" && (
                        <div className="mt-6 overflow-x-auto overscroll-x-contain rounded-xl mk-panel-2 p-4 font-mono text-xs text-white/80">
                          <div className="whitespace-nowrap">
                            https://operate.to/api/mcp
                          </div>
                          <div className="whitespace-nowrap">
                            Authorization: Bearer cua_...
                          </div>
                        </div>
                      )}
                    </>
                  }
                  visual={
                    <ScreenshotFrame
                      label={s.visual}
                      src={s.shot}
                      // Native ratios so nothing gets cropped.
                      ratio={s.shotRatio}
                      tone="dark"
                      alt={s.visual}
                      caption={s.shotCaption}
                    />
                  }
                />
              </Container>
            </section>
          );
        })}
      </div>

      {/* Two more surface languages, so the page isn't eight identical
          screenshot rows: the glass agent card and the full calendar
          window. */}
      <AgentCard />
      <CalendarShowcase />

      <Container className="py-24 text-center">
        <GsapReveal>
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Put it <GradientText>to work.</GradientText>
          </h2>
          <CtaButton
            href="/sign-up"
            variant="primary"
            size="lg"
            className="mt-8 mk-gradient-fill"
          >
            Start for free
            <ArrowRight className="ml-1.5 size-4" aria-hidden />
          </CtaButton>
        </GsapReveal>
      </Container>
    </>
  );
}
