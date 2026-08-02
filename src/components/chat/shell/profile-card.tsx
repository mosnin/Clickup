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

import { UserButton, useUser } from "@clerk/nextjs";
import { useChatShell } from "./chat-shell";

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
