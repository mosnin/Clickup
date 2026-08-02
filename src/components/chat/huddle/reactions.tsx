"use client";

// Reactions: the one control in a huddle that works perfectly with no audio.
//
// A reaction is a **kind 24810 in the ephemeral band**, which means the log
// signs it and hands it back without writing a row (06-protocol §16.22). That
// is exactly right for a gesture in a live call: it is attributable while it
// matters and gone afterwards, and a permanent record of every thumbs-up in
// every call would be a table growing at the rate of a gesture.
//
// The burst is optimistic and the echo is dropped (see the provider): a
// reaction that appears a round trip after the press does not read as a
// reaction, it reads as lag.

import { useRef, useState } from "react";
import { SmilePlus } from "lucide-react";
import { AnimatePresence, motion } from "@/components/motion";
import { Popover } from "@/components/chat/transcript/popover";
import { useHuddle } from "./huddle-provider";

/**
 * The tray.
 *
 * Six, not the whole emoji picker: a huddle reaction is answered in the second
 * somebody says the thing it is answering, and a search field is longer than
 * that second. The room's composer is where the full picker lives.
 */
export const HUDDLE_REACTIONS = ["👍", "🎉", "😂", "👀", "🙌", "❤️"] as const;

export function ReactionControl() {
  const { react, mine } = useHuddle();
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const joined = mine !== null;

  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="React"
        aria-disabled={!joined}
        disabled={!joined}
        data-testid="huddle-react"
        onClick={() => setOpen((value) => !value)}
        className="tap-target chat-icon-button disabled:cursor-not-allowed disabled:opacity-45"
      >
        <SmilePlus aria-hidden className="h-4 w-4" />
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        label="React"
        className="p-1"
      >
        <div className="flex items-center gap-0.5">
          {HUDDLE_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React with ${emoji}`}
              onClick={() => {
                setOpen(false);
                void react(emoji);
              }}
              className="tap-target rounded-lg px-2 py-1 text-lg hover:bg-black/5 dark:hover:bg-white/10"
            >
              {emoji}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

/**
 * The bursts themselves, floating above the bar.
 *
 * `AnimatePresence` so a reaction that expires leaves rather than disappearing,
 * and every timing comes from the shared motion primitives, so reduced motion
 * is respected without this file knowing how.
 */
export function ReactionBurst() {
  const { reactions } = useHuddle();
  return (
    <div
      aria-live="polite"
      data-testid="huddle-burst"
      className="pointer-events-none absolute inset-x-0 -top-10 flex items-end justify-center gap-1"
    >
      <AnimatePresence>
        {reactions.map((reaction) => (
          <motion.span
            key={`${reaction.pubkey}-${reaction.at}-${reaction.emoji}`}
            initial={{ opacity: 0, y: 8, scale: 0.8 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.9 }}
            className="text-xl"
            title={`${reaction.senderName} reacted`}
          >
            {reaction.emoji}
          </motion.span>
        ))}
      </AnimatePresence>
    </div>
  );
}
