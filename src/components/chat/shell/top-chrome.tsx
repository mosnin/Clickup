"use client";

// The 40px strip across the top of the application.
//
// In Buzz this strip exists because a Tauri window has no title bar and
// something has to be draggable. We are a web app inside a browser (and, per
// D10, inside a desktop wrapper that draws its own frame), so the strip has to
// earn its height differently: it is where the two questions the sidebar
// cannot answer live.
//
//   • Where am I — when the sidebar is collapsed off-canvas, or you are on a
//     phone with the drawer shut, nothing else on screen names the community
//     or the room. This line does, quietly, and it is the reason the strip is
//     not simply deleted.
//   • Which application am I in — the mode switch. It sits here rather than in
//     the sidebar header (where the Work shell keeps it) precisely because the
//     Chat sidebar can be collapsed to nothing, and the only control that
//     changes which application you are looking at must never be behind a
//     collapse.
//
// It also carries in-room search, and that is the third question the sidebar
// cannot answer — "where was this said". Two search entry points is deliberate,
// the way a file manager has both a jump bar and a search pane: the sidebar's
// row dispatches ⌘K, the product's cross-dashboard quick-switch, which reaches
// rooms, tasks and pages by name; this one is search *in* the conversation and
// is the only surface that can express `from:`, `in:`, `after:` and `before:`.
// It takes ⌘⇧F so the two never contend for one keystroke — see
// `search/search-launcher.tsx` for the argument.
//
// What it deliberately does not carry: back and forward. Buzz needs them
// because its window has none, and it hand-derives `canGoForward` from the
// router's history index. Next's router does not expose one, and the History
// API cannot be asked whether going forward would do anything — so the
// honest options are a pair of buttons that are always enabled and sometimes
// no-ops, or none. The browser and the desktop wrapper both already draw them.

import { useMemo } from "react";
import { PanelLeft } from "lucide-react";
import { ChatSearchLauncher } from "@/components/chat/search";
import { useRoster } from "@/components/chat/presence";
import type { ResolvableAuthor } from "@/lib/buzz/search-query";
import { TOP_CHROME_HEIGHT_PX } from "./layout";
import { useChatShell } from "./chat-shell";
import { useChannel, useChannels } from "./channel-data";
import { title } from "./sections";

export function ChatTopChrome({ onOpenNav }: { onOpenNav: () => void }) {
  const { isNarrow, sidebarOpen, setSidebarOpen, channelId, scopeName, scope } =
    useChatShell();
  const channel = useChannel(channelId);
  const { channels } = useChannels();
  const roster = useRoster();

  // Who `from:` may resolve to. The roster is already subscribed once for the
  // whole application (the shell's `PresenceProvider`), so this is a read of
  // rows that are on screen rather than a second query — and an entry with no
  // Chat key cannot have authored anything, so it is not a candidate.
  const people = useMemo<ResolvableAuthor[]>(() => {
    const out: ResolvableAuthor[] = [];
    for (const entry of roster.entries.values()) {
      if (entry.pubkey) out.push({ pubkey: entry.pubkey, name: entry.name });
    }
    return out;
  }, [roster.entries]);

  // A fresh array every render would tear down and rebuild the dialog's
  // directory memo on each one; `undefined` (rooms not loaded) reads as an
  // empty directory, which is the honest answer — `in:` resolves against
  // nothing rather than against a guess.
  const rooms = useMemo(() => channels ?? [], [channels]);

  return (
    <header
      data-chat-top-chrome=""
      style={{ height: TOP_CHROME_HEIGHT_PX }}
      className="flex shrink-0 items-center gap-2 px-2"
    >
      <button
        type="button"
        // One control, two jobs, because they are the same job at two widths:
        // "show me the navigation". Naming it after the effect rather than the
        // mechanism keeps the label true in both.
        onClick={() => (isNarrow ? onOpenNav() : setSidebarOpen(!sidebarOpen))}
        aria-label={isNarrow ? "Show navigation" : "Toggle sidebar"}
        aria-expanded={isNarrow ? undefined : sidebarOpen}
        className="chat-icon-button tap-target shrink-0"
      >
        <PanelLeft aria-hidden className="size-4" />
      </button>

      <p className="chat-quiet min-w-0 flex-1 truncate text-xs">
        {scopeName ? <span>{scopeName}</span> : null}
        {channel ? (
          <>
            <span aria-hidden className="px-1.5 opacity-50">
              /
            </span>
            <span className="text-foreground">
              {channel.kind === "dm" || channel.kind === "group_dm"
                ? title(channel)
                : `#${channel.name}`}
            </span>
          </>
        ) : null}
      </p>

      {/* `shrink-0` because the location line beside it is `flex-1 truncate`:
          without it the two negotiate and the control is what gives way, which
          at 390px means a search box squeezed to its padding. */}
      <ChatSearchLauncher
        scope={scope}
        channels={rooms}
        people={people}
        className="shrink-0"
      />
    </header>
  );
}
