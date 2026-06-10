import Link from "next/link";
import type { Metadata } from "next";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Pricing" };

export default function PricingPage() {
  return (
    <main className="px-4 py-16 sm:px-6 sm:py-20">
      <section className="mx-auto max-w-3xl text-center">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">
          Honest pricing.
        </h1>
        <p className="mt-4 text-base text-muted-foreground sm:text-lg">
          Free for one. $10 a person, a month, when you bring a team.
        </p>
      </section>

      <section className="mx-auto mt-12 grid max-w-4xl gap-4 sm:grid-cols-2">
        <Tier
          name="Free"
          price="$0"
          cadence="forever"
          tagline="For one. Personal use."
          features={[
            "Your personal space",
            "Unlimited tasks, lists, docs",
            "Quick Task AI (10 / day)",
            "Brain search",
            "Mobile + offline",
          ]}
          cta="Get started"
          ctaHref="/sign-up"
          muted
        />
        <Tier
          name="Pro"
          price="$10"
          cadence="per user / month"
          tagline="For teams shipping work together."
          features={[
            "Everything in Free",
            "Unlimited workspaces + members",
            "Quick Task AI (unlimited)",
            "Realtime presence + CRDT docs",
            "Slack, Capacitor, integrations",
            "Priority support",
          ]}
          cta="Start a workspace"
          ctaHref="/sign-up"
        />
      </section>

      <p className="mx-auto mt-10 max-w-xl text-center text-xs text-muted-foreground">
        Annual billing knocks 20% off. No usage gotchas. Cancel anything.
      </p>
    </main>
  );
}

function Tier({
  name,
  price,
  cadence,
  tagline,
  features,
  cta,
  ctaHref,
  muted,
}: {
  name: string;
  price: string;
  cadence: string;
  tagline: string;
  features: string[];
  cta: string;
  ctaHref: string;
  muted?: boolean;
}) {
  return (
    <article
      className={
        "rounded-3xl border p-6 " +
        (muted
          ? "border-border bg-muted/30"
          : "border-foreground bg-background shadow-sm")
      }
    >
      <h2 className="text-lg font-semibold">{name}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{tagline}</p>
      <p className="mt-4">
        <span className="text-4xl font-semibold tracking-tight">{price}</span>
        <span className="ml-1 text-sm text-muted-foreground">{cadence}</span>
      </p>
      <ul className="mt-5 space-y-2 text-sm">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <span
              aria-hidden
              className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-brand-500"
            />
            <span>{f}</span>
          </li>
        ))}
      </ul>
      <div className="mt-6">
        <Link href={ctaHref}>
          <Button className="w-full" variant={muted ? "outline" : "primary"}>
            {cta}
          </Button>
        </Link>
      </div>
    </article>
  );
}
