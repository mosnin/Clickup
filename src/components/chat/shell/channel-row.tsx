"use client";

// One room in the sidebar.
//
// The row is the most repeated object in the application, so its rules are
// worth stating rather than inferring from the JSX:
//
//   • The leading glyph says what kind of room it is, not what it is about.
//     `#` for a channel, a lock for a private one, a disc of initials for a
//     direct message — the same vocabulary the room header uses, so a room
//     looks like itself wherever you meet it.
//   • The trailing slot holds exactly one thing at a time. Mute and unread
//     never stack: a muted room with unread shows the unread (it is still
//     news), a muted room without shows the bell and drops to half opacity
//     (it is furniture). Two marks in one slot is how a 32px row becomes
//     unreadable.
//   • The label reserves its bold width. Activating a row switches it to
//     semibold, and without the reservation every click nudges the badge
//     sideways — a reflow you feel more than see, on the one gesture people
//     make most.
//
// Leaving a room routes through the house's deferred-delete pattern: the row
// disappears immediately, a toast offers Undo, and the mutation only runs when
// the undo window closes. Leaving is not destructive, but it is a thing you do
// by accident on a small screen, and the pattern already exists.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BellOff, FileText, Hash, Lock } from "lucide-react";
import { useMutation } from "convex/react";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import type { ChatChannelSummary } from "@/lib/buzz/channel-types";
import { leaveChannel } from "./channel-data";
import { useChatShell } from "./chat-shell";
import { channelHref } from "./layout";
import { title, unreadMark } from "./sections";

export function ChannelRow({
  channel,
  isActive,
  onNavigate,
  onHidden,
}: {
  channel: ChatChannelSummary;
  isActive: boolean;
  onNavigate: () => void;
  /** Called when the row leaves the list optimistically, and again on undo. */
  onHidden: (channelId: string, hidden: boolean) => void;
}) {
  const mark = unreadMark(channel, isActive);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const leave = useMutation(leaveChannel);
  // Leaving is behind an undo toast, so a refused mutation surfaces eight
  // seconds after the row has already gone — which is the worst moment to
  // discover the arguments were wrong.
  const { scope } = useChatShell();
  const scopeArgs = scope ?? { scopeType: "user" as const, scopeId: "" };
  const { toast } = useToast();

  const isDirect = channel.kind === "dm" || channel.kind === "group_dm";
  const label = title(channel);
  const unreadCount = mark.kind === "count" ? mark.count : mark.kind === "dot" ? 1 : 0;

  function onLeave() {
    onHidden(channel.channelId, true);
    toast(`Left ${isDirect ? label : `#${channel.name}`}`, {
      action: { label: "Undo", onClick: () => onHidden(channel.channelId, false) },
      onExpire: () => {
        void leave({ ...scopeArgs, channelId: channel.channelId }).catch((error: unknown) => {
          onHidden(channel.channelId, false);
          toast(error instanceof Error ? error.message : "Could not leave", {
            kind: "error",
          });
        });
      },
    });
  }

  return (
    <li className="relative">
      <Link
        href={channelHref(channel.channelId)}
        onClick={onNavigate}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuAt({ x: event.clientX, y: event.clientY });
        }}
        aria-current={isActive ? "page" : undefined}
        data-active={isActive ? "true" : "false"}
        data-muted={channel.muted ? "true" : "false"}
        data-unread={unreadCount > 0 ? "true" : "false"}
        data-unread-count={unreadCount}
        className="chat-row"
      >
        <RoomGlyph channel={channel} label={label} />

        {/* The width reservation: an invisible semibold copy in the same grid
            cell, so bold and regular occupy identical space. */}
        <span className="grid min-w-0 flex-1">
          <span className="col-start-1 row-start-1 truncate">{label}</span>
          <span
            aria-hidden
            className="col-start-1 row-start-1 invisible truncate font-semibold"
          >
            {label}
          </span>
        </span>

        {channel.muted && unreadCount === 0 ? (
          <BellOff aria-hidden className="chat-quiet size-3.5 shrink-0" />
        ) : null}
        {mark.kind === "count" ? (
          <span className="chat-badge shrink-0">{mark.label}</span>
        ) : null}
        {mark.kind === "dot" ? (
          <span className="chat-dot shrink-0" aria-hidden />
        ) : null}
        {mark.kind !== "none" ? (
          <span className="sr-only">
            {mark.kind === "count" ? `${mark.label} unread` : "unread"}
          </span>
        ) : null}
      </Link>

      {menuAt ? (
        <RowMenu
          at={menuAt}
          onClose={() => setMenuAt(null)}
          items={[
            {
              label: "Copy channel name",
              run: () => void copy(isDirect ? label : `#${channel.name}`),
            },
            {
              label: "Copy link",
              run: () =>
                void copy(
                  `${window.location.origin}${channelHref(channel.channelId)}`,
                ),
            },
            { label: "Leave channel", run: onLeave, destructive: true },
          ]}
        />
      ) : null}
    </li>
  );
}

function RoomGlyph({
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
        className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-[0.6875rem] font-semibold"
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

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard permission denied — nothing useful to say about it */
  }
}

type MenuItem = { label: string; run: () => void; destructive?: boolean };

/**
 * The row's context menu.
 *
 * Positioned at the pointer and closed by anything: a click elsewhere,
 * Escape, a scroll. It stops the Escape event so the shell's drawer handler
 * does not also fire — the innermost open surface owns the key.
 */
function RowMenu({
  at,
  items,
  onClose,
}: {
  at: { x: number; y: number };
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
  }, []);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: at.x, top: at.y }}
      className="fixed z-50 min-w-44 rounded-lg bg-background p-1 shadow-lg"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            item.run();
          }}
          className={cn(
            "chat-row h-7 text-[0.8125rem]",
            item.destructive && "text-danger",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
