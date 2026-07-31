"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { AnimatePresence, motion } from "motion/react";
import { api } from "@convex/_generated/api";
import { EASE } from "@/components/motion";
import {
  provenanceOf,
  relevantDecisions,
  type ProvenanceStep,
} from "@/lib/provenance";
import type { PanelDef } from "@/lib/panel";
import { cn } from "@/lib/utils";

// The answer to "why is this what it is", where the number is.
//
// Three thoughts arrive in order when you read "14 overdue": which fourteen,
// who decided what counts as overdue, and can I trust this. Everywhere else
// those cost a conversation. Here the panel is a definition, the answer is an
// envelope and the rule is a signed plan decision — so all three are already
// data and the chain is a computation rather than a feature.
//
// Two rules it holds to:
//
// **Nothing here is narrated.** No stored explanation to go stale, nothing
// written by a model. An explanation that can disagree with the thing it
// explains is worse than none, because people believe it — and this exists
// specifically to make numbers trustworthy.
//
// **It is off until asked for.** A dashboard that explains itself unprompted
// is a dashboard you cannot read. The affordance is the number itself.

export function ProvenanceSheet({
  def,
  total,
  truncated,
  rows,
  scopeType,
  scopeId,
  authoredByName,
  onClose,
}: {
  def: PanelDef;
  total: number;
  truncated: boolean;
  rows: { id: string; title: string; href: string | null }[];
  scopeType: "user" | "workspace";
  scopeId: string;
  authoredByName?: string | null;
  onClose: () => void;
}) {
  // Only fetched once somebody asks — a panel that pulls the workspace's
  // decisions on every render is a panel that costs more than it shows.
  const decisions = useQuery(api.plans.decisionsInScope, {
    scopeType,
    scopeId,
    limit: 60,
  });

  const steps = useMemo(
    () =>
      provenanceOf({
        def,
        total,
        truncated,
        rows,
        authoredByName,
        decisions: relevantDecisions(def, decisions ?? []),
      }),
    [def, total, truncated, rows, authoredByName, decisions],
  );

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.25, ease: EASE }}
      className="overflow-hidden"
    >
      <div className="mt-2 rounded-lg bg-page p-2.5 ring-1 ring-border">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Why this number
          </span>
          <button
            type="button"
            onClick={onClose}
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
        </div>
        <ol className="mt-1.5 space-y-1">
          {steps.map((step) => (
            <Step key={step.key} step={step} />
          ))}
        </ol>
        {decisions === undefined && (
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            Looking for the decision behind it…
          </p>
        )}
      </div>
    </motion.div>
  );
}

function Step({ step }: { step: ProvenanceStep }) {
  const text = (
    <span
      className={cn(
        "block text-[11px] leading-relaxed",
        step.kind === "decision" && "text-foreground",
        step.kind !== "decision" && "text-muted-foreground",
      )}
    >
      {step.text}
    </span>
  );
  return (
    <li className="min-w-0">
      {step.href ? (
        <Link href={step.href} className="block hover:underline">
          {text}
        </Link>
      ) : (
        text
      )}
    </li>
  );
}

/**
 * The affordance.
 *
 * The number is the button, because anything else is chrome competing with
 * the thing it is about. Rendered as a real button so it is reachable by
 * keyboard, and labelled so a screen reader announces what pressing it does
 * rather than reading the number twice.
 */
export function ProvenanceToggle({
  children,
  open,
  onToggle,
  className,
}: {
  children: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label="Why this number"
      onClick={onToggle}
      className={cn(
        "text-left underline-offset-4 hover:underline focus-visible:underline",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Wires the toggle and the sheet together for a panel body. */
export function useProvenance() {
  const [open, setOpen] = useState(false);
  return {
    open,
    toggle: () => setOpen((v) => !v),
    close: () => setOpen(false),
    Presence: AnimatePresence,
  };
}
