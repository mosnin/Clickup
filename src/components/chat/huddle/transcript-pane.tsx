"use client";

// Live captions, and the toggle that asks for them.
//
// **A caption is not an event and there is no caption kind**, which is the one
// design decision in this file and the reason the pane says what it says. Buzz
// posts recognized speech as messages into its ephemeral channel; ours would
// have to go into the room, where it would sit in the timeline forever. A
// durable record of everything said in every call is a governance decision
// nobody made, and Buzz's own list of what a huddle deliberately lacks ends
// with "no recording" — so captions ride the room's realtime channel exactly as
// typing does, live in this pane for the length of the call, and are gone with
// it. The pane says so out loud rather than implying an archive.
//
// What that means with no voice provider: nothing is being recognized, so the
// toggle is disabled with the transport's own sentence. The pane still draws
// lines, because a caption can also come from an **agent** describing what it
// just said (`buzz.huddle.caption` is one function for both), and that half is
// real today.

import { useEffect, useRef } from "react";
import { Captions } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHuddle } from "./huddle-provider";

export function TranscriptToggle() {
  const { session, transport, mediaLive, dispatch } = useHuddle();
  const canCaption = transport.capabilities.captions && mediaLive;
  const reason =
    transport.unavailableReason ??
    "The audio path is not up, so there is nothing to transcribe.";

  return (
    <button
      type="button"
      aria-pressed={session.transcriptionEnabled}
      aria-disabled={!canCaption}
      disabled={!canCaption}
      data-testid="huddle-captions"
      title={canCaption ? "Live captions" : reason}
      onClick={() =>
        dispatch({
          type: "set_transcription",
          enabled: !session.transcriptionEnabled,
          // `byUser: true` is what stops the agent auto-enable rule from
          // turning captions back on after somebody turned them off. Without
          // it, a room with a machine in it overrules the person every time.
          byUser: true,
        })
      }
      className={cn(
        "tap-target chat-icon-button disabled:cursor-not-allowed disabled:opacity-45",
        session.transcriptionEnabled && canCaption ? "text-foreground" : "",
      )}
    >
      <Captions aria-hidden className="h-4 w-4" />
      <span className="sr-only">Live captions</span>
    </button>
  );
}

/**
 * The pane.
 *
 * Auto-scrolls to the newest line, and does it with `scrollTop` rather than
 * `scrollIntoView`: the pane sits inside the room, and `scrollIntoView` on a
 * nested scroller drags the whole conversation up with it.
 */
export function TranscriptPane({ className }: { className?: string }) {
  const { captions, session, transport, mediaLive } = useHuddle();
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [captions.length]);

  const capturing = session.transcriptionEnabled && transport.capabilities.captions && mediaLive;

  return (
    <section
      aria-label="Huddle transcript"
      data-testid="huddle-transcript"
      className={cn("flex min-h-0 flex-col gap-1", className)}
    >
      {/* Wraps rather than truncates: the sentence on the right is the only
          place this surface says the captions are not being kept, and at
          390px a `justify-between` row clips exactly that half. */}
      <header className="flex flex-wrap items-baseline justify-between gap-x-2">
        <h3 className="text-tiny font-semibold uppercase tracking-wider">Transcript</h3>
        <p className="chat-quiet text-tiny">Not recorded — this clears when the huddle ends.</p>
      </header>
      <div ref={scroller} className="chat-scroll flex max-h-40 flex-col gap-1 overflow-y-auto">
        {captions.map((line) => (
          <p key={`${line.pubkey}-${line.at}`} className="text-mini leading-snug">
            <span className="font-medium">{line.name}</span>{" "}
            <span className="chat-quiet">{line.text}</span>
          </p>
        ))}
        {captions.length === 0 ? (
          <p className="chat-quiet text-mini leading-snug">
            {capturing
              ? "Listening."
              : transport.capabilities.captions
                ? "Captions are off."
                : // The honest sentence, and it names what still works: an agent
                  // in the call can write here through the same function a
                  // speech-to-text tap would.
                  "Nothing is being transcribed — this deployment has no voice provider. Agents in the huddle can still write here."}
          </p>
        ) : null}
      </div>
    </section>
  );
}
