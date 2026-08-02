"use client";

// The optimistic row, and the key that has to survive becoming real.
//
// Sending a message is two facts arriving at different times: what you wrote
// (instantly, locally) and the event the server signed (a round trip later).
// Drawing the first and then replacing it with the second is the whole trick,
// and the thing that makes it look seamless — or look like a flicker — is the
// React key.
//
// A message's id is a hash of the signed event, so a pending message does not
// have one yet. Key the row on `id` and the moment the acknowledgement lands
// the key changes, React unmounts the bubble and mounts a different one, and
// the message visibly blinks — worst of all right after somebody pressed Enter,
// which is exactly the moment they are watching it. `renderKey` is the answer
// (`src/lib/buzz/message-types.ts` documents the field): it is the local key
// while pending, and the *same* local key after acknowledgement, because the
// acknowledged event inherits it. Hence `SendHandle.localKey` — the composer's
// job is not only to send, it is to tell the transcript which pending row this
// event became.
//
// Pure and DOM-free so the transcript owner can reason about the shape without
// mounting a composer.

import { extractMentionedClerkIds, parseMentionBody } from "@/lib/mentions";
import type { ChatMessage } from "@/lib/buzz/message-types";

/**
 * Kind 9, `KIND_STREAM_MESSAGE` (`convex/buzz/_kinds.ts`).
 *
 * Written as a number rather than imported: the registry is a Convex module
 * that pulls the whole kind table and its validators, and a client bundle does
 * not need 400 lines of storage-class logic to draw one bubble.
 */
export const MESSAGE_KIND = 9;

/** Who the composer is sending as. */
export type ComposerAuthor = {
  /** The principal id — a Clerk id for a person, an agent document id. */
  pubkey: string;
  name: string;
  avatarUrl?: string;
  isAgent?: boolean;
};

export type SendTarget = {
  scopeType: "user" | "workspace";
  scopeId: string;
  channelId: string;
  /** Set when this composer is replying inside a thread. */
  parentId?: string;
  rootId?: string;
  /**
   * What kind of thing is being written. `MESSAGE_KIND` unless said otherwise.
   *
   * The optimistic row travels the same projection as every acknowledged row
   * (see the header), and a projection is told which kinds draw a row on the
   * surface it is drawing. So a forum comment optimistically drawn as a kind-9
   * message is a row the forum's own content set drops — the comment vanishes
   * for the ~200ms it is pending and then appears, which reads as a send that
   * failed and then did not.
   *
   * The server still decides the real kind, from which mutation the text came
   * through. This is only what the pending row claims to be, and it has to claim
   * the same thing.
   */
  kind?: number;
};

/** Exactly the arguments `buzz/messages:post` takes. */
export type PostArgs = {
  scopeType: "user" | "workspace";
  scopeId: string;
  channelId: string;
  body: string;
  parentId?: string;
  rootId?: string;
};

export function postArgs(target: SendTarget, body: string): PostArgs {
  return {
    scopeType: target.scopeType,
    scopeId: target.scopeId,
    channelId: target.channelId,
    body,
    ...(target.parentId ? { parentId: target.parentId } : {}),
    ...(target.rootId ? { rootId: target.rootId } : {}),
  };
}

/**
 * The id the server gave the event, whatever shape it answered in.
 *
 * The mutation lands beside this file and has not settled on returning a bare
 * id or a row. The composer needs one bit — did it land, and under what id —
 * so it reads either rather than making the two files agree on a shape neither
 * of them cares about.
 */
export function acknowledgedId(result: unknown): string | null {
  if (typeof result === "string") return result || null;
  if (result && typeof result === "object") {
    const row = result as { id?: unknown; messageId?: unknown; _id?: unknown };
    for (const value of [row.id, row.messageId, row._id]) {
      if (typeof value === "string" && value) return value;
    }
  }
  return null;
}

/** `optimistic-<uuid>` — unique per send, and never mistaken for an event id. */
export function newLocalKey(): string {
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `optimistic-${uuid}`;
}

export function isLocalKey(key: string): boolean {
  return key.startsWith("optimistic-");
}

/**
 * The row the transcript draws the instant Enter is pressed.
 *
 * `id` is the local key too, so a transcript keyed on either field behaves.
 * `signerPubkey` equals `pubkey` and says something true: nothing has signed
 * this yet, and it is attributed to the person who typed it. It is not a claim
 * that the relay signed it — which is why the two fields exist separately.
 */
export function createOptimisticMessage(args: {
  localKey: string;
  body: string;
  author: ComposerAuthor;
  target: SendTarget;
  now: number;
}): ChatMessage {
  const { localKey, body, author, target, now } = args;
  return {
    id: localKey,
    renderKey: localKey,
    createdAt: now,
    pubkey: author.pubkey,
    signerPubkey: author.pubkey,
    author: author.name,
    ...(author.avatarUrl ? { authorAvatarUrl: author.avatarUrl } : {}),
    isAgent: author.isAgent ?? false,
    body,
    tags: optimisticTags(body, target, author.pubkey),
    kind: target.kind ?? MESSAGE_KIND,
    ...(target.parentId ? { parentId: target.parentId } : {}),
    ...(target.rootId ? { rootId: target.rootId } : {}),
    depth: target.parentId ? 1 : 0,
    edited: false,
    pending: true,
    mine: true,
    reactions: [],
  };
}

/**
 * The tags the real event will carry, predicted locally.
 *
 * Predicted rather than left empty because a pending row is filtered by the
 * same code that filters real ones — a row with no `h` tag is a row the
 * channel window will not accept, and the message would not appear at all until
 * the server answered. The server is still the authority; this only has to be
 * right enough for the ~200ms the row is pending.
 */
function optimisticTags(body: string, target: SendTarget, self: string): string[][] {
  const tags: string[][] = [["h", target.channelId], ["p", self]];
  if (target.rootId) tags.push(["e", target.rootId, "", "root"]);
  if (target.parentId) tags.push(["e", target.parentId, "", "reply"]);
  for (const id of extractMentionedClerkIds(body)) {
    if (id !== self) tags.push(["p", id]);
  }
  return tags;
}

/**
 * The mentions in a body, as the draft store caches them.
 *
 * Read back out of the text rather than tracked alongside it, so a draft
 * restored from disk — or a body an agent wrote — produces the same refs as one
 * typed through the picker. One grammar, one parser (`src/lib/mentions.ts`).
 */
export function mentionRefsFor(
  body: string,
  known: { id: string; name: string; kind: "user" | "agent" }[],
): { displayName: string; actorId: string; isAgent: boolean }[] {
  const seen = new Set<string>();
  const refs: { displayName: string; actorId: string; isAgent: boolean }[] = [];
  for (const part of parseMentionBody(body)) {
    if (part.kind !== "mention" || seen.has(part.clerkId)) continue;
    seen.add(part.clerkId);
    refs.push({
      displayName: part.name,
      actorId: part.clerkId,
      isAgent: known.find((k) => k.id === part.clerkId)?.kind === "agent",
    });
  }
  return refs;
}
