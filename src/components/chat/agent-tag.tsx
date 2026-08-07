"use client";

// The "agent" identity tag — one component, two call sites: the message row's
// header and the room's member list. It used to be hand-rolled twice, each
// with its own solid fill (`--chat-hover` in one, `--chat-active` in the
// other), so the same word carried two different weights depending on where
// you read it. Work marks a computed fact like this one — not a status, just
// "this was written by a machine" — with an OUTLINED `.ui-chip` pill rather
// than a fill, the same call `dashboard/status-pill.tsx` and
// `dashboard/priority.tsx` make: a fill is reserved for the few things that
// genuinely encode state. This is that pill, styled for Chat's tighter rows.

import { cn } from "@/lib/utils";

export function AgentTag({
  title,
  className,
}: {
  /** e.g. "Runs for Alex Rivera" — omit when there is nothing to say. */
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "ui-chip inline-flex shrink-0 items-center rounded-full px-1.5 text-micro font-medium uppercase tracking-wide text-[var(--chat-quiet)]",
        className,
      )}
    >
      agent
    </span>
  );
}
