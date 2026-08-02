"use client";

// The pills under a message.
//
// Small surface, one rule: the pill is a *toggle*, and it says which state it
// is in. `aria-pressed` rather than a colour alone, because "did my reaction
// land" is the entire question a reader has when they click one, and a 4%
// difference in fill answers it for maybe half of them.
//
// The ordering is the projector's (`firstAt`, earliest reaction) and nothing
// here re-sorts. A pill that reordered when somebody else reacted would move
// under the cursor of the person about to click it.

import type { ChatReaction } from "@/lib/buzz/message-types";
import { cn } from "@/lib/utils";
import { reactionLabel } from "./reaction-algebra";

export function MessageReactions({
  reactions,
  onToggle,
  disabled,
}: {
  reactions: readonly ChatReaction[];
  onToggle: (emoji: string, remove: boolean) => void;
  disabled?: boolean;
}) {
  if (reactions.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-wrap items-center gap-1">
      {reactions.map((reaction) => (
        <li key={reaction.emoji}>
          <button
            type="button"
            disabled={disabled}
            aria-pressed={reaction.mine}
            aria-label={reactionLabel(reaction)}
            // The reactor list as a native tooltip: cheap, keyboard-reachable
            // through the accessible name above, and it does not need a
            // portal that would be clipped by the transcript's scroller.
            title={reaction.reactors.join(", ")}
            onClick={() => onToggle(reaction.emoji, reaction.mine)}
            data-reaction={reaction.emoji}
            className={cn(
              "flex h-5 items-center gap-1 rounded-full px-1.5 text-[0.6875rem] tabular-nums transition-colors",
              reaction.mine
                ? "bg-[var(--chat-active)] font-semibold"
                : "bg-[var(--chat-hover)] hover:bg-[var(--chat-active)]",
              disabled && "opacity-50",
            )}
          >
            {reaction.emojiUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={reaction.emojiUrl}
                alt={reaction.emoji}
                className="size-3.5 object-contain"
              />
            ) : (
              <span aria-hidden>{reaction.emoji}</span>
            )}
            <span>{reaction.count}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
