"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import { AnimatePresence, motion } from "motion/react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Chart } from "@/components/charts/chart";
import {
  DEFAULT_STYLE,
  STYLE_ENUMS,
  normalizeStylePatch,
  type ComponentStyle,
  type StylePatch,
} from "@/lib/component-style";
import { EASE } from "@/components/motion";
import { cn } from "@/lib/utils";

// Say it, see it, then decide.
//
// Nineteen style axes is real power and real learning. "Make it a donut, only
// the overdue ones, and quieter" is neither — and it is how people actually
// hold what they want in their heads. This turns the sentence into a patch
// against the same closed vocabulary the pickers write, so the two paths
// produce identical results and neither is the "advanced" one.
//
// **Nothing is applied until you have seen it.** The answer arrives as a
// preview beside the current look, with a sentence saying what it understood.
// A natural-language control that acts immediately is a control you cannot
// aim, because the only way to find out what it did is to have it already
// done — and then you are hunting for undo instead of choosing.
//
// **And there is no trust in the model here.** It picks from enumerated lists;
// `normalizeStylePatch` drops anything else on the way in. The worst a bad
// answer produces is a preview you decline.

const EXAMPLES = [
  "make it a donut",
  "quieter, no grid",
  "big and colourful",
  "like a printed report",
  "dark with neon bars",
];

/** Enough shape to judge a change by, at rail width. */
const MINI = [
  {
    key: "a",
    label: "A",
    points: [
      { key: "1", label: "", value: 6 },
      { key: "2", label: "", value: 10 },
      { key: "3", label: "", value: 4 },
      { key: "4", label: "", value: 12 },
    ],
  },
  {
    key: "b",
    label: "B",
    points: [
      { key: "1", label: "", value: 3 },
      { key: "2", label: "", value: 4 },
      { key: "3", label: "", value: 7 },
      { key: "4", label: "", value: 2 },
    ],
  },
];

export function IntentComposer({
  style,
  panelLabel,
  onApply,
}: {
  /** What the panel looks like now — the thing being changed. */
  style: ComponentStyle;
  panelLabel: string;
  onApply: (patch: StylePatch) => void;
}) {
  const draft = useAction(api.panelIntent.draftPanel);
  const [sentence, setSentence] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<{
    patch: StylePatch;
    said: string;
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setMessage(null);
    setProposal(null);
    try {
      const result = await draft({
        sentence: trimmed,
        current: { panel: panelLabel, style },
        // The one definition of what this system can express, handed to the
        // model rather than restated on the server — a second copy would
        // drift, and a drifted copy suggests options that silently vanish.
        vocabulary: STYLE_ENUMS,
      });
      if (!result.ok) {
        setMessage(result.message ?? "Couldn't work that one out.");
        return;
      }
      const patch = normalizeStylePatch(result.patch);
      if (Object.keys(patch).length === 0) {
        // The model answered but nothing survived normalization — it asked for
        // something this vocabulary cannot express. Say that plainly rather
        // than showing an identical preview and letting them wonder.
        setMessage(
          result.said ??
            "That isn't something panels can do yet. Try describing the look instead.",
        );
        return;
      }
      setProposal({ patch, said: result.said ?? "Here's what that looks like." });
    } finally {
      setBusy(false);
    }
  }

  const preview: ComponentStyle = proposal
    ? { ...style, ...proposal.patch }
    : style;

  return (
    <section>
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Just say it
      </span>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(sentence);
        }}
        className="mt-2 flex gap-1.5"
      >
        <input
          value={sentence}
          onChange={(e) => setSentence(e.target.value)}
          placeholder="make it a donut, no grid…"
          aria-label={`Describe how ${panelLabel} should look`}
          className="soft-field min-w-0 flex-1 px-2.5 py-1.5 text-xs"
        />
        <Button type="submit" size="sm" disabled={busy || !sentence.trim()}>
          {busy ? "…" : "Try"}
        </Button>
      </form>

      {!proposal && !message && (
        <div className="mt-2 flex flex-wrap gap-1">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                setSentence(example);
                void ask(example);
              }}
              className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {example}
            </button>
          ))}
        </div>
      )}

      {message && (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {message}
        </p>
      )}

      <AnimatePresence>
        {proposal && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="mt-3 rounded-lg bg-page p-2.5 ring-1 ring-border"
          >
            <p className="text-[11px] leading-relaxed">{proposal.said}</p>

            {/* Before and after, side by side. A preview on its own cannot be
                judged — the question is always "is that better than what I
                have", and answering it from memory is guesswork. */}
            <div className="mt-2 grid grid-cols-2 gap-2">
              {[
                { label: "Now", value: style },
                { label: "Proposed", value: preview },
              ].map((option) => (
                <div key={option.label} className="min-w-0">
                  <span className="mb-1 block text-[10px] text-muted-foreground">
                    {option.label}
                  </span>
                  <span
                    className={cn(
                      "block rounded bg-card p-1.5",
                      option.label === "Proposed" && "ring-1 ring-foreground",
                    )}
                  >
                    <Chart
                      kind="column"
                      series={MINI}
                      style={{ ...option.value, stackMode: "stacked" }}
                      unit="count"
                      width={110}
                      height={44}
                      label={option.label}
                    />
                  </span>
                </div>
              ))}
            </div>

            <div className="mt-2.5 flex gap-1.5">
              <Button
                size="sm"
                className="flex-1"
                onClick={() => {
                  onApply(proposal.patch);
                  setProposal(null);
                  setSentence("");
                }}
              >
                Use it
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setProposal(null)}
              >
                No
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

/** The shipped look, for a composer with nothing selected. */
export const NEUTRAL_STYLE = DEFAULT_STYLE;
