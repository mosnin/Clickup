// Liveness: who is here, who is typing, and what they have said about it.
//
// Three states of a person, and they are not one feature with three fields —
// they differ in where they may be stored, which is the only classification
// that matters on this substrate (06-protocol §16.22, §2):
//
//   presence  ephemeral. A heartbeat with a TTL. Never in the durable log.
//   typing    ephemeral, and *faster* than a heartbeat. Never written at all.
//   status    durable. A parameterized-replaceable event (kind 30315) that
//             survives the tab being closed, because a person who wrote
//             "out sick" means it tomorrow morning too.
//
// This file holds the rules and none of the plumbing: it imports nothing, so
// the same functions decide what a dot means in a React component and what a
// Convex query returns. Everything here is a total function of its arguments
// and a `now` — there is no `Date.now()` in this file, which is what makes the
// away threshold and the TTL ratio testable rather than merely asserted.
//
// The one number to keep straight: **the presence TTL is three times the
// heartbeat interval.** That ratio is the whole reason a flaky minute of
// network does not make somebody blink out of a room and back — one missed
// beat leaves two windows of headroom. `PRESENCE_TTL_HEARTBEATS` names it and
// `tests/buzz-presence.test.ts` fails if it is ever quietly retuned.

// ---------------------------------------------------------------------------
// Presence (01-core-comms §5.1, 06-protocol §14)
// ---------------------------------------------------------------------------

/** A client republishes this often while it is not offline. */
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * How many heartbeat windows a row survives without a fresh beat.
 *
 * Three, and the number is load-bearing rather than round: at two, a single
 * dropped publish is indistinguishable from a closed laptop, so presence
 * flickers for everyone on a busy network. At three, one miss costs nothing
 * and two consecutive misses — which is a client that has genuinely stopped —
 * still resolve inside three minutes.
 */
export const PRESENCE_TTL_HEARTBEATS = 3;

/** `SET … EX 180` in Buzz's Redis; a row's freshness window here. */
export const PRESENCE_TTL_MS =
  PRESENCE_HEARTBEAT_INTERVAL_MS * PRESENCE_TTL_HEARTBEATS;

/**
 * Ten minutes without a sign of the human, and they are away.
 *
 * Away means **"the human is not at the machine"** — Slack and Discord's
 * semantics, and deliberately not "Chat is not the focused window". Window
 * visibility is not an input anywhere in this file: somebody reading a spec in
 * another tab with the room open beside it is at their desk, and marking them
 * away teaches everyone to ignore the dot.
 */
export const PRESENCE_IDLE_TIMEOUT_MS = 10 * 60_000;

export type PresenceStatus = "online" | "away" | "offline";

/** What a heartbeat may claim. Offline is the *absence* of one, never a claim. */
export type PresenceState = "online" | "away";

/**
 * A manual override, persisted per identity.
 *
 * `"auto"` rather than `"online"` on purpose: choosing "Online" is choosing to
 * stop overriding, not choosing to be permanently green. A stored `"online"`
 * would pin somebody's dot for the rest of the week.
 */
export type PresencePreference = "auto" | "away" | "offline";

/** Where the override lives. Per pubkey — two accounts in one browser differ. */
export function presencePreferenceKey(pubkey: string): string {
  return `buzz-presence-preference:${pubkey}`;
}

export function parsePresencePreference(raw: unknown): PresencePreference {
  return raw === "away" || raw === "offline" ? raw : "auto";
}

/**
 * A stored heartbeat's claim, or null.
 *
 * Unknown strings are null rather than coerced (Buzz's `parseLivePresenceEvent`
 * returns null for an unrecognised status): a state we do not know is not a
 * state, and guessing between "online" and "away" is guessing about whether
 * somebody is at their desk. Callers decide what to do with a live row that
 * claims nothing — see `presenceFromHeartbeat`.
 */
export function parsePresenceState(raw: unknown): PresenceState | null {
  return raw === "online" || raw === "away" ? raw : null;
}

