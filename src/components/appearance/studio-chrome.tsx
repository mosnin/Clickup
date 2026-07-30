"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

// The studio's own shell.
//
// Customising the app is not a settings page. It is a place you go into, spend
// time in, and come back out of — and it needs its own navigation for the same
// reason a code editor does: you are moving between chapters of one document,
// not between unrelated features. Wearing the main dashboard's sidebar made it
// a page floating inside an app it is supposed to be about.
//
// So the studio replaces the nav while you are in it, and the first thing in
// that nav is the way out. A section that changes the chrome and does not
// obviously give it back is a trap.

export type StudioSection = {
  slug: string;
  label: string;
  blurb: string;
};

export const STUDIO_SECTIONS: StudioSection[] = [
  { slug: "", label: "Overview", blurb: "Start from a look, then adjust" },
  { slug: "type", label: "Type", blurb: "The faces you read in" },
  { slug: "colour", label: "Colour", blurb: "Accent, surfaces, corners" },
  { slug: "layout", label: "Layout", blurb: "Navigation, density, motion" },
  { slug: "panels", label: "Panels", blurb: "Frames, fills, titles" },
  { slug: "charts", label: "Charts", blurb: "Palettes, marks, axes" },
];

export function StudioChrome({
  base,
  title,
  context,
  actions,
  children,
}: {
  /** Route prefix — "/dashboard/appearance" or a space's own studio. */
  base: string;
  title: string;
  context?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="-mx-4 -my-6 flex min-h-[calc(100dvh-1rem)] flex-col md:flex-row">
      {/* The studio's nav. Sticky rather than fixed: it scrolls with a long
          chapter on a short screen instead of trapping the content. */}
      <nav
        aria-label="Appearance"
        className="shrink-0 border-b border-border px-4 py-4 md:sticky md:top-0 md:h-dvh md:w-60 md:border-b-0 md:border-r md:px-3 md:py-5"
      >
        <Link
          href="/dashboard"
          className="tap-target mb-5 inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to the app
        </Link>

        <p className="px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Appearance
        </p>

        <ul className="mt-2 flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
          {STUDIO_SECTIONS.map((section) => {
            const href = section.slug ? `${base}/${section.slug}` : base;
            const active =
              pathname === href ||
              (section.slug === "" && pathname === `${base}/`);
            return (
              <li key={section.slug || "overview"} className="flex-shrink-0">
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "block rounded-lg px-2 py-1.5 text-sm transition-colors",
                    active
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  {section.label}
                  <span className="hidden text-[11px] text-muted-foreground md:block">
                    {section.blurb}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
        <header className="mb-8 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl">{title}</h1>
            {context && (
              <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                {context}
              </p>
            )}
          </div>
          {actions}
        </header>
        {children}
      </div>
    </div>
  );
}
