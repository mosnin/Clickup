"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";

// The project's standing context, shown on every task in it.
//
// This is the human half of the thing agents get automatically: `get_task`
// returns pinned project docs in its payload, and this panel puts the same docs
// in front of the person doing the work. Two audiences, one source — the
// alternative is a brief the agents follow and the humans never see.
//
// Collapsed by default and previewed in one line, because it repeats on every
// task in the project: expanded-by-default context would push the actual task
// below the fold on the tenth read.

export function TaskContextPanel({ listId }: { listId: string }) {
  const docs = useQuery(api.docs.pinnedContextForList, {
    listId: listId as Id<"lists">,
  });
  const [openId, setOpenId] = useState<string | null>(null);

  // Nothing pinned is the common case and needs no empty state — an unused
  // panel on every task would be noise. The project page is where you pin one.
  if (!docs || docs.length === 0) return null;

  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Project context
      </h2>
      <ul className="space-y-2">
        {docs.map((doc) => {
          const expanded = openId === doc._id;
          return (
            <li key={doc._id} className="bento rounded-xl">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpenId(expanded ? null : doc._id)}
                className="tap-target flex w-full items-center gap-3 px-3 py-2.5 text-left"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {doc.title}
                  </span>
                  {!expanded && (
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {previewOf(doc.content)}
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
                  {/* Plain text, not a second rich-text renderer: this is a
                      reference read. The full editor is one click away. */}
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
                    {plainText(doc.content) || "This document is empty."}
                  </p>
                  <Link
                    href={`/dashboard/d/${doc._id}`}
                    className="mt-3 inline-block text-xs font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    Open document
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

/**
 * Plain text out of Tiptap JSON. Mirrors convex/_docText.ts — that module is
 * server-side (Convex build graph), so the client keeps its own tiny copy
 * rather than importing across the boundary.
 */
function plainText(content: unknown): string {
  const parts: string[] = [];
  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (typeof n.text === "string") parts.push(n.text);
    if (Array.isArray(n.content)) for (const child of n.content) walk(child);
  }
  walk(content);
  return parts.join(" ").trim();
}

function previewOf(content: unknown): string {
  const text = plainText(content);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}
