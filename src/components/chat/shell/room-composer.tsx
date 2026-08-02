"use client";

// The seam between the composer and the transcript.
//
// Two agents built the halves of sending a message and neither could see the
// other's edge: the composer emits a *projected* `ChatMessage` when you press
// enter, and the transcript accepts *raw* `TimelineEvent`s. That difference is
// deliberate on the transcript's side and worth preserving — an optimistic row
// travels the same projection as every other row, so grouping, day dividers and
// the unread rule apply to it without a second code path deciding what a
// pending message looks like. Splicing a finished row in after the fold would
// have been fewer lines and would have made the pending message the one row in
// the transcript that obeys different rules.
//
// So this file converts, and it is the only place that does.
//
// It also resolves the two things the composer needs and the room happens to
// know: who you are in this community, and who can be mentioned in this room.

import { useCallback, useMemo } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useUser } from "@clerk/nextjs";
import type { ChatChannelSummary, ChatScope } from "@/lib/buzz/channel-types";
import type { ChatMessage } from "@/lib/buzz/message-types";
import type { TimelineEvent } from "@/lib/buzz/timeline";
import {
  MessageComposer,
  type ComposerAuthor,
  type ComposerMentionable,
  type PostMutation,
} from "@/components/chat/composer";
import { useComposerMedia } from "@/components/chat/media/composer-media";
import { useToast } from "@/components/toast";

/** `api.buzz.identity.myPubkey` — who you are in the log. */
const myPubkey = makeFunctionReference<
  "query",
  Record<string, never>,
  { pubkey: string | null } | null
>("buzz/identity:myPubkey");

/** `api.buzz.channels.members` — who is in this room, and so who is mentionable. */
const membersRef = makeFunctionReference<
  "query",
  { scopeType: "user" | "workspace"; scopeId: string; channelId: string },
  | {
      actorId: string;
      actorType: "user" | "agent";
      name: string;
      isSelf: boolean;
    }[]
  | null
>("buzz/channels:members");

/**
 * A projected row back into the event it came from.
 *
 * Lossy on purpose: everything dropped (`author`, `mine`, `reactions`) is
 * something the projector recomputes from the event and the reader's identity.
 * Carrying a precomputed `mine` through here would be a second answer to "is
 * this message yours", and the two would disagree the moment somebody's key
 * changed under them.
 */
function toPendingEvent(message: ChatMessage): TimelineEvent {
  return {
    kind: message.kind,
    pubkey: message.pubkey,
    created_at: message.createdAt,
    tags: message.tags,
    content: message.body,
    localKey: message.renderKey,
    pending: true,
  };
}

export type PendingChange =
  | { type: "add"; event: TimelineEvent }
  | { type: "settle"; localKey: string }
  | { type: "fail"; localKey: string };

