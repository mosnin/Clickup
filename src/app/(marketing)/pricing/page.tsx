import Link from "next/link";
import type { Metadata } from "next";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Pricing" };

const TIERS = [
  {
    name: "Free",
    price: "$0",
    cadence: "forever",
    blurb: "For individuals getting started.",
    features: ["Personal space", "Up to 1 team workspace", "Mobile + web"],
    cta: "Get started",
    highlight: false,
  },
  {
    name: "Team",
    price: "$10",
    cadence: "per user / month",
    blurb: "For teams that ship.",
    features: [
      "Everything in Free",
      "Unlimited workspaces",
      "Roles and permissions",
      "Email notifications",
    ],
    cta: "Start a team",
    highlight: true,
  },
  {
    name: "Business",
    price: "Contact us",
    cadence: "",
    blurb: "For organizations with security needs.",
    features: ["SSO", "Audit logs", "Priority support"],
    cta: "Talk to sales",
    highlight: false,
  },
];

export default function PricingPage() {
  return (
    <section className="px-4 py-16 sm:py-24">
      <div className="mx-auto max-w-5xl">
        <header className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">
            Simple pricing that scales with you.
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
            Start free, upgrade when your team grows.
          </p>
        </header>
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {TIERS.map((tier) => (
            <div
              key={tier.name}
              className={
                tier.highlight
                  ? "rounded-3xl border-2 border-brand-600 bg-background p-8 shadow-lg"
                  : "rounded-3xl border border-border bg-background p-8"
              }
            >
              <h2 className="text-lg font-semibold">{tier.name}</h2>
              <p className="mt-2 text-sm text-muted-foreground">{tier.blurb}</p>
              <p className="mt-6 text-3xl font-semibold">
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
                      •
                    </span>
                    {f}
                  </li>
                ))}
              </ul>
              <Link href="/sign-up" className="mt-8 block">
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
