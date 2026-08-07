"use client";

// Home — what is waiting for you, across the community you are standing in.
//
// Buzz calls this the Inbox and puts it at `/`. It is the one screen that is
// not about a room: rooms are where you go to do something, home is where you
// find out what there is to do. So it is a list ordered by claim on your
// attention — mentions, then unread, then everything else quiet — rather than
// by recency, which the sidebar already sorts by.
//
// It renders from the same subscription the sidebar draws, so the two can
// never disagree about what is unread. There is no second query and no second
// count.

import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { FileText, Hash, Lock } from "lucide-react";
import { timeAgo } from "@/lib/time";
import { Stagger, StaggerItem } from "@/components/motion";
import type { ChatChannelSummary } from "@/lib/buzz/channel-types";
import { RemindersSection } from "@/components/chat/reminders";
import { useChannels } from "./channel-data";
import { useChatShell } from "./chat-shell";
import { ContentSurface } from "./surfaces";
import { channelHref } from "./layout";
import { title, unreadMark } from "./sections";

export function ChatHomeScreen() {
  const { channels, error } = useChannels();
  const { scope, scopeName } = useChatShell();
  const { user } = useUser();

  const waiting = (channels ?? [])
    .filter((c) => c.joined && c.archivedAt === undefined)
    .filter((c) => c.unread > 0 || c.mentions > 0)
    .sort(byClaim);

  return (
    <ContentSurface>
      <div className="chat-scroll min-h-0 flex-1">
        <div className="mx-auto w-full max-w-2xl px-5 py-8 sm:px-8">
          <h1 className="text-2xl font-bold tracking-tight">
            {user?.firstName ? `Hello, ${user.firstName}` : "Hello"}
          </h1>
          <div className="title-rule" />
          <p className="chat-quiet mt-4 text-sm">
            {scopeName
              ? `Everything waiting for you in ${scopeName}.`
              : "Everything waiting for you."}
          </p>

          {error ? (
            <p role="status" className="mt-6 text-sm text-danger">
              {error}
            </p>
          ) : null}

          {channels !== undefined && waiting.length === 0 && !error ? (
            <p className="chat-quiet mt-8 text-sm">
              Nothing unread. Pick a room from the sidebar, or start one.
            </p>
          ) : null}

          {waiting.length > 0 ? (
            <Stagger className="mt-6 space-y-1">
              {waiting.map((channel) => (
                <StaggerItem key={channel.channelId}>
                  <WaitingRow channel={channel} />
                </StaggerItem>
              ))}
            </Stagger>
          ) : null}

          {/* Reminders belong here rather than behind their own route: Buzz
              retired `/reminders` for the same reason (§4.5). A reminder is not
              a place you go, it is one of the things waiting for you. */}
          <RemindersSection scope={scope} />
        </div>
      </div>
    </ContentSurface>
  );
}

/** Mentions first, then unread volume, then most recent. */
function byClaim(a: ChatChannelSummary, b: ChatChannelSummary): number {
  if (a.mentions !== b.mentions) return b.mentions - a.mentions;
  if (a.unread !== b.unread) return b.unread - a.unread;
  return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
}

function WaitingRow({ channel }: { channel: ChatChannelSummary }) {
  const mark = unreadMark(channel, false);
  const isDirect = channel.kind === "dm" || channel.kind === "group_dm";
  const label = title(channel);
  return (
    // `.chat-row` rather than a restated pill: the sidebar one column over is
    // already this exact geometry (the pill radius, the row height token),
    // and a second hand-rolled `rounded-xl px-3 py-2.5` here is a place that
    // silently stops matching it the next time either one is tuned. `h-auto`
    // because this row carries two lines (name, then a timestamp) where the
    // sidebar's carries one — `.chat-row` sets a `min-height`, not a fixed
    // one, so the second line is free to grow it.
    <Link
      href={channelHref(channel.channelId)}
      className="chat-row h-auto py-1.5"
    >
      <WaitingGlyph channel={channel} label={label} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {isDirect ? label : `#${channel.name}`}
        </span>
        <span className="chat-quiet block truncate text-xs">
          {channel.lastActivityAt
            ? timeAgo(channel.lastActivityAt)
            : "No activity yet"}
        </span>
      </span>
      {mark.kind === "count" ? (
        <span className="chat-badge shrink-0">{mark.label}</span>
      ) : null}
      {mark.kind === "dot" ? (
        <span className="chat-dot shrink-0" aria-hidden />
      ) : null}
    </Link>
  );
}

/**
 * The leading glyph: `#` for a channel, a lock for a private one, a disc of
 * initials for a direct message — the same vocabulary
 * `shell/channel-row.tsx`'s `RoomGlyph` draws in the sidebar, reproduced
 * rather than imported (that helper is not exported — it is that file's
 * private detail), so the two lists read as one row language without either
 * owning the other.
 */
function WaitingGlyph({
  channel,
  label,
}: {
  channel: ChatChannelSummary;
  label: string;
}) {
  if (channel.kind === "dm" || channel.kind === "group_dm") {
    return (
      <span
        aria-hidden
        className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-tiny font-semibold"
      >
        {label.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  const Glyph =
    channel.kind === "forum"
      ? FileText
      : channel.visibility === "private"
        ? Lock
        : Hash;
  return <Glyph aria-hidden className="chat-quiet size-4 shrink-0" />;
}
