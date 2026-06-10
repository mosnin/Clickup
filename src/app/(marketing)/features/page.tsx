import type { Metadata } from "next";

export const metadata: Metadata = { title: "Features" };

export default function FeaturesPage() {
  return (
    <main className="px-4 py-16 sm:px-6 sm:py-20">
      <section className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">
          Pace is the work app that gets out of your way.
        </h1>
        <p className="mt-4 text-base text-muted-foreground sm:text-lg">
          Most tools make you describe what you want done by clicking through
          forms. Pace lets you describe it in a sentence — and does the rest.
        </p>
      </section>

      <section className="mx-auto mt-16 max-w-4xl space-y-12">
        <Feature
          label="Quick Task"
          title="One sentence in. One task out."
          body="Type 'Remind me to send the contract Friday morning.' Pace picks the right list, sets the priority, fills in the date, and assigns the right person. Cmd+K from anywhere."
        />
        <Feature
          label="Brain"
          title="Search that knows what you're working on."
          body="Ask 'who owns the launch review?' — Pace searches across tasks, docs, and comments and answers with sources you can click."
        />
        <Feature
          label="Realtime"
          title="See your team without watching them."
          body="Avatar stack on every doc, list, and task. Pulsing dot when someone's typing. A soft flash when a task moves under another cursor."
        />
        <Feature
          label="Mobile"
          title="Built for the phone, not shrunk for it."
          body="Swipe right to complete. Swipe left to undo. Bottom tabs you can reach with your thumb. Native haptics."
        />
      </section>
    </main>
  );
}

function Feature({
  label,
  title,
  body,
}: {
  label: string;
  title: string;
  body: string;
}) {
  return (
    <article className="border-l-2 border-brand-500 pl-5">
      <p className="text-xs font-semibold uppercase tracking-wider text-brand-700">
        {label}
      </p>
      <h2 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">
        {title}
      </h2>
      <p className="mt-2 text-sm text-muted-foreground sm:text-base">{body}</p>
    </article>
  );
}