/**
 * Am I at the machine? OS idle wins when the platform exposes it.
 *
 * In-app activity only sees the window it is in, so a person editing a
 * document in another application looks idle to it and is not. OS idle is the
 * real answer, so it is authoritative wherever it exists (a desktop shell);
 * the in-app fallback is what the browser can honestly offer.
 */
export function resolveAutomaticPresenceStatus(
  input: { osIdleSeconds: number | null; lastActivityAt: number },
  now: number,
): PresenceState {
  const idleMs =
    input.osIdleSeconds !== null && Number.isFinite(input.osIdleSeconds)
      ? Math.max(0, input.osIdleSeconds) * 1000
      : Math.max(0, now - input.lastActivityAt);
  return idleMs >= PRESENCE_IDLE_TIMEOUT_MS ? "away" : "online";
}

/** The override, applied over what the machine worked out. */
export function resolvePreferredStatus(
  preference: PresencePreference,
  automatic: PresenceState,
): PresenceStatus {
  if (preference === "away") return "away";
  if (preference === "offline") return "offline";
  return automatic;
}

/** A heartbeat that has not been refreshed inside the TTL is not evidence. */
export function presenceIsLive(updatedAt: number, now: number): boolean {
  return now - updatedAt < PRESENCE_TTL_MS;
}

/**
 * A stored heartbeat, read as a status.
 *
 * The TTL decides *offline*; the row decides *away*. A live row whose claim we
 * cannot parse reads as online — a beat arriving at all is direct evidence
 * that a client is running, and the only thing an unknown string leaves open
 * is whether the human beside it has stepped out.
 */
export function presenceFromHeartbeat(
  row: { state: unknown; updatedAt: number } | null | undefined,
  now: number,
): PresenceStatus {
  if (!row) return "offline";
  if (!presenceIsLive(row.updatedAt, now)) return "offline";
  return parsePresenceState(row.state) ?? "online";
}

/**
 * How many heartbeats a client may miss and still be counted here.
 *
 * Derived rather than written down, so it cannot disagree with the two
 * constants above. It is two, and the *first* miss is the one that matters:
 * one dropped publish must never be a state change.
 */
export function missedHeartbeatsTolerated(): number {
  return PRESENCE_TTL_HEARTBEATS - 1;
}

export const PRESENCE_LABEL: Record<PresenceStatus, string> = {
  online: "Online",
  away: "Away",
  offline: "Offline",
};

/** The dot. Buzz's palette, kept: emerald, amber, and a muted ghost. */
export function presenceDotClass(status: PresenceStatus): string {
  if (status === "online") return "bg-emerald-500";
  if (status === "away") return "bg-amber-500";
  return "bg-[var(--color-muted-foreground)]/35";
}

/** The chip: a fill and a matching text colour, no dot (it would be redundant). */
export function presenceChipClass(status: PresenceStatus): string {
  if (status === "online") return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400";
  if (status === "away") return "bg-amber-500/15 text-amber-700 dark:text-amber-500";
  return "bg-[var(--chat-hover)] text-[var(--color-muted-foreground)]";
}

// ---------------------------------------------------------------------------
// Typing (01-core-comms §5.2)
// ---------------------------------------------------------------------------

/** An indicator with no refresh dies this long after the beat that raised it. */
export const TYPING_TTL_MS = 8_000;
/** At most one broadcast per room per this window, however fast somebody types. */
export const TYPING_SEND_INTERVAL_MS = 3_000;
/** How often a client sweeps expired entries — only while somebody is typing. */
export const TYPING_PRUNE_INTERVAL_MS = 1_000;
/**
 * After an author's message lands, ignore their indicators for this long.
 *
 * Without it the room lies at the worst moment: a throttled indicator sent
 * 200ms before the message arrives outlives the message by eight seconds, so
 * the dots re-light directly under the sentence they were announcing.
 */
export const TYPING_POST_MESSAGE_SUPPRESS_MS = 2_000;

/**
 * A typist, in one scope.
 *
 * Scope is the room *or* a thread inside it, never both collapsed: typing a
 * reply in a thread and typing in the channel are different claims, and
 * merging them puts a thread reply's dots under the main transcript.
 */
export type TypingScope = { channelId: string; threadHeadId: string | null };

