"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Container } from "@/components/marketing/ui";
import { GsapReveal } from "@/components/marketing/gsap";
import { cn } from "@/lib/utils";

// Stories — the fifth surface language: three full-bleed gradient columns
// under one clipped frame, dark ink on light colour, portrait masked into the
// panel. Nothing else on the site looks like this, which is the point: it
// breaks the run of dark cards right before the CTA.
//
// ── On the quotes ────────────────────────────────────────────────────────
// Attributed to a ROLE and a TEAM SHAPE, never to a named person, and the
// portrait well holds the team's roster instead of a face. That is deliberate:
// a named quote beside a stock photo of someone who never said it is a
// fabricated endorsement. The layout is ready for the real thing — add
// `person` and `photo` to an entry when a customer gives permission.

type Story = {
  org: string;
  orgNote?: string;
  role: string;
  teamShape: string;
  quote: string;
  href: string;
  /** Roster shown as orbs in the well, in display order. */
  roster: ("human" | "agent")[];
  /** Two lines of shape-of-work detail under the roster. */
  facts: { label: string; value: string }[];
  /** Agent orb tint for this column. */
  orb: string;
  /** Light gradient — needs to stay light enough for near-black ink. */
  gradient: string;
};

const STORIES: Story[] = [
  {
    org: "Engineering",
    orgNote: "pod",
    role: "Engineering lead",
    teamShape: "6 people, 4 agents",
    quote:
      "The agents pick up the work nobody wants to context-switch into — the flaky test, the changelog, the migration nobody scheduled. Every one of them still ends at a human approving the merge.",
    href: "/use-cases/engineering",
    roster: ["human", "human", "human", "agent", "agent", "agent", "agent"],
    facts: [
      { label: "Runs on", value: "Sprints + approval gates" },
      { label: "Agents scoped to", value: "2 lists each" },
    ],
    orb: "#1d4ed8",
    gradient: "from-[#bfe6ff] via-[#6cb0ff] to-[#2f6df0]",
  },
  {
    org: "Delivery",
    orgNote: "agency",
    role: "Operations lead",
    teamShape: "12 people, 9 agents",
    quote:
      "Client work lives or dies on consistency. Every engagement runs the same list template, the same statuses, the same approval gate — so the tenth project looks like the first one.",
    href: "/use-cases/agencies",
    roster: ["human", "human", "human", "human", "agent", "agent", "agent"],
    facts: [
      { label: "Runs on", value: "List templates per client" },
      { label: "Every handoff", value: "Logged and signed" },
    ],
    orb: "#0d9488",
    gradient: "from-[#c3f5ee] via-[#5fd6cd] to-[#0f8f9c]",
  },
  {
    org: "Solo",
    orgNote: "operator",
    role: "Founder",
    teamShape: "1 person, 3 agents",
    quote:
      "I did not want another dashboard. I wanted the backlog to move while I sleep, and to read exactly what happened when I wake up. That is the part that actually changed.",
    href: "/use-cases/solo",
    roster: ["human", "agent", "agent", "agent"],
    facts: [
      { label: "Runs on", value: "One personal space" },
      { label: "Wakes up to", value: "A finished checklist" },
    ],
    orb: "#4f46e5",
    gradient: "from-[#d5dcff] via-[#8f9cff] to-[#4f46e5]",
  },
];

// Fine grain over the flat gradients — the difference between "gradient" and
// "printed surface". Inline SVG turbulence, no asset.
const NOISE =
  "url('data:image/svg+xml,%3Csvg viewBox=%220 0 200 200%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22n%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.8%22 numOctaves=%223%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23n)%22/%3E%3C/svg%3E')";

// Notched frame — corners cut rather than rounded, so the block reads as a
// plate set into the page.
const NOTCH =
  "polygon(24px 0, 100% 0, 100% calc(100% - 24px), calc(100% - 24px) 100%, 0 100%, 0 24px)";

