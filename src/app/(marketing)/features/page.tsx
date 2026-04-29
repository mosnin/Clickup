import type { Metadata } from "next";

export const metadata: Metadata = { title: "Features" };

const PILLARS = [
  {
    label: "Speed",
    items: [
      {
        title: "⌘K command palette",
        body: "Search tasks, docs, lists, and people. Run commands. Jump anywhere. The mouse is optional.",
      },
      {
        title: "Keyboard shortcuts",
        body: "Mark complete with t. Comment with c. Assign with a. New task with n. The shortcuts you'd expect.",
      },
      {
        title: "Realtime, alive",
        body: "See who's online, who's on this task, what just changed. No reload button.",
      },
    ],
  },
  {
    label: "AI with agency",
    items: [
      {
        title: "Type a sentence, get a task",
        body: "\"Ship the Q1 review by Friday, assign Maya, mark urgent\" — Pace fills in the priority, due date, assignee, and list.",
      },
      {
        title: "Brain that reads context",
        body: "Ask it questions about your workspace. It cites sources. It knows what page you're on.",
      },
      {
        title: "AI in docs and tasks",
        body: "Continue a doc. Summarize a thread. Draft a description from a title. Streaming everywhere.",
      },
    ],
  },
  {
    label: "Mobile-first",
    items: [
      {
        title: "Bottom tab nav",
        body: "Where your thumb is. Home, Inbox, +, Brain, Profile.",
      },
      {
        title: "Gestures, not taps",
        body: "Swipe-right to complete. Swipe-left to defer. Pull to refresh.",
      },
      {
        title: "Installable",
        body: "PWA on web, Capacitor wrapper on iOS and Android. One codebase. One product.",
      },
    ],
  },
  {
    label: "The boring parts, done right",
    items: [
      {
        title: "Spaces · Folders · Lists · Tasks",
        body: "Hierarchy that scales from one person to one company. Personal stays personal.",
      },
      {
        title: "Custom statuses + fields",
        body: "Per-list workflow stages. Custom fields with the types you actually need.",
      },
      {
        title: "Views",
        body: "List, Board, Calendar, Gantt. Drag tasks across columns or onto a date.",
      },
      {
        title: "Time tracking · Goals · Reports",
        body: "Track what you spent, set what to aim at, see how the week went.",
      },
      {
        title: "Comments + chat",
        body: "Threaded comments, @mentions with a real picker, and a workspace chat — all in one inbox.",
      },
      {
        title: "Docs + whiteboards",
        body: "Rich text where the work lives. Whiteboards for the part that won't fit in a list.",
      },
    ],
  },
];

export default function FeaturesPage() {
  return (
    <section className="px-4 py-16 sm:py-24">
      <div className="mx-auto max-w-5xl">
        <header className="text-center">
          <h1 className="text-4xl font-semibold tracking-tight sm:text-6xl">
            One opinion. <span className="text-brand-600">Speed.</span>
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
            Everything Pace ships either makes you faster or stays out of the
            way. The list is short on purpose.
          </p>
        </header>

        <div className="mt-16 space-y-16">
          {PILLARS.map((pillar) => (
            <section key={pillar.label}>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-brand-700">
                {pillar.label}
              </h2>
              <ul className="mt-4 grid gap-4 md:grid-cols-3">
                {pillar.items.map((f) => (
                  <li
                    key={f.title}
                    className="rounded-3xl border border-border bg-background p-6"
                  >
                    <h3 className="text-base font-semibold">{f.title}</h3>
                    <p className="mt-2 text-sm text-muted-foreground">{f.body}</p>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}