export function typingKey(pubkey: string, threadHeadId: string | null): string {
  return `${pubkey}:${threadHeadId ?? "channel"}`;
}

export type TypingSignal = {
  pubkey: string;
  name: string;
  isAgent?: boolean;
  channelId: string;
  threadHeadId?: string | null;
  /** When the sender emitted it, in ms. Not when we received it. */
  sentAt: number;
};

export type TypingEntry = {
  key: string;
  pubkey: string;
  name: string;
  isAgent: boolean;
  threadHeadId: string | null;
  /** Preserved across refreshes, so the display order does not shuffle. */
  firstSeenAt: number;
  expiresAt: number;
};

export type TypingState = {
  entries: Readonly<Record<string, TypingEntry>>;
  /** key → the moment post-message suppression lifts. */
  suppressedUntil: Readonly<Record<string, number>>;
};

export const EMPTY_TYPING_STATE: TypingState = Object.freeze({
  entries: Object.freeze({}),
  suppressedUntil: Object.freeze({}),
});

/**
 * Fold one received indicator into the state.
 *
 * Every refusal here is something that would otherwise draw dots that are not
 * true: an indicator for another room (a client subscribed to two), your own
 * echo (you know you are typing), one already expired when it arrived (a
 * queued publish delivered after a reconnect), and one from somebody the room
 * has just heard from (see `TYPING_POST_MESSAGE_SUPPRESS_MS`).
 *
 * The expiry is `min(now + TTL, sentAt + TTL)`, so a signal that spent three
 * seconds in flight shows for five and not for eleven — the sender's clock
 * bounds the claim, and our own clock bounds a sender whose clock is ahead.
 */
export function receiveTypingSignal(
  state: TypingState,
  signal: TypingSignal,
  context: { now: number; selfPubkey: string; scope: TypingScope },
): TypingState {
  const { now, selfPubkey, scope } = context;
  if (signal.channelId !== scope.channelId) return state;
  if (signal.pubkey === selfPubkey) return state;

  const threadHeadId = signal.threadHeadId ?? null;
  const key = typingKey(signal.pubkey, threadHeadId);

  const suppressed = state.suppressedUntil[key];
  if (suppressed !== undefined && suppressed > now) return state;

  const expiresAt = Math.min(now + TYPING_TTL_MS, signal.sentAt + TYPING_TTL_MS);
  // Already dead on arrival. Inserting it would draw a row that the very next
  // prune removes, which reads as a flicker rather than as a person.
  if (expiresAt <= now) return state;

  const existing = state.entries[key];
  return {
    ...state,
    entries: {
      ...state.entries,
      [key]: {
        key,
        pubkey: signal.pubkey,
        name: signal.name,
        isAgent: signal.isAgent ?? false,
        threadHeadId,
        firstSeenAt: existing?.firstSeenAt ?? now,
        expiresAt,
      },
    },
  };
}

/**
 * A message from this author landed: drop their entry and hold the door shut.
 *
 * Both halves are needed. Dropping alone leaves the throttled indicator that
 * was already in flight free to re-light the dots two hundred milliseconds
 * later; suppressing alone leaves the current entry showing for its full eight
 * seconds under a message that has already arrived.
 */
export function noteMessageFrom(
  state: TypingState,
  message: { pubkey: string; threadHeadId?: string | null },
  now: number,
): TypingState {
  const key = typingKey(message.pubkey, message.threadHeadId ?? null);
  const entries = { ...state.entries };
  delete entries[key];
  return {
    entries,
    suppressedUntil: { ...state.suppressedUntil, [key]: now + TYPING_POST_MESSAGE_SUPPRESS_MS },
  };
}

/**
 * Drop what has expired. Returns the *same object* when nothing changed, so a
 * one-second interval in a React component is not a one-second re-render of
 * the transcript it sits under.
 */
