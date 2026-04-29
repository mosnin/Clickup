import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function HomePage() {
  return (
    <>
      <section className="px-4 pt-16 sm:pt-24">
        <div className="mx-auto max-w-4xl text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700">
            <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-accent-500" />
            Find your pace
          </span>
          <h1 className="mt-6 text-5xl font-semibold tracking-tight sm:text-7xl">
            The work app that
            <br />
            <span className="text-brand-600">gets out of your way.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-balance text-lg text-muted-foreground">
            Pace is a productivity tool with one job: don&apos;t slow you down.
            Press <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[12px]">⌘K</kbd> to do anything.
            Type a sentence to create a task. Use it on your phone.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/sign-up">
              <Button size="lg">Start free</Button>
            </Link>
            <Link href="#how-it-works">
              <Button size="lg" variant="outline">
                See how it&apos;s different
              </Button>
            </Link>
          </div>
        </div>

        {/* CSS-art preview of the dashboard. No screenshot lib, no fake data —
            just enough to suggest "this is fast" without lying about features. */}
        <div className="mx-auto mt-16 max-w-5xl">
          <div className="rounded-[2rem] border border-border bg-background p-3 shadow-2xl shadow-brand-900/5">
            <div className="overflow-hidden rounded-2xl border border-border">
              <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-4 py-2.5">
                <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
                <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
                <span className="ml-auto rounded-full border border-border bg-background px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                  ⌘K  go anywhere
                </span>
              </div>
              <div className="grid grid-cols-12 gap-0">
                <aside className="col-span-3 border-r border-border bg-muted/20 p-3 text-xs">
                  <div className="mb-2 flex items-center justify-between text-muted-foreground">
                    <span className="font-semibold uppercase tracking-wider">Personal</span>
                  </div>
                  <ul className="space-y-1">
                    <li className="rounded-lg bg-brand-50 px-2 py-1.5 font-medium text-brand-700">
                      › This week
                    </li>
                    <li className="px-2 py-1.5 text-muted-foreground">› Reading</li>
                    <li className="px-2 py-1.5 text-muted-foreground">› Side project</li>
                  </ul>
                  <div className="mb-2 mt-4 flex items-center justify-between text-muted-foreground">
                    <span className="font-semibold uppercase tracking-wider">Acme</span>
                    <span>2</span>
                  </div>
                  <ul className="space-y-1">
                    <li className="px-2 py-1.5 text-muted-foreground">› Q1 launch</li>
                    <li className="px-2 py-1.5 text-muted-foreground">› Design review</li>
                  </ul>
                </aside>
                <main className="col-span-9 p-4">
                  <div className="flex items-baseline justify-between">
                    <h3 className="text-base font-semibold">This week</h3>
                    <span className="text-xs text-muted-foreground">5 tasks</span>
                  </div>
                  <ul className="mt-3 space-y-1.5 text-sm">
                    {[
                      { done: true, title: "Ship the Pace marketing page", due: "Today" },
                      { done: false, title: "Wire the command palette to search", due: "Today", hot: true },
                      { done: false, title: "Calendar drag-to-reschedule", due: "Tue" },
                      { done: false, title: "Walk the dog", due: "—" },
                      { done: false, title: "Brain: read what page I'm on", due: "Wed" },
                    ].map((row, i) => (
                      <li
                        key={i}
                        className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2"
                      >
                        <span
                          className={
                            row.done
                              ? "inline-flex h-4 w-4 items-center justify-center rounded-full bg-brand-600 text-[10px] text-white"
                              : "inline-block h-4 w-4 rounded-full border-2 border-border"
                          }
                        >
                          {row.done && "✓"}
                        </span>
                        <span className={row.done ? "text-muted-foreground line-through" : ""}>
                          {row.title}
                        </span>
                        {row.hot && (
                          <span className="rounded-full bg-accent-500/15 px-2 py-0.5 text-[10px] font-medium text-accent-600">
                            urgent
                          </span>
                        )}
                        <span className="ml-auto text-xs text-muted-foreground">{row.due}</span>
                      </li>
                    ))}
                  </ul>
                </main>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="how-it-works" className="px-4 py-24">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-center text-3xl font-semibold tracking-tight sm:text-4xl">
            Three things we&apos;d rather not be slow at.
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-center text-muted-foreground">
            Most productivity tools have everything. Pace has one opinion: speed
            is the feature.
          </p>

          <ul className="mt-12 grid gap-6 md:grid-cols-3">
            <Pillar
              kbd="⌘K"
              title="Open. Type. Go."
              body="Search every task, doc, list, and teammate. Run any command. Never touch the mouse if you don't want to."
            />
            <Pillar
              kbd="✨"
              title="AI that takes action."
              body="Type a sentence. Pace creates the task with the right priority, dates, and assignee — pulled from your workspace, not invented."
              accent
            />
            <Pillar
              kbd="📱"
              title="Mobile is the product."
              body="Bottom tabs. Swipe to complete. Pull to refresh. Your phone is where work happens — Pace was designed there first."
            />
          </ul>
        </div>
      </section>

      <section className="px-4 py-20">
        <div className="mx-auto max-w-3xl rounded-[2rem] border border-border bg-brand-50 p-10 text-center sm:p-14">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Sustainable speed.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
            Pace isn&apos;t about going faster than you can sustain. It&apos;s about
            not being slowed down by the tool. Big difference.
          </p>
          <Link href="/sign-up" className="mt-6 inline-block">
            <Button size="lg">Start free</Button>
          </Link>
          <p className="mt-3 text-xs text-muted-foreground">
            Free forever for solo work. No card required.
          </p>
        </div>
      </section>
    </>
  );
}

function Pillar({
  kbd,
  title,
  body,
  accent,
}: {
  kbd: string;
  title: string;
  body: string;
  accent?: boolean;
}) {
  return (
    <li
      className={
        accent
          ? "rounded-3xl border-2 border-brand-500 bg-background p-6"
          : "rounded-3xl border border-border bg-background p-6"
      }
    >
      <span
        aria-hidden
        className="inline-flex h-10 min-w-10 items-center justify-center rounded-full bg-muted px-3 font-mono text-sm font-semibold"
      >
        {kbd}
      </span>
      <h3 className="mt-4 text-lg font-semibold">{title}</h3>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
    </li>
  );
}
