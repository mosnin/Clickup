"use client";

import Link from "next/link";
import { Bell, Menu, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import { motion } from "motion/react";
import { SPRING } from "@/components/motion";
import { api } from "@convex/_generated/api";
import { cn } from "@/lib/utils";
import { useSidebar } from "@/components/ui/sidebar";
import { Monogram } from "@/components/dashboard/monogram";
import { PageTitle } from "@/components/dashboard/page-title";

// Shell fusion (Phase H): the sticky contextual header every dashboard
// surface mounts at its top — the Square-style shell's grammar expressed
// in our tokens. Left: an optional glyph + the surface's name + quiet
// context (counts, place). Right: the surface's actions (buttons, theme
// toggle, avatar stacks). Sticks under the app's top edge inside the
// scrolling main column.
//
// This intentionally replaces the old `title-rule` page headings on shell
// surfaces — pages keep their own <h1> semantics via the `title` prop.
//
// Every dashboard route renders this as its top element (inside the single
// SidebarProvider from dashboard/layout.tsx), so the mobile "open
// navigation" trigger lives here rather than as a floating button — it
// scrolls (and sticks) with the header instead of permanently overlapping
// whatever the page put at its own top edge (M6).

// ── The big title, and why it is a default rather than a prop ──────────────
//
// Every inner page had chrome and no headline. All three design references
// open a screen the same way — a quiet eyebrow, a large title, then the
// content — and we had built the small half only, which is most of why Home
// looked designed and the other twenty screens looked like a document. The
// large half existed as `PageTitle` and had been adopted on seven pages in
// four months, which is how you can tell that "add it to each page" was never
// going to happen.
//
// So it is on by default here: every surface that mounts a header gets a
// headline, and the ones that genuinely should not — full-bleed editors, where
// the document IS the title — say `headline={false}` once.
//
// The `<h1>` moves with it. Two of them on one page is worse than a small
// title, so the sticky bar's copy drops to a `<p>` exactly when the headline
// is rendering the real one.

export function PageHeader({
  icon: Icon,
  title,
  context,
  actions,
  className,
  children,
  headline = true,
  eyebrow,
  description,
  headlineActions,
}: {
  icon?: LucideIcon;
  title: string;
  /** Quiet inline context after the title: counts, place, timestamps. */
  context?: ReactNode;
  /** Right-aligned action cluster. */
  actions?: ReactNode;
  className?: string;
  /** Optional second row (tab strips, filter bars) inside the sticky area. */
  children?: ReactNode;
  /**
   * The large title block under the sticky bar.
   *
   * `true` (the default) renders `title` at headline size. A node replaces the
   * text — a rename affordance, a name beside a status chip. `false` is for
   * full-bleed editors only.
   */
  headline?: boolean | ReactNode;
  /** What this screen is FOR. Omit rather than restating the title. */
  eyebrow?: ReactNode;
  /** One line under the headline. */
  description?: ReactNode;
  /**
   * Actions that belong beside the headline rather than in the sticky bar.
   *
   * Most do not: an action that scrolls away is an action you have to scroll
   * back for. This is for the ones that are about the title itself.
   */
  headlineActions?: ReactNode;
}) {
  const { toggleSidebar } = useSidebar();
  const Heading = headline === false ? "h1" : "p";

  return (
    <>
    {/* ── The capsule ──────────────────────────────────────────────────────
        The reference's welcome bar: one rounded-full capsule holding the
        page's name on the left and its controls on the right, floating over
        the content, WHITE even when the app is dark. That last part is the
        whole trick — a light island on a dark window is what makes the bar
        read as chrome that belongs to the product rather than to the page —
        and `.ui-light-island` re-declares the light theme's tokens inside it
        so everything a page passes in (buttons, chips, counts) is drawn with
        values that work on white. In light mode the island is a no-op and the
        capsule separates by hairline and shadow.

        The sticky wrapper is OPAQUE. It was bg-background/80 + blur, and a
        card scrolling under an 80% band doesn't read as "behind the chrome" —
        it reads as two components overlapping, which is exactly the defect
        report it earned. Chrome either owns its band completely or it isn't
        chrome. */}
    <div
      className={cn(
        "sticky top-0 z-20 -mx-4 -mt-6 bg-background px-4 pb-2 pt-3 sm:-mx-6 sm:px-6",
        className,
      )}
    >
      {/* Surface tokens, not a light island. The white-in-dark capsule was
          taken from the reference and it read as a defect — "a massive light
          strip at the top" — because unlike the reference we are not
          pitch-black everywhere else: against our charcoal panels and lime
          backdrop a huge white bar is a third loud thing, and Apple would
          never open a dark surface with one. The capsule is chrome; chrome
          wears the theme. */}
      {/* Arrives from above and settles on the spring every other moving
          thing in the app uses. It replays on route changes, which is the
          point: the chrome greets each screen instead of being furniture. */}
      <motion.div
        initial={{ y: -14, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={SPRING}
        className="flex min-h-12 items-center justify-between gap-x-3 rounded-full bg-card py-1.5 pl-4 pr-2 shadow-[var(--ui-shadow-md)]"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <button
            type="button"
            aria-label="Open navigation"
            onClick={toggleSidebar}
            // The only way to the sidebar below `md`, so it keeps a real
            // 44px-class target — drawn as one of the capsule's circular
            // controls rather than as an invisible halo.
            className="-ml-2 flex size-9 flex-shrink-0 items-center justify-center rounded-full bg-muted text-foreground md:hidden"
          >
            <Menu className="size-4" aria-hidden />
          </button>
          {Icon && (
            <Icon
              aria-hidden
              className="size-4 flex-shrink-0 text-muted-foreground"
            />
          )}
          <Heading className="truncate text-sm font-bold tracking-tight">
            {title}
          </Heading>
          {context && (
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              {context}
            </div>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-2 min-w-0">
          {actions}
          <CapsuleCluster />
        </div>
      </motion.div>
      {children && <div className="pt-2">{children}</div>}
    </div>
    {headline !== false && (
      // Outside the sticky element on purpose: chrome sticks and stays small,
      // the headline scrolls away and is allowed to be large. `mt-6` restores
      // the gutter the header's own `-mt-6` cancelled.
      <PageTitle
        className="mt-6"
        eyebrow={eyebrow}
        title={headline === true ? title : headline}
        description={description}
        actions={headlineActions}
      />
    )}
    </>
  );
}

/**
 * The capsule's right end: notifications, then you.
 *
 * The reference's welcome bar closes with exactly this — a circular bell and
 * the avatar — and it is what makes the capsule the product's chrome rather
 * than a titled div: whichever page you are on, the same two things hold the
 * right edge. One header is mounted at a time, so the unread subscriptions
 * here cost what the sidebar's badge already costs, not a multiple of it.
 *
 * Exported so Chat's top chrome (`chat/shell/top-chrome.tsx`) can mount the
 * same cluster at the same end of its own capsule — one chrome, both modes,
 * rather than a lookalike bell that can drift from this one.
 */
export function CapsuleCluster() {
  const me = useQuery(api.users.current, {});
  const unreadMentions = useQuery(api.mentions.unreadCountForCurrent, {});
  const unreadUpdates = useQuery(api.notificationCenter.unreadCount, {});
  const unread = (unreadMentions ?? 0) + (unreadUpdates ?? 0);
  return (
    <div className="flex items-center gap-1.5 pl-1">
      <Link
        href="/dashboard/inbox"
        aria-label={unread > 0 ? `Inbox, ${unread} unread` : "Inbox"}
        className="relative flex size-9 items-center justify-center rounded-full bg-background text-foreground transition-colors hover:bg-muted"
      >
        <Bell aria-hidden className="size-4" />
        {unread > 0 && (
          <span
            aria-hidden
            className="absolute right-1 top-1 size-2 rounded-full bg-signal-lime ring-2 ring-card"
          />
        )}
      </Link>
      {/* A name can lag the row (webhook sync), and a cluster missing its
          avatar reads as broken chrome — fall back rather than vanish. */}
      {me ? (
        <Monogram name={me.name || "You"} seed={me.clerkId} size="md" />
      ) : null}
    </div>
  );
}
