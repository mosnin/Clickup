"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { PRICING } from "@/lib/marketing-content";
import { Container, CtaButton, SectionHeading } from "@/components/marketing/ui";
import { DUR, EASE_OUT, GsapReveal, prefersReducedMotion, useGsap, isHoverCapable } from "@/components/marketing/gsap";

type Billing = "monthly" | "annual";

const teamTier = PRICING.tiers.find((t) => t.name === "Team");
const teamAnnualNote =
  teamTier && "annualNote" in teamTier ? teamTier.annualNote : undefined;

/** Middle tier's price/period react to the billing toggle; the other two stay put. */
function tierPrice(name: string, billing: Billing) {
  const tier = PRICING.tiers.find((t) => t.name === name)!;
  if (billing === "annual" && "annualPrice" in tier && tier.annualPrice) {
    return { price: tier.annualPrice, period: tier.period };
  }
  return { price: tier.price, period: tier.period };
}

export function PricingSection() {
  const [billing, setBilling] = useState<Billing>("monthly");
  const monthlyBtnRef = useRef<HTMLButtonElement | null>(null);
  const annualBtnRef = useRef<HTMLButtonElement | null>(null);
  const isFirstBillingRender = useRef(true);
  const idleFloatRef = useRef<gsap.core.Tween | null>(null);

  // Subtle fade/slide when the Team tier's price swaps between billing modes.
  const priceRef = useGsap(
    ({ root }) => {
      gsap.fromTo(
        root,
        { autoAlpha: 0, y: 6 },
        { autoAlpha: 1, y: 0, duration: DUR.fast, ease: EASE_OUT },
      );
    },
    [billing],
  );

  // Featured Team card: a very subtle idle float. Scoped in useGsap so
  // reduced-motion never starts it.
  const featuredCardRef = useGsap(({ root }) => {
    idleFloatRef.current = gsap.to(root, {
      y: "+=4",
      duration: 3.5,
      ease: "sine.inOut",
      yoyo: true,
      repeat: -1,
    });
  }, []);

  // Quick scale-press on the billing toggle's active pill when it switches.
  useEffect(() => {
    if (isFirstBillingRender.current) {
      isFirstBillingRender.current = false;
      return;
    }
    if (prefersReducedMotion()) return;
    const el = billing === "monthly" ? monthlyBtnRef.current : annualBtnRef.current;
    if (!el) return;
    gsap.fromTo(el, { scale: 0.96 }, { scale: 1, duration: DUR.fast, ease: EASE_OUT });
  }, [billing]);

  // Damped hover lift for pricing cards. Relative to whatever the card's
  // current y is (static offset and/or mid-idle-float) so it layers instead
  // of overriding. The featured card's idle float pauses for the duration.
  function handleCardEnter(e: React.MouseEvent<HTMLDivElement>, featured: boolean) {
    if (prefersReducedMotion() || !isHoverCapable()) return;
    const el = e.currentTarget;
    if (featured) idleFloatRef.current?.pause();
    const current = (gsap.getProperty(el, "y") as number) || 0;
    gsap.quickTo(el, "y", { duration: DUR.fast, ease: EASE_OUT })(current - 6);
  }

  function handleCardLeave(e: React.MouseEvent<HTMLDivElement>, featured: boolean) {
    if (prefersReducedMotion() || !isHoverCapable()) return;
    const el = e.currentTarget;
    const current = (gsap.getProperty(el, "y") as number) || 0;
    gsap.to(el, {
      y: current + 6,
      duration: DUR.fast,
      ease: EASE_OUT,
      onComplete: featured ? () => idleFloatRef.current?.resume() : undefined,
    });
  }

  return (
    <section className="bg-background py-24 sm:py-28">
      <Container>
        <SectionHeading
          eyebrow={PRICING.eyebrow}
          title={PRICING.title}
          sub={PRICING.sub}
        />

        {/* Billing toggle */}
        <div className="mt-8 flex justify-center">
          <div
            role="group"
            aria-label="Billing period"
            className="inline-flex items-center rounded-full bg-muted p-1"
          >
            <button
              ref={monthlyBtnRef}
              type="button"
              aria-pressed={billing === "monthly"}
              onClick={() => setBilling("monthly")}
              className={cn(
                "inline-flex min-h-11 items-center justify-center rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
                billing === "monthly"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Monthly
            </button>
            <button
              ref={annualBtnRef}
              type="button"
              aria-pressed={billing === "annual"}
              onClick={() => setBilling("annual")}
              className={cn(
                "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
                billing === "annual"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Annual
              {teamAnnualNote && (
                <span className="inline-flex items-center rounded-full bg-azure-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-azure-700">
                  {teamAnnualNote}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Cards */}
        <GsapReveal stagger className="mt-10 grid items-stretch gap-6 lg:grid-cols-3">
          {PRICING.tiers.map((tier) => {
            const { price, period } = tierPrice(tier.name, billing);
            return (
              <div
                key={tier.name}
                ref={tier.featured ? featuredCardRef : undefined}
                onMouseEnter={(e) => handleCardEnter(e, tier.featured)}
                onMouseLeave={(e) => handleCardLeave(e, tier.featured)}
                className={cn(
                  "flex flex-col rounded-[20px] p-7",
                  tier.featured
                    ? "bg-navy-900 text-white shadow-2xl ring-1 ring-navy-800 lg:-translate-y-2"
                    : "bg-background ring-1 ring-border",
                )}
              >
                <span
                  className={cn(
                    "text-sm font-semibold uppercase tracking-widest",
                    tier.featured ? "text-white/60" : "text-muted-foreground",
                  )}
                >
                  {tier.name}
                </span>

                <div ref={tier.name === "Team" ? priceRef : undefined} className="mt-4 flex items-baseline gap-2">
                  <span className="text-4xl font-semibold tracking-tight">
                    {price}
                  </span>
                  <span
                    className={cn(
                      "text-xs",
                      tier.featured ? "text-white/60" : "text-muted-foreground",
                    )}
                  >
                    {period}
                  </span>
                </div>

                <p
                  className={cn(
                    "mt-2 text-sm",
                    tier.featured ? "text-white/70" : "text-muted-foreground",
                  )}
                >
                  {tier.blurb}
                </p>

                <div
                  className={cn(
                    "mt-6 border-t pt-6",
                    tier.featured ? "border-white/10" : "border-border",
                  )}
                >
                  <ul className="space-y-3">
                    {tier.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-2.5">
                        <Check
                          aria-hidden="true"
                          className={cn(
                            "mt-0.5 size-4 flex-shrink-0",
                            tier.featured ? "text-azure-400" : "text-azure-600",
                          )}
                        />
                        <span
                          className={cn(
                            "text-sm leading-snug",
                            tier.featured ? "text-white/85" : "text-foreground",
                          )}
                        >
                          {feature}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="mt-auto pt-6">
                  <CtaButton
                    href={tier.href}
                    variant={tier.featured ? "primary" : "ghostLight"}
                    className="w-full"
                  >
                    {tier.cta}
                  </CtaButton>
                </div>
              </div>
            );
          })}
        </GsapReveal>

        {/* Enterprise row */}
        <div className="mt-8 flex flex-col items-start justify-between gap-4 rounded-[20px] bg-muted px-7 py-6 sm:flex-row sm:items-center">
          <div>
            <p className="font-semibold text-foreground">
              {PRICING.enterprise.title}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {PRICING.enterprise.body}
            </p>
          </div>
          <CtaButton href={PRICING.enterprise.cta.href} variant="primary">
            {PRICING.enterprise.cta.label}
          </CtaButton>
        </div>
      </Container>
    </section>
  );
}
