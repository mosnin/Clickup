"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Shell fusion (Phase H): the sticky contextual header every dashboard
// surface mounts at its top — the Square-style shell's grammar expressed
// in our tokens. Left: an optional glyph + the surface's name + quiet
// context (counts, place). Right: the surface's actions (buttons, theme
// toggle, avatar stacks). Sticks under the app's top edge inside the
// scrolling main column.
//
// This intentionally replaces the old `title-rule` page headings on shell
// surfaces — pages keep their own <h1> semantics via the `title` prop.

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
  return (
    <div
      className={cn(
        "sticky top-0 z-20 -mx-4 border-b border-border bg-card/95 px-4 backdrop-blur-sm sm:-mx-6 sm:px-6",
        className,
      )}
    >
      <div className="flex min-h-[52px] flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
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
