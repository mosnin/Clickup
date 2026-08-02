// The bridge, in the parts that need no database.
//
// C12's whole thesis is that the two dashboards are one product, and the rule
// that keeps that honest is stated once here so every file downstream can be
// checked against it: **the bridge is never a store.** Everything the bridge
// shows is either a read across a source that already owns the fact, or a
// reference resolved at the moment somebody looks at it. Nothing is copied. A
// task's status denormalized into the Chat log is a number that is right the
// day it is written and wrong every day after, and a stale status in a room is
// worse than no status at all — the reader cannot tell which one they are
// looking at.
//
// What lives here is the part with no `ctx`: the token grammar both dashboards
// speak, the key that carries a room across the tenancy fence, the two href
// shapes, and the arithmetic behind the switcher's badge. Pure, so the Convex
// functions, the React components and the tests all consult the same copy —
// the same reason `_refs.ts` and `notify.ts` are pure.

// Relative rather than through the `@convex/*` / `@/*` aliases, because this
// module is imported from `convex/buzz/*` as well as from React, and the Convex
// bundler resolves neither alias. Both targets are pure — `_refs.ts` says so in
// its header, and `mentions.ts` is four functions and a regex — so importing
// them costs the Convex bundle nothing.
import { REF_KINDS, type RefKind } from "../../../convex/_refs";
import { parseMentionBody, type MessagePart } from "../mentions";

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export type BridgeScope = { scopeType: "user" | "workspace"; scopeId: string };

/**
 * A room, as one string.
 *
 * `mentions.parentId` is a bare string and a Buzz channel id is only unique
 * *inside* a community — every index in `convex/buzz/_tables.ts` leads on the
 * scope for exactly that reason. So a mention row that stored the channel id
 * alone would name a room the inbox cannot look up without guessing which
 * community it came from, and guessing is how one tenant's room resolves for
 * another tenant's reader.
 *
 * `|` rather than `:` because a Clerk subject contains no pipe and a Convex id
 * contains none either, while `:` is already the separator inside a reference
 * token — one delimiter meaning two things is one parser away from a bug.
 */
export function roomKey(scope: BridgeScope, channelId: string): string {
  return `${scope.scopeType}|${scope.scopeId}|${channelId}`;
}

/** The inverse. Total: anything that is not a room key is `null`, never a throw. */
export function parseRoomKey(
  raw: string,
): { scope: BridgeScope; channelId: string } | null {
  const parts = raw.split("|");
  if (parts.length !== 3) return null;
  const [scopeType, scopeId, channelId] = parts;
  if (scopeType !== "user" && scopeType !== "workspace") return null;
  if (!scopeId || !channelId) return null;
  return { scope: { scopeType, scopeId }, channelId };
}

// ---------------------------------------------------------------------------
// The two href shapes
// ---------------------------------------------------------------------------

/** Where a room lives. The one place the Chat route shape is written down. */
export function roomHref(channelId: string): string {
  return `/chat/c/${channelId}`;
}

/**
 * Where a Work object lives, given what the resolver could find out about it.
 *
 * A task's URL needs its list, which is why this takes a context object rather
 * than an id: the routing table is not derivable from a reference token alone,
 * and a chip that had to know it would be a second copy of the router.
 */
export function workHref(
  kind: RefKind,
  id: string,
  context: { listId?: string; workspaceId?: string } = {},
): string | null {
  switch (kind) {
    case "task":
      return context.listId ? `/dashboard/l/${context.listId}/t/${id}` : null;
    case "list":
      return `/dashboard/l/${id}`;
    case "project":
      return `/dashboard/p/${id}`;
    case "page":
      return `/dashboard/pages/${id}`;
    case "sprint":
      return context.workspaceId
        ? `/dashboard/w/${context.workspaceId}?tab=sprints`
        : null;
    case "goal":
      return context.workspaceId
        ? `/dashboard/w/${context.workspaceId}?tab=goals`
        : null;
    case "room":
      return roomHref(id);
  }
}

// ---------------------------------------------------------------------------
// The body, in both grammars at once
// ---------------------------------------------------------------------------

export type BridgePart =
  | { kind: "text"; text: string }
  | { kind: "mention"; name: string; actorId: string }
  | { kind: "ref"; refKind: RefKind; id: string; label: string };

