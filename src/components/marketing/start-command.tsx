"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { SITE_URL } from "@/lib/marketing-nav";

// The command that onboards an agent, on the logged-out homepage.
//
// It sits under the hero CTAs rather than replacing them because the two
// audiences arrive on the same page: a person evaluating the product wants
// "Start for free", and a person who already has an agent running wants the
// line they can paste into it. Making either one hunt is the failure.
//
// The command is shown in full, never abbreviated with a placeholder host —
// somebody is going to select this text with a mouse, and a line that reads
// `curl <your-domain>/start` is a line that fails when they do.

const COMMAND = `curl -fsSL ${SITE_URL.replace(/\/$/, "")}/start`;

export function StartCommand() {
  const [copied, setCopied] = useState(false);
  // Cleared on unmount: the timeout outlives the component when somebody
  // copies and immediately navigates, and setting state after that is a
  // React warning in dev and a leak in principle.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(COMMAND);
    } catch {
      // Clipboard access is refused in some embedded browsers and over
      // plain HTTP. The command is visible and selectable either way, so
      // there is nothing to recover — just don't claim it worked.
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mx-auto mt-10 w-full max-w-xl">
      <p className="text-xs font-medium uppercase tracking-[0.16em] text-white/40">
        Already have an agent?
      </p>
      {/* Stacked below sm, one row above it.
          Sharing a row at 390px cut the command off at "operate.to/" — the
          `/start` disappeared behind the Copy button, which is the one word
          on the page that has to survive. The command still scrolls inside
          itself if a font substitution makes it wider than expected, but at
          full width it does not have to. */}
      <div className="mt-3 flex flex-col gap-1.5 rounded-2xl bg-white/[0.06] p-1.5 ring-1 ring-white/15 backdrop-blur sm:flex-row sm:items-center sm:gap-2 sm:pl-4">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-2.5 py-2 text-left font-mono text-[0.8rem] text-white/90 sm:px-0 sm:text-sm">
          <span className="select-none text-white/35">$ </span>
          {COMMAND}
        </code>
        <button
          type="button"
          onClick={copy}
          // aria-live on the label, not the button: the accessible name
          // changing is the announcement, and wrapping the whole control
          // makes a screen reader re-read the command on every copy.
          className="tap-target inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xl bg-white/10 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-white/20"
        >
          {copied ? (
            <Check className="size-3.5" aria-hidden />
          ) : (
            <Copy className="size-3.5" aria-hidden />
          )}
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <p className="mt-3 text-sm leading-6 text-white/50">
        Paste it into your agent. It reads how this works, connects itself,
        and asks you to approve it — you never copy a key.
      </p>
    </div>
  );
}
