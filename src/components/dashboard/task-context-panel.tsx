"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { cn } from "@/lib/utils";

// The project's standing context, shown on every task in it.
//
// This is the human half of the thing agents get automatically: `get_task`
// returns pinned pages in its payload, and this panel puts the same pages in
// front of the person doing the work. Two audiences, one source — the
// alternative is a brief the agents follow and the humans never see.
//
// The heading says what pinning *does* rather than what it is. "Will the agent
// actually get this?" is the question someone writing context has, and it was
// previously unanswerable from any surface — you pinned a doc and hoped.
//
// Collapsed by default and previewed in one line, because it repeats on every
// task in the project: expanded-by-default context would push the actual task
// below the fold on the tenth read.

export function TaskContextPanel({ listId }: { listId: string }) {
  const pages = useQuery(api.pages.pinnedForTarget, {
    targetType: "list",
    targetId: listId,
  });
  const [openId, setOpenId] = useState<string | null>(null);

  // Nothing pinned is the common case and needs no empty state — an unused
  // panel on every task would be noise. The page itself is where you pin one.
  if (!pages || pages.length === 0) return null;

  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Context agents get with this task
      </h2>
      <ul className="space-y-2">
        {pages.map((page) => {
          const expanded = openId === page.pageId;
          return (
            <li key={page.pageId} className="bento rounded-xl">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpenId(expanded ? null : page.pageId)}
                className="tap-target flex w-full items-center gap-3 px-3 py-2.5 text-left"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {page.title}
                  </span>
                  {!expanded && (
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {page.excerpt}
                    </span>
                  )}
                </span>
                <ChevronDown
                  aria-hidden
                  className={cn(
                    "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
                    expanded && "rotate-180",
                  )}
                />
              </button>

              {expanded && (
                <div className="border-t border-border px-3 py-3">
                  {/* The excerpt, not a second editor: this is a reference
                      read, and the real page is one click away. */}
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
                    {page.excerpt || "This page is empty."}
                  </p>
                  <Link
                    href={`/dashboard/pages/${page.pageId}`}
                    className="mt-3 inline-block text-xs font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    Open page
                  </Link>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