export function pruneTyping(state: TypingState, now: number): TypingState {
  let changed = false;
  const entries: Record<string, TypingEntry> = {};
  for (const [key, entry] of Object.entries(state.entries)) {
    if (entry.expiresAt > now) entries[key] = entry;
    else changed = true;
  }
  const suppressedUntil: Record<string, number> = {};
  for (const [key, until] of Object.entries(state.suppressedUntil)) {
    if (until > now) suppressedUntil[key] = until;
    else changed = true;
  }
  return changed ? { entries, suppressedUntil } : state;
}

/** Everyone currently typing in one scope, oldest claim first. */
export function typingIn(state: TypingState, threadHeadId: string | null): TypingEntry[] {
  return Object.values(state.entries)
    .filter((entry) => entry.threadHeadId === (threadHeadId ?? null))
    .sort((a, b) => a.firstSeenAt - b.firstSeenAt || a.key.localeCompare(b.key));
}

/**
 * The sentence. Buzz's four shapes, verbatim.
 *
 * Names are never elided below three, because "2 people are typing" in a
 * two-person DM is strictly less information than either name.
 */
export function typingLabel(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing...`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing...`;
  if (names.length === 3) return `${names[0]}, ${names[1]}, and ${names[2]} are typing...`;
  const others = names.length - 2;
  return `${names[0]}, ${names[1]}, and ${others} others are typing...`;
}

/**
 * The send-side throttle.
 *
 * A clock rather than a boolean because the room is part of the state: the
 * throttle **resets when the channel changes**, so walking into a room and
 * typing announces immediately instead of waiting out a window that was opened
 * somewhere else. Pure, so the caller owns where the clock is stored (a ref).
 */
export type TypingClock = { scopeKey: string | null; lastSentAt: number };

export const IDLE_TYPING_CLOCK: TypingClock = Object.freeze({
  scopeKey: null,
  lastSentAt: 0,
});

export function typingScopeKey(scope: TypingScope): string {
  return `${scope.channelId}:${scope.threadHeadId ?? "channel"}`;
}

export function shouldSendTyping(
  clock: TypingClock,
  input: { scope: TypingScope; now: number },
): { send: boolean; clock: TypingClock } {
  const scopeKey = typingScopeKey(input.scope);
  if (clock.scopeKey !== scopeKey) {
    return { send: true, clock: { scopeKey, lastSentAt: input.now } };
  }
  if (input.now - clock.lastSentAt >= TYPING_SEND_INTERVAL_MS) {
    return { send: true, clock: { scopeKey, lastSentAt: input.now } };
  }
  return { send: false, clock };
}

/**
 * You sent a message: hold your own next announcement.
 *
 * The receiver-side suppression above protects everybody else's client from a
 * stale indicator of yours. This protects the *next* one: without it, the
 * keystroke after pressing Enter is a fresh broadcast, and the room sees you
 * start typing again before it has drawn what you just said.
 */
export function noteMessageSent(clock: TypingClock, now: number): TypingClock {
  if (clock.scopeKey === null) return clock;
  return {
    scopeKey: clock.scopeKey,
    lastSentAt: now + TYPING_POST_MESSAGE_SUPPRESS_MS - TYPING_SEND_INTERVAL_MS,
  };
}

// ---------------------------------------------------------------------------
// Custom user status (01-core-comms §5.3)
// ---------------------------------------------------------------------------

/** NIP-38 / Buzz's `KIND_USER_STATUS`. Addressable: one live row per author. */
export const USER_STATUS_KIND = 30315;
/** The `d` coordinate. One general status, not one per surface. */
export const USER_STATUS_D_TAG = "general";
/** Long enough for a sentence, short enough to sit on one line beside a name. */
export const USER_STATUS_MAX_LENGTH = 120;

export type UserStatus = {
  text: string;
  emoji: string;
  /** ms. The event's own `created_at`, lifted out of seconds. */
  updatedAt: number;
  /** ms, or null for "until I clear it". */
  expiresAt: number | null;
};

/** Buzz's five chips, and the five people actually pick. */
export const USER_STATUS_PRESETS: readonly { text: string; emoji: string }[] = [
  { text: "In a meeting", emoji: "🗣️" },
  { text: "Commuting", emoji: "🚌" },
  { text: "Out sick", emoji: "🤒" },
  { text: "Vacationing", emoji: "🏖️" },
  { text: "Working remotely", emoji: "🏠" },
];

