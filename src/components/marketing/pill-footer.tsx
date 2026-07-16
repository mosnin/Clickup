import Link from "next/link";
import { ArrowRight } from "lucide-react";
import {
  FEATURE_LINKS,
  RESOURCE_LINKS,
  SITE_NAME,
  SITE_TAGLINE,
  USE_CASE_LINKS,
} from "@/lib/marketing-nav";
import { LEGAL_LINKS } from "@/lib/legal";

const COLUMNS = [
  {
    heading: "Product",
    links: [
      ...FEATURE_LINKS.slice(0, 4).map((l) => ({ href: l.href, label: l.label })),
      { href: "/features", label: "All features" },
      { href: "/pricing", label: "Pricing" },
    ],
  },
  {
    heading: "Use cases",
    links: USE_CASE_LINKS.map((l) => ({ href: l.href, label: l.label })),
  },
  {
    heading: "Resources",
    links: RESOURCE_LINKS.map((l) => ({ href: l.href, label: l.label })),
  },
  {
    heading: "Company",
    links: [
      { href: "/company", label: "About" },
      { href: "/sign-up", label: "Get started" },
      { href: "/sign-in", label: "Log in" },
    ],
  },
];

export function PillFooter() {
  return (
    <footer className="bg-cream px-3 pb-6 pt-16 sm:px-6">
      <div className="mx-auto max-w-6xl">
        {/* CTA band */}
        <div className="relative overflow-hidden rounded-[2rem] bg-cocoa-900 px-6 py-12 text-white sm:px-12 sm:py-16">
          <span
            aria-hidden
            className="absolute -right-24 -top-24 h-80 w-80 rounded-full bg-[radial-gradient(closest-side,#cf8a4e,transparent_70%)] opacity-50 blur-2xl"
          />
          <span
            aria-hidden
            className="absolute -bottom-32 -left-16 h-80 w-80 rounded-full bg-[radial-gradient(closest-side,#54402a,transparent_70%)] opacity-70 blur-2xl"
          />
          <div className="relative flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-end">
            <div>
              <p className="text-sm font-medium text-ember-300">Get started</p>
              <h2 className="mt-3 max-w-md text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
                Your first agent, online before your coffee cools.
              </h2>
            </div>
            <Link
              href="/sign-up"
              className="group inline-flex flex-shrink-0 items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-semibold text-foreground transition-transform active:scale-[0.97]"
            >
              Start free
              <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5" />
            </Link>
          </div>
        </div>

        {/* Link columns */}
        <div className="grid gap-10 px-2 py-12 sm:grid-cols-2 lg:grid-cols-6">
          <div className="lg:col-span-2">
            <Link
              href="/"
              className="flex items-center gap-2 text-[13px] font-extrabold uppercase tracking-[0.18em]"
            >
              <span
                aria-hidden
                className="inline-block h-3.5 w-3.5 rounded-[4px] bg-foreground"
              />
              {SITE_NAME}
            </Link>
            <p className="mt-3 max-w-xs text-sm text-muted-foreground">
              {SITE_TAGLINE}. Tasks, docs, and sprints, plus first-class AI
              agent teammates you can actually see working.
            </p>
          </div>
          {COLUMNS.map((col) => (
            <div key={col.heading}>
              <h3 className="text-[13px] font-medium text-muted-foreground">
                {col.heading}
              </h3>
              <ul className="mt-3 space-y-2">
                {col.links.map((link) => (
                  <li key={link.href + link.label}>
                    <Link
                      href={link.href}
                      className="text-sm text-foreground/80 transition-colors hover:text-foreground"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-4 border-t border-black/[0.07] px-2 pt-6">
          <nav
            aria-label="Legal"
            className="flex flex-wrap items-center gap-x-5 gap-y-2"
          >
            <Link
              href="/legal"
              className="text-xs font-medium text-foreground/70 transition-colors hover:text-foreground"
            >
              Legal
            </Link>
            {LEGAL_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
            <p className="text-xs text-muted-foreground">
              © {new Date().getFullYear()} {SITE_NAME}. All rights reserved.
            </p>
            <p className="text-xs text-muted-foreground">
              Works with any MCP-capable agent runtime.
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
