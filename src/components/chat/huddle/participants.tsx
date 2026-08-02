"use client";

// Who is in the call.
//
// The list is built from the **log** — the folded 48101/48102 roster — and
// never from the audio transport's peer list. With no provider those two
// disagree completely (one is empty), and the one that has to win is the one
// that is true: a person who joined *is* in the call whether or not anybody can
// hear them.
//
// The speaking ring is the opposite: it is drawn only from something the
// transport measured, so with no provider nobody's ring ever lights. That is
// the honest answer. A ring driven by anything else — a random walk, a "last
// message" heuristic — would be an animation that looks exactly like the real
// thing and means nothing.

import { useRef, useState } from "react";
import { UsersRound, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover } from "@/components/chat/transcript/popover";
import { useHuddle, type HuddleRosterEntry } from "./huddle-provider";

/**
 * A deterministic colour for a pubkey.
 *
 * Buzz's `HexAvatar`: an HSL hue from the first four hex characters, with the
 * next six shown as text. Deterministic matters more than pretty — the same
 * person is the same colour in every call, in every room, forever, so a roster
 * is scannable before any name is read.
 */
export function pubkeyTint(pubkey: string): string {
  const seed = Number.parseInt(pubkey.slice(0, 4) || "0", 16) || 0;
  return `hsl(${seed % 360} 62% 45%)`;
}

function ParticipantAvatar({ entry }: { entry: HuddleRosterEntry }) {
  return (
    <span
      className={cn(
        "relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[0.625rem] font-semibold text-white",
        // The speaking ring: 2px, and only when the transport said so.
        entry.speaking ? "ring-2 ring-emerald-500 ring-offset-1 ring-offset-transparent" : "",
      )}
      style={{ backgroundColor: pubkeyTint(entry.pubkey) }}
      aria-hidden
    >
      {entry.name.slice(0, 2).toUpperCase()}
    </span>
  );
}

/**
 * One participant row.
 *
 * The subtitle answers the only three questions a roster is asked, in the order
 * they matter: is this person talking right now, is this a machine, is this
 * anybody at all.
 */
function ParticipantRow({
  entry,
  onRemove,
}: {
  entry: HuddleRosterEntry;
  onRemove?: () => void;
}) {
  const subtitle = entry.speaking ? "Speaking" : entry.isAgent ? "Agent" : "In the huddle";
  return (
    <li
      data-testid="huddle-participant"
      data-pubkey={entry.pubkey}
      data-speaking={entry.speaking}
      className="flex items-center gap-2 rounded-lg px-2 py-1.5"
    >
      <ParticipantAvatar entry={entry} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.8125rem] font-medium">
          {entry.name}
          {entry.isSelf ? " (you)" : ""}
        </span>
        <span className="chat-quiet block truncate text-[0.6875rem]">{subtitle}</span>
      </span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${entry.name} from the huddle`}
          onClick={onRemove}
          className="tap-target chat-icon-button shrink-0"
        >
          <X aria-hidden className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </li>
  );
}

export function ParticipantsControl() {
  const { roster } = useHuddle();
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Participants (${roster.length})`}
        data-testid="huddle-participants"
        onClick={() => setOpen((value) => !value)}
        className="tap-target flex items-center gap-1.5 rounded-full bg-black/5 px-3 py-1.5 text-[0.8125rem] font-medium hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
      >
        <UsersRound aria-hidden className="h-4 w-4" />
        <span className="tabular-nums">{roster.length}</span>
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        label="Participants"
        className="w-72 p-1"
      >
        <ul className="flex max-h-72 flex-col overflow-y-auto chat-scroll">
          {roster.map((entry) => (
            <ParticipantRow key={entry.pubkey} entry={entry} />
          ))}
          {roster.length === 0 ? (
            <li className="chat-quiet px-2 py-2 text-[0.8125rem]">Nobody is in this huddle.</li>
          ) : null}
        </ul>
      </Popover>
    </>
  );
}

/**
 * The faces, inline in the bar.
 *
 * Capped, because a bar is a bar: past six the count in the participants
 * control is the better answer and the row stops shrinking the controls beside
 * it.
 */
export function ParticipantStrip({ max = 6 }: { max?: number }) {
  const { roster } = useHuddle();
  const shown = roster.slice(0, max);
  const rest = roster.length - shown.length;
  return (
    <span className="flex items-center -space-x-1.5" data-testid="huddle-strip">
      {shown.map((entry) => (
        <span key={entry.pubkey} title={entry.name}>
          <ParticipantAvatar entry={entry} />
        </span>
      ))}
      {rest > 0 ? (
        <span className="chat-quiet pl-3 text-[0.6875rem] tabular-nums">+{rest}</span>
      ) : null}
    </span>
  );
}
