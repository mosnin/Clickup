"use client";

// The huddle bar: the one place a call is visible while it is happening.
//
// Layout is Buzz's — a three-column grid `[1fr auto 1fr]` with the status
// cluster left, the controls centred **on the axis of the screen** rather than
// on the axis of what is left over, and a spacer right. It is worth the extra
// element: a control cluster that drifts as the status text grows is a set of
// buttons that are never twice in the same place.
//
// The bar is rendered only while a call is up (`HUDDLE_VISIBLE_PHASES`), and it
// states the truth about audio once, on the left, where a person looks when
// something is not as expected — not as a toast, because with no voice provider
// this is the *steady state* of the deployment rather than an event.
//
// Every control here is real or disabled. See `controls.tsx` for why that
// sentence is the whole design.

import { cn } from "@/lib/utils";
import { PhoneOff, X } from "lucide-react";
import { HUDDLE_VISIBLE_PHASES } from "@/lib/buzz/huddle";
import { MicControls, SpeakerControls } from "./controls";
import { AddAgentControl } from "./add-agent";
import { ParticipantsControl, ParticipantStrip } from "./participants";
import { ReactionBurst, ReactionControl } from "./reactions";
import { TranscriptPane, TranscriptToggle } from "./transcript-pane";
import { useHuddle } from "./huddle-provider";

/** What the left cluster says the call is doing. */
function phraseFor(phase: string, participants: number): string {
  switch (phase) {
    case "creating":
      return "Starting a huddle…";
    case "connecting":
      return "Joining…";
    case "leaving":
      return "Leaving…";
    default:
      return participants === 1
        ? "Huddle · just you so far"
        : `Huddle · ${participants} people`;
  }
}

export function HuddleBar({ className }: { className?: string }) {
  const {
    session,
    mediaNotice,
    mediaLive,
    roster,
    error,
    busy,
    leave,
    dismissError,
    signalTransport,
  } = useHuddle();

  if (!HUDDLE_VISIBLE_PHASES.has(session.phase)) return null;

  return (
    <div
      data-testid="huddle-bar"
      data-phase={session.phase}
      data-media={mediaLive ? "live" : "silent"}
      className={cn(
        // One column on a phone, and that is not a nicety. Two columns at
        // 390px gives the status cluster whatever seven controls left over,
        // which is about one word wide — the notice then sets one word per
        // line and the controls run off the right edge of a surface that
        // clips, so Leave becomes unreachable in a call you are already in.
        "bento relative grid grid-cols-1 items-center gap-3 rounded-2xl px-3 py-2",
        "sm:grid-cols-[1fr_auto] lg:grid-cols-[1fr_auto_1fr]",
        className,
      )}
    >
      <ReactionBurst />

      {/* ── left: what is happening, and what is not ─────────────────── */}
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <ParticipantStrip />
          <p className="min-w-0 truncate text-[0.8125rem] font-medium">
            {phraseFor(session.phase, roster.length)}
          </p>
        </div>

        {mediaNotice ? (
          // Stated once, quietly, and never as an error: with no provider this
          // is what the deployment *is*, and the call itself is entirely real.
          <p
            data-testid="huddle-media-notice"
            className="chat-quiet max-w-prose text-[0.6875rem] leading-snug"
          >
            {mediaNotice}
          </p>
        ) : null}

        {signalTransport === "unavailable" && !mediaNotice ? (
          <p className="chat-quiet text-[0.6875rem] leading-snug">
            Reactions and captions need a realtime service; the roster is live either way.
          </p>
        ) : null}

        {error ? (
          <p
            role="alert"
            data-testid="huddle-error"
            className="flex items-center gap-1.5 text-[0.6875rem] leading-snug text-red-600 dark:text-red-400"
          >
            {error}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={dismissError}
              className="tap-target chat-icon-button"
            >
              <X aria-hidden className="h-3 w-3" />
            </button>
          </p>
        ) : null}
      </div>

      {/* ── centre: the controls, on the axis ────────────────────────── */}
      <div className="flex flex-wrap items-center justify-center gap-1.5 justify-self-center">
        <MicControls />
        <SpeakerControls />
        <ParticipantsControl />
        <ReactionControl />
        <TranscriptToggle />
        <AddAgentControl />
        <button
          type="button"
          onClick={() => void leave()}
          aria-busy={busy}
          data-testid="huddle-leave"
          className="tap-target flex items-center gap-1.5 rounded-full bg-red-600 px-3 py-1.5 text-[0.8125rem] font-medium text-white hover:bg-red-700"
        >
          <PhoneOff aria-hidden className="h-4 w-4" />
          Leave
        </button>
      </div>

      {/* The spacer that keeps the cluster centred on the screen rather than
          on whatever the status text left behind. Hidden below lg, where the
          bar is two columns and centring on the remainder is the right answer. */}
      <div aria-hidden className="hidden lg:block" />

      {session.transcriptionEnabled ? (
        <TranscriptPane className="col-span-full border-t border-black/5 pt-2 dark:border-white/10" />
      ) : null}

      {/*
        The screen-reader status line. It says the two things that are not
        visible from the controls: whether the microphone is actually open, and
        whether audio exists at all. `aria-live="polite"` so it is announced on
        change rather than interrupting.
      */}
      <output aria-live="polite" className="sr-only">
        {mediaLive
          ? session.micMuted
            ? "Microphone muted."
            : session.inputMode === "push_to_talk"
              ? "Push to talk: hold Control and Space to speak."
              : "Microphone open."
          : "No audio in this huddle."}
      </output>
    </div>
  );
}