/**
 * The reference splitter.
 *
 * The **vocabulary** is imported from `convex/_refs.ts` rather than restated,
 * so a kind added there is a kind this renders — that is the point of adding
 * one literal instead of inventing a second token. What is local is the
 * *splitting*: `_refs.extractRefs` answers "which references are in this body",
 * which is the question a write path asks, and a renderer needs the complement
 * — the prose between them, in order. Adding a splitter to `_refs.ts` was not a
 * sanctioned edit, and a splitter built from the imported vocabulary cannot
 * drift from it the way a second regex would.
 */
const REF_TOKEN = new RegExp(
  `#\\[([^\\]\\n]+)\\]\\((${REF_KINDS.join("|")}):([^)\\s]+)\\)`,
  "g",
);

function splitRefs(text: string): BridgePart[] {
  const out: BridgePart[] = [];
  let last = 0;
  for (const match of text.matchAll(REF_TOKEN)) {
    if (match.index === undefined) continue;
    if (match.index > last) {
      out.push({ kind: "text", text: text.slice(last, match.index) });
    }
    out.push({
      kind: "ref",
      refKind: match[2] as RefKind,
      id: match[3].trim(),
      label: match[1].trim(),
    });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/**
 * A message body as renderable parts, in both token grammars.
 *
 * Mentions first, through `parseMentionBody` — the app's one mention parser,
 * imported rather than re-rolled, because a mention that renders as a pill in
 * Work and as raw brackets in Chat is the exact failure the shared grammar
 * exists to prevent. References are then split out of the *text* parts only,
 * so a `(` inside a mention's name can never open a reference.
 */
export function parseBridgeBody(body: string): BridgePart[] {
  const out: BridgePart[] = [];
  for (const part of parseMentionBody(body) as MessagePart[]) {
    if (part.kind === "mention") {
      out.push({ kind: "mention", name: part.name, actorId: part.clerkId });
      continue;
    }
    out.push(...splitRefs(part.text));
  }
  return out;
}

/**
 * Every task a set of bodies points at, deduplicated and in first-seen order.
 *
 * Used by the transcript to ask for one page of live task cards instead of one
 * subscription per chip. The cap is what stops a pasted wall of references from
 * turning one screen of messages into an unbounded read.
 */
export function taskIdsIn(bodies: Iterable<string>, max = 40): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const body of bodies) {
    for (const part of parseBridgeBody(body)) {
      // Checked before the push, not after: `max: 0` has to mean nothing, and
      // a cap tested afterwards always lets the first one through.
      if (out.length >= max) return out;
      if (part.kind !== "ref" || part.refKind !== "task") continue;
      if (seen.has(part.id)) continue;
      seen.add(part.id);
      out.push(part.id);
    }
  }
  return out;
}

/** The token to write when a message becomes a task. `_refs.formatRef`'s shape. */
export function taskRefToken(taskId: string, title: string): string {
  return `#[${title.replace(/[[\]()]/g, "").trim() || "task"}](task:${taskId})`;
}

// ---------------------------------------------------------------------------
// The live task line
// ---------------------------------------------------------------------------

export type TaskCard = {
  taskId: string;
  listId: string;
  listName: string;
  title: string;
  statusName: string;
  statusColor: string;
  statusCategory: "open" | "in_progress" | "complete" | "closed";
  assigneeNames: string[];
  dueDate?: number;
  blocked: boolean;
};

/**
 * The one line under a task chip: state, who has it, when it is due.
 *
 * Computed from the card every time it is drawn rather than stored anywhere.
 * That is the rule at the top of this file in its smallest form — the sentence
 * is a function of the task, so it cannot be stale, and there is no second copy
 * to reconcile when somebody reassigns the task from the other dashboard.
 */
export function describeTask(
  card: TaskCard,
  now: number,
  formatDate: (ms: number) => string,
): string {
  const bits: string[] = [card.statusName];
  if (card.assigneeNames.length === 1) bits.push(card.assigneeNames[0]);
  else if (card.assigneeNames.length > 1) {
    bits.push(`${card.assigneeNames.length} assignees`);
  }
  if (card.dueDate !== undefined) {
    const done =
      card.statusCategory === "complete" || card.statusCategory === "closed";
    const overdue = !done && card.dueDate < now;
    bits.push(`${overdue ? "overdue " : "due "}${formatDate(card.dueDate)}`);
  }
  if (card.blocked) bits.push("blocked");
  return bits.join(" · ");
}

