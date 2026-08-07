import Link from "next/link";
import { CtaButton, Container } from "@/components/marketing/ui";
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
      {/* Spline scene behind the footer.

          pointer-events-none on the wrapper: the iframe would otherwise
          swallow every click meant for the link columns above it. lazy so it
          never competes with the page's own load, and aria-hidden + a title
          because it carries no information a screen reader needs.

          Legibility is the scrims' job, not the scene's: a flat wash plus a
          top-down gradient that starts at the footer's own fill, so the band
          reads as one surface and white text keeps its contrast wherever the
          scene happens to be bright. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      >
        {/* Over-sized and edge-masked. The scene letterboxes to its own
            aspect, so at inset-0 its boundary landed inside the footer as two
            hard vertical seams; blowing it out past the container and fading
            the outer 30% to transparent means the viewer only ever sees the
            middle of it. */}
        <div
          className="absolute -inset-x-[15%] -inset-y-[25%]"
          style={{
            maskImage:
              "radial-gradient(70% 65% at 50% 50%, black 40%, transparent 100%)",
            WebkitMaskImage:
              "radial-gradient(70% 65% at 50% 50%, black 40%, transparent 100%)",
          }}
        >
          <iframe
            src="https://my.spline.design/aidatamodelinteraction-mdTL3FktFVHgDvFr5TKtnYDV"
            title=""
            aria-hidden
            tabIndex={-1}
            loading="lazy"
            className="absolute left-0 top-0 h-full w-full border-0"
          />
        </div>
        <div className="absolute inset-0 bg-navy-950/72" />
        <div className="absolute inset-0 bg-gradient-to-b from-navy-950 via-navy-950/55 to-navy-950/90" />
      </div>

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
