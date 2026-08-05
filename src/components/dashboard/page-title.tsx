import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// The big title block, below the sticky chrome.
//
// `PageHeader` already exists and every surface mounts it — but it is a 52px
// sticky bar with a 14px title, which is *chrome*: where am I, what can I do
// here. It is not a page header in the sense the design references mean, and
// its absence is most of why the inner pages read as flat next to Home. All
// three references open a screen the same way: a quiet eyebrow line, then a
// large title, then the content. Panze and Atlassian keep a compact bar above
// it, which is exactly the arrangement we already have — the big half was
// simply never built.
//
// So this sits *under* PageHeader rather than replacing it. Chrome sticks and
// stays small; the title scrolls away and is allowed to be large.
//
// The eyebrow earns its place by saying what the screen is FOR, not by
// repeating the title in smaller letters. "Manage and track your projects"
// over "Project Dashboard" works; "Projects" over "Projects" is noise and
// should be omitted — which is why `eyebrow` is optional and there is no
// default.

export function PageTitle({
  eyebrow,
  title,
  description,
  actions,
  className,
  children,
}: {
  /** What this screen is for. Omit rather than restating the title. */
  eyebrow?: ReactNode;
  title: ReactNode;
  /** One line under the title. Longer than that belongs on the page. */
  description?: ReactNode;
  /** Right-aligned cluster: the primary action and at most one other. */
  actions?: ReactNode;
  className?: string;
  /** Optional row below the rule — segmented controls, filters. */
  children?: ReactNode;
}) {
  return (
    <div className={cn("mb-5", className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          {eyebrow ? (
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              {eyebrow}
            </p>
          ) : null}
          {/* Large, and deliberately not `truncate`: a long project name
              wrapping to two lines is better than one silently cut, because
              the name is the one thing on the screen you cannot recover from
              elsewhere. */}
          <h1 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
            {title}
          </h1>
          {description ? (
            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {/* The hairline the brand system already uses under page titles. */}
      <div className="title-rule mt-4" />
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}
