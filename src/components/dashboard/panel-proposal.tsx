"use client";

import { useMutation, useQuery } from "convex/react";
import { AnimatePresence, motion } from "motion/react";
import { api } from "@convex/_generated/api";
import { EASE } from "@/components/motion";
import { Panel } from "@/components/dashboard/panel";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { describePanel, normalizePanel } from "@/lib/panel";

// An agent suggesting a panel that does not exist yet.
//
// `proposeScreen` let an agent rearrange the panels you have. This is the step
// past that: a panel is a definition now, so an agent that has been doing the
// work can write a question your screen isn't asking — "nothing here shows
// what's blocked on you" — and hand it over.
//
// The consent shape is the one used for layouts and for task approval gates,
// and it does not bend: an agent AUTHORS, a person PLACES. An interface that
// rearranges itself is an interface nobody can learn, and that is true whether
// the change is a reorder or a whole new panel.
//
// **The preview is the panel.** Not a description of one, not a screenshot —
// `<Panel>` running the proposed definition against this scope's real data,
// drawn the way it will be drawn. That is the only preview worth showing,
// because a suggested panel is exactly as good as what it turns out to say
// about your actual work, and a mockup cannot tell you that.
//
// It renders inline rather than morphing the grid, which is the one place this
// differs from a layout proposal: there is nothing on the canvas yet to morph
// into. Accepting mints it, and the caller places it.

export function PanelProposal({
  screenKey,
  scopeType,
  scopeId,
  onAccept,
}: {
  screenKey: string;
  scopeType: "user" | "workspace";
  scopeId: string;
  /** Put the new panel on the screen. The server does not know your layout. */
  onAccept: (componentId: string) => void;
}) {
  const proposals = useQuery(api.uiComponents.proposalsFor, { screenKey });
  const resolve = useMutation(api.uiComponents.resolveProposal);
  const { toast } = useToast();

  const proposal = (proposals ?? [])[0] ?? null;
  if (!proposal) return null;

  const def = normalizePanel(proposal.definition);

  function act(accept: boolean) {
    if (!proposal) return;
    void resolve({
      proposalId: proposal.proposalId as Parameters<
        typeof resolve
      >[0]["proposalId"],
      accept,
    })
      .then((result) => {
        if (accept && result?.componentId) {
          onAccept(result.componentId as string);
          toast("Panel added to your screen");
        }
      })
      .catch((e) =>
        toast(errorMessage(e, "Couldn't resolve the suggestion"), {
          kind: "error",
        }),
      );
  }

  return (
    <AnimatePresence initial={false}>
      <motion.div
        key={proposal.proposalId}
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.3, ease: EASE }}
        className="bento-tile rounded-2xl p-4"
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
          <div className="min-w-0">
            <p className="text-sm">
              <span className="font-medium">{proposal.agentName}</span> suggests
              a panel this screen doesn&apos;t have
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {proposal.reason}
            </p>
            {/* Said in the product's words, derived from the definition — the
                agent's own account of what it built is not the record. */}
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              {describePanel(def)}
            </p>

            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => act(false)}
                className="rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                No thanks
              </button>
              <button
                type="button"
                onClick={() => act(true)}
                className="rounded-full bg-foreground px-3 py-1.5 text-xs text-background"
              >
                Add it
              </button>
            </div>
          </div>

          {/* The panel itself, over your data. Nothing here is a mockup. */}
          <div className="min-w-0">
            <Panel
              definition={proposal.definition}
              scopeType={scopeType}
              scopeId={scopeId}
              className="min-h-[11rem]"
            />
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
