"use client";

// Pagination — the one pager.
//
// The rule it exists to enforce: a list that is cut off must say so and offer
// the rest. The projects directory used to end with "Showing 24 of 91. Narrow
// your search to see more", which tells you your work is there and then asks
// you to guess a search term to reach it.
//
// The whole difficulty is `pageRange`, so that is a pure function exported for
// its own test. Every ellipsis bug is the same bug — the window is computed
// from the current page without accounting for the ends, so page 1 renders
// "1 2 3 … 20" and page 2 renders "1 2 3 4 … 20" and the control changes width
// as you walk it, moving the button under the pointer. Here the window is a
// fixed WIDTH, clamped against both ends, so the strip is the same size on
// every page and the numbers move under a still frame instead.

import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** A rendered slot: a page number, or a gap that stands for several. */
export type PageSlot = number | "gap";

/**
 * The slots to draw for `page` of `count`.
 *
 * `siblings` is how many neighbours flank the current page. The first and last
 * page are always present — they are the two destinations people actually aim
 * for — and a gap only appears where it replaces MORE than one page, because
 * "1 … 3" is wider than "1 2 3" and tells you less.
 */
export function pageRange(
  page: number,
  count: number,
  siblings = 1,
): PageSlot[] {
  if (count <= 0) return [];
  const current = Math.min(Math.max(1, Math.trunc(page)), count);
  // first + last + current + siblings on both sides + two gaps.
  const width = siblings * 2 + 5;
  if (count <= width) {
    return Array.from({ length: count }, (_, i) => i + 1);
  }

  // Clamp the window against both ends so its width never changes.
  const left = Math.max(current - siblings, 1);
  const right = Math.min(current + siblings, count);
  const showLeftGap = left > 2;
  const showRightGap = right < count - 1;

  if (!showLeftGap && showRightGap) {
    const run = siblings * 2 + 3;
    return [
      ...Array.from({ length: run }, (_, i) => i + 1),
      "gap" as const,
      count,
    ];
  }
  if (showLeftGap && !showRightGap) {
    const run = siblings * 2 + 3;
    return [
      1,
      "gap" as const,
      ...Array.from({ length: run }, (_, i) => count - run + 1 + i),
    ];
  }
  if (showLeftGap && showRightGap) {
    return [
      1,
      "gap" as const,
      ...Array.from({ length: right - left + 1 }, (_, i) => left + i),
      "gap" as const,
      count,
    ];
  }
  return Array.from({ length: count }, (_, i) => i + 1);
}

export type PaginationProps = {
  /** Total number of pages. One or fewer renders nothing. */
  count: number;
  /** The current page, 1-based. */
  page: number;
  /** Names the control for screen readers — "Projects", "Search results". */
  label: string;
  onPageChange: (page: number) => void;
  siblingCount?: number;
  className?: string;
};

export function Pagination({
  count,
  page,
  label,
  onPageChange,
  siblingCount = 1,
  className,
}: PaginationProps) {
  // One page is not a pager. Rendering a disabled control under every short
  // list is furniture that says "there could be more" when there could not.
  if (count <= 1) return null;

  const current = Math.min(Math.max(1, Math.trunc(page)), count);
  const slots = pageRange(current, count, siblingCount);
  const go = (next: number) => {
    const clamped = Math.min(Math.max(1, next), count);
    if (clamped !== current) onPageChange(clamped);
  };

  return (
    <nav
      aria-label={label}
      className={cn("flex items-center justify-center gap-1", className)}
    >
      <button
        type="button"
        onClick={() => go(current - 1)}
        disabled={current === 1}
        aria-label="Previous page"
        className="tap-target inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <ChevronLeft aria-hidden className="size-4" />
      </button>

      {slots.map((slot, i) =>
        slot === "gap" ? (
          // Not a button, and not announced: it is a typographic mark saying
          // "numbers omitted", and a screen reader reading "ellipsis" between
          // every page is noise. The page count is on the nav's own label.
          <span
            key={`gap-${i}`}
            aria-hidden
            className="px-1 text-sm text-muted-foreground"
          >
            …
          </span>
        ) : (
          <button
            key={slot}
            type="button"
            onClick={() => go(slot)}
            // `aria-current="page"` rather than aria-selected: these are
            // destinations within one collection, which is what that attribute
            // is for, and it is what a pager's own convention is.
            aria-current={slot === current ? "page" : undefined}
            aria-label={`Page ${slot}`}
            className={cn(
              "tap-target inline-flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-sm tabular-nums transition-colors",
              slot === current
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {slot}
          </button>
        ),
      )}

      <button
        type="button"
        onClick={() => go(current + 1)}
        disabled={current === count}
        aria-label="Next page"
        className="tap-target inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <ChevronRight aria-hidden className="size-4" />
      </button>
    </nav>
  );
}
