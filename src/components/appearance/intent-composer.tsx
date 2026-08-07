"use client";

import { useCallback, useEffect, useState } from "react";
import { useAction } from "convex/react";
import { AnimatePresence, motion } from "motion/react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  normalizeStylePatch,
  type ComponentStyle,
  type StylePatch,
} from "@/lib/component-style";
import {
  applyIntent,
  vocabularyFor,
  type PanelChange,
} from "@/lib/panel-intent";
import { describePanel, normalizePanel, type PanelDef } from "@/lib/panel";
import { EASE } from "@/components/motion";

// Say it, and watch it happen to the real thing.
//
// Nineteen style axes, seven sources, seventeen dimensions and eleven measures
// is real power and real learning. "Only my overdue ones, as a donut, quieter"
// is neither — and it is how people actually hold what they want in their
// heads. This turns the sentence into a patch against the same closed
// vocabulary the pickers write, so the two paths produce identical results and
// neither is the "advanced" one.
//
// **There is no preview pane, on purpose.** The first version of this showed a
// little before/after specimen, which was the same mistake as a settings page
// in miniature: a picture *of* the change, beside the thing the change is
// about. So the answer is applied to the actual panel — the one on your screen,
// with your data, at the size you read it — and the only question left is
// whether it stays. Try, look, keep or undo.
//
// **And the sentence shown back is computed, never quoted.** The model returns
// its own account of what it did; nothing checks that account, and after
// normalization it can be flatly untrue. So its line is shown as what it
// *understood*, and what actually changed is derived by diffing the two
// definitions. When nothing survived, that diff is empty and this says so
// rather than reading back a confident sentence about a panel that did not
// move.
//
// **No trust in the model is required anywhere.** It picks from enumerated
// lists narrowed to what this panel can use; `normalizePanel` drops the rest.
// The worst a hostile or hallucinated answer produces is a change you undo.

const STYLE_EXAMPLES = [
  "make it a donut",
  "quieter, no grid",
  "big and colourful",
  "like a printed report",
];

const PANEL_EXAMPLES = [
  "only my overdue ones",
  "group by assignee",
  "as a donut, no grid",
  "everything blocked, biggest first",
  "how many finished each day this month",
];

/**
 * Ask about a whole panel.
 *
 * `onPreview` applies the answer to the real panel without saving; `onCommit`
 * makes it stick. The parent decides what "apply without saving" means for its
 * surface — a draft in the builder, a live preview layer in the inspector.
 */
