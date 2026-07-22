"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { ArrowRight, Bot, ChevronDown, LayoutGrid, Menu, X } from "lucide-react";
import gsap from "gsap";
import { cn } from "@/lib/utils";
import { Container, CtaButton } from "@/components/marketing/ui";
import {
  DUR,
  EASE_OUT,
  scrollToAnchor,
  useGsap,
} from "@/components/marketing/gsap";
import { SITE_NAME } from "@/lib/marketing-nav";
import { PRODUCTS_MENU } from "@/lib/marketing-content";

// Same-page anchor links (e.g. the Products dropdown's "/features#mcp")
// get a GSAP-driven scroll instead of a full Next navigation when we're
// already on the target page — smoother, and keeps the fixed nav offset
// consistent with the rest of the site's motion language.
function handleAnchorNavigate(
  e: ReactMouseEvent<HTMLAnchorElement>,
  href: string,
  pathname: string,
) {
  const hashIndex = href.indexOf("#");
  if (hashIndex === -1) return;
  const base = href.slice(0, hashIndex) || "/";
  if (pathname !== base) return; // different page — let Next handle it
  const hash = href.slice(hashIndex);
  const target = document.querySelector(hash);
  if (!target) return;
  e.preventDefault();
  scrollToAnchor(hash, {
    offsetY: 80,
    onComplete: () => window.history.replaceState(null, "", href),
  });
}

// Fixed top nav for the logged-out site. Transparent over the azure hero
// at the very top of "/"; solid navy glass everywhere else (any other
// route, or "/" once scrolled). Text is always white — the nav never
// renders dark-on-light.

const NAV_LINKS: { href: string; label: string }[] = [
  { href: "/use-cases", label: "Use cases" },
  { href: "/pricing", label: "Pricing" },
  { href: "/resources", label: "Resources" },
];

const PRODUCT_ICONS: Record<string, typeof LayoutGrid> = {
  "operate Platform": LayoutGrid,
  "operate for Agents": Bot,
};

