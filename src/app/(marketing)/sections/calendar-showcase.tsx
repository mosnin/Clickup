"use client";

import gsap from "gsap";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { Container, Eyebrow } from "@/components/marketing/ui";
import { DUR, EASE_OUT, useGsap } from "@/components/marketing/gsap";
import GradientText from "@/components/gradient-text";
import { cn } from "@/lib/utils";

// Calendar view — the third card language on the site: neither a bento tile
// nor a glass panel but a full application window, chrome and all, because
// the point of this section is "here is the actual week view".
//
// Mobile containment is deliberate: the grid keeps its real column widths and
// scrolls inside its own overflow-x-auto rail, so a 360px screen pans the
// calendar rather than widening the page (see the html/body overflow-x: clip
// backstop in globals.css).

const DAYS = [
  { name: "Mon", date: "14" },
  { name: "Tue", date: "15" },
  { name: "Wed", date: "16", today: true },
  { name: "Thu", date: "17" },
  { name: "Fri", date: "18" },
];

const HOURS = ["9", "10", "11", "12", "1", "2", "3", "4"];

type Event = {
  day: number;
  /** Row start / span in the hour grid. */
  start: number;
  span: number;
  title: string;
  meta: string;
  tone: "blue" | "cyan" | "teal" | "slate";
};

const EVENTS: Event[] = [
  { day: 0, start: 0, span: 1, title: "Sprint 14 planning", meta: "9:00 · whole team", tone: "blue" },
  { day: 0, start: 2, span: 2, title: "Checkout retry fix", meta: "due · atlas-01", tone: "cyan" },
  { day: 1, start: 1, span: 2, title: "Billing webhook migration", meta: "due · Dana", tone: "teal" },
  { day: 1, start: 4, span: 1, title: "Agent review", meta: "2:00 · 30m", tone: "slate" },
  { day: 2, start: 0, span: 2, title: "Q3 launch brief", meta: "due · Priya", tone: "blue" },
  { day: 2, start: 3, span: 1, title: "Standup digest", meta: "recurring · daily", tone: "slate" },
  { day: 3, start: 1, span: 3, title: "Changelog 2.4", meta: "due · atlas-01", tone: "cyan" },
  { day: 4, start: 2, span: 2, title: "Sprint 14 review", meta: "closes sprint", tone: "teal" },
  { day: 4, start: 5, span: 1, title: "Retro", meta: "4:00 · 45m", tone: "slate" },
];

const TONES = {
  blue: "border-blue-400/55 bg-blue-500/30 text-blue-50",
  cyan: "border-cyan-400/55 bg-cyan-500/25 text-cyan-50",
  teal: "border-teal-400/55 bg-teal-500/25 text-teal-50",
  slate: "border-white/20 bg-white/[0.09] text-white/85",
} as const;

// The four things our calendar can draw, each a real row type in the data
// model — task due dates, sprint boundaries, recurring schedules, time
// entries. Not third-party calendar accounts.
const LAYERS = [
  { label: "Task due dates", on: true, dot: "bg-blue-400" },
  { label: "Sprint boundaries", on: true, dot: "bg-teal-400" },
  { label: "Recurring schedules", on: true, dot: "bg-cyan-400" },
  { label: "Tracked time", on: false, dot: "bg-white/25" },
];

const NEXT_UP = [
  { title: "Checkout retry fix", when: "Today · 11:00", who: "atlas-01" },
  { title: "Q3 launch brief", when: "Wed", who: "Priya" },
  { title: "Changelog 2.4", when: "Thu", who: "atlas-01" },
];

const MINI_WEEKS = [
  ["", "", "1", "2", "3", "4", "5"],
  ["6", "7", "8", "9", "10", "11", "12"],
  ["13", "14", "15", "16", "17", "18", "19"],
  ["20", "21", "22", "23", "24", "25", "26"],
  ["27", "28", "29", "30", "31", "", ""],
];

