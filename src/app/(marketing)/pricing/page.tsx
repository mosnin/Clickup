import Link from "next/link";
import type { Metadata } from "next";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Pricing" };

const TIERS = [
  {
    name: "Solo",
    price: "$0",
    cadence: "forever",
    blurb: "For one person. Personal space, no limits, no card.",
    features: [
      "Personal space",
      "Unlimited tasks, docs, whiteboards",
      "⌘K, AI, mobile",
      "30-day trash",
    ],
    cta: "Start free",
    highlight: false,
  },
  {
    name: "Team",
    price: "$8",
    cadence: "per user / month",
    blurb: "For teams under 50.",
    features: [
      "Everything in Solo",
      "Unlimited team workspaces",
      "Roles, invites, audit log",
      "Slack + email notifications",
      "Time tracking + reports",
    ],
    cta: "Start a team",
    highlight: true,
  },
  {
    name: "Business",
    price: "Talk to us",
    cadence: "",
    blurb: "For companies that need SSO and a contract.",
    features: ["Everything in Team", "SSO + SCIM", "API + webhooks", "Priority support"],
    cta: "Contact sales",
    highlight: false,
  },
];

export default function PricingPage() {
  return (
    <section className="px-4 py-16 sm:py-24">
      <div className="mx-auto max-w-5xl">
        <header className="text-center">
          <h1 className="text-4xl font-semibold tracking-tight sm:text-6xl">
            Pay for the team plan.
            <br />
            <span className="text-brand-600">Don&apos;t pay to think.</span>
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
            Solo is free forever. The team plan exists because we&apos;d like to
            keep the lights on.
          </p>
        </header>

        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {TIERS.map((tier) => (
            <div
              key={tier.name}
              className={
                tier.highlight
                  ? "rounded-3xl border-2 border-brand-600 bg-background p-8 shadow-lg shadow-brand-900/5"
                  : "rounded-3xl border border-border bg-background p-8"
              }
            >
              <div className="flex items-baseline justify-between">
                <h2 className="text-lg font-semibold">{tier.name}</h2>
                {tier.highlight && (
                  <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-brand-700">
                    Most teams
                  </span>
                )}
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{tier.blurb}</p>
              <p className="mt-6 text-3xl font-semibold tracking-tight">
                {tier.price}{" "}
                {tier.cadence && (
                  <span className="text-base font-normal text-muted-foreground">
                    {tier.cadence}
                  </span>
                )}
              </p>
              <ul className="mt-6 space-y-2 text-sm">
                {tier.features.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <span aria-hidden className="mt-1 text-brand-600">
                      ✓
                    </span>
                    {f}
                  </li>
                ))}
              </ul>
              <Link
                href={tier.name === "Business" ? "mailto:hello@pace.app" : "/sign-up"}
                className="mt-8 block"
              >
                <Button
                  className="w-full"
                  variant={tier.highlight ? "primary" : "outline"}
                >
                  {tier.cta}
                </Button>
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
