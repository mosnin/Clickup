"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { EASE } from "@/components/motion";
import { timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";

// Revision requests on a task or a project.
//
// The state is the point. A comment saying "this needs work" is invisible five
// comments later; a revision stays visible until someone accepts it, and an
// agent reading the task sees it in the same payload as the description.
//
// Who can do what mirrors the backend, which mirrors approval gates: anyone can
// ask, whoever holds the work reports it addressed, only a person accepts or
// reopens. The UI never offers a control the server would refuse.

type Revision = Doc<"revisions">;

const STATUS_STYLES: Record<Revision["status"], string> = {
  open: "bg-pastel-yellow text-foreground",
  addressed: "bg-pastel-blue text-foreground",
  accepted: "bg-pastel-green text-foreground",
};

const STATUS_LABELS: Record<Revision["status"], string> = {
  open: "Open",
  addressed: "Addressed",
  accepted: "Accepted",
};

export function RevisionsPanel({
  parentType,
  parentId,
}: {
  parentType: "task" | "list";
  parentId: string;
}) {
  const revisions = useQuery(api.revisions.forParent, { parentType, parentId });
  const request = useMutation(api.revisions.request);
  const address = useMutation(api.revisions.address);
  const decide = useMutation(api.revisions.decide);
  const remove = useMutation(api.revisions.remove);
  const { toast } = useToast();

  const [drafting, setDrafting] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    try {
      await request({ parentType, parentId, body: text });
      setBody("");
      setDrafting(false);
      toast("Revision requested");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save that", {
        kind: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  const open = (revisions ?? []).filter((r) => r.status !== "accepted");
  const done = (revisions ?? []).filter((r) => r.status === "accepted");

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Revisions
          {open.length > 0 ? (
            <span className="ml-2 rounded-full bg-pastel-yellow px-1.5 py-0.5 text-[10px] font-semibold text-foreground">
              {open.length}
            </span>
          ) : null}
        </h2>
        {!drafting && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDrafting(true)}
            className="tap-target"
          >
            Request a change
          </Button>
        )}
      </div>

      {drafting && (
        <div className="mb-3 space-y-2">
          <textarea
            autoFocus
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            placeholder="What needs to change, and why? An agent reads this verbatim."
            className="soft-field w-full resize-y rounded-xl px-3 py-2 text-sm"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={submit} disabled={busy || !body.trim()}>
              Request
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDrafting(false);
                setBody("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {revisions === undefined ? (
        <div className="space-y-2">
          <div className="h-16 animate-pulse rounded-xl bg-muted" />
        </div>
      ) : revisions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing has been sent back. Ask for a change and whoever holds this —
          person or agent — sees it with the work.
        </p>
      ) : (
        <ul className="space-y-2">
          <AnimatePresence initial={false}>
            {[...open, ...done].map((revision) => (
              <motion.li
                key={revision._id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.22, ease: EASE }}
                className={cn(
                  "bento rounded-xl p-3",
                  revision.status === "accepted" && "opacity-60",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 whitespace-pre-wrap break-words text-sm text-foreground">
                    {revision.body}
                  </p>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                      STATUS_STYLES[revision.status],
                    )}
                  >
                    {STATUS_LABELS[revision.status]}
                  </span>
                </div>

                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  {revision.requestedByName} · {timeAgo(revision.createdAt)}
                </p>

                {revision.responseNote && (
                  <div className="mt-2 rounded-lg bg-muted p-2.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {revision.addressedByName ?? "Response"}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">
                      {revision.responseNote}
                    </p>
                  </div>
                )}

                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  {revision.status === "open" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        try {
                          await address({ revisionId: revision._id });
                          toast("Marked as addressed");
                        } catch (err) {
                          toast(
                            err instanceof Error ? err.message : "Failed",
                            { kind: "error" },
                          );
                        }
                      }}
                    >
                      I handled this
                    </Button>
                  )}
                  {revision.status === "addressed" && (
                    <>
                      <Button
                        size="sm"
                        onClick={async () => {
                          try {
                            await decide({
                              revisionId: revision._id,
                              accept: true,
                            });
                            toast("Accepted");
                          } catch (err) {
                            toast(
                              err instanceof Error ? err.message : "Failed",
                              { kind: "error" },
                            );
                          }
                        }}
                      >
                        Accept
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={async () => {
                          try {
                            await decide({
                              revisionId: revision._id,
                              accept: false,
                            });
                            toast("Reopened");
                          } catch (err) {
                            toast(
                              err instanceof Error ? err.message : "Failed",
                              { kind: "error" },
                            );
                          }
                        }}
                      >
                        Not yet
                      </Button>
                    </>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    onClick={() => {
                      // Deferred delete, the same pattern as every other
                      // destructive action: the row goes when the undo window
                      // closes, not when the button is pressed.
                      toast("Revision removed", {
                        action: { label: "Undo", onClick: () => {} },
                        onExpire: () =>
                          void remove({
                            revisionId: revision._id as Id<"revisions">,
                          }),
                      });
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </section>
  );
}
