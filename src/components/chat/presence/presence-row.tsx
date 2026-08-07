"use client";

// A name with a dot on it, and the control for your own.
//
// `PresenceRow` is what a member list, a DM rail row and a mention popover all
// draw. It takes an `actorId` and reads the roster from context rather than
// taking a status prop, because the alternative is every list threading a
// status map down through itself — and the one that forgets is the one where
// the dots are silently always grey.
//
// An **agent is drawn exactly the same way**. Not a badge, not a separate
// section, not a machine icon: a squircle instead of a circle (the avatar's
// own distinction) and the same dot in the same place. That is the whole point
// of `presence.actorType` — a machine at work beside you is a colleague you
// can see, and a rail that files it under "integrations" makes it furniture.

import { useState } from "react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import type { ChatScope } from "@/lib/buzz/channel-types";
import { PRESENCE_LABEL, type PresencePreference } from "@/lib/buzz/presence";
import { ActorAvatar } from "@/components/chat/transcript/avatar";
import { PresenceAvatarDot, PresenceDot, StatusEmoji } from "./presence-dot";
import { StatusEditor } from "./status-editor";
import { useRoster, type MyPresence } from "./presence-provider";

export function PresenceRow({
  actorId,
  fallbackName,
  isAgent,
  pubkey,
  className,
}: {
  actorId: string;
  /** Used until the roster knows their name — a member list already has it. */
  fallbackName?: string;
  isAgent?: boolean;
  pubkey?: string;
  className?: string;
}) {
  const roster = useRoster();
  const entry = roster.entries.get(actorId);
  const status = roster.statusOf(actorId);
  const custom = roster.statusTextOf(actorId);
  const name = entry?.name || fallbackName || "Someone";

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <span className="relative shrink-0">
        <ActorAvatar
          label={name}
          pubkey={entry?.pubkey ?? pubkey ?? actorId}
          isAgent={entry?.actorType === "agent" || isAgent}
          size={24}
        />
        <PresenceAvatarDot status={status} />
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="truncate text-mini">{name}</span>
        {custom ? (
          // The status sits *after* the name and truncates first: the name is
          // the thing being identified, and a long status must never be able
          // to push it out of the row it labels.
          <span
            className="chat-quiet flex min-w-0 items-baseline gap-1 truncate text-xs"
            title={custom.text}
          >
            <StatusEmoji emoji={custom.emoji} />
            <span className="truncate">{custom.text}</span>
          </span>
        ) : null}
      </span>
      {/* Away is the one state worth spelling out inline: online is the dot's
          default reading, and offline is the absence of colour. "Away" is the
          one people misread as "busy" or "do not disturb". */}
      {status === "away" ? (
        <span className="chat-quiet shrink-0 text-tiny">
          {entry?.lastSeenAt ? timeAgo(entry.lastSeenAt) : PRESENCE_LABEL.away}
        </span>
      ) : null}
    </div>
  );
}

const PREFERENCES: { value: PresencePreference; label: string; hint: string }[] = [
  { value: "auto", label: "Active", hint: "Away automatically after 10 minutes" },
  { value: "away", label: "Away", hint: "Stay away until you change it" },
  { value: "offline", label: "Appear offline", hint: "Nobody sees you here" },
];

/**
 * Your own dot, and the two things you can do about it.
 *
 * The manual override is `"auto"` and not `"online"` when you pick Active,
 * which is why the label says Active rather than Online: choosing it is
 * choosing to stop overriding, not choosing to be permanently green. A stored
 * "online" would pin somebody's dot for the rest of the week and they would
 * never know why the away timer stopped working.
 */
export function MyPresenceControl({
  scope,
  presence,
  className,
}: {
  scope: ChatScope | null;
  presence: MyPresence;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <div className={cn("flex w-full flex-col gap-3", className)}>
      <div className="flex flex-col gap-0.5">
        {PREFERENCES.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => presence.setPreference(option.value)}
            aria-pressed={presence.preference === option.value}
            className={cn(
              "tap-target flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-mini transition-colors",
              presence.preference === option.value
                ? "bg-[var(--chat-hover)] font-medium"
                : "hover:bg-[var(--chat-hover)]",
            )}
          >
            <PresenceDot
              status={
                option.value === "auto"
                  ? presence.status === "offline"
                    ? "online"
                    : presence.status
                  : option.value === "away"
                    ? "away"
                    : "offline"
              }
            />
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
          </button>
        ))}
        <p className="chat-quiet px-2 pt-1 text-tiny">
          {PREFERENCES.find((o) => o.value === presence.preference)?.hint}
        </p>
      </div>

      <div className="border-t pt-3 chat-divider">
        {editing ? (
          <StatusEditor scope={scope} onDone={() => setEditing(false)} />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="tap-target w-full rounded-lg px-2 py-1.5 text-left text-mini transition-colors hover:bg-[var(--chat-hover)]"
          >
            Set a status
          </button>
        )}
      </div>
    </div>
  );
}
