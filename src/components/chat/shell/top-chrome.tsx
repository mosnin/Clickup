"use client";

// The capsule across the top of the application.
//
// It exists for the two questions the sidebar cannot answer.
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
//
// The shape is Work's capsule, not a bare strip: `rounded-full border
// border-border bg-card py-1.5 pl-4 pr-2 shadow-md`, the exact classes
// `dashboard/page-header.tsx` floats over every Work page — because a bare
// strip here and a floating capsule one dashboard over is the two halves of
// one product disagreeing about what their own chrome looks like. It closes
// with the same `CapsuleCluster` (bell + avatar) Work's capsule closes with,
// imported rather than rebuilt, so notifications mean the same thing and cost
// the same one subscription in both places.

import { useMemo } from "react";
import { PanelLeft } from "lucide-react";
import { ChatSearchLauncher } from "@/components/chat/search";
import { useRoster } from "@/components/chat/presence";
import { CapsuleCluster } from "@/components/dashboard/page-header";
import type { ResolvableAuthor } from "@/lib/buzz/search-query";
import { useChatShell } from "./chat-shell";
import { useChannel, useChannels } from "./channel-data";
import { title } from "./sections";

/**
 * The capsule's total footprint (its own height plus the band's padding),
 * exported so the sidebar drawer (`channel-sidebar.tsx`) can reserve exactly
 * this much space above its own content on a phone — the drawer overlays the
 * room, including the space this capsule occupies, so the two have to agree
 * on the number and there is no way to ask the DOM "how tall did the header
 * render" before it has.
 */
export const TOP_CHROME_BAND_HEIGHT_PX = 64;

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
    <header data-chat-top-chrome="" className="flex shrink-0 items-center px-2 pb-2 pt-2">
      <div className="flex min-h-12 w-full items-center gap-2 rounded-full bg-card py-1.5 pl-4 pr-2 shadow-md">
        <button
          type="button"
          // One control, two jobs, because they are the same job at two widths:
          // "show me the navigation". Naming it after the effect rather than the
          // mechanism keeps the label true in both.
          onClick={() => (isNarrow ? onOpenNav() : setSidebarOpen(!sidebarOpen))}
          aria-label={isNarrow ? "Show navigation" : "Toggle sidebar"}
          aria-expanded={isNarrow ? undefined : sidebarOpen}
          className="chat-icon-button tap-target -ml-2 shrink-0"
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

        {/* `shrink-0` because the location line beside it is `flex-1
            truncate`: without it the two negotiate and the control is what
            gives way, which at 390px means a search box squeezed to its
            padding. */}
        <ChatSearchLauncher
          scope={scope}
          channels={rooms}
          people={people}
          className="shrink-0"
        />

        {/* The capsule's right end, same as Work's: notifications, then you.
            One chrome, both modes — see the module comment. */}
        <CapsuleCluster />
      </div>
    </header>
  );
}
