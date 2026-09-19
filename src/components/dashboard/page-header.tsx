"use client";

import Link from "next/link";
import { Bell, Menu, Search, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { cn } from "@/lib/utils";
import { useSidebar } from "@/components/ui/sidebar";
import { UserAvatar } from "@/components/identity/user-avatar";
import { PageTitle } from "@/components/dashboard/page-title";

// Deel top bar: a thin white strip, hairline underneath, title on the left,
// actions + search + bell + avatar on the right. No capsule, no spring
// entrance, no light-island — those were the previous product's chrome and
// they are the first thing that made every page look unlike Deel.
//
// The sticky wrapper is opaque. Chrome either owns its band or it is not
// chrome. Headline (the 24px page title) sits UNDER the bar and scrolls away.

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
  hideTitle = false,
}: {
  icon?: LucideIcon;
  title: string;
  /** Quiet inline context after the title: counts, place, timestamps. */
  context?: ReactNode;
  /** Right-aligned action cluster, before the global search/bell/avatar. */
  actions?: ReactNode;
  className?: string;
  /** Optional second row (tab strips, filter bars) inside the sticky area. */
  children?: ReactNode;
  /**
   * The large title block under the sticky bar.
   *
   * `true` (the default) renders `title` at Deel's 24px page-title size.
   * A node replaces the text. `false` is for Home (greeting is the h1) and
   * full-bleed editors.
   */
  headline?: boolean | ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  headlineActions?: ReactNode;
  /** Hide the bar title. Home's greeting is the page title; "Home" in the
      strip would be Deel wearing a tab label. The string still names the
      page for anyone reading the DOM. */
  hideTitle?: boolean;
}) {
  const { toggleSidebar } = useSidebar();
  // The bar is always chrome. The real <h1> is either PageTitle (headline
  // on) or the page itself (Home's greeting). Two h1s on one screen is
  // worse than a small title.

  return (
    <>
    <div
      className={cn(
        "sticky top-0 z-20 -mx-4 -mt-6 border-b border-border bg-background px-4 pb-3 pt-3 sm:-mx-6 sm:px-6",
        className,
      )}
    >
      <div className="flex min-h-10 items-center justify-between gap-x-3">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <button
            type="button"
            aria-label="Open navigation"
            onClick={toggleSidebar}
            className="tap-target -ml-1 flex size-9 flex-shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] text-foreground hover:bg-muted md:hidden"
          >
            <Menu className="size-4" aria-hidden />
          </button>
          {Icon && (
            <Icon
              aria-hidden
              className="size-4 flex-shrink-0 text-muted-foreground"
            />
          )}
          <p
            className={cn(
              "truncate text-compact font-semibold tracking-tight text-foreground",
              // When the 24px page title is on the page, the bar repeating
              // it is Deel wearing a tab label. Home also hides it (greeting
              // is the title). Screen readers still get the name.
              (hideTitle || headline !== false) && "sr-only",
            )}
          >
            {title}
          </p>
          {context && (
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              {context}
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-shrink-0 items-center gap-1.5">
          {actions}
          <CapsuleCluster />
        </div>
      </div>
      {children && <div className="pt-2">{children}</div>}
    </div>
    {headline !== false && (
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
 * The product's right-edge chrome: search, notifications, you.
 *
 * Deel puts these three in the top-right of every page. Exported so Chat's
 * top chrome can mount the same cluster rather than a lookalike that drifts.
 */
export function CapsuleCluster() {
  const me = useQuery(api.users.current, {});
  const unreadMentions = useQuery(api.mentions.unreadCountForCurrent, {});
  const unreadUpdates = useQuery(api.notificationCenter.unreadCount, {});
  const waitingOnYou = useQuery(api.obligations.countForCurrentUser, {});
  const unread =
    (unreadMentions ?? 0) + (unreadUpdates ?? 0) + (waitingOnYou ?? 0);
  return (
    <div className="flex items-center gap-0.5 pl-1">
      <button
        type="button"
        aria-label="Search"
        onClick={() => window.dispatchEvent(new CustomEvent("open-command-palette"))}
        className="tap-target relative flex size-9 items-center justify-center rounded-[var(--ui-radius-control)] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Search aria-hidden className="size-4" />
      </button>
      <Link
        href="/dashboard/inbox"
        aria-label={unread > 0 ? `Inbox, ${unread} unread` : "Inbox"}
        className="tap-target relative flex size-9 items-center justify-center rounded-[var(--ui-radius-control)] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Bell aria-hidden className="size-4" />
        {unread > 0 && (
          <span
            aria-hidden
            className="absolute right-1.5 top-1.5 size-2 rounded-full bg-[var(--color-unread)] ring-2 ring-background"
          />
        )}
      </Link>
      {me ? (
        <UserAvatar
          name={me.name || "You"}
          seed={me.clerkId}
          imageUrl={me.imageUrl}
          size="md"
        />
      ) : null}
    </div>
  );
}
