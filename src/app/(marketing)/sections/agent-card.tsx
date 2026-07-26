"use client";

import gsap from "gsap";
import { Container, Eyebrow } from "@/components/marketing/ui";
import {
  GlassChip,
  GlassDivider,
  GlassPanel,
  GlassRule,
  GlassStat,
} from "@/components/marketing/glass";
import { DUR, EASE_OUT, useGsap } from "@/components/marketing/gsap";
import GradientText from "@/components/gradient-text";

// "Every agent has a card" — the glass card language, deliberately not the
// bento grid: one object at hero scale with the copy beside it, floating over
// a lit backdrop so the frosted fill has something to read through.
//
// What the card shows is the real per-agent detail page: identity, live
// presence, the MCP calls it just made, its governance flags, and its scope.

const CALL_LOG = [
  { tool: "next_task", detail: "→ OPS-241 · Checkout retry" },
  { tool: "claim_task", detail: "ttl 60m" },
  { tool: "get_skill", detail: '"release-checklist"' },
  { tool: "add_comment", detail: "3 findings" },
  { tool: "update_checklist", detail: "4/4 done" },
  { tool: "request_approval", detail: "→ Dana" },
  { tool: "finish_run", detail: "ok · 2 artifacts" },
];

const POINTS = [
  {
    title: "Identity, not integration",
    body: "An agent is a principal with a name, a scope and a heartbeat — assignable from any task, mentionable in any thread.",
  },
  {
    title: "Its whole record, in one place",
    body: "Runs, artifacts, cost and every tool call it made, kept as an append-only trail you can read months later.",
  },
  {
    title: "Guardrails on the card itself",
    body: "Role, list restrictions, daily budget and approval gates live on the agent, so the limits travel with it.",
  },
];