export function CalendarShowcase() {
  const ref = useGsap(({ root }) => {
    gsap.fromTo(
      root.querySelector("[data-cal-window]"),
      { autoAlpha: 0, y: 40 },
      {
        autoAlpha: 1,
        y: 0,
        duration: DUR.slow,
        ease: EASE_OUT,
        scrollTrigger: { trigger: root, start: "top 78%" },
      },
    );
    gsap.fromTo(
      root.querySelectorAll("[data-cal-event]"),
      { autoAlpha: 0, y: 10, scale: 0.97 },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: DUR.fast,
        ease: EASE_OUT,
        stagger: 0.05,
        scrollTrigger: { trigger: root, start: "top 68%" },
      },
    );
  });

  return (
    <section
      ref={ref}
      className="relative overflow-hidden bg-background py-24 sm:py-28"
    >
      <Container>
        <div className="max-w-2xl">
          <Eyebrow>Calendar</Eyebrow>
          <h2 className="mt-3 text-balance text-3xl font-semibold tracking-[-0.02em] text-foreground sm:text-4xl">
            The week, <GradientText>as your team will actually run it</GradientText>.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted-foreground">
            Due dates, sprint boundaries and recurring schedules on one grid —
            human work and agent work in the same columns, because they are the
            same tasks.
          </p>
        </div>

        <div
          data-cal-window
          className="mt-10 overflow-hidden rounded-2xl bg-neutral-950/80 ring-1 ring-white/10"
        >
          {/* App header */}
          <div className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-3">
            <div className="flex items-center gap-1" aria-hidden>
              <span className="grid size-6 place-items-center rounded-md bg-white/[0.06] text-white/45">
                <ChevronLeft className="size-3.5" />
              </span>
              <span className="grid size-6 place-items-center rounded-md bg-white/[0.06] text-white/45">
                <ChevronRight className="size-3.5" />
              </span>
            </div>
            <p className="text-sm font-medium text-white">July 14 – 18</p>
            <div className="ml-auto flex items-center gap-2">
              <span className="hidden items-center gap-2 rounded-full bg-white/[0.06] px-3 py-1.5 text-tiny text-white/45 sm:flex">
                <Search className="size-3" aria-hidden />
                Search tasks
              </span>
              <span className="rounded-full bg-white/[0.06] px-2.5 py-1.5 text-tiny text-white/70">
                Engineering
              </span>
              <span
                aria-hidden
                className="size-6 rounded-full ring-1 ring-white/15"
                style={{
                  backgroundImage:
                    "radial-gradient(circle at 32% 28%, #7dd3fc, #2563eb 65%, #0b2f6b)",
                }}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[210px_minmax(0,1fr)]">
            {/* Left rail */}
            <div className="border-b border-white/[0.07] p-4 lg:border-b-0 lg:border-r">
              <p className="text-tiny font-semibold uppercase tracking-widest text-white/40">
                July
              </p>
              <div className="mt-2 grid grid-cols-7 gap-y-1 text-center text-micro text-white/30">
                {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
                  <span key={i}>{d}</span>
                ))}
              </div>
              <div className="mt-1 grid grid-cols-7 gap-y-0.5 text-center text-tiny">
                {MINI_WEEKS.flat().map((d, i) => (
                  <span
                    key={i}
                    className={cn(
                      "rounded py-0.5",
                      d === "16"
                        ? "bg-blue-500/80 font-medium text-white"
                        : ["14", "15", "17", "18"].includes(d)
                          ? "bg-white/[0.07] text-white/80"
                          : "text-white/45",
                    )}
                  >
                    {d}
                  </span>
                ))}
              </div>

              <p className="mt-6 text-tiny font-semibold uppercase tracking-widest text-white/40">
                Show on calendar
              </p>
              <ul className="mt-2 space-y-1.5">
                {LAYERS.map((layer) => (
                  <li
                    key={layer.label}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden
                        className={cn("size-2 shrink-0 rounded-full", layer.dot)}
                      />
                      <span
                        className={cn(
                          "truncate text-xs",
                          layer.on ? "text-white/75" : "text-white/40",
                        )}
                      >
                        {layer.label}
                      </span>
                    </span>
                    <span
                      aria-hidden
                      className={cn(
                        "h-3.5 w-6 shrink-0 rounded-full p-0.5 transition-colors",
                        layer.on ? "bg-blue-500/70" : "bg-white/10",
                      )}
                    >
                      <span
                        className={cn(
                          "block size-2.5 rounded-full bg-white transition-transform",
                          layer.on ? "translate-x-2.5" : "translate-x-0",
                        )}
                      />
                    </span>
                  </li>
                ))}
              </ul>

              <p className="mt-6 text-tiny font-semibold uppercase tracking-widest text-white/40">
                Next up
              </p>
              <ul className="mt-2 space-y-2">
                {NEXT_UP.map((item) => (
                  <li
                    key={item.title}
                    className="rounded-lg bg-white/[0.04] px-2.5 py-2 ring-1 ring-white/[0.07]"
                  >
                    <p className="truncate text-xs text-white/85">
                      {item.title}
                    </p>
                    <p className="mt-0.5 truncate text-micro text-white/45">
                      {item.when} · {item.who}
                    </p>
                  </li>
                ))}
              </ul>
            </div>

            {/* Week grid — keeps real column widths and pans inside its own
                rail on narrow screens. */}
            <div className="overflow-x-auto overscroll-x-contain">
              <div className="min-w-[560px]">
                <div className="grid grid-cols-[44px_repeat(5,minmax(0,1fr))] border-b border-white/[0.07]">
                  <div />
                  {DAYS.map((day) => (
                    <div
                      key={day.name}
                      className="px-2 py-2 text-center"
                    >
                      <p className="text-micro uppercase tracking-widest text-white/40">
                        {day.name}
                      </p>
                      <p
                        className={cn(
                          "mx-auto mt-1 grid size-6 place-items-center rounded-full text-xs",
                          day.today
                            ? "bg-blue-500/80 font-medium text-white"
                            : "text-white/70",
                        )}
                      >
                        {day.date}
                      </p>
                    </div>
                  ))}
                </div>

                <div className="relative grid grid-cols-[44px_repeat(5,minmax(0,1fr))]">
                  {/* Hour gutter */}
                  <div>
                    {HOURS.map((hour) => (
                      <div
                        key={hour}
                        className="h-[72px] pr-2 pt-1 text-right text-micro text-white/30"
                      >
                        {hour}
                      </div>
                    ))}
                  </div>

                  {DAYS.map((day, dayIndex) => (
                    <div
                      key={day.name}
                      className="relative border-l border-white/[0.07]"
                    >
                      {HOURS.map((hour) => (
                        <div
                          key={hour}
                          className="h-[72px] border-b border-white/[0.05]"
                        />
                      ))}
                      {EVENTS.filter((e) => e.day === dayIndex).map((event) => (
                        <div
                          key={event.title}
                          data-cal-event
                          className={cn(
                            "absolute inset-x-1 overflow-hidden rounded-lg border px-2 py-1.5",
                            TONES[event.tone],
                          )}
                          style={{
                            top: event.start * 72 + 3,
                            height: event.span * 72 - 6,
                          }}
                        >
                          <p className="truncate text-tiny font-medium">
                            {event.title}
                          </p>
                          <p className="truncate text-micro opacity-70">
                            {event.meta}
                          </p>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Footer bar */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/[0.07] px-4 py-3 text-tiny">
            <span className="flex items-center gap-2 text-white/60">
              <span
                aria-hidden
                className="size-1.5 animate-breathe rounded-full bg-emerald-400"
              />
              Drag an event to reschedule — it writes the task&apos;s due date
            </span>
            <span className="ml-auto text-white/45">Sprint 14 · day 3 of 10</span>
          </div>
        </div>
      </Container>
    </section>
  );
}
