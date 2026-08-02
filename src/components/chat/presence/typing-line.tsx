"use client";

// "Ada is typing..."
//
// It sits between the transcript and the composer, in a band that is always
// there. That is the one layout decision worth defending: a line that appears
// and disappears pushes the last message up and down by its own height every
// few seconds, which is a transcript that will not sit still while you read
// it. So the band reserves its height and only its contents come and go.
//
// `aria-live="polite"` and never `assertive`: somebody typing is not an
// interruption, and a screen reader that announced every keystroke burst in a
// busy room would be unusable. The `data-testid` appears only when the line
// has something to say, which is what lets a test assert absence.
//
// The sentence itself is `typingLabel` in `src/lib/buzz/presence.ts`, tested
// there. This file draws it.

import { cn } from "@/lib/utils";
import { typingLabel, type TypingEntry } from "@/lib/buzz/presence";
import { ActorAvatar } from "@/components/chat/transcript/avatar";

export function TypingLine({
  typists,
  variant = "transcript",
  className,
}: {
  typists: readonly TypingEntry[];
  /** `activity` is the smaller form for a composer accessory or a rail row. */
  variant?: "transcript" | "activity";
  className?: string;
}) {
  const label = typingLabel(typists.map((t) => t.name));
  const activity = variant === "activity";

  return (
    <div
      aria-live="polite"
      // Present in the tree even when empty, so the announcement region is
      // stable and the band does not resize the transcript above it.
      {...(label ? { "data-testid": "message-typing-indicator" } : {})}
      className={cn(
        "flex items-center gap-1.5 overflow-hidden",
        activity ? "h-4 text-[0.6875rem]" : "h-5 px-1 text-xs",
        className,
      )}
    >
      {label ? (
        <>
          {/* Overlapping, because three marks in a row is a list and three
              overlapping is a group — and a group is what "and 2 others" is
              about to say in words anyway. */}
          <span className="flex shrink-0 items-center">
            {typists.slice(0, 3).map((typist, index) => (
              <ActorAvatar
                key={typist.key}
                label={typist.name}
                pubkey={typist.pubkey}
                isAgent={typist.isAgent}
                size={activity ? 14 : 16}
                className={index === 0 ? "" : "-ml-1.5"}
              />
            ))}
          </span>
          {/* The shimmer is Tailwind's own pulse rather than a keyframe of our
              own, so it inherits `motion-reduce` without a media query here. */}
          <span className="chat-quiet min-w-0 flex-1 animate-pulse truncate motion-reduce:animate-none">
            {label}
          </span>
        </>
      ) : null}
    </div>
  );
}

/**
 * The composer accessory's split (`useChannelActivityTyping`).
 *
 * People and agents are separated rather than merged into one sentence, and
 * the reason is not tidiness: "Ada and Scout are typing" reads as two
 * colleagues, and one of them is a machine whose reply will arrive in one
 * piece three seconds from now. Knowing which is which changes whether you
 * wait.
 */
export function splitTypists(typists: readonly TypingEntry[]): {
  people: TypingEntry[];
  agents: TypingEntry[];
} {
  return {
    people: typists.filter((t) => !t.isAgent),
    agents: typists.filter((t) => t.isAgent),
  };
}
