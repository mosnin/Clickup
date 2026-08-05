"use client";

// The footer card: who you are, and where you are.
//
// Buzz stacks your display name over your *status*, and cross-fades that line
// to the community name on hover. We have no status concept yet, so the
// cross-fade would be an animation between a line and itself — the second line
// is simply the community, which is the half of the pair that actually tells
// you something a room can be wrong about.
//
// The avatar is Clerk's own `UserButton`, not a picture of one. It is the
// account menu — manage account, sign out — and reproducing that surface here
// would mean a second, worse copy of something that already works.

import { Sparkles } from "lucide-react";
import { UserButton, useUser } from "@clerk/nextjs";
import { useCustomize } from "@/components/appearance/customize-provider";
import { useChatShell } from "./chat-shell";

/**
 * The way into customise mode, worded and shaped exactly as the Work
 * sidebar words and shapes it.
 *
 * Same verb, same icon, same "Done customising" on the way out — because it
 * is the same act on the same product, and a reader who learned it in one
 * half should not have to discover it again in the other. It lives beside
 * the theme control and the account row for the same reason it does in Work:
 * these are the three things about the application rather than about the
 * work, and they belong together at the bottom.
 */
export function ChatCustomiseRow() {
  const { active, setActive } = useCustomize();
  const { closeNav } = useChatShell();
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => {
        const next = !active;
        setActive(next);
        // Below md the sidebar is a drawer covering the whole screen, so
        // entering the mode from inside it would hide the one surface the
        // mode exists to let you edit. Only on entry — closing the nav
        // under somebody who is still using it is its own small rudeness.
        if (next) closeNav();
      }}
      className="chat-row justify-start px-2 hover:bg-[var(--chat-hover)] aria-pressed:bg-[var(--chat-active)]"
    >
      <Sparkles aria-hidden className="chat-quiet size-3.5 shrink-0" />
      <span className="flex-1 truncate text-left">
        {active ? "Done customising" : "Customise"}
      </span>
    </button>
  );
}

export function ChatProfileCard() {
  const { scopeName } = useChatShell();
  const { user } = useUser();
  const name = user?.fullName ?? user?.username ?? "Your account";

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-1 py-1 transition-colors hover:bg-muted/70">
      <UserButton afterSignOutUrl="/" />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[0.8125rem] font-semibold">{name}</span>
        <span className="chat-quiet truncate text-[0.6875rem]">
          {scopeName || " "}
        </span>
      </span>
    </div>
  );
}
