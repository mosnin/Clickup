"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// The card in a board column or a grid.
//
// Board, Projects, Pages and Templates each draw their own version of this
// today, which is the whole reason those four screens do not look like one
// product. The shape all three design references agree on, top to bottom:
//
//   pastel tag chips → title → one line of description → a meta row
//
// The meta row is the part that gets improvised most and matters most: a date
// chip, an avatar stack, small counts. Never a paragraph of grey text, which
// is what a card degrades into when nobody has said what belongs there.
//
// Deliberately NOT taken from the references: tinting the card itself per
// category. Panze gives each task card its own pastel wash, which is lovely
// at four cards and noise at forty — and our brand system already carries
// meaning in chips rather than in surfaces.

export type EntityTag = {
  label: string;
  /** A `--color-pastel-*` name. Meaning lives here, not on the card. */
  tone?: "blue" | "green" | "yellow" | "red" | "purple" | "neutral";
};

const TONE: Record<NonNullable<EntityTag["tone"]>, string> = {
  blue: "bg-pastel-blue text-neutral-900",
  green: "bg-pastel-green text-neutral-900",
  yellow: "bg-pastel-yellow text-neutral-900",
  red: "bg-pastel-red text-neutral-900",
  purple: "bg-pastel-purple text-neutral-900",
  neutral: "bg-muted text-muted-foreground",
};

export function EntityCard({
  href,
  tags,
  title,
  description,
  meta,
  actions,
  className,
}: {
  /** When present the whole card is the link, so the hit area is the card. */
  href?: string;
  tags?: EntityTag[];
  title: ReactNode;
  /** Clamped to two lines — a card is a summary, not the record. */
  description?: ReactNode;
  /** Date chips, avatar stacks, counts. */
  meta?: ReactNode;
  /** Top-right affordance: a menu, a checkbox. */
  actions?: ReactNode;
  className?: string;
}) {
  const body = (
    <>
      {(tags?.length || actions) && (
        <div className="mb-2 flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-wrap gap-1">
            {tags?.map((tag) => (
              <span
                key={tag.label}
                className={cn(
                  "rounded-full px-2 py-0.5 text-tiny font-medium",
                  TONE[tag.tone ?? "neutral"],
                )}
              >
                {tag.label}
              </span>
            ))}
          </div>
          {actions ? (
            <div className="flex shrink-0 items-center gap-1">{actions}</div>
          ) : null}
        </div>
      )}
      <p className="text-sm font-semibold leading-snug">{title}</p>
      {description ? (
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      ) : null}
      {meta ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {meta}
        </div>
      ) : null}
    </>
  );

  const shell = cn(
    "bento block rounded-2xl bg-card p-3.5 text-left",
    href && "lift",
    className,
  );

  return href ? (
    <Link href={href} className={shell}>
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  );
}

/** The date/count chip the meta row is made of. */
export function MetaChip({
  icon,
  children,
}: {
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className="bento-tile inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5">
      {icon}
      {children}
    </span>
  );
}
