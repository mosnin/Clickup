"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "./use-ai-lights";

const STAGGER_MS = 20;
const CHAR_MS = 300;

export function RisingText({
  text,
  className = "",
  delay = 0,
}: {
  text: string;
  className?: string;
  delay?: number;
}) {
  const { reduced } = useReducedMotion();
  return (

    <span className={`block leading-none whitespace-nowrap ${className}`}>
      {Array.from(text).map((ch, i) => (
        <span
          key={i}
          className={
            reduced
              ? "inline-block align-middle animate-[ai-char-fade_var(--d)_ease_both]"
              : "inline-block align-middle animate-[ai-char_var(--d)_cubic-bezier(0.66,0,0.34,1)_both]"
          }
          style={
            {
              "--d": `${CHAR_MS}ms`,
              animationDelay: reduced ? `${delay}ms` : `${delay + i * STAGGER_MS}ms`,

              width: ch === " " ? "0.28em" : undefined,
            } as React.CSSProperties
          }
        >
          {ch === " " ? " " : ch}
        </span>
      ))}
    </span>
  );
}

export interface Variant {
  key: string;

  radius: number | "pill";

  pad: string;
  Content: () => React.ReactElement;
}

const BOX = "px-5 py-3.5";
const BOX_CONTROL = "py-2.5 pr-2.5 pl-5";

function Trail({
  children,
  delay = 140,
}: {
  children: React.ReactNode;
  delay?: number;
}) {
  return (
    <span
      className="shrink-0 animate-[ai-char-fade_300ms_ease_both] text-[13px] leading-none tabular-nums text-[var(--s-text-subtle)]"
      style={{ animationDelay: `${delay}ms` }}
    >
      {children}
    </span>
  );
}

/** One row: body left, trail right, centred against each other. */
function Row({
  children,
  trail,
}: {
  children: React.ReactNode;
  trail?: React.ReactNode;
}) {
  return (
    <span className="flex items-center gap-2">
      <span className="min-w-0 flex-1">{children}</span>
      {trail}
    </span>
  );
}

/* -- 1. Workflow chain ----------------------------------------------------
   Three steps, the middle one running.

   Two earlier attempts failed in opposite directions. The first was a header,
   a divider, a label/value row and a tinted `ready` badge — the shape of every
   dashboard card ever drawn. Stripping all that left a name over a subtitle,
   which is not minimal so much as EMPTY: nothing was being said that the other
   three variants were not already saying better.

   The idea here is the one thing a workflow node genuinely has and no other
   variant does: SEQUENCE. Three dots joined by a hairline, the passed ones
   filled, the live one ringed and pulsing, the pending one hollow. The labels
   sit under the track so the eye reads the shape first and the words second.
   It is still two type sizes and one ink ramp — the interest comes from the
   structure, not from adding colour back. */

/** One node on the track. `state` drives the fill; nothing else differs. */
function Step({
  label,
  state,
  delay,
}: {
  label: string;
  state: "done" | "live" | "next";
  delay: number;
}) {
  return (
    <span className="flex flex-1 flex-col items-center gap-2">
      <span
        className="relative grid size-3.5 shrink-0 animate-[ai-char-fade_300ms_ease_both] place-items-center"
        style={{ animationDelay: `${delay}ms` }}
      >
        {/* Three states, three weights of the same ink — no accent colour, and
            no two states relying on the same fill. `done` is muted because it is
            finished and no longer needs attention; `live` is full-strength;
            `next` is an outline, present but not yet real. */}
        <span
          className={
            state === "done"
              ? "size-3 rounded-[4px] bg-[var(--s-text-subtle)]"
              : state === "live"
                ? "size-3 rounded-[4px] bg-[var(--s-text-primary)]"
                : "size-3 rounded-[4px] border border-[var(--s-border-1)] bg-[var(--s-surface-2)]"
          }
        />
        {}
        {state === "live" ? (
          <span className="absolute inset-[-3px] animate-[ai-ring_1.8s_ease-out_infinite] rounded-[6px] border border-[var(--s-text-primary)]" />
        ) : null}
      </span>
      {}
      <span
        className="animate-[ai-char-fade_300ms_ease_both] text-[14px] leading-none"
        style={{
          animationDelay: `${delay + 60}ms`,
          color:
            state === "next"
              ? "var(--s-text-subtle)"
              : "var(--s-text-body)",
        }}
      >
        {label}
      </span>
    </span>
  );
}

