import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function HomePage() {
  return (
    <>
      <section className="px-4 pt-16 sm:pt-24">
        <div className="mx-auto max-w-4xl text-center">
          <span className="inline-flex items-center rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
            Now in early access
          </span>
          <h1 className="mt-6 text-4xl font-semibold tracking-tight sm:text-6xl">
            One app to replace them all.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-balance text-lg text-muted-foreground">
            Tasks, docs, goals, and chat in a single workspace. Personal spaces
            for your own work, team workspaces for everything else.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/sign-up">
              <Button size="lg">Get started — free</Button>
            </Link>
            <Link href="/features">
              <Button size="lg" variant="outline">
                See features
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <section className="px-4 py-20 sm:py-28">
        <div className="mx-auto grid max-w-5xl gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              title: "Personal spaces",
              body: "Keep solo work tidy. Every account starts with a private space only you can see.",
            },
            {
              title: "Team workspaces",
              body: "Invite teammates, assign roles, and run projects together with clear ownership.",
            },
            {
              title: "Works offline",
              body: "Installable as a PWA. Pin it to your home screen on desktop or mobile.",
            },
          ].map((card) => (
            <div
              key={card.title}
              className="rounded-3xl border border-border bg-background p-6"
            >
              <h2 className="text-lg font-semibold">{card.title}</h2>
              <p className="mt-2 text-sm text-muted-foreground">{card.body}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