/**
 * How long a status lasts.
 *
 * Buzz has no expiry at all — clearing is explicit — and that is the single
 * most-reported way a status goes wrong: "In a meeting 🗣️" is still there on
 * Thursday, so nobody believes any of them. An expiry is added here rather
 * than adopted from Buzz, and it is carried as NIP-40's standard `expiration`
 * tag rather than a field of our own, so an exported event still means what it
 * says in any Nostr tool.
 */
export const STATUS_DURATIONS: readonly { label: string; minutes: number | null }[] = [
  { label: "Don't clear", minutes: null },
  { label: "30 minutes", minutes: 30 },
  { label: "1 hour", minutes: 60 },
  { label: "4 hours", minutes: 240 },
  { label: "Today", minutes: 8 * 60 },
  { label: "This week", minutes: 7 * 24 * 60 },
];

/** A shortcode like `:shipit:`, which resolves against the community palette. */
export function isEmojiShortcode(emoji: string): boolean {
  return /^:([^:\s]+):$/u.test(emoji);
}

/**
 * A 30315 event, read as a status.
 *
 * `content` is the text, the first `["emoji", …]` tag is the emoji, and an
 * `["expiration", <unix seconds>]` tag is when it lapses. A status with
 * neither text nor emoji collapses to null — that shape *is* the clear, so
 * treating it as a status would leave an empty pill beside somebody's name
 * forever.
 */
export function parseUserStatusEvent(event: {
  content: string;
  tags: readonly (readonly string[])[];
  created_at: number;
}): UserStatus | null {
  const text = (event.content ?? "").trim().slice(0, USER_STATUS_MAX_LENGTH);
  const emojiTag = event.tags.find((tag) => tag[0] === "emoji");
  const emoji = (emojiTag?.[1] ?? "").trim();
  if (!text && !emoji) return null;

  const expirationTag = event.tags.find((tag) => tag[0] === "expiration");
  const expirationSecs = Number(expirationTag?.[1]);
  const expiresAt =
    expirationTag && Number.isFinite(expirationSecs) && expirationSecs > 0
      ? Math.floor(expirationSecs) * 1000
      : null;

  return { text, emoji, updatedAt: event.created_at * 1000, expiresAt };
}

export function userStatusExpired(status: UserStatus, now: number): boolean {
  return status.expiresAt !== null && status.expiresAt <= now;
}

/**
 * The status to *show*, which is not always the status that is stored.
 *
 * Expiry is derived on read rather than swept by a cron. The alternative is a
 * scheduled job publishing a clear on somebody's behalf, which puts an event
 * in the log that its author did not write and makes "who cleared this" a
 * question with a wrong answer.
 */
export function activeUserStatus(
  status: UserStatus | null | undefined,
  now: number,
): UserStatus | null {
  if (!status) return null;
  return userStatusExpired(status, now) ? null : status;
}

/** Newest wins, and an equal timestamp keeps what is already on screen. */
export function newerUserStatus(
  existing: UserStatus | null,
  incoming: UserStatus | null,
): UserStatus | null {
  if (!incoming) return existing;
  if (!existing) return incoming;
  return incoming.updatedAt > existing.updatedAt ? incoming : existing;
}

export type StatusDraft = { text: string; emoji: string; minutes: number | null };

/**
 * What the dialog has, turned into what the mutation takes — or null when
 * there is nothing to save.
 *
 * Trimming here and not at the call site is deliberate: `"   "` is not a
 * status, and a Save button that is enabled because the box is not literally
 * empty is a button that publishes whitespace.
 */
export function normalizeStatusDraft(
  draft: StatusDraft,
  now: number,
): { text: string; emoji: string; expiresAt: number | null } | null {
  const text = draft.text.trim().slice(0, USER_STATUS_MAX_LENGTH);
  const emoji = draft.emoji.trim();
  if (!text && !emoji) return null;
  const expiresAt =
    draft.minutes !== null && draft.minutes > 0 ? now + draft.minutes * 60_000 : null;
  return { text, emoji, expiresAt };
}
