import type { ReactNode } from "react";
import Link from "next/link";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Deel's widget chrome: 16px semibold title on the left, optional count,
 * overflow affordance on the right, optional "View all" footer.
 *
 * Used inside `StyledSurface` so the studio still restyles the card. This
 * component only draws the header/footer Deel puts on every homepage widget.
 */
export function DeelWidgetHeader({
  title,
  subtitle,
  href,
  menu,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  href?: string;
  menu?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-4">
      <div className="min-w-0">
        <h3 className="truncate text-base font-semibold tracking-tight text-foreground">
          {title}
        </h3>
        {subtitle ? (
          <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>
      {menu ??
        (href ? (
          <Link
            href={href}
            aria-label="Open"
            className="tap-target -mr-1 flex size-8 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </Link>
        ) : null)}
    </div>
  );
}

export function DeelWidgetFooter({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "mt-auto flex items-center justify-between gap-2 border-t border-border px-5 py-3 text-sm font-medium text-[var(--color-link)] transition-colors hover:underline",
      )}
    >
      {children}
    </Link>
  );
}
