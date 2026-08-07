"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { Container, Eyebrow } from "@/components/marketing/ui";
import {
  DUR,
  EASE_OUT,
  prefersReducedMotion,
  useGsap,
} from "@/components/marketing/gsap";
import GradientText from "@/components/gradient-text";
import { cn } from "@/lib/utils";

// Feature card grid — five live product surfaces rather than a description of
// them: the agent console, the automation engine, the custom-field editor,
// the approval gate and the template library, each rendered as the real chrome
// it wears in the app.
//
// Motion has two layers:
//   • Entrance — every [data-card] rises in on scroll (GSAP, staggered), and
//     the console types itself out the first time it lands in view.
//   • Ambient — the CSS loops in globals.css (shimmer / breathe / glowPulse /
//     floatSlow / caret / typing-dots) keep the cards alive afterwards.
// Both respect prefers-reduced-motion; the CSS block disables its loops and
// useGsap never runs the callback, leaving every card in its final state.

const ACCENT = "linear-gradient(45deg,#06b6d4,#3b82f6,#2563eb)";

/** Types `text` out one character at a time, once, when it scrolls into view. */
function Typewriter({
  text,
  speed = 26,
  className,
  caret = true,
}: {
  text: string;
  speed?: number;
  className?: string;
  caret?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(() => text.length);

  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    setShown(0);
    let timer: ReturnType<typeof setInterval> | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        let i = 0;
        timer = setInterval(() => {
          i += 1;
          setShown(i);
          if (i >= text.length && timer) clearInterval(timer);
        }, speed);
      },
      { threshold: 0.4 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (timer) clearInterval(timer);
    };
  }, [text, speed]);

  return (
    <span
      ref={ref}
      className={cn(className, caret && shown < text.length && "caret")}
    >
      {/* The full string stays in the accessibility tree so the typing effect
          is purely visual — screen readers never see a half-written word. */}
      <span aria-hidden>{text.slice(0, shown)}</span>
      <span className="sr-only">{text}</span>
    </span>
  );
}

/** A meter that animates from 0 to `value`% the first time it's seen. */
function Meter({ value, className }: { value: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => value);

  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    setWidth(0);
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        requestAnimationFrame(() => setWidth(value));
      },
      { threshold: 0.6 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [value]);

  return (
    <div
      ref={ref}
      className={cn(
        "h-1 w-14 overflow-hidden rounded-full bg-white/10",
        className,
      )}
    >
      <div
        className="meter-fill h-full rounded-full"
        style={{ width: `${width}%`, backgroundImage: ACCENT }}
      />
    </div>
  );
}

/** Agent identity mark — the app's orb, not a stock photo. */
function Orb({
  hue,
  className,
  delay,
}: {
  hue: number;
  className?: string;
  delay?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block shrink-0 rounded-full ring-1 ring-white/15 animate-floatSlow",
        className,
      )}
      style={{
        animationDelay: delay,
        backgroundImage: `radial-gradient(circle at 32% 28%, hsl(${hue} 92% 72%), hsl(${hue + 22} 78% 44%) 62%, hsl(${hue + 40} 70% 26%))`,
      }}
    />
  );
}

export function FeatureCards() {
  const ref = useGsap(({ root }) => {
    gsap.fromTo(
      root.querySelectorAll("[data-card]"),
      { autoAlpha: 0, y: 26 },
      {
        autoAlpha: 1,
        y: 0,
        duration: DUR.base,
        ease: EASE_OUT,
        stagger: 0.09,
        scrollTrigger: { trigger: root, start: "top 78%" },
      },
    );
  });

  return (
    <section className="bg-background py-24 sm:py-28">
      <Container>
        <div className="max-w-2xl">
          <Eyebrow>The workbench</Eyebrow>
          <h2 className="mt-3 text-balance text-3xl font-semibold tracking-[-0.02em] text-foreground sm:text-4xl">
            Everything an agent touches is{" "}
            <GradientText>a surface you can see</GradientText>.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted-foreground">
            Direct work in plain language, watch it execute through MCP, and
            keep the parts that matter behind a human&apos;s sign-off.
          </p>
        </div>

        <div
          ref={ref}
          className="mx-auto mt-12 grid w-full grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3"
        >
          <AgentConsoleCard />
          <AutomationCard />
          <FieldsCard />
          <ApprovalCard />
          <TemplatesCard />
        </div>
      </Container>
    </section>
  );
}

