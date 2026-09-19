import Link from "next/link";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  ReactNode,
} from "react";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { totalLabel } from "@/lib/deel-chrome";

/**
 * Shared 2025 Deel surfaces, tailored to operate.
 *
 * Read from Mobbin Deel web (people table, worker/contract profile,
 * compliance metrics, funds empty, dialogs): unboxed tables, one filter
 * capsule, blue name links, status as a coloured dot + word, KV cards,
 * a pale empty blob, and a back link over a large name. Nothing here is
 * a second product — these are the default chrome every operate page
 * should already be speaking.
 */

export function StatusDot({
  color,
  label,
  className,
}: {
  color: string;
  label: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm text-foreground",
        className,
      )}
    >
      <span
        aria-hidden
        className="inline-block size-2 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}

export function DeelFilterBar({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("deel-filter-bar", className)} {...props}>
      {children}
    </div>
  );
}

export function TotalCount({
  count,
  singular,
  plural,
  className,
}: {
  count: number;
  singular: string;
  plural?: string;
  className?: string;
}) {
  return (
    <p className={cn("text-xs text-muted-foreground", className)}>
      {totalLabel(count, singular, plural)}
    </p>
  );
}

export function BackLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground",
        className,
      )}
    >
      <ChevronLeft className="size-4" aria-hidden />
      {children}
    </Link>
  );
}

export function KvCard({
  title,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("deel-kv-card", className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 px-5 py-3.5">
          {title ? (
            <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          ) : (
            <span />
          )}
          {action}
        </header>
      )}
      <div>{children}</div>
    </section>
  );
}

export function KvRow({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("deel-kv-row", className)}>
      <dt className="min-w-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-sm text-foreground">{children}</dd>
    </div>
  );
}

export function MetricStrip({
  items,
  className,
}: {
  items: {
    value: ReactNode;
    label: string;
    tone?: string;
  }[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid gap-3 sm:grid-cols-2 lg:grid-cols-3",
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.label} className="deel-metric-tile">
          <p className="font-title text-2xl font-semibold tracking-tight text-foreground">
            {item.value}
          </p>
          <p className="mt-2 inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            {item.tone ? (
              <span
                aria-hidden
                className="inline-block size-2 rounded-full"
                style={{ backgroundColor: item.tone }}
              />
            ) : null}
            {item.label}
          </p>
        </div>
      ))}
    </div>
  );
}

export function EmptyBlob({
  title,
  message,
  action,
  className,
}: {
  title: string;
  message?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-16 text-center", className)}>
      <PaleBlob />
      <p className="mt-5 text-sm font-medium text-foreground">{title}</p>
      {message ? (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{message}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

function PaleBlob() {
  return (
    <svg
      width="88"
      height="64"
      viewBox="0 0 88 64"
      aria-hidden
      className="deel-empty-blob"
    >
      <ellipse cx="44" cy="36" rx="40" ry="22" fill="currentColor" />
      <path
        d="M36 28c0-6 4-12 8-12s8 6 8 12c2-4 8-6 10-2 2 5-4 10-10 10h-16c-6 0-12-5-10-10 2-4 8-2 10 2z"
        fill="none"
        stroke="var(--color-link)"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="2.5 2.2"
      />
    </svg>
  );
}

export function NameLink({
  href,
  children,
  className,
  done,
  scroll,
  style,
  title,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  done?: boolean;
  scroll?: boolean;
  style?: CSSProperties;
  title?: string;
}) {
  return (
    <Link
      href={href}
      scroll={scroll}
      style={style}
      title={title}
      className={cn(
        "deel-name-link min-w-0 font-medium hover:underline",
        done && "text-muted-foreground line-through",
        className,
      )}
    >
      {children}
    </Link>
  );
}

export function FilterPill({
  active,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn("deel-filter-pill", active && "deel-filter-pill-on", className)}
      {...props}
    >
      {children}
    </button>
  );
}

export function SettingsGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("deel-settings-grid", className)}>{children}</div>;
}

export function DeelTabs({
  children,
  label,
  className,
}: {
  children: ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <nav aria-label={label} className={cn("deel-tabs", className)}>
      {children}
    </nav>
  );
}

export function deelTabClass(current?: boolean, className?: string) {
  return cn("deel-tab", current && "deel-tab-on", className);
}
