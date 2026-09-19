"use client";

import Link from "next/link";
import { Bell, Menu, Search, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { cn } from "@/lib/utils";
import { useSidebar } from "@/components/ui/sidebar";
import { UserAvatar } from "@/components/identity/user-avatar";

/**
 * Deel page lead (Mobbin people / documents / profile / funds).
 *
 * The lavender AppTopNav is the only sticky chrome. Inner pages open with
 * a large name on the left and actions on the right — no second sticky
 * strip, no icon tile, no "List" eyebrow repeating the route. Optional
 * description and context sit under the title; tabs/filters are children.
 */

export function PageHeader({
  title,
  context,
  actions,
  className,
  children,
  headline = true,
  description,
  headlineActions,
  hideTitle = false,
}: {
  icon?: LucideIcon;
  title: string;
  /** Quiet inline context after the title: counts, place, timestamps. */
  context?: ReactNode;
  /** Right-aligned action cluster. */
  actions?: ReactNode;
  className?: string;
  /** Optional second row (tab strips, filter bars). */
  children?: ReactNode;
  /**
   * The large title block.
   *
   * `true` (the default) renders `title` at Deel's page-title size.
   * A node replaces the text. `false` is for Home (greeting is the h1) and
   * full-bleed editors.
   */
  headline?: boolean | ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  headlineActions?: ReactNode;
  /** Hide the visible title. Home's greeting is the page title. */
  hideTitle?: boolean;
}) {
  const { toggleSidebar } = useSidebar();
  const showHeadline = headline !== false && !hideTitle;
  const heading = headline === true ? title : headline;
  const right = headlineActions ?? actions;

  return (
    <div className={cn("mb-6", className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <button
            type="button"
            aria-label="Open navigation"
            onClick={toggleSidebar}
            className="tap-target -ml-1 mt-0.5 flex size-9 flex-shrink-0 items-center justify-center rounded-full text-foreground hover:bg-muted md:hidden"
          >
            <Menu className="size-4" aria-hidden />
          </button>
          <div className="min-w-0">
            {showHeadline ? (
              <h1 className="text-balance text-[1.75rem] font-semibold leading-tight tracking-tight text-foreground">
                {heading}
              </h1>
            ) : (
              <p className="sr-only">{title}</p>
            )}
            {description ? (
              <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">
                {description}
              </p>
            ) : null}
            {context ? (
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
                {context}
              </div>
            ) : null}
          </div>
        </div>
        {right ? (
          <div className="flex min-w-0 flex-shrink-0 items-center gap-2">
            {right}
          </div>
        ) : null}
      </div>
      {children ? <div className="mt-4 space-y-3">{children}</div> : null}
    </div>
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
        className="tap-target relative flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Search aria-hidden className="size-4" />
      </button>
      <Link
        href="/dashboard/inbox"
        aria-label={unread > 0 ? `Inbox, ${unread} unread` : "Inbox"}
        className="tap-target relative flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
