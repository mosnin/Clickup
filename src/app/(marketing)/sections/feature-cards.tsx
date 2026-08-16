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

// Feature card grid — the instrument bento, rebuilt in the founder's
// reference language (m1ckc3s/nullframe: the Nothing design aesthetic).
// Every card is an instrument reading off the fleet rather than a
// description of a feature: uppercase mono meta-rows, hover-revealed tags,
// dot-matrix numerals, a pulsing LED, segmented bars, a contribution grid
// and an append-only feed row — the industrial panel a design engineer
// would run a fleet from.
//
// The five features it replaces are still all here, wearing gauges:
// the agent console is the hero (mission control), the automation engine
// is the runs counter, the approval gate is the red-LED queue, and the
// custom-field editor / template library slots became the two claims this
// page actually leads with — budget ceilings (x402) and the hosted MCP —
// plus the shipped-grid and event feed, which are the observability story.
//
// Styles live in globals.css under `nf-` (values ported from the
// reference, namespaced because the app already owns `.card`). Numerals
// are Doto, vendored + subset to 3.4KB. Reduced motion: the CSS block
// zeroes every loop and useGsap leaves the cards in final state.

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

/**
 * One instrument. The reference's card shell: meta-row header (label left,
 * optional right info, tag that appears on hover), a one-shot shimmer sweep
 * on first hover, and whatever the instrument reads below.
 */
function Card({
  label,
  right,
  tag,
  tagAlways = false,
  className,
  children,
}: {
  label: React.ReactNode;
  right?: React.ReactNode;
  tag?: string;
  tagAlways?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [shining, setShining] = useState(false);

  return (
    <div
      data-card
      className={cn("nf-card", className)}
      onMouseEnter={() => {
        if (!prefersReducedMotion() && !shining) setShining(true);
      }}
    >
      <span
        aria-hidden
        className={cn("nf-shine", shining && "play")}
        onAnimationEnd={() => setShining(false)}
      />
      <div className="nf-meta">
        <span>{label}</span>
        {right}
        {tag && <span className={cn("nf-tag", tagAlways && "always")}>{tag}</span>}
      </div>
      {children}
    </div>
  );
}

/** A segmented bar with `on` of `total` lit, staggered in like the reference. */
function Segbar({
  on,
  total = 14,
  tone,
}: {
  on: number;
  total?: number;
  tone?: "green" | "orange";
}) {
  return (
    <div className={cn("nf-segbar", tone)} aria-hidden>
      {Array.from({ length: total }, (_, i) => (
        <i
          key={i}
          className={i < on ? "on" : undefined}
          style={{ animationDelay: `${i * 0.03}s` }}
        />
      ))}
    </div>
  );
}

// ── Hero: mission control (the agent console) ────────────────────────────

function MissionControlCard() {
  return (
    <Card
      label={
        <span className="inline-flex items-center gap-2">
          <span className="nf-led" /> Fleet — mission control
        </span>
      }
      tag="LIVE"
      tagAlways
      className="nf-hero"
    >
      {/* The pair is its own baseline-aligned row, CENTERED by the outer
          flex — putting self-end on the sub inside the stretched outer row
          sent "+3" to the bottom of a 400px card, detached from its figure. */}
      <div className="flex flex-1 items-center justify-center">
        <div className="flex items-end gap-4">
          <span className="nf-doto">08</span>
          <span className="nf-doto-sub pb-3">+3</span>
        </div>
      </div>
      <div className="nf-hero-foot">
        <div>
          <p className="nf-day">Agents on shift</p>
          <p className="nf-mono-sub">Sprint 14 · day 3 · plus three humans</p>
        </div>
        <p className="nf-mono-sub nf-status text-right">
          <Typewriter text="scout → claiming OPS-114 · release the sprint" />
        </p>
      </div>
    </Card>
  );
}

// ── Runs (the automation engine) ─────────────────────────────────────────

function RunsCard() {
  return (
    <Card label="Runs — today" tag="24H">
      <p className="nf-metric">
        142<small>DONE</small>
      </p>
      <p className="nf-mono-sub">
        Claim → build → hand back.
        <br />
        Every step on the record.
      </p>
      <Segbar on={9} tone="green" />
    </Card>
  );
}

// ── Spend ceiling (x402 budgets) ─────────────────────────────────────────

function SpendCard() {
  // r=46 → circumference 2πr ≈ 289. 41% spent.
  const C = 289;
  const pct = 41;
  return (
    <Card label="Spend — ceiling" tag="CAP">
      <div className="nf-ring-wrap">
        <svg viewBox="0 0 110 110" aria-hidden>
          <circle className="nf-ring-bg" cx="55" cy="55" r="46" />
          <circle
            className="nf-ring-fg"
            cx="55"
            cy="55"
            r="46"
            strokeDasharray={C}
            strokeDashoffset={C - (C * pct) / 100}
          />
        </svg>
        <span className="nf-ring-val">
          {pct}
          <small>%</small>
        </span>
      </div>
      <p className="nf-mono-sub text-center">Stops at 100</p>
    </Card>
  );
}

// ── Approvals (the human gate) ───────────────────────────────────────────

function ApprovalsCard() {
  return (
    <Card
      label={
        <span className="inline-flex items-center gap-2">
          <span className="nf-led red" /> Approvals
        </span>
      }
      tag="GATED"
      tagAlways
    >
      <p className="nf-doto-val">03</p>
      <p className="nf-mono-sub">
        Waiting on you.
        <br />
        One click to land it.
      </p>
    </Card>
  );
}

// ── Hosted MCP ───────────────────────────────────────────────────────────

function McpCard() {
  return (
    <Card label="MCP — hosted" tag="1 URL">
      <p className="nf-metric">
        184<small>TOOLS</small>
      </p>
      <p className="nf-mono-sub">
        One endpoint · any runtime.
        <br />
        Claude, GPT, or your own.
      </p>
      <Segbar on={12} />
    </Card>
  );
}

// ── Shipped grid (12 weeks of completed work) ────────────────────────────

// Seeded, not random: a render must equal its hydration or React warns.
const CELLS = Array.from({ length: 7 * 12 }, (_, i) => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  const v = x - Math.floor(x);
  return v < 0.28 ? 0 : v < 0.5 ? 1 : v < 0.72 ? 2 : v < 0.9 ? 3 : 4;
});