export function IntentComposer({
  def,
  label,
  examples = PANEL_EXAMPLES,
  placeholder = "only my overdue ones, as a donut…",
  onPreview,
  onCommit,
}: {
  def: PanelDef;
  label: string;
  examples?: string[];
  placeholder?: string;
  /** Show this, unsaved. `null` means put it back. */
  onPreview: (next: PanelDef | null) => void;
  onCommit: (next: PanelDef) => void;
}) {
  const draft = useAction(api.panelIntent.draftPanel);
  const [sentence, setSentence] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [proposal, setProposal] = useState<{
    next: PanelDef;
    changes: PanelChange[];
    said: string;
  } | null>(null);

  // Leaving with a preview applied would strand the panel looking like
  // something nobody chose.
  const cancel = useCallback(() => {
    setProposal(null);
    onPreview(null);
  }, [onPreview]);

  useEffect(() => cancel, [cancel]);

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setMessage(null);
    setProposal(null);
    onPreview(null);
    try {
      const result = await draft({
        sentence: trimmed,
        current: {
          panel: label,
          is: describePanel(def),
          definition: def,
        },
        // Narrowed to what this panel can actually use — see `vocabularyFor`.
        // A model offered a shape its source cannot draw will sometimes pick
        // it, and a dropped answer reads as a control that did nothing.
        vocabulary: vocabularyFor(def),
      });

      if (!result.ok) {
        setMessage(result.message ?? "Couldn't work that one out.");
        return;
      }

      const { next, changes } = applyIntent(def, result.patch);
      if (changes.length === 0) {
        setMessage(
          result.said ??
            "That isn't something panels can do yet. Try describing what you want to see, or how it should look.",
        );
        return;
      }

      setProposal({
        next,
        changes,
        said: result.said ?? "Here's what that looks like.",
      });
      onPreview(next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <span className="text-tiny font-medium uppercase tracking-wider text-muted-foreground">
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
          placeholder={placeholder}
          aria-label={`Describe ${label}`}
          className="soft-field min-w-0 flex-1 px-2.5 py-1.5 text-xs"
        />
        <Button type="submit" size="sm" disabled={busy || !sentence.trim()}>
          {busy ? "…" : "Try"}
        </Button>
      </form>

      {!proposal && !message && (
        <div className="mt-2 flex flex-wrap gap-1">
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                setSentence(example);
                void ask(example);
              }}
              className="rounded-full bg-muted px-2 py-0.5 text-micro text-muted-foreground transition-colors hover:text-foreground"
            >
              {example}
            </button>
          ))}
        </div>
      )}

      {message && (
        <p className="mt-2 text-tiny leading-relaxed text-muted-foreground">
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
            <p className="text-tiny leading-relaxed">{proposal.said}</p>

            {/* Derived from the two definitions, so it cannot claim a change
                that normalization dropped. */}
            <ul className="mt-2 space-y-0.5">
              {proposal.changes.slice(0, 6).map((change) => (
                <li
                  key={change.key}
                  className="flex items-baseline justify-between gap-2 text-tiny"
                >
                  <span className="min-w-0 truncate text-muted-foreground">
                    {change.label}
                  </span>
                  <span className="flex-shrink-0 tabular-nums">
                    {change.after}
                  </span>
                </li>
              ))}
              {proposal.changes.length > 6 && (
                <li className="text-micro text-muted-foreground">
                  and {proposal.changes.length - 6} more
                </li>
              )}
            </ul>

            <div className="mt-2.5 flex gap-1.5">
              <Button
                size="sm"
                className="flex-1"
                onClick={() => {
                  onCommit(proposal.next);
                  setProposal(null);
                  setSentence("");
                }}
              >
                Keep it
              </Button>
              <Button size="sm" variant="outline" onClick={cancel}>
                Undo
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

/**
 * Ask about a look, with no panel definition in hand.
 *
 * The inspector can be pointed at anything — a built-in panel, a whole screen —
 * where there is a resolved style but no definition to rewrite. Built on the
 * same path rather than a second one: the style is wrapped in a throwaway
 * definition, and only the style half of the answer is read back out.
 */
export function StyleIntentComposer({
  style,
  label,
  onPreview,
  onCommit,
}: {
  style: ComponentStyle;
  label: string;
  onPreview: (patch: StylePatch | null) => void;
  onCommit: (patch: StylePatch) => void;
}) {
  const def = normalizePanel({
    title: label,
    query: { from: "tasks" },
    shape: "column",
    style,
  });

  const patchOf = (next: PanelDef): StylePatch => {
    // Only the keys the answer actually moved — handing the whole resolved
    // style back would write nineteen explicit overrides for a sentence about
    // one, and every layer beneath would stop reaching this panel forever.
    const out: StylePatch = {};
    for (const [key, value] of Object.entries(next.style)) {
      if (style[key as keyof ComponentStyle] !== value) {
        (out as Record<string, unknown>)[key] = value;
      }
    }
    return normalizeStylePatch(out);
  };

  return (
    <IntentComposer
      def={def}
      label={label}
      examples={STYLE_EXAMPLES}
      placeholder="quieter, no grid…"
      onPreview={(next) => onPreview(next ? patchOf(next) : null)}
      onCommit={(next) => onCommit(patchOf(next))}
    />
  );
}
