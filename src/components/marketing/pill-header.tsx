"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, ChevronDown, Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnimatePresence, EASE, motion } from "@/components/motion";
import {
  MEGA_MENUS,
  PLAIN_LINKS,
  SITE_NAME,
  type NavLeaf,
} from "@/lib/marketing-nav";

// The marketing pill header: a floating, blurred pill that expands as you
// scroll, with hover/click mega menus (Features, Use cases, Resources) on
// desktop and a full-screen staggered menu on mobile.

export function PillHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close the mega menu on outside click / Escape.
  useEffect(() => {
    if (!menu) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenu(null);
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // Lock page scroll behind the full-screen mobile menu.
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  const active = MEGA_MENUS.find((m) => m.key === menu);

  return (
    <header className="fixed inset-x-0 top-0 z-50 px-3 pt-3 sm:px-6 sm:pt-5">
      <div
        ref={rootRef}
        onMouseLeave={() => setMenu(null)}
        className="relative mx-auto w-full"
        style={{ maxWidth: 1120 }}
      >
        <motion.nav
          aria-label="Primary"
          initial={false}
          animate={{
            maxWidth: scrolled ? 1120 : 1000,
            paddingTop: scrolled ? 10 : 7,
            paddingBottom: scrolled ? 10 : 7,
          }}
          transition={{ type: "spring", stiffness: 220, damping: 30 }}
          className={cn(
            "mx-auto flex items-center justify-between gap-2 rounded-full border px-3 backdrop-blur-xl transition-[background-color,border-color,box-shadow] duration-500 sm:px-4",
            scrolled
              ? "border-black/[0.07] bg-white/85 shadow-[0_16px_40px_-20px_rgb(16_16_18/0.35)]"
              : "border-white/40 bg-white/60 shadow-none",
          )}
        >
          <Link
            href="/"
            className="flex items-center gap-2 whitespace-nowrap px-2 text-[13px] font-extrabold uppercase tracking-[0.18em]"
          >
            <span
              aria-hidden
              className="inline-block h-3.5 w-3.5 rounded-[4px] bg-foreground"
            />
            {SITE_NAME}
          </Link>

          <ul className="hidden items-center lg:flex">
            {MEGA_MENUS.map((m) => (
              <li key={m.key}>
                <button
                  type="button"
                  aria-expanded={menu === m.key}
                  onMouseEnter={() => setMenu(m.key)}
                  onClick={() => setMenu((cur) => (cur === m.key ? null : m.key))}
                  className={cn(
                    "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-3 py-1.5 text-sm transition-colors",
                    menu === m.key
                      ? "bg-black/[0.05] text-foreground"
                      : "text-foreground/70 hover:text-foreground",
                  )}
                >
                  {m.label}
                  <ChevronDown
                    className={cn(
                      "h-3 w-3 transition-transform duration-300",
                      menu === m.key && "rotate-180",
                    )}
                  />
                </button>
              </li>
            ))}
            {PLAIN_LINKS.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  onMouseEnter={() => setMenu(null)}
                  className="whitespace-nowrap rounded-full px-3 py-1.5 text-sm text-foreground/70 transition-colors hover:text-foreground"
                >
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>

          <div className="hidden items-center gap-1.5 lg:flex">
            <Link
              href="/sign-in"
              className="whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-medium text-foreground/80 transition-colors hover:text-foreground"
            >
              Log in
            </Link>
            <Link
              href="/sign-up"
              className="group inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-foreground px-4 py-1.5 text-sm font-semibold text-white transition-transform active:scale-[0.97]"
            >
              Get started
              <ArrowRight className="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-0.5" />
            </Link>
          </div>

          <button
            type="button"
            aria-label="Open menu"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen(true)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-black/5 lg:hidden"
          >
            <Menu className="h-5 w-5" />
          </button>
        </motion.nav>

        {/* ── Desktop mega menu panel ── */}
        <AnimatePresence>
          {active && (
            <motion.div
              key={active.key}
              initial={{ opacity: 0, y: 10, scale: 0.985, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: 8, scale: 0.99, filter: "blur(4px)" }}
              transition={{ duration: 0.3, ease: EASE }}
              className="absolute left-1/2 top-full z-50 mt-2 hidden w-[min(760px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-3xl border border-black/[0.07] bg-white/95 p-2 shadow-[0_32px_80px_-24px_rgb(16_16_18/0.4)] backdrop-blur-2xl lg:block"
            >
              <div className="flex gap-2">
                <ul
                  className={cn(
                    "grid flex-1 content-start gap-0.5 p-2",
                    active.columns === 2 && "grid-cols-2",
                  )}
                >
                  {active.links.map((link, i) => (
                    <motion.li
                      key={link.href}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.35, ease: EASE, delay: 0.04 * i }}
                    >
                      <MegaLink link={link} onNavigate={() => setMenu(null)} />
                    </motion.li>
                  ))}
                </ul>
                <MenuHighlight
                  menuKey={active.key}
                  onNavigate={() => setMenu(null)}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Full-screen mobile menu ── */}
      <AnimatePresence>
        {mobileOpen && <MobileMenu onClose={() => setMobileOpen(false)} />}
      </AnimatePresence>
    </header>
  );
}

function MegaLink({
  link,
  onNavigate,
}: {
  link: NavLeaf;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={link.href}
      onClick={onNavigate}
      className="group block rounded-2xl px-3 py-2.5 transition-colors hover:bg-sage-100/70"
    >
      <span className="flex items-center gap-1 text-sm font-semibold">
        {link.label}
        <ArrowRight className="h-3 w-3 -translate-x-1 opacity-0 transition-all duration-300 group-hover:translate-x-0 group-hover:opacity-100" />
      </span>
      <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
        {link.description}
      </span>
    </Link>
  );
}

const HIGHLIGHTS: Record<
  string,
  { eyebrow: string; title: string; href: string; cta: string }
> = {
  features: {
    eyebrow: "See it live",
    title: "Bring your first agent online in under two minutes.",
    href: "/sign-up",
    cta: "Start free",
  },
  "use-cases": {
    eyebrow: "Every team",
    title: "One coordination layer, whatever the work looks like.",
    href: "/use-cases",
    cta: "Browse all",
  },
  resources: {
    eyebrow: "New",
    title: "Read what shipped in the latest release.",
    href: "/resources/changelog",
    cta: "Changelog",
  },
};

function MenuHighlight({
  menuKey,
  onNavigate,
}: {
  menuKey: string;
  onNavigate: () => void;
}) {
  const h = HIGHLIGHTS[menuKey];
  if (!h) return null;
  return (
    <Link
      href={h.href}
      onClick={onNavigate}
      className="group relative flex w-56 flex-shrink-0 flex-col justify-between overflow-hidden rounded-2xl bg-moss-900 p-4 text-white"
    >
      <span
        aria-hidden
        className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-[radial-gradient(closest-side,#7f906a,transparent_70%)] opacity-60 blur-xl transition-transform duration-700 group-hover:scale-125"
      />
      <span className="relative text-[10px] font-semibold uppercase tracking-[0.16em] text-sage-300">
        {h.eyebrow}
      </span>
      <span className="relative mt-6 text-sm font-semibold leading-snug">
        {h.title}
      </span>
      <span className="relative mt-4 inline-flex items-center gap-1 text-xs font-semibold text-sage-200">
        {h.cta}
        <ArrowRight className="h-3 w-3 transition-transform duration-300 group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}

// Full-screen mobile menu: cream sheet, grouped links cascading in.
function MobileMenu({ onClose }: { onClose: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3, ease: EASE }}
      className="grain fixed inset-0 z-[60] flex flex-col bg-cream lg:hidden"
    >
      <div className="flex items-center justify-between px-5 pb-2 pt-5">
        <Link
          href="/"
          onClick={onClose}
          className="flex items-center gap-2 text-[13px] font-extrabold uppercase tracking-[0.18em]"
        >
          <span
            aria-hidden
            className="inline-block h-3.5 w-3.5 rounded-[4px] bg-foreground"
          />
          {SITE_NAME}
        </Link>
        <button
          type="button"
          aria-label="Close menu"
          onClick={onClose}
          className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-black/10 bg-white/70"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <motion.nav
        aria-label="Mobile"
        className="flex-1 overflow-y-auto px-5 pb-6"
        initial="hidden"
        animate="show"
        variants={{
          hidden: {},
          show: { transition: { staggerChildren: 0.05, delayChildren: 0.1 } },
        }}
      >
        <MobileGroup
          title="Product"
          links={[
            { href: "/features", label: "Features", description: "" },
            { href: "/pricing", label: "Pricing", description: "" },
            { href: "/company", label: "Company", description: "" },
          ]}
          big
          onNavigate={onClose}
        />
        {MEGA_MENUS.filter((m) => m.key !== "features").map((m) => (
          <MobileGroup
            key={m.key}
            title={m.label}
            links={m.links}
            onNavigate={onClose}
          />
        ))}
      </motion.nav>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: EASE, delay: 0.35 }}
        className="grid grid-cols-2 gap-2 border-t border-black/[0.07] bg-cream/90 px-5 py-4 backdrop-blur"
      >
        <Link
          href="/sign-in"
          onClick={onClose}
          className="inline-flex items-center justify-center rounded-full border border-black/15 bg-white px-4 py-3 text-sm font-semibold"
        >
          Log in
        </Link>
        <Link
          href="/sign-up"
          onClick={onClose}
          className="inline-flex items-center justify-center gap-1.5 rounded-full bg-foreground px-4 py-3 text-sm font-semibold text-white"
        >
          Get started <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </motion.div>
    </motion.div>
  );
}

function MobileGroup({
  title,
  links,
  big = false,
  onNavigate,
}: {
  title: string;
  links: NavLeaf[];
  big?: boolean;
  onNavigate: () => void;
}) {
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 16, filter: "blur(4px)" },
        show: {
          opacity: 1,
          y: 0,
          filter: "blur(0px)",
          transition: { duration: 0.45, ease: EASE },
        },
      }}
      className="border-b border-black/[0.07] py-4 last:border-0"
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {title}
      </p>
      <ul className={cn("mt-2", big ? "space-y-1" : "grid grid-cols-1 gap-0.5")}>
        {links.map((l) => (
          <li key={l.href}>
            <Link
              href={l.href}
              onClick={onNavigate}
              className={cn(
                "group flex items-center justify-between rounded-xl py-1.5 pr-1",
                big
                  ? "text-2xl font-bold tracking-tight"
                  : "text-base font-medium",
              )}
            >
              {l.label}
              <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform duration-300 group-active:translate-x-1" />
            </Link>
          </li>
        ))}
      </ul>
    </motion.div>
  );
}
