import Link from "next/link";

const SECTIONS = [
  {
    heading: "Product",
    links: [
      { href: "/features", label: "Features" },
      { href: "/pricing", label: "Pricing" },
    ],
  },
  {
    heading: "Company",
    links: [
      { href: "/about", label: "About" },
      { href: "/sign-up", label: "Get started" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { href: "/privacy", label: "Privacy" },
      { href: "/terms", label: "Terms" },
    ],
  },
];

export function PillFooter() {
  return (
    <footer className="px-3 pb-6 pt-12 sm:px-6">
      <div className="mx-auto max-w-6xl rounded-3xl border border-border bg-muted/40 p-6 sm:rounded-[2rem] sm:p-10">
        <div className="grid gap-8 sm:grid-cols-2 md:grid-cols-4">
          <div>
            <Link
              href="/"
              className="flex items-center gap-2 text-sm font-semibold"
            >
              <span
                aria-hidden
                className="inline-block h-6 w-6 rounded-full bg-brand-600"
              />
              ClickUp Clone
            </Link>
            <p className="mt-3 text-sm text-muted-foreground">
              One app to replace them all.
            </p>
          </div>
          {SECTIONS.map((section) => (
            <div key={section.heading}>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {section.heading}
              </h3>
              <ul className="mt-3 space-y-2">
                {section.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-sm hover:text-brand-600"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-10 flex flex-col items-start justify-between gap-3 border-t border-border pt-6 sm:flex-row sm:items-center">
          <p className="text-xs text-muted-foreground">
            © {new Date().getFullYear()} ClickUp Clone. All rights reserved.
          </p>
          <p className="text-xs text-muted-foreground">
            Built with Next.js · Convex · Clerk · Resend
          </p>
        </div>
      </div>
    </footer>
  );
}
