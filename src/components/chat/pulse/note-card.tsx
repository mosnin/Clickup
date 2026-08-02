"use client";

// One note, and one burst of agent activity.
//
// Two row types, one file, because they are the same object drawn at two
// densities and keeping them together is what stops the second one drifting
// into a different visual language. A note is a person saying something; an
// agent card is a run of things one machine did, folded by
// `groupAgentNotes` — the fold is pure and lives in `src/lib/buzz/pulse.ts`, so
// nothing here decides what belongs together.
//
// The upvote is the only action with state, and it is optimistic: the pill
// flips immediately and `applyReactionState` clamps the count, because the
// server round trip is longer than the gesture and a pill that waits reads as
// a pill that did not register.

import { useState } from "react";
import { ArrowBigUp } from "lucide-react";
import { timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";
import {
  applyReactionState,
  noteSnippet,
  type AgentNoteGroup,
  type PulseNote,
  type ReactionState,
} from "@/lib/buzz/pulse";
import type { PulseAuthor } from "./pulse-data";

function displayName(pubkey: string, names: Map<string, PulseAuthor>): string {
  return names.get(pubkey)?.name ?? `${pubkey.slice(0, 8)}…`;
}

/** Two letters. Never more — it is a 32px tile. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-[0.6875rem] font-semibold"
    >
      {initials(name)}
    </span>
  );
}

export function NoteCard({
  note,
  names,
  reaction,
  onUpvote,
  canUpvote,
}: {
  note: PulseNote;
  names: Map<string, PulseAuthor>;
  reaction: ReactionState | undefined;
  onUpvote: (noteId: string, on: boolean) => Promise<void>;
  canUpvote: boolean;
}) {
  // Held locally so the pill answers the click, then reconciles when the
  // subscription catches up. `undefined` means "no local opinion yet", which is
  // not the same as "not upvoted" — the difference is what stops the pill
  // flickering off between the click and the round trip.
  const [pending, setPending] = useState<ReactionState | undefined>(undefined);
  const state = pending ?? reaction ?? { count: 0, reactedByViewer: false };
  const author = displayName(note.pubkey, names);
  const isAgent = names.get(note.pubkey)?.isAgent ?? false;

  async function toggle() {
    const next = applyReactionState(state, !state.reactedByViewer);
    setPending(next);
    try {
      await onUpvote(note.id, next.reactedByViewer);
    } finally {
      // Hand authority back to the subscription. Whatever the server decided is
      // now the truth, including "you had already upvoted this".
      setPending(undefined);
    }
  }

  return (
    <article className="bento rounded-2xl px-4 py-3">
      <div className="flex items-start gap-3">
        <Avatar name={author} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="truncate text-sm font-semibold">{author}</span>
            {isAgent ? (
              <span className="chat-badge" data-size="sm">
                agent
              </span>
            ) : null}
            <span className="chat-quiet text-xs">{timeAgo(note.createdAt * 1000)}</span>
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm">{note.content}</p>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-1 pl-11">
        <button
          type="button"
          disabled={!canUpvote}
          onClick={toggle}
          aria-pressed={state.reactedByViewer}
          aria-label={state.reactedByViewer ? "Remove your upvote" : "Upvote this note"}
          className={cn(
            "tap-target flex items-center gap-1 rounded-full px-2 py-1 text-xs transition-colors",
            state.reactedByViewer ? "bg-muted font-semibold" : "chat-quiet hover:bg-muted/70",
            !canUpvote && "cursor-not-allowed opacity-50",
          )}
        >
          <ArrowBigUp aria-hidden className="size-3.5" />
          <span>{state.count}</span>
        </button>
      </div>
    </article>
  );
}

/**
 * A burst of one agent's notes, as one card.
 *
 * Keyed on `group.key` by the caller, which is `${pubkey}-${latestAt}` and does
 * not change when older history is paged in — that is the property
 * `groupAgentNotes` exists to guarantee, and it is why this card does not
 * remount underneath somebody who is reading it.
 */
export function AgentActivityCard({
  group,
  names,
}: {
  group: AgentNoteGroup;
  names: Map<string, PulseAuthor>;
}) {
  const author = displayName(group.pubkey, names);
  return (
    <article className="bento rounded-2xl px-4 py-3">
      <div className="flex items-start gap-3">
        <Avatar name={author} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="truncate text-sm font-semibold">{author}</span>
            <span className="chat-quiet text-xs">
              {group.notes.length === 1
                ? timeAgo(group.latestAt * 1000)
                : `${group.notes.length} updates · ${timeAgo(group.latestAt * 1000)}`}
            </span>
          </p>
          <ul className="mt-1 space-y-1">
            {group.notes.map((entry) => (
              <li key={entry.id} className="text-sm">
                {/* One line per act — verb, object, outcome. A card that
                    reprinted whole notes would be a transcript, and a
                    transcript is what the room is for. */}
                {noteSnippet(entry.content)}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </article>
  );
}