export function RoomComposer({
  scope,
  channel,
  channelLabel,
  parentId,
  rootId,
  autoFocus,
  postRef,
  postKind,
  onPending,
  onTyping,
}: {
  /**
   * Null while the community is still resolving. Handled here rather than at
   * the call site so the composer band keeps its height — a composer that
   * disappears and comes back is a layout jump on every room you open.
   */
  scope: ChatScope | null;
  channel: ChatChannelSummary;
  channelLabel: string;
  parentId?: string;
  rootId?: string;
  autoFocus?: boolean;
  /**
   * Where the text goes. Defaults to `buzz/messages:post`.
   *
   * The forum's comment box needs `buzz/forum:comment` and nothing else about
   * this component — the identity it resolves, the members it turns into
   * mentionables, the pending-row plumbing are the same three facts wherever the
   * text is going.
   */
  postRef?: PostMutation;
  /** What the optimistic row claims to be, when it is not a chat message. */
  postKind?: number;
  onPending: (change: PendingChange) => void;
  /** Announce that somebody is writing. Throttled by the room's typing hook. */
  onTyping?: () => void;
}) {
  const { user } = useUser();
  const { toast } = useToast();
  const identity = useQuery(myPubkey, {});
  const members = useQuery(
    membersRef,
    scope
      ? {
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          channelId: channel.channelId,
        }
      : "skip",
  );

  const author: ComposerAuthor | null = useMemo(() => {
    if (!identity?.pubkey) return null;
    return {
      pubkey: identity.pubkey,
      name: user?.fullName ?? "You",
    };
  }, [identity?.pubkey, user?.fullName]);

  const mentionables: ComposerMentionable[] = useMemo(
    () =>
      (members ?? []).map((m) => ({
        id: m.actorId,
        name: m.name,
        kind: m.actorType,
      })),
    [members],
  );

  // Attachments, and where they are offered.
  //
  // Wherever the text is going through `buzz/messages:post` — a room, a thread —
  // and nowhere else. A surface that redirected the composer (`postRef`) chose a
  // different door on purpose, and `buzz/media:post` only knows the one it
  // wraps; offering a paperclip that posts somewhere else would be a control
  // that silently files the message in the wrong place. The forum's comment box
  // is the current instance of that, and it gets attachments when it gets its
  // own door rather than by accident.
  const media = useComposerMedia(
    scope ?? { scopeType: "user", scopeId: "" },
    channel.channelId,
    useCallback((reason: string) => toast(reason, { kind: "error" }), [toast]),
  );
  const attachable = !postRef && postKind === undefined && !disabledForMedia(channel, scope);

  const handleOptimistic = useCallback(
    (message: ChatMessage) =>
      onPending({ type: "add", event: toPendingEvent(message) }),
    [onPending],
  );

  const handleAcknowledged = useCallback(
    // The acknowledged event arrives through the room's own subscription, so
    // the pending copy is dropped rather than rewritten. Keeping both, keyed
    // differently, is how one message renders twice for a frame.
    (localKey: string) => onPending({ type: "settle", localKey }),
    [onPending],
  );

  const handleFailed = useCallback(
    (localKey: string) => onPending({ type: "fail", localKey }),
    [onPending],
  );

  // No key yet means the send would be refused server-side, so the composer
  // says why instead of accepting keystrokes it cannot post. This is a real
  // state, not a loading flicker: keys are minted in a Node action (D3), so
  // somebody who has never posted in Chat genuinely has none until then.
  const identityPending = identity === undefined || !scope;
  const disabled = !author || !scope || channel.archivedAt !== undefined;
  const disabledReason = channel.archivedAt
    ? "This room is archived."
    : identityPending
      ? "Connecting…"
      : "Setting up your Chat identity…";

  return (
    <MessageComposer
      scope={scope ?? { scopeType: "user", scopeId: "" }}
      channelId={channel.channelId}
      channelLabel={channelLabel}
      {...(postRef ? { postRef } : {})}
      {...(postKind !== undefined ? { postKind } : {})}
      parentId={parentId}
      rootId={rootId}
      author={author ?? { pubkey: "", name: user?.fullName ?? "You" }}
      mentionables={mentionables}
      autoFocus={autoFocus}
      {...(attachable ? { media } : {})}
      disabled={disabled}
      disabledReason={disabled ? disabledReason : undefined}
      onOptimistic={handleOptimistic}
      onAcknowledged={handleAcknowledged}
      onFailed={handleFailed}
      {...(onTyping ? { onTyping } : {})}
    />
  );
}

/**
 * Rooms that cannot take an upload at all.
 *
 * An archived room and a community that has not resolved yet — the same two
 * states the composer is disabled for. Checked separately because the paperclip
 * has to be gone rather than merely inert: an upload URL is minted the moment it
 * is clicked, and the server would refuse it a moment later.
 */
function disabledForMedia(
  channel: ChatChannelSummary,
  scope: ChatScope | null,
): boolean {
  return !scope || channel.archivedAt !== undefined;
}

/** Fold a change into the pending list. Pure, so the room can test it. */
export function applyPending(
  pending: readonly TimelineEvent[],
  change: PendingChange,
): TimelineEvent[] {
  switch (change.type) {
    case "add":
      return [...pending, change.event];
    case "settle":
      return pending.filter((e) => e.localKey !== change.localKey);
    case "fail":
      // Kept, not dropped. A failed send stays on screen as a row you can see
      // and retry; removing it would make a message you wrote disappear with
      // only a toast to say so.
      return pending.map((e) =>
        e.localKey === change.localKey ? { ...e, pending: false, failed: true } : e,
      );
  }
}
