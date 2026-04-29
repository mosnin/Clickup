import type { Metadata } from "next";

export const metadata: Metadata = { title: "About" };

export default function AboutPage() {
  return (
    <section className="px-4 py-16 sm:py-24">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-6xl">
          We&apos;re building Pace because every other tool got slower.
        </h1>
        <p className="mt-6 text-lg text-muted-foreground">
          ClickUp, Notion, Asana, Jira — they all started fast and got bloated.
          Each new feature added a setting, a panel, a modal. We&apos;d like to
          stop doing that.
        </p>

        <div className="prose prose-zinc mt-10 max-w-none text-foreground">
          <p>
            Pace has one opinion: <strong>speed is the feature</strong>. Every
            keystroke. Every screen. Every empty state. Either it makes you
            faster or it stays out of the way.
          </p>
          <p>
            We measure ourselves against the clock, not the feature list. How
            many keypresses to create a task? How long to find it again? How
            quickly does the app feel alive when a teammate shows up? Those are
            the numbers we&apos;re trying to drive down.
          </p>
          <p>
            That sounds limiting. It is. The limit is the point — without it
            we&apos;d be ClickUp.
          </p>
        </div>

        <p className="mt-12 text-sm text-muted-foreground">
          Pace is open source.{" "}
          <a
            href="https://github.com/mosnin/Clickup"
            className="text-brand-700 underline hover:text-brand-800"
          >
            Find us on GitHub.
          </a>
        </p>
      </div>
    </section>
  );
}