export function Stories() {
  return (
    // Lifted off the black canvas so <CalendarShowcase />'s pixel handoff
    // (data-st-03) has a real color to sample and dissolve into — the strip
    // it fills merges seamlessly into this band because they ARE this band.
    <section className="relative overflow-hidden bg-[#0d0d0d] py-24 sm:py-28">
      {/* Ruled backdrop, barely there. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.04]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(to right, #ffffff 0, #ffffff 1px, transparent 1px, transparent 48px)",
        }}
      />

      <Container>
        <GsapReveal className="mx-auto flex max-w-3xl flex-col items-center gap-5 text-center">
          {/* Plain text, so it can take the word-level reveal the gradient
              headings can't (SplitText would sever background-clip). */}
          <h2
            data-reveal-02="words"
            data-scroll
            className="text-4xl font-medium leading-[1.1] tracking-[-0.02em] text-foreground sm:text-5xl"
          >
            Built for the teams already working this way
          </h2>
          <p className="max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            Engineering pods, delivery agencies and one-person shops run the
            same primitives — a shared board, agents with scopes, and a human
            at the gate.
          </p>
        </GsapReveal>

        <GsapReveal
          className="group/frame relative mt-10 w-full overflow-hidden border border-white/[0.06]"
          style={{ clipPath: NOTCH }}
        >
          <div className="grid grid-cols-1 md:grid-cols-3">
            {STORIES.map((story, i) => (
              <article
                key={story.org}
                className={cn(
                  "group relative flex min-h-[560px] flex-col bg-gradient-to-b text-navy-950",
                  story.gradient,
                  i < STORIES.length - 1 &&
                    "border-b border-black/10 md:border-b-0 md:border-r",
                )}
              >
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 opacity-[0.07] mix-blend-overlay"
                  style={{ backgroundImage: NOISE }}
                />

                <header className="relative z-20 flex items-start justify-between gap-4 p-7 pb-0">
                  <p className="text-[1.1875rem] font-medium tracking-tight">
                    {story.org}
                    {story.orgNote ? (
                      <span className="ml-1 text-sm font-light">
                        {story.orgNote}
                      </span>
                    ) : null}
                  </p>
                  <div className="text-right">
                    <p className="text-compact font-medium">{story.role}</p>
                    <p className="mt-0.5 text-mini opacity-70">
                      {story.teamShape}
                    </p>
                  </div>
                </header>

                {/* The well. The reference puts a portrait here; we put the
                    team itself — the humans and agents on the roster as orbs.
                    It keeps the layout's rhythm without inventing a face, and
                    it says something the quote can't: the actual shape of the
                    team.

                    No stripe band behind it. That treatment exists in the
                    reference to cut a photographed figure into the panel;
                    with a card in the well it just streaked horizontally
                    across all three columns and read as a rendering bug. */}
                <div className="relative mt-2 flex h-[260px] w-full shrink-0 items-center justify-center overflow-hidden px-7">
                  <div className="relative z-10 w-full rounded-xl bg-black/[0.07] p-4 ring-1 ring-black/10 backdrop-blur-[2px]">
                    <p className="text-micro font-semibold uppercase tracking-widest opacity-55">
                      On this team
                    </p>
                    <div className="mt-3 flex items-center">
                      {story.roster.map((member, r) => (
                        <span
                          key={r}
                          aria-hidden
                          className={cn(
                            "size-7 rounded-full ring-2",
                            r > 0 && "-ml-2",
                            member === "agent"
                              ? "ring-white/50"
                              : "ring-black/15",
                          )}
                          style={{
                            zIndex: story.roster.length - r,
                            backgroundImage:
                              member === "agent"
                                ? `radial-gradient(circle at 32% 28%, #ffffff, ${story.orb} 70%)`
                                : "radial-gradient(circle at 32% 28%, rgba(0,0,0,0.45), rgba(0,0,0,0.75))",
                          }}
                        />
                      ))}
                      <span className="ml-3 text-xs opacity-70">
                        {story.teamShape}
                      </span>
                    </div>
                    <dl className="mt-4 space-y-2 text-xs">
                      {story.facts.map((fact) => (
                        <div
                          key={fact.label}
                          className="flex items-baseline justify-between gap-3 border-t border-black/10 pt-2 first:border-0 first:pt-0"
                        >
                          <dt className="opacity-60">{fact.label}</dt>
                          <dd className="text-right font-medium">
                            {fact.value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                </div>

                <div className="relative z-20 flex flex-1 flex-col p-7 pt-2">
                  <blockquote className="mb-8 text-lg font-normal leading-[1.32] tracking-tight text-navy-950 sm:text-xl">
                    &ldquo;{story.quote}&rdquo;
                  </blockquote>

                  <div className="mt-auto flex items-center justify-between gap-3">
                    <Link
                      href={story.href}
                      className="text-mini font-medium underline-offset-4 transition-opacity hover:opacity-60 hover:underline"
                    >
                      See how this team works
                    </Link>
                    <span
                      aria-hidden
                      className="grid size-8 place-items-center bg-black/10 transition-colors group-hover:bg-black/20"
                      style={{
                        clipPath:
                          "polygon(6px 0, calc(100% - 6px) 0, 100% 6px, 100% calc(100% - 6px), calc(100% - 6px) 100%, 6px 100%, 0 calc(100% - 6px), 0 6px)",
                      }}
                    >
                      <ArrowRight className="size-3.5" />
                    </span>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </GsapReveal>
      </Container>
    </section>
  );
}
