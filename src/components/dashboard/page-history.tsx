"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { RotateCcw } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { timeAgo } from "@/lib/time";

// A page's history.
//
// Collapsed by default and quiet: history is reassurance, not something you
// read. The panel's job is to make "can I undo this?" answerable at a glance
// and only then to get out of the way.
//
// Each row is a version *before* someone's edits, which is what makes restore
// meaningful — a row holding the state after an edit would be identical to the
// live page and restoring it would do nothing. The rows say so in words rather
// than leaving the reader to work out which side of the edit they're looking at.
//
// Restoring is an ordinary edit rather than a rewind — the server routes it
// through the same update path as typing, so the version being replaced is
// itself recorded first. That means restore is undoable by restoring again,
// which is why this needs no confirmation dialog: nothing here is destructive.

export function PageHistory({ pageId }: { pageId: Id<"pages"> }) {
  const revisions = useQuery(api.pages.history, { pageId, limit: 30 });
  const restore = useMutation(api.pages.restoreRevision);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [previewing, setPreviewing] = useState<Id<"pageRevisions"> | null>(null);
  const preview = useQuery(
    api.pages.readRevision,
    previewing ? { revisionId: previewing } : "skip",
  );

  // No history is the common case for a new page and needs no empty state —
  // a panel that says "nothing has happened" on every new page is noise.
  if (!revisions || revisions.length === 0) return null;

  const latest = revisions[0];

  return (
    <Card className="rounded-2xl p-5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="flex-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          History
        </span>
        <span className="text-[11px] text-muted-foreground">
          {revisions.length}
          {revisions.length === 30 ? "+" : ""}
        </span>
      </button>

      {open ? (
        <ul className="mt-3 space-y-2">
          {revisions.map((r) => {
            const showing = previewing === r.revisionId;
            return (
              <li key={r.revisionId} className="bento-tile p-3">
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    aria-expanded={showing}
                    onClick={() => setPreviewing(showing ? null : r.revisionId)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-xs font-medium">
                      Before {r.actorName || "someone"} edited
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      {timeAgo(r.createdAt)}
                    </span>
                    {r.excerpt ? (
                      <span className="mt-1 line-clamp-2 block text-[11px] leading-relaxed text-muted-foreground">
                        {r.excerpt}
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    aria-label={`Restore the version from ${timeAgo(r.createdAt)}`}
                    title="Put this version back. Restoring is itself undoable."
                    onClick={() => {
                      void restore({ revisionId: r.revisionId })
                        .then(() => {
                          setPreviewing(null);
                          toast(
                            "Restored — the version you replaced is in history too",
                          );
                        })
                        .catch((e) =>
                          toast(
                            errorMessage(e, "Couldn't restore that version"),
                            { kind: "error" },
                          ),
                        );
                    }}
                    className="tap-target inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <RotateCcw className="h-3 w-3" />
                  </button>
                </div>

                {showing ? (
                  <div className="mt-2 border-t border-border pt-2">
                    {preview === undefined ? (
                      <div className="h-12 animate-pulse rounded bg-muted" />
                    ) : preview === null ? (
                      <p className="text-[11px] text-muted-foreground">
                        That version is no longer available.
                      </p>
                    ) : (
                      <>
                        <p className="text-[11px] font-medium">
                          {preview.title}
                        </p>
                        {/* Plain text, not a second editor: this is a glance
                            before deciding, and the full page is one click
                            away once restored. */}
                        <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[11px] leading-relaxed text-muted-foreground">
                          {preview.markdown || "(empty)"}
                        </pre>
                      </>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {latest.actorName || "Someone"} edited this{" "}
          {timeAgo(latest.updatedAt)}.
        </p>
      )}
    </Card>
  );
}
