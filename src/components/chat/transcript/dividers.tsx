"use client";

// The rows that are not messages.
//
// All three are rows in the same virtualized list as the messages, and that is
// the only structural fact about them worth defending: a divider drawn as
// decoration inside a message row makes that row a different height than the
// virtualizer measured, and every row below it lands in the wrong place.
//
// They also reset grouping — which the projector already did by the time these
// render, but it is worth saying where the visual consequence lives: the
// message under a divider always draws its own header, because a continuation
// hanging under "Today" reads as a message with no author.

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ChatRow } from "@/lib/buzz/message-types";
import { cn } from "@/lib/utils";
import { ActorAvatar } from "./avatar";
import { formatDayHeading, formatTime } from "./date-labels";

/**
 * A day boundary.
 *
 * The heading is computed from the timestamp on every render, never baked: a
 * tab left open overnight relabels "Today" as "Yesterday" instead of insisting
 * on what was true when the row was first drawn.
 */
export function DayDivider({ at }: { at: number }) {
  return (
    <div className="relative flex items-center justify-center py-3" data-row="day">
      <span
        aria-hidden
        className="absolute inset-x-0 top-1/2 h-px bg-[var(--chat-hairline)]"
      />
      <span className="relative rounded-full bg-background px-2 text-tiny font-medium text-[var(--chat-quiet)]">
        {formatDayHeading(at)}
      </span>
    </div>
  );
}

/**
 * The unread rule.
 *
 * Ink rather than a second accent colour: `--chat-accent` is the one mark this
 * product uses to mean "this is new", and it is the same one the sidebar's
 * unread badge draws. A red "NEW" line would be a second vocabulary for one
 * idea.
 */
export function UnreadDivider({ count }: { count: number }) {
  return (
    <div
      className="relative flex items-center justify-center py-2"
      data-row="unread"
    >
      <span
        aria-hidden
        className="absolute inset-x-0 top-1/2 h-px bg-[var(--chat-accent)] opacity-40"
      />
      {/* Centred, matching the reference composition — the same axis a day
          divider sits on, so the two read as one family of separator rather
          than as two unrelated marks. */}
      <span className="relative rounded-full bg-[var(--chat-accent)] px-2 py-0.5 text-micro font-semibold uppercase tracking-wider text-[var(--chat-accent-fg)]">
        {count > 0 ? `${count} new` : "New"}
      </span>
    </div>
  );
}

/**
 * A relay-signed statement about the room: somebody joined, the topic changed,
 * a message was removed.
 *
 * Centred, quiet, and deliberately not shaped like a message — it has no
 * author avatar and no actions, because it is not something a person said and
 * offering to reply to it would be a lie about what it is.
 */
export function SystemRow({ text, at }: { text: string; at: number }) {
  return (
    <div
      data-row="system"
      className="flex items-center justify-center gap-2 px-5 py-1.5 text-center text-xs text-[var(--chat-quiet)]"
    >
      <span>{text}</span>
      <time dateTime={new Date(at * 1000).toISOString()} className="sr-only">
        {new Date(at * 1000).toISOString()}
      </time>
    </div>
  );
}

/**
 * A run of system events of the same sort, folded into one row.
 *
 * Ten people joining a channel is one fact. Drawn as ten rows it is an
 * announcement that pushes the conversation off the screen — the transcript
 * ends up mostly bookkeeping about itself — so the projector folds them and
 * hands over a composed sentence plus the labels that went into it.
 *
 * Two things this renderer must not do, and both are tempting:
 *
 *   • **It does not write the sentence.** `text` arrives composed. Assembling
 *     copy here from `kind` and `actors` would be a second voice for the same
 *     event, and the two would disagree the first time the projector learns a
 *     new membership verb.
 *   • **It does not hide the members.** The fold is a summary, not a
 *     replacement: the row expands to the individual people, because "who
 *     joined" is precisely the question a folded "9 people joined" provokes.
 *
 * The expansion changes the row's height, which is fine and is the reason the
 * list measures every row it draws rather than trusting an estimate.
 */
export function SystemGroupRow({
  row,
}: {
  row: Extract<ChatRow, { type: "system-group" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div data-row="system-group" data-kind={row.kind} className="px-5 py-1.5">
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        className="tap-target mx-auto flex max-w-full items-center gap-2 rounded-full px-2 py-1 text-xs text-[var(--chat-quiet)] transition-colors hover:bg-[var(--chat-hover)]"
      >
        <span className="flex -space-x-1.5">
          {/* Three faces and then a number: a facepile that grows without
              bound stops being a glance and becomes a list drawn sideways. */}
          {row.actors.slice(0, 3).map((label) => (
            <ActorAvatar
              key={label}
              label={label}
              pubkey={label}
              size={18}
              className="ring-2 ring-background"
            />
          ))}
        </span>
        <span className="min-w-0 truncate">{row.text}</span>
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded ? (
        <ul className="mx-auto mt-1 flex max-w-sm flex-col gap-1 rounded-lg bg-[var(--chat-hover)] px-3 py-2 text-xs">
          {row.actors.map((label) => (
            <li key={label} className="flex items-center gap-2">
              <ActorAvatar label={label} pubkey={label} size={18} />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <span className="shrink-0 tabular-nums text-[var(--chat-quiet)]">
                {formatTime(row.at)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Draw whichever of the four this row is. Messages are handled elsewhere. */
export function NonMessageRow({ row }: { row: Exclude<ChatRow, { type: "message" }> }) {
  if (row.type === "day") return <DayDivider at={row.at} />;
  if (row.type === "unread") return <UnreadDivider count={row.count} />;
  if (row.type === "system-group") return <SystemGroupRow row={row} />;
  return <SystemRow text={row.text} at={row.at} />;
}
