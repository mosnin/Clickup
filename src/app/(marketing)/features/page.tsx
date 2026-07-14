import type { Metadata } from "next";

export const metadata: Metadata = { title: "Features" };

const FEATURES = [
  {
    title: "Tasks",
    body: "Track work with statuses, priorities, due dates, and assignees.",
  },
  {
    title: "Docs",
    body: "Rich text documents that live alongside your tasks.",
  },
  {
    title: "Goals",
    body: "Set targets and roll up progress from underlying tasks automatically.",
  },
  {
    title: "Chat",
    body: "Threaded messages scoped to a space, workspace, or task.",
  },
  {
    title: "Mobile + desktop",
    body: "Responsive UI everywhere, installable as a PWA on every platform.",
  },
  {
    title: "Realtime",
    body: "Backed by Convex — every change is live, no refreshing required.",
  },
];

export default function FeaturesPage() {
  return (
    <section className="px-4 py-16 sm:py-24">
      <div className="mx-auto max-w-5xl">
        <header className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">
            Everything you need, nothing you don&apos;t.
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
            A focused set of capabilities that cover 90% of what teams use other
            tools for.
          </p>
        </header>
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-2xl border border-border bg-background p-6"
            >
              <h2 className="text-lg font-semibold">{f.title}</h2>
              <p className="mt-2 text-sm text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