export function AgentCard() {
  const ref = useGsap(({ root }) => {
    gsap.fromTo(
      root.querySelector("[data-glass]"),
      { autoAlpha: 0, y: 34, scale: 0.985 },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: DUR.slow,
        ease: EASE_OUT,
        scrollTrigger: { trigger: root, start: "top 75%" },
      },
    );
    gsap.fromTo(
      root.querySelectorAll("[data-call]"),
      { autoAlpha: 0, x: -8 },
      {
        autoAlpha: 1,
        x: 0,
        duration: DUR.fast,
        ease: EASE_OUT,
        stagger: 0.07,
        scrollTrigger: { trigger: root, start: "top 65%" },
      },
    );
    gsap.fromTo(
      root.querySelectorAll("[data-point]"),
      { autoAlpha: 0, y: 18 },
      {
        autoAlpha: 1,
        y: 0,
        duration: DUR.base,
        ease: EASE_OUT,
        stagger: 0.1,
        scrollTrigger: { trigger: root, start: "top 75%" },
      },
    );
  });

  return (
    <section
      ref={ref}
      className="relative overflow-hidden bg-background py-24 sm:py-28"
    >
      {/* The glass needs light behind it or the blur has nothing to do. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(65% 55% at 74% 32%, rgba(59,130,246,0.42), transparent 72%), radial-gradient(45% 45% at 18% 82%, rgba(6,182,212,0.3), transparent 72%), radial-gradient(38% 38% at 88% 78%, rgba(125,211,252,0.18), transparent 70%)",
        }}
      />

      <Container>
        <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-16">
          <div>
            <Eyebrow>Agents HQ</Eyebrow>
            <h2 className="mt-3 text-balance text-3xl font-semibold tracking-[-0.02em] text-foreground sm:text-4xl">
              Every agent carries <GradientText>its own card</GradientText>.
            </h2>
            <p className="mt-4 text-base leading-relaxed text-muted-foreground">
              Open one and you get the whole picture: what it&apos;s holding
              right now, the last calls it made, and the limits it works
              inside.
            </p>

            <dl className="mt-8 space-y-6">
              {POINTS.map((point) => (
                <div key={point.title} data-point>
                  <dt className="text-sm font-semibold text-foreground">
                    {point.title}
                  </dt>
                  <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {point.body}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div data-glass className="min-w-0">
            <GlassPanel className="w-full">
              <div className="flex flex-col p-5 pb-6 sm:p-6 sm:pb-7">
                <div className="mb-3 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="truncate text-2xl font-medium leading-tight tracking-tight text-white">
                      atlas-01
                    </h3>
                    <p className="mt-1 truncate text-sm font-light text-white/65">
                      Engineering workspace · Claude Code runtime
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-xs uppercase tracking-widest text-white/55">
                      Agent
                    </div>
                    <div className="mt-1 flex items-center justify-end gap-1.5">
                      <span
                        aria-hidden
                        className="h-2 w-2 animate-breathe rounded-full bg-emerald-400"
                        style={{
                          boxShadow: "0 0 6px rgba(16,185,129,0.45)",
                        }}
                      />
                      <span className="text-xs text-emerald-300">Working</span>
                    </div>
                  </div>
                </div>

                {/* The call log — what this agent actually did through MCP,
                    with a lifted shadow plate under it so the window reads as
                    a separate pane inside the glass. */}
                <div className="relative mb-4 w-full">
                  <div
                    aria-hidden
                    className="absolute inset-0 translate-y-2 scale-[0.98] rounded-lg bg-neutral-950/50 ring-1 ring-white/5"
                  />
                  <div className="relative overflow-hidden rounded-lg bg-[linear-gradient(180deg,rgba(19,24,31,0.92),rgba(10,13,18,0.94))] ring-1 ring-white/10">
                    <div className="flex items-center justify-between gap-2 border-b border-white/5 bg-neutral-950/50 px-3 py-2">
                      <div className="flex items-center gap-2" aria-hidden>
                        <span className="h-2 w-2 rounded-full bg-red-500/60" />
                        <span className="h-2 w-2 rounded-full bg-amber-500/60" />
                        <span className="h-2 w-2 rounded-full bg-emerald-500/60" />
                      </div>
                      <span className="truncate rounded-full border border-white/10 bg-neutral-900/60 px-2 py-1 text-[11px] text-white/60">
                        run 4f2c · 12m ago
                      </span>
                    </div>
                    <div className="grid grid-cols-[30px_1fr] text-[11px] leading-5">
                      <div
                        aria-hidden
                        className="select-none border-r border-white/5 bg-neutral-950/30 px-2 py-2 text-right text-white/25"
                      >
                        {CALL_LOG.map((_, i) => (
                          <div key={i}>{i + 1}</div>
                        ))}
                      </div>
                      <div className="px-3 py-2 font-mono">
                        {CALL_LOG.map((call) => (
                          <div
                            key={call.tool}
                            data-call
                            className="flex min-w-0 gap-2 whitespace-nowrap"
                          >
                            <span className="text-cyan-300">{call.tool}</span>
                            <span className="truncate text-white/45">
                              {call.detail}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mb-4 flex justify-between gap-1">
                  <GlassStat value="4/4" label="Checklist" />
                  <GlassDivider />
                  <GlassStat value="1" label="Task held" />
                  <GlassDivider />
                  <GlassStat value="7" label="Calls this run" />
                </div>

                <GlassRule className="mb-4" />

                <div className="mb-4 flex flex-wrap gap-2">
                  <GlassChip tone="blue">Member role</GlassChip>
                  <GlassChip tone="cyan">2 lists</GlassChip>
                  <GlassChip tone="emerald">Approval required</GlassChip>
                </div>

                <div
                  className="mb-4 overflow-hidden rounded px-2 py-1 font-mono text-[11px]"
                  style={{
                    background:
                      "linear-gradient(90deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.14) 50%, rgba(255,255,255,0.06) 100%)",
                  }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-white/70">
                      Budget 812 / 2000 today
                    </span>
                    <span className="shrink-0 text-white">MCP v1</span>
                  </div>
                </div>

                <div className="flex flex-wrap justify-between gap-4 text-white/70">
                  <div className="flex flex-col gap-1">
                    <span className="text-sm">Auto-claim on dispatch</span>
                    <span className="text-xs text-white/50">
                      Signed webhooks out
                    </span>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className="flex items-center gap-2 text-sm">
                      Human sign-off
                      <span
                        aria-hidden
                        className="h-2 w-2 rounded-full bg-blue-400"
                        style={{ boxShadow: "0 0 6px rgba(59,130,246,0.5)" }}
                      />
                    </span>
                    <span className="text-xs text-white/50">
                      Last approved by Dana
                    </span>
                  </div>
                </div>
              </div>
            </GlassPanel>
            <p className="mt-3 text-center text-xs text-muted-foreground">
              An agent&apos;s detail card in Agents HQ.
            </p>
          </div>
        </div>
      </Container>
    </section>
  );
}