export function MarketingNav() {
  const pathname = usePathname();
  const isHome = pathname === "/";
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [productsOpen, setProductsOpen] = useState(false);
  const productsRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  // Transparent only on "/" while unscrolled; solid everywhere else.
  const transparent = isHome && !scrolled;

  useEffect(() => {
    if (!isHome) return;
    const onScroll = () => setScrolled(window.scrollY >= 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [isHome]);

  // Close the mobile overlay + products dropdown on route change.
  useEffect(() => {
    setOpen(false);
    setProductsOpen(false);
  }, [pathname]);

  // Lock body scroll while the mobile overlay is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Escape key closes the overlay.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Products dropdown: click-outside + Escape both close it.
  useEffect(() => {
    if (!productsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setProductsOpen(false);
    };
    const onPointerDown = (e: MouseEvent) => {
      if (!productsRef.current?.contains(e.target as Node)) {
        setProductsOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [productsOpen]);

  return (
    <>
      <header
        ref={headerRef}
        className={cn(
          "fixed inset-x-0 top-0 z-50 transition-colors duration-300",
          transparent
            ? "bg-transparent"
            : "border-b border-white/10 bg-background/85 backdrop-blur-md",
        )}
      >
        <Container>
          <div className="flex h-16 items-center justify-between">
            <Link
              href="/"
              className="flex items-center gap-1.5 text-lg font-semibold tracking-tight text-white"
            >
              {SITE_NAME.replace(/\.to$/, "")}
              <span
                aria-hidden
                className="mb-2.5 inline-block size-1.5 rounded-full bg-azure-400"
              />
              <span className="ml-2 hidden text-sm font-normal text-white/60 sm:inline">
                for agents
              </span>
            </Link>

            <nav aria-label="Primary" className="contents">
              <div
                ref={productsRef}
                className="relative hidden items-center gap-0.5 rounded-full bg-white/5 px-2 py-1 ring-1 ring-white/10 md:flex"
              >
                <button
                  type="button"
                  aria-haspopup="true"
                  aria-expanded={productsOpen}
                  onClick={() => setProductsOpen((v) => !v)}
                  className="flex items-center gap-1 rounded-full px-3 py-1.5 text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-white"
                >
                  Products
                  <ChevronDown
                    aria-hidden
                    className={cn(
                      "size-3.5 transition-transform duration-200",
                      productsOpen && "rotate-180",
                    )}
                  />
                </button>
                {NAV_LINKS.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="rounded-full px-3 py-1.5 text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-white"
                  >
                    {link.label}
                  </Link>
                ))}

                {productsOpen && (
                  <ProductsDropdown
                    pathname={pathname}
                    onClose={() => setProductsOpen(false)}
                  />
                )}
              </div>
            </nav>

            <div className="hidden items-center gap-3 md:flex">
              <Link
                href="/sign-in"
                className="rounded-full bg-white/10 px-4 py-1.5 text-sm font-medium text-white ring-1 ring-white/15 transition-colors hover:bg-white/20"
              >
                Log in
              </Link>
              <CtaButton href="/sign-up" variant="primary" size="md">
                Start free
              </CtaButton>
            </div>

            <button
              type="button"
              ref={menuButtonRef}
              aria-label="Open menu"
              onClick={() => setOpen(true)}
              className="tap-target -mr-1 flex items-center justify-center text-white md:hidden"
            >
              <Menu className="size-6" aria-hidden />
            </button>
          </div>
        </Container>
      </header>

      {open && (
        <MobileOverlay
          onClose={() => setOpen(false)}
          triggerRef={menuButtonRef}
          headerRef={headerRef}
        />
      )}
    </>
  );
}

function ProductsDropdown({
  pathname,
  onClose,
}: {
  pathname: string;
  onClose: () => void;
}) {
  const rootRef = useGsap(({ root }) => {
    gsap.fromTo(
      root,
      { autoAlpha: 0, y: -6, scale: 0.98 },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: DUR.fast,
        ease: EASE_OUT,
      },
    );
  });

  return (
    <div
      ref={rootRef}
      className="absolute left-0 top-full mt-2 w-[26rem] rounded-2xl mk-panel-2 p-2 shadow-2xl backdrop-blur-xl"
    >
      {PRODUCTS_MENU.items.map((item) => {
        const Icon = PRODUCT_ICONS[item.title] ?? LayoutGrid;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={(e) => {
              handleAnchorNavigate(e, item.href, pathname);
              onClose();
            }}
            className="flex gap-3 rounded-xl p-3 transition-colors hover:bg-white/5"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/5 ring-1 ring-white/15">
              <Icon className="size-4 text-white/80" aria-hidden />
            </span>
            <span>
              <span className="block text-sm font-semibold text-white">
                {item.title}
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-white/60">
                {item.body}
              </span>
            </span>
          </Link>
        );
      })}
      <div className="my-1 border-t border-white/10" />
      <Link
        href={PRODUCTS_MENU.compare.href}
        onClick={onClose}
        className="flex items-center justify-between rounded-xl p-3 text-sm text-white/80 transition-colors hover:bg-white/5"
      >
        {PRODUCTS_MENU.compare.label}
        <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </div>
  );
}

function MobileOverlay({
  onClose,
  triggerRef,
  headerRef,
}: {
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  headerRef: RefObject<HTMLElement | null>;
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useGsap(({ root }) => {
    gsap.fromTo(
      root.querySelectorAll("[data-gs-item]"),
      { autoAlpha: 0, y: 20 },
      {
        autoAlpha: 1,
        y: 0,
        duration: 0.5,
        ease: EASE_OUT,
        stagger: 0.06,
      },
    );
  });

  // Dialog focus lifecycle: move focus into the overlay (close button) on
  // open, hide the fixed header from the accessibility tree + tab order
  // while the overlay covers it, and restore focus to the hamburger
  // trigger that opened it once the overlay unmounts.
  useEffect(() => {
    const header = headerRef.current;
    const trigger = triggerRef.current;
    header?.setAttribute("inert", "");
    closeButtonRef.current?.focus();
    return () => {
      header?.removeAttribute("inert");
      trigger?.focus();
    };
  }, [headerRef, triggerRef]);

  // Trap Tab/Shift+Tab within the overlay's focusable elements.
  useEffect(() => {
    const container = rootRef.current;
    if (!container) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = container.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    container.addEventListener("keydown", onKeyDown);
    return () => container.removeEventListener("keydown", onKeyDown);
  }, [rootRef]);

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="Menu"
      className="fixed inset-0 z-50 flex flex-col bg-navy-950 md:hidden"
    >
      <Container>
        <div className="flex h-16 items-center justify-between">
          <Link
            href="/"
            onClick={onClose}
            className="flex items-center gap-1.5 text-lg font-semibold tracking-tight text-white"
          >
            {SITE_NAME.replace(/\.to$/, "")}
            <span
              aria-hidden
              className="mb-2.5 inline-block size-1.5 rounded-full bg-azure-400"
            />
          </Link>
          <button
            type="button"
            ref={closeButtonRef}
            aria-label="Close menu"
            onClick={onClose}
            className="tap-target -mr-1 flex items-center justify-center text-white"
          >
            <X className="size-6" aria-hidden />
          </button>
        </div>
      </Container>

      <nav
        aria-label="Primary, mobile"
        className="flex flex-1 flex-col justify-center gap-2 px-8"
      >
        {PRODUCTS_MENU.items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            onClick={onClose}
            data-gs-item
            className="py-3 text-3xl font-semibold tracking-tight text-white"
          >
            {item.title}
          </Link>
        ))}
        {NAV_LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            onClick={onClose}
            data-gs-item
            className="py-3 text-3xl font-semibold tracking-tight text-white"
          >
            {link.label}
          </Link>
        ))}
      </nav>

      <Container className="mb-10 flex flex-col gap-3">
        <Link
          href="/sign-in"
          onClick={onClose}
          data-gs-item
          className="flex h-12 items-center justify-center rounded-full bg-white/10 text-sm font-medium text-white ring-1 ring-inset ring-white/15"
        >
          Log in
        </Link>
        <div data-gs-item>
          <CtaButton
            href="/sign-up"
            variant="onDark"
            size="lg"
            className="w-full"
          >
            Start free
          </CtaButton>
        </div>
      </Container>
    </div>
  );
}
