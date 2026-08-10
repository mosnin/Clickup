import Link from "next/link";
import { CtaButton, Container } from "@/components/marketing/ui";
import { DatamoshBackdrop } from "@/components/marketing/datamosh/DatamoshBackdrop";
import {
  FEATURE_LINKS,
  USE_CASE_LINKS,
  RESOURCE_LINKS,
  PLAIN_LINKS,
  SITE_NAME,
  SITE_TAGLINE,
  type NavLeaf,
} from "@/lib/marketing-nav";

// Navy marketing footer — the closing band of every logged-out page.
// Sources its link columns from marketing-nav.ts so it always matches the
// header's mega menus and the sitemap.

type FooterLink = { href: string; label: string };

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: FooterLink[];
}) {
  return (
    <div>
      <h3 className="text-tiny font-semibold uppercase tracking-widest text-white/60">
        {title}
      </h3>
      <ul className="mt-4 space-y-1">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="block py-1 text-sm text-white/70 transition-colors hover:text-white"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

const PRODUCT_LINKS: NavLeaf[] = FEATURE_LINKS.slice(0, 6);
const COMPANY_LINKS: FooterLink[] = [
  ...PLAIN_LINKS,
  { href: "/legal", label: "Legal" },
];

export function MarketingFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="relative isolate overflow-hidden bg-navy-950 text-white">
      {/* The footer's backdrop: the datamosh decode, stretched over the whole
          band rather than boxed into a card.

          It replaces a Spline scene that was doing the same job from a
          third-party iframe — an external request, an opaque payload, and a
          <div> that swallowed clicks meant for the link columns. This paints
          the same idea with fillRect on our own canvas: no network, no vendor,
          and it pauses when it is off screen instead of running forever in a
          hidden band at the bottom of every page.

          The scrim lives inside the backdrop rather than out here, because
          legibility is its problem: the palette runs to saturated yellow and
          white, and it changes several times a second under text that has to
          stay readable the whole time. */}
      <DatamoshBackdrop className="-z-10" />

      <Container className="py-16">
        <div className="grid grid-cols-1 gap-x-10 gap-y-12 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
          <div>
            <Link href="/" aria-label="operate.to" className="inline-flex items-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/brand/operate-logo-white.svg"
                alt="operate.to"
                className="h-6 w-auto"
              />
            </Link>
            <p className="mt-3 max-w-[15rem] text-sm leading-relaxed text-white/50">
              {SITE_TAGLINE}
            </p>
            <CtaButton
              href="/sign-up"
              variant="onDark"
              size="md"
              className="mt-6"
            >
              Start free
            </CtaButton>
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-4 lg:justify-items-end">
            <FooterColumn title="Product" links={PRODUCT_LINKS} />
            <FooterColumn title="Use cases" links={USE_CASE_LINKS} />
            <FooterColumn title="Resources" links={RESOURCE_LINKS} />
            <FooterColumn title="Company" links={COMPANY_LINKS} />
          </div>
        </div>
      </Container>

      <div className="border-t border-white/10">
        <Container className="flex flex-wrap items-center justify-between gap-4 py-6 text-xs text-white/60">
          <p>
            &copy; {year} {SITE_NAME}
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <Link
              href="/legal/terms"
              className="transition-colors hover:text-white/70"
            >
              Terms
            </Link>
            <Link
              href="/legal/privacy"
              className="transition-colors hover:text-white/70"
            >
              Privacy
            </Link>
            <Link
              href="/legal/security"
              className="transition-colors hover:text-white/70"
            >
              Security
            </Link>
          </div>
          <p>Built for humans and agents.</p>
        </Container>
      </div>
    </footer>
  );
}