// ---------------------------------------------------------------------------
// The badge
// ---------------------------------------------------------------------------

export type SideCounts = {
  /** Work's queue, with everything that came from Chat taken back out. */
  work: number;
  /** Chat's queue: rooms addressed to you, plus Chat's own reminders. */
  chat: number;
};

export const BADGE_CAP = 99;

/**
 * The number on the button, or "" for nothing.
 *
 * A zero badge is not a small badge — it is a dot that says "there is something
 * here" about nothing, and after a week people stop reading the ones that are
 * real.
 */
export function badgeLabel(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  return count > BADGE_CAP ? `${BADGE_CAP}+` : String(Math.floor(count));
}

/**
 * Which mode a path is in. The switcher badges the *other* one.
 *
 * Read from the pathname rather than held in state, for the same reason the
 * mode switcher is two links rather than a toggle: the browser already knows
 * which application you are looking at, and a second answer can disagree with
 * the URL.
 */
export function modeForPath(pathname: string): "work" | "chat" {
  return pathname === "/chat" || pathname.startsWith("/chat/") ? "chat" : "work";
}

/**
 * The number the switcher shows on the half you are not standing in.
 *
 * There is deliberately no total. The two counts answer different questions
 * about different queues, and a sum would be the one number that is wrong in
 * both directions: it double-counts nothing only because `partitionCounts`
 * below guarantees the two sets are disjoint, and it means nothing to a person
 * deciding whether to switch.
 */
export function badgeForOtherSide(
  counts: SideCounts,
  mode: "work" | "chat",
): number {
  return mode === "chat" ? counts.work : counts.chat;
}

/**
 * The partition, stated once so it can be tested.
 *
 * Every unread thing in this product belongs to exactly one side, and which
 * side is decided by **where the thing lives**, never by which table it landed
 * in. A Chat mention writes a row in Work's `mentions` table — that is the
 * unified inbox, and it is the point — but it is still a thing that happened in
 * a room, so it is counted on the Chat side and nowhere else.
 *
 * The inputs are the four queues that exist. Nothing here reads a fifth: if a
 * count needed a table of its own, the bridge would have become a store.
 */
export function partitionCounts(input: {
  /** `mentions` rows whose `parentType` is not "room". */
  workMentions: number;
  /** `notifications` rows whose `type` does not start with "chat.". */
  workUpdates: number;
  /** Tasks gated on this reader's approval. */
  workApprovals: number;
  /** Room mentions from Chat's own read state — what Chat itself badges. */
  chatRoomMentions: number;
  /** `notifications` rows whose `type` starts with "chat." (reminders). */
  chatUpdates: number;
}): SideCounts {
  return {
    work: input.workMentions + input.workUpdates + input.workApprovals,
    chat: input.chatRoomMentions + input.chatUpdates,
  };
}

/**
 * Does a notification row belong to Chat?
 *
 * The `chat.` prefix is the convention `buzz/notifications.ts` and
 * `buzz/reminders.ts` already write, so this reads an existing fact rather than
 * introducing a flag. A row that predates the convention counts as Work, which
 * is the safe direction: a Work badge that is one too high is a person who
 * looks at their inbox, and a Chat badge that is one too high is a person who
 * opens a room and finds nothing.
 */
export function isChatNotification(type: string): boolean {
  return type.startsWith("chat.");
}

// ---------------------------------------------------------------------------
// A room bound to a project
// ---------------------------------------------------------------------------

export type RoomBinding = {
  projectId: string;
  projectName: string;
  spaceName: string;
  boundAt: number;
};

/**
 * What the room says about its binding.
 *
 * Three states, and the third is the one that matters: a room can be bound to a
 * project the *reader* cannot see. The binding row is not the authority on
 * that; the project's own space is, checked with Work's `_authz` at read time.
 * So the reader is told the room is bound to something they may not open,
 * rather than being shown a name they were never entitled to.
 */
export function bindingSentence(binding: RoomBinding | null, bound: boolean): string {
  if (binding) return `Bound to ${binding.projectName}`;
  if (bound) return "Bound to a project you cannot see";
  return "Not bound to a project";
}
