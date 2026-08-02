"use client";

// A Work object, named in a room, drawn live.
//
// The chip is the smallest visible piece of the bridge and it carries the whole
// argument. What is stored in the message is a **label** somebody typed:
// `#[Payroll rewrite](task:t7)`. What is drawn is the task's state *right now* —
// its column, who has it, when it is due — read through a subscription that
// re-renders when somebody changes any of those from the other dashboard.
//
// Three states, and the middle one is the one worth designing:
//
//   • **live** — the reader can open it. Status dot, current title, one line of
//     state. Clicking goes to Work.
//   • **unfinished** — the reader cannot open it, or it no longer exists. The
//     author's label renders as quiet, underlined-dotted text, exactly the way
//     `.page-wikilink-missing` renders a page link written ahead of its page.
//     It reads as something not yet connected rather than as something broken,
//     and it says *nothing* about the object: the label was already in the
//     message, and the live title never arrives at a reader without access.
//   • **loading** — the label, unstyled. Never a skeleton: a chip is four words
//     inside a sentence, and a pulsing block inside a paragraph is worse than a
//     word that firms up.

import Link from "next/link";
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { describeTask, workHref, type TaskCard } from "@/lib/buzz/bridge";
import type { ResolvedRef } from "./bridge-data";

/**
 * A date, in the reader's own calendar.
 *
 * Through `Intl` rather than `toISOString().slice(0, 10)` for the reason
 * `src/lib/dates.ts` opens with: the UTC day is the wrong day for anyone west
 * of Greenwich in the evening, and a due date that is off by one is worse than
 * no due date.
 */
function formatDateShort(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** A task reference, with whatever the live query has said about it so far. */
export function TaskChip({
  id,
  label,
  card,
}: {
  id: string;
  label: string;
  card: TaskCard | undefined;
}) {
  const now = Date.now();
  const line = useMemo(
    () => (card ? describeTask(card, now, formatDateShort) : ""),
    [card, now],
  );

  if (!card) return <UnresolvedRef label={label} />;

  const done =
    card.statusCategory === "complete" || card.statusCategory === "closed";
  return (
    <Link
      href={workHref("task", id, { listId: card.listId }) ?? "#"}
      title={`${card.title} — ${line}`}
      className="mx-0.5 inline-flex max-w-full items-baseline gap-1.5 rounded px-1 align-baseline hover:bg-[var(--chat-hover)]"
    >
      <span
        aria-hidden
        className="inline-block size-2 shrink-0 translate-y-px rounded-full"
        style={{ background: card.statusColor }}
      />
      <span className={cn("truncate font-medium", done && "line-through opacity-70")}>
        {card.title}
      </span>
      <span className="chat-quiet shrink-0 text-xs">{line}</span>
    </Link>
  );
}

/**
 * Any other reference kind, once the resolver has spoken.
 *
 * Shares the unfinished rendering with `TaskChip` on purpose: "I cannot show
 * you this" must look the same whatever the thing is, or the difference becomes
 * a signal about what the thing was.
 */
export function RefChip({ ref: resolved }: { ref: ResolvedRef }) {
  if (!resolved.found || !resolved.href) {
    return <UnresolvedRef label={resolved.label} />;
  }
  return (
    <Link
      href={resolved.href}
      className="mx-0.5 inline-flex max-w-full items-baseline gap-1 rounded px-1 align-baseline font-medium hover:bg-[var(--chat-hover)]"
    >
      <span className="chat-quiet text-xs">
        {resolved.kind === "room" ? "#" : `${resolved.kind} ·`}
      </span>
      <span className="truncate">{resolved.title ?? resolved.label}</span>
    </Link>
  );
}

/**
 * A reference that did not resolve.
 *
 * Deliberately not an error and deliberately not a link. It shows what the
 * author wrote, which the reader can already see in the raw text anyway, and
 * nothing else — no "not found", which would confirm the object's absence, and
 * no "forbidden", which would confirm its presence.
 */
export function UnresolvedRef({ label }: { label: string }) {
  return (
    <span
      className="chat-quiet mx-0.5 underline decoration-dotted underline-offset-2"
      title="Not connected"
    >
      {label}
    </span>
  );
}
