"use client";

import { Menu, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useSidebar } from "@/components/ui/sidebar";

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

export function PageHeader({
  icon: Icon,
  title,
  context,
  actions,
  className,
  children,
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
}) {
  const { toggleSidebar } = useSidebar();

  return (
    <div
      className={cn(
        "sticky top-0 z-20 -mx-4 border-b border-border bg-card/95 px-4 backdrop-blur-sm sm:-mx-6 sm:px-6",
        className,
      )}
    >
      <div className="flex min-h-[52px] flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            aria-label="Open navigation"
            onClick={toggleSidebar}
            className="-ml-1.5 flex size-8 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground md:hidden"
          >
            <Menu className="size-4" aria-hidden />
          </button>
          {Icon && (
            <Icon
              aria-hidden
              className="size-4 flex-shrink-0 text-muted-foreground"
            />
          )}
          <h1 className="truncate text-sm font-semibold tracking-tight">
            {title}
          </h1>
          {context && (
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              {context}
            </div>
          )}
        </div>
        {actions && (
          <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>
        )}
      </div>
      {children}
    </div>
  );
}
