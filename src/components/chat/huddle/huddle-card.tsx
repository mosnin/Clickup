"use client";

// The two ways into a call: the button in the room, and the row in the
// timeline.
//
// The card is what a **48100** renders as. `src/lib/buzz/timeline.ts` already
// puts that kind in `TIMELINE_CONTENT_KINDS`, so a huddle announcement already
// occupies a row; this is what goes in it. It is drawn from the *folded*
// snapshot rather than from the announcement alone, which is the difference
// between "somebody started a huddle an hour ago" and "there is a huddle
// happening, with these three people in it, join it".
//
// The decay rule shows up here and nowhere else in the UI, which is where it
// matters: a 48100 older than the joinable window with no 48103 reads as
// **Ended** even though nothing ever said so. Without that, a room whose last
// participant closed a laptop shows "in progress" forever, with a Join button
// that connects to nobody — and the person who presses it has no way to learn
// that the call is not there.

import { Headphones } from "lucide-react";
import { cn } from "@/lib/utils";
import { huddleById, type HuddleSnapshot } from "@/lib/buzz/huddle";
import { useHuddle } from "./huddle-provider";

/** The one sentence a card says about state. */
export function huddleCardStatus(snapshot: HuddleSnapshot | null): string {
  if (!snapshot) return "Huddle";
  if (snapshot.endReason === "expired") return "Huddle · ended";
  if (snapshot.endReason === "ended") return "Huddle · ended";
  return snapshot.participantCount === 1
    ? "Huddle · in progress · 1 person"
    : `Huddle · in progress · ${snapshot.participantCount} people`;
}

/**
 * The in-timeline card for one huddle announcement.
 *
 * `eventId` is the 48100's id, which **is** the huddle id — so a row can be
 * drawn from the message it already holds, with no extra lookup and no id to
 * carry in the content.
 */
export function HuddleCard({ eventId, className }: { eventId: string; className?: string }) {
  const { huddles, mine, join, leave, busy } = useHuddle();
  // The provider holds the folded set for this room; a card is one entry of it,
  // looked up in **all** of them rather than only the live one — a card for a
  // call that is over is the commonest card there is, and one that could not
  // find its own snapshot would draw a bare "Huddle" with no state at all.
  const snapshot = huddleById(huddles, eventId);
  const joinable = snapshot?.live === true;
  const inThisOne = mine?.huddleId === eventId;

  return (
    <div
      data-testid="huddle-card"
      data-huddle={eventId}
      data-live={joinable}
      className={cn("bento flex items-center gap-3 rounded-2xl px-3 py-2", className)}
    >
      <span className="icon-tile" aria-hidden>
        <Headphones className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.8125rem] font-medium">
          {huddleCardStatus(snapshot)}
        </span>
      </span>
      {inThisOne ? (
        <button
          type="button"
          onClick={() => void leave()}
          aria-busy={busy}
          className="tap-target rounded-full bg-black/5 px-3 py-1.5 text-[0.8125rem] font-medium hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
        >
          Leave
        </button>
      ) : joinable ? (
        <button
          type="button"
          onClick={() => void join(eventId)}
          aria-busy={busy}
          data-testid="huddle-card-join"
          className="tap-target rounded-full bg-foreground px-3 py-1.5 text-[0.8125rem] font-medium text-background"
        >
          Join
        </button>
      ) : null}
    </div>
  );
}

/**
 * Start, or join what is already running.
 *
 * One button for both, because from where the person is standing it is one
 * intention — and the server agrees: `huddle.start` returns the existing call
 * with `created: false` rather than opening a second one, since two calls in
 * one room split a conversation with no way for anybody to tell which one the
 * others are in.
 */
export function HuddleStartButton({ className }: { className?: string }) {
  const { live, mine, session, start, join, busy } = useHuddle();
  if (mine) return null;
  const joinable = live !== null;

  return (
    <button
      type="button"
      aria-busy={busy}
      disabled={session.phase !== "idle"}
      data-testid="huddle-start"
      onClick={() => (joinable && live ? void join(live.huddleId) : void start())}
      className={cn(
        "tap-target flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[0.8125rem] font-medium",
        joinable
          ? "bg-emerald-600 text-white hover:bg-emerald-700"
          : "bg-black/5 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15",
        "disabled:cursor-not-allowed disabled:opacity-45",
        className,
      )}
    >
      <Headphones aria-hidden className="h-4 w-4" />
      {/* The word goes away on a phone, the name does not. Five pane toggles
          and a member count already fill a 390px room header, and a control
          whose label pushes the last of them off the edge has taken a feature
          away to describe itself. `sr-only` rather than `hidden`, so the
          button is still called "Join huddle" to anyone reading it aloud. */}
      <span className="sr-only sm:not-sr-only">
        {joinable ? `Join huddle · ${live.participantCount}` : "Huddle"}
      </span>
    </button>
  );
}
