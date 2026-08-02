"use client";

// Muting, from wherever you are standing.
//
// Two controls and one hook, and the hook is the interesting part: `useMutes`
// hands back the two `Set`s `shouldNotifyForEvent` wants, so a surface that
// needs to know whether to make a noise asks the same store the settings screen
// writes to. There is no second source of "is this muted".
//
// Deliberately not a settings page. Muting a room is something you decide while
// reading the room — the rule from the house style: never make somebody leave
// their work to change their work. A mute list buried in preferences is a list
// you have to translate names back into rooms from.
//
// Both controls are text, not a bell with a line through it. An icon here would
// be a decoration standing in for a word that is one syllable long, and the
// muted/unmuted states of a crossed-out bell are famously indistinguishable at
// 16px.

import { useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import type { ChatScope } from "@/lib/buzz/channel-types";
import {
  mutesQuery,
  setChannelMutedMutation,
  setThreadMutedMutation,
} from "./refs";

export type MuteSets = {
  channels: ReadonlySet<string>;
  threads: ReadonlySet<string>;
  /** `true` until the first answer arrives — treat as "nothing muted yet". */
  loading: boolean;
};

const NOTHING: ReadonlySet<string> = new Set();

/**
 * Everything this person has muted in this community, as sets.
 *
 * Sets rather than arrays because the only consumer is a membership test run
 * once per incoming event, and because it is the exact shape
 * `NotifyRelationship` takes — a hook that returns arrays would put a
 * `new Set(...)` in a render path that runs on every message.
 */
export function useMutes(scope: ChatScope): MuteSets {
  const data = useQuery(mutesQuery, { scopeType: scope.scopeType, scopeId: scope.scopeId });
  return useMemo(
    () => ({
      channels: data ? new Set(data.channels) : NOTHING,
      threads: data ? new Set(data.threads) : NOTHING,
      loading: data === undefined,
    }),
    [data],
  );
}

/**
 * Mute a room.
 *
 * No undo toast, and that is not an oversight: an undoable delete defers a
 * destructive write, and this write destroys nothing — the control that
 * reverses it is the same control, sitting right where you left it, already
 * saying "Muted". A confirmation for a reversible toggle is noise.
 */
export function ChannelMuteToggle({
  scope,
  channelId,
  muted,
  className,
}: {
  scope: ChatScope;
  channelId: string;
  muted: boolean;
  className?: string;
}) {
  const setMuted = useMutation(setChannelMutedMutation);
  const { toast } = useToast();
  return (
    <MuteButton
      muted={muted}
      labels={{ on: "Muted", off: "Mute channel" }}
      className={className}
      onToggle={async (next) => {
        try {
          await setMuted({
            scopeType: scope.scopeType,
            scopeId: scope.scopeId,
            channelId,
            muted: next,
          });
        } catch (err) {
          toast(err instanceof Error ? err.message : "Could not change that", {
            kind: "error",
          });
        }
      }}
    />
  );
}

/**
 * Mute a thread, by its **root** id.
 *
 * The root and never the message you happen to be looking at: a thread has one
 * root however deep a reply sits, so muting the root is muting the
 * conversation. Muting an intermediate message would silence one branch and
 * leave the rest loud, which is not a thing anybody means by "mute this
 * thread".
 */
export function ThreadMuteToggle({
  scope,
  channelId,
  rootId,
  muted,
  className,
}: {
  scope: ChatScope;
  channelId: string;
  rootId: string;
  muted: boolean;
  className?: string;
}) {
  const setMuted = useMutation(setThreadMutedMutation);
  const { toast } = useToast();
  return (
    <MuteButton
      muted={muted}
      labels={{ on: "Muted", off: "Mute thread" }}
      className={className}
      onToggle={async (next) => {
        try {
          await setMuted({
            scopeType: scope.scopeType,
            scopeId: scope.scopeId,
            channelId,
            rootId,
            muted: next,
          });
        } catch (err) {
          toast(err instanceof Error ? err.message : "Could not change that", {
            kind: "error",
          });
        }
      }}
    />
  );
}

function MuteButton({
  muted,
  labels,
  onToggle,
  className,
}: {
  muted: boolean;
  labels: { on: string; off: string };
  onToggle: (next: boolean) => void | Promise<void>;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={muted}
      onClick={() => void onToggle(!muted)}
      className={cn(
        "tap-target rounded-full px-3 py-1 text-xs font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        muted
          ? "bg-foreground/10 text-foreground"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
        className,
      )}
    >
      {muted ? labels.on : labels.off}
    </button>
  );
}
