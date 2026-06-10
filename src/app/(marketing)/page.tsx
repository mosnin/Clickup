import Link from "next/link";
import { Button } from "@/components/ui/button";

const CLAIMS: { h: string; p: string }[] = [
  {
    h: "One keystroke",
    p: "⌘K from anywhere. Type what you mean. Pace fills in the rest.",
  },
  {
    h: "Never the wrong list",
    p: "Pace knows your spaces. It picks the list you'd have picked.",
  },
  {
    h: "Stays out of your way",
    p: "Soft delete with one-tap undo. Realtime that doesn't shout.",
  },
];

export default function HomePage() {
  return (
    <main className="px-4 py-16 sm:px-6 sm:py-24">
      <section className="mx-auto max-w-3xl text-center">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-6xl">
          Type. Done.
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-base text-muted-foreground sm:text-lg">
          Pace turns a plain-English sentence into the right task on the right
          list. One keystroke.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link href="/sign-up">
            <Button size="lg">Get started</Button>
          </Link>
          <Link href="/features">
            <Button size="lg" variant="ghost">
              See it move
            </Button>
          </Link>
        </div>
        <div className="mx-auto mt-14 max-w-2xl rounded-3xl border border-border bg-background p-6 text-left shadow-sm">
          <div className="flex items-center gap-2 rounded-full border border-border bg-muted/30 px-4 py-2">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-500" aria-hidden />
            <span className="text-sm">Remind me to call mom Friday at 3</span>
          </div>
          <div className="mt-3 rounded-2xl border border-brand-200 bg-brand-50 p-4 text-sm">
            <p className="font-medium">Call mom</p>
            <p className="mt-1 text-xs text-brand-700">
              Personal · Friday, 3:00pm · Reminder
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto mt-24 grid max-w-4xl gap-6 sm:grid-cols-3">
        {CLAIMS.map((f) => (
          <div
            key={f.h}
            className="rounded-3xl border border-border bg-background p-6"
          >
            <h3 className="text-lg font-semibold">{f.h}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{f.p}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