/** Shared card shell: lifted charcoal, hairline ring, inner sheen + glow. */
function Card({
  className,
  glow,
  children,
}: {
  className?: string;
  /** Outer bloom radius/opacity — the big card carries a stronger one. */
  glow: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-card
      className={cn(
        "relative overflow-hidden rounded-2xl bg-neutral-900/60 ring-1 ring-white/10 backdrop-blur transition-transform duration-300 hover:-translate-y-1.5",
        className,
      )}
    >
      <div
        aria-hidden
        className="shimmer pointer-events-none absolute inset-0 rounded-2xl"
        style={{ boxShadow: glow }}
      />
      {children}
    </div>
  );
}

function CardHead({
  title,
  body,
  chip,
}: {
  title: string;
  body: string;
  chip?: React.ReactNode;
}) {
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">
          {title}
        </h3>
        {chip}
      </div>
      <p className="mt-1 text-sm text-neutral-400">{body}</p>
    </>
  );
}

// ── 1. Agent console (spans two columns) ─────────────────────────────────

function AgentConsoleCard() {
  return (
    <Card
      className="lg:col-span-2"
      glow="inset 0 0 0 1px rgba(255,255,255,0.06), 0 40px 120px rgba(37,99,235,0.18)"
    >
      <div className="p-5 sm:p-6">
        <CardHead
          title="Agent console"
          body="Brief an agent the way you'd brief a teammate. It executes through MCP."
        />

        <div className="relative mt-4 overflow-hidden rounded-2xl bg-zinc-950/80 ring-1 ring-white/10">
          {/* header */}
          <div className="flex items-center justify-between border-b border-white/5 px-4 py-2.5">
            <span className="inline-flex items-center gap-2 rounded-full bg-blue-900/30 px-3 py-0.5 text-tiny text-blue-200 ring-1 ring-blue-700">
              <span className="h-1.5 w-1.5 animate-breathe rounded-full bg-blue-400" />
              Working
              <span className="typing-dots" aria-hidden>
                <i />
                <i />
                <i />
              </span>
            </span>
            <span className="text-tiny text-neutral-400">
              atlas-01 · operate MCP
            </span>
          </div>

          {/* messages */}
          <div className="max-h-52 space-y-2 overflow-auto px-4 py-3">
            <div className="flex items-start gap-2">
              <Orb hue={205} className="h-6 w-6" />
              <div className="max-w-[80%] rounded-xl bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 ring-1 ring-white/10">
                Connected. 112 tools available on this workspace.
              </div>
            </div>

            <div className="flex justify-end">
              <div
                className="max-w-[80%] animate-glowPulse rounded-xl px-3 py-1.5 text-xs text-white ring-1 ring-blue-400"
                style={{ backgroundImage: ACCENT }}
              >
                Take the checkout retry fix — approval before it ships.
              </div>
            </div>

            <div className="flex items-start gap-2">
              <Orb hue={205} className="h-6 w-6" delay=".1s" />
              <div className="max-w-[80%] overflow-hidden rounded-xl bg-neutral-900 ring-1 ring-white/10">
                <div className="border-b border-white/5 px-3 py-1.5 text-tiny text-neutral-400">
                  Tool call · claim_task
                </div>
                <pre className="whitespace-pre-wrap px-3 py-2 font-mono text-tiny leading-5 text-neutral-300">
                  <Typewriter text={'claim_task({ task: "OPS-241", ttl: "60m" })'} />
                </pre>
                <div className="flex items-center gap-2 border-t border-white/5 px-3 py-1.5 text-tiny">
                  <span className="h-1.5 w-1.5 animate-breathe rounded-full bg-cyan-300" />
                  <span className="text-neutral-400">
                    Claimed · approval gate raised
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* composer */}
          <div className="flex items-center gap-2 border-t border-white/5 px-4 py-2.5">
            <div className="flex flex-1 items-center gap-2 rounded-full bg-neutral-900 px-3 py-1.5 text-xs text-neutral-400 ring-1 ring-white/10">
              <svg
                aria-hidden
                className="w-3.5 animate-tilt"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span className="flex-1 truncate text-neutral-500">
                Message your agent…
              </span>
            </div>
            <span
              className="animate-glowPulse rounded-full px-3 py-1.5 text-xs text-white ring-1 ring-blue-400"
              style={{ backgroundImage: ACCENT }}
            >
              Dispatch
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ── 2. Automations ───────────────────────────────────────────────────────

function AutomationCard() {
  return (
    <Card glow="inset 0 0 0 1px rgba(255,255,255,0.05), 0 24px 70px rgba(37,99,235,0.12)">
      <div className="p-4 sm:p-5">
        <CardHead
          title="Automations"
          body="Rules that fire inside the same transaction as the change."
          chip={
            <span className="inline-flex shrink-0 animate-breathe items-center rounded-full bg-blue-500/10 px-2 py-0.5 text-tiny text-blue-200 ring-1 ring-blue-500/40">
              3 actions
            </span>
          }
        />

        <div className="mt-4 overflow-hidden rounded-xl bg-zinc-950/80 ring-1 ring-white/10">
          <div className="flex items-center gap-1.5 bg-neutral-900/70 px-3 py-2">
            <span className="h-2 w-2 animate-breathe rounded-full bg-rose-500/80" />
            <span
              className="h-2 w-2 animate-breathe rounded-full bg-amber-400/80"
              style={{ animationDelay: ".1s" }}
            />
            <span
              className="h-2 w-2 animate-breathe rounded-full bg-emerald-500/80"
              style={{ animationDelay: ".2s" }}
            />
            <span className="caret ml-3 text-tiny text-neutral-400">
              on task created
            </span>
          </div>
          <div className="p-3 font-mono text-tiny leading-5">
            <pre className="whitespace-pre-wrap">
              <span className="text-neutral-500">01</span>{" "}
              <span className="text-neutral-400">{"// before"}</span>
              {"\n"}
              <span className="text-neutral-500">02</span>{" "}
              <span className="rounded bg-rose-500/10 px-1 text-rose-300">
                - unassigned, no due date
              </span>
              {"\n"}
              <span className="text-neutral-500">03</span>{" "}
              <span className="text-neutral-400">{"// after"}</span>
              {"\n"}
              <span className="text-neutral-500">04</span>{" "}
              <span className="rounded bg-emerald-500/10 px-1 text-emerald-300">
                + assign → atlas-01
              </span>
              {"\n"}
              <span className="text-neutral-500">05</span>{" "}
              <span className="rounded bg-emerald-500/10 px-1 text-emerald-300">
                + due → in 3 days
              </span>
            </pre>
          </div>
          <div className="flex items-center justify-between border-t border-white/5 px-3 py-2 text-tiny">
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
              <span className="text-neutral-400">Live on this list</span>
            </div>
            <Meter value={72} />
          </div>
        </div>
      </div>
    </Card>
  );
}

// ── 3. Custom fields ─────────────────────────────────────────────────────

const FIELD_TYPES = [
  { label: "Money", active: true },
  { label: "Rating", active: false },
  { label: "Formula", active: false },
];

function FieldsCard() {
  return (
    <Card glow="inset 0 0 0 1px rgba(255,255,255,0.05), 0 30px 80px rgba(37,99,235,0.10)">
      <div className="p-4 sm:p-5">
        <CardHead
          title="Custom fields"
          body="Twenty field types, validated once and shared with the agent API."
        />

        <div className="mt-4 rounded-xl bg-zinc-950/80 p-3 ring-1 ring-white/10">
          <p className="mb-2 text-tiny uppercase tracking-wide text-blue-200">
            Field type
          </p>
          <div className="grid grid-cols-[1fr_auto] items-center gap-3">
            <div className="space-y-2">
              {FIELD_TYPES.map((type) => (
                <div
                  key={type.label}
                  className={cn(
                    "flex items-center gap-2",
                    !type.active && "opacity-70",
                  )}
                >
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full",
                      type.active
                        ? "animate-breathe bg-blue-400"
                        : "bg-white/20",
                    )}
                  />
                  <span
                    className={cn(
                      "text-sm",
                      type.active ? "text-white" : "text-neutral-300",
                    )}
                  >
                    {type.label}
                  </span>
                </div>
              ))}
            </div>
            <div className="relative h-20 w-8 overflow-hidden rounded-lg bg-white/5 ring-1 ring-white/10">
              <div className="absolute left-1/2 top-1.5 h-[90%] w-1 -translate-x-1/2 rounded-full bg-white/10" />
              <div className="absolute bottom-3 left-1/2 h-4 w-4 -translate-x-1/2 animate-floatSlow rounded-full bg-blue-400 ring-1 ring-blue-300" />
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-white/5 px-2 py-1 text-tiny text-neutral-300 ring-1 ring-white/10">
              Rollup
            </span>
            <span className="rounded-full bg-white/5 px-2 py-1 text-tiny text-neutral-300 ring-1 ring-white/10">
              Formula
            </span>
            <span className="animate-breathe rounded-full bg-blue-500/10 px-2 py-1 text-tiny text-blue-200 ring-1 ring-blue-400/50">
              Currency: USD
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ── 4. Approvals ─────────────────────────────────────────────────────────

function ApprovalCard() {
  return (
    <Card glow="inset 0 0 0 1px rgba(255,255,255,0.05), 0 30px 80px rgba(37,99,235,0.10)">
      <div className="p-4 sm:p-5">
        <CardHead
          title="Approval gates"
          body="Agents can raise a gate. Only a human can lower it."
        />

        <div className="mt-4 rounded-xl bg-zinc-950/80 p-3 ring-1 ring-white/10">
          <div className="flex items-center gap-2">
            <Orb hue={205} className="h-6 w-6" />
            <Orb hue={158} className="-ml-2 h-6 w-6" delay=".1s" />
            <span className="ml-1 truncate text-xs text-neutral-400">
              atlas-01 · scout-02
            </span>
            <span className="ml-auto shrink-0 animate-breathe rounded-full bg-emerald-500/10 px-2 py-0.5 text-tiny text-emerald-300 ring-1 ring-emerald-500/40">
              2 waiting
            </span>
          </div>

          <div className="mt-3 rounded-lg bg-neutral-900 p-3 text-sm text-neutral-200 ring-1 ring-white/10">
            Checklist is 4/4 and blockers cleared — requesting sign-off on{" "}
            <span className="text-blue-300">OPS-241</span>.
          </div>

          <div className="mt-3 flex items-center gap-2">
            <span className="flex-1 rounded-full bg-white/5 px-3 py-1.5 text-center text-xs text-neutral-200 ring-1 ring-white/10">
              Send back
            </span>
            <span
              className="flex-1 animate-glowPulse rounded-full px-3 py-1.5 text-center text-xs text-white ring-1 ring-blue-400"
              style={{ backgroundImage: ACCENT }}
            >
              Approve
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ── 5. Template library ──────────────────────────────────────────────────

const TEMPLATES = [
  { name: "Two-week sprint", meta: "Statuses · fields · ceremonies", cta: "Add" },
  { name: "Product launch", meta: "Docs · milestones · roadmap", cta: "Use" },
];

function TemplatesCard() {
  return (
    <Card glow="inset 0 0 0 1px rgba(255,255,255,0.05), 0 30px 80px rgba(37,99,235,0.10)">
      <div className="p-4 sm:p-5">
        <CardHead
          title="Template library"
          body="Spin up a whole space — lists, statuses, fields, sample work."
        />

        <div className="mt-4 space-y-2">
          {TEMPLATES.map((template, i) => (
            <div
              key={template.name}
              className="flex items-center gap-3 rounded-xl bg-zinc-950/80 p-3 ring-1 ring-white/10"
            >
              <div
                aria-hidden
                className="h-10 w-10 shrink-0 animate-floatSlow rounded-lg bg-gradient-to-br from-blue-500/25 to-cyan-400/10 ring-1 ring-white/10"
                style={{ animationDelay: `${i * 0.08}s` }}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-neutral-200">
                  {template.name}
                </p>
                <p className="truncate text-tiny text-neutral-500">
                  {template.meta}
                </p>
              </div>
              <span className="shrink-0 animate-breathe rounded-full bg-blue-900/30 px-2 py-0.5 text-tiny text-blue-200 ring-1 ring-blue-700">
                {template.cta}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