function ShippedCard() {
  return (
    <Card label="Shipped — last 12 weeks" tag="SIM" className="nf-wide">
      <div
        className="nf-contrib-grid"
        // 10px cells: 7 rows at 14px measured 116px tall and overflowed the
        // 185px card straight over its own label and caption.
        style={{
          gridTemplateColumns: "repeat(12, 10px)",
          gridTemplateRows: "repeat(7, 10px)",
          gridAutoFlow: "column",
        }}
        aria-hidden
      >
        {CELLS.map((level, i) => (
          <i
            key={i}
            className={level > 0 ? `l${level}` : undefined}
            style={{ animationDelay: `${(i % 12) * 0.04}s` }}
          />
        ))}
      </div>
      <p className="nf-mono-sub">
        Tasks, not tokens <span className="nf-dim">· agents and humans on one graph</span>
      </p>
    </Card>
  );
}

// ── Event feed (the append-only log) ─────────────────────────────────────

const EVENTS = [
  { text: "scout finished billing-migration — awaiting go-ahead", when: "4M" },
  { text: "ada approved deploy-runbook", when: "12M" },
  { text: "budget notice · fleet at 80% of daily ceiling", when: "1H" },
  { text: "triage claimed OPS-114", when: "2H" },
];

function FeedCard() {
  return (
    <Card label="Events — append-only" tag="LOG" className="nf-wide">
      <div className="nf-feed-rows">
        {EVENTS.map((event) => (
          <div key={event.text} className="nf-feed-row">
            <span className="truncate">{event.text}</span>
            <span className="nf-dim">{event.when}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function FeatureCards() {
  const ref = useGsap(({ root }) => {
    gsap.fromTo(
      root.querySelectorAll("[data-card]"),
      { autoAlpha: 0, y: 22, scale: 0.93 },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: DUR.base,
        ease: EASE_OUT,
        stagger: 0.07,
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

        <div ref={ref} className="nf-bento mx-auto mt-12 max-w-[1120px]">
          <MissionControlCard />
          <RunsCard />
          <SpendCard />
          <ApprovalsCard />
          <McpCard />
          <ShippedCard />
          <FeedCard />
        </div>
      </Container>
    </section>
  );
}