function BlockContent() {
  const steps: { label: string; state: "done" | "live" | "next" }[] = [
    { label: "Fetch", state: "done" },
    { label: "Parse", state: "live" },
    { label: "Write", state: "next" },
  ];
  return (
    <span className="block w-[268px]">
      <span className="relative flex items-start">
        {}
        {}
        <span
          className="absolute top-[7px] right-[16.667%] left-[16.667%] h-px animate-[ai-char-fade_300ms_ease_both] bg-[var(--s-border-1)]"
          style={{ animationDelay: "60ms" }}
        />
        {steps.map((st, i) => (
          <Step key={st.label} {...st} delay={100 + i * 70} />
        ))}
      </span>
    </span>
  );
}

function ProgressContent() {
  return (
    <span className="block w-[246px]">
      <Row
        trail={
          <span className="flex items-center gap-1.5">
            <Trail delay={120}>45%</Trail>
            <svg
              viewBox="0 0 16 16"
              className="size-3.5 shrink-0"
              aria-hidden="true"
            >
              <circle
                cx="8"
                cy="8"
                r="6"
                className="fill-none stroke-[var(--s-border-1)]"
                strokeWidth="2"
              />
              <path
                d="M8 2A6 6 0 0 1 14 8"
                className="animate-[ai-spin_900ms_linear_infinite] fill-none stroke-[var(--s-text-body)]"
                strokeWidth="2"
                strokeLinecap="round"
                style={{ transformOrigin: "8px 8px" }}
              />
            </svg>
          </span>
        }
      >
        <RisingText
          text="Indexing"
          className="text-[16px] leading-none text-[var(--s-text-body)]"
        />
      </Row>
    </span>
  );
}

/* -- 3. Terminal ----------------------------------------------------------
   The only variant that INVERTS, and the biggest jump in the rotation: a change
   of polarity lands harder than any change of proportion.

   The `$` stays — in a terminal it is not decoration, it is what tells you the
   line is a command rather than output. */

function TerminalContent() {
  return (
    <span className="block w-[242px] space-y-2 font-mono">
      <span className="block text-[14px] leading-none text-[#8c8c8c]">
        <span className="text-[#5f5f5f]">$</span> deploy
      </span>
      <RisingText
        text="published"
        className="block text-[14px] leading-none text-[#d6d6d6]"
        delay={60}
      />
    </span>
  );
}

/* -- 4. Prompt bar --------------------------------------------------------
   Intent in, action out. The send button sits in the trail slot, and the box
   uses the trimmed padding so the button's own bulk does not read as a wider
   right margin than the text has on the left. */

function WandContent() {
  return (
    <span className="block w-[282px]">
      <Row
        trail={
          <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-[var(--s-text-primary)]">
            <svg
              viewBox="0 0 12 12"
              className="size-4 fill-none stroke-[var(--s-text-inverse)]"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 9.5V2.5M6 2.5 3 5.5M6 2.5 9 5.5" />
            </svg>
          </span>
        }
      >
        <RisingText
          text="build me a scraper"
          className="text-[16px] leading-none text-[var(--s-text-muted)]"
        />
      </Row>
    </span>
  );
}

/** The rotation. Ordered so the body never makes the same kind of move twice
 *  running: a tall node, a short row, the dark panel, then a bar. */
export const VARIANTS: Variant[] = [
  { key: "block", radius: 16, pad: BOX, Content: BlockContent },
  { key: "progress", radius: 15, pad: BOX, Content: ProgressContent },
  { key: "terminal", radius: 16, pad: BOX, Content: TerminalContent },
  { key: "wand", radius: 18, pad: BOX_CONTROL, Content: WandContent },
];

/** Variants whose face INVERTS — a dark panel on a light page. The body reads
 *  this to pick its face colour, so the terminal is the one shape that flips. */
export const DARK_KEYS = new Set(["terminal"]);

/** Resolve a variant's radius against the box it will occupy. */
export function radiusFor(v: Variant, height: number): number {
  return v.radius === "pill" ? height / 2 : v.radius;
}

export function useVariantSizes(): {
  sizes: { w: number; h: number }[] | null;
  probe: React.ReactElement;
} {
  const ref = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<{ w: number; h: number }[] | null>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const measure = () => {
      const boxes = Array.from(
        host.querySelectorAll<HTMLElement>("[data-probe]"),
      ).map((el) => {
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      });
      if (boxes.length === VARIANTS.length && boxes.every((b) => b.w && b.h)) {
        setSizes(boxes);
      }
    };
    measure();

    document.fonts?.ready.then(measure).catch(() => {});
  }, []);

  const probe = (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none invisible absolute top-0 left-0 -z-10"
    >
      {}
      {VARIANTS.map((v) => (
        <div key={v.key} data-probe className={`inline-block ${v.pad}`}>
          <v.Content />
        </div>
      ))}
    </div>
  );

  return { sizes, probe };
}
