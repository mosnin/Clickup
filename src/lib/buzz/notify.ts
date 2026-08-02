// Why you were told, and why you were not.
//
// Every chat product generates exactly one support question at volume: "why
// didn't I get notified?" (and its twin, "why did I?"). A boolean cannot answer
// it. So nothing in this file returns one — every decision comes back as a
// *named* reason plus the numbered rule that produced it, and the UI, the
// server delivery path and the tests all read the same answer.
//
// The file is pure on purpose. It is the one place in the Chat dashboard where a
// wrong answer is silent: a notification that never arrives leaves no trace, no
// error, no row anybody can look at. A rule that lives in a React effect is a
// rule that is tested by reading it. So the rules live here, the effects call
// them, and `tests/buzz-notify.test.ts` is the executable spec.
//
// ## The ordering IS the specification
//
// 01-core-comms §7.1 gives nine steps and says they are evaluated in that exact
// order; §10 item 32 restates why. Two of those orderings are load-bearing and
// neither is obvious:
//
//   - A **broadcast** and a **mention** are checked *before* a channel mute, so
//     both pierce it. Muting #general means "stop telling me about #general",
//     not "stop telling me when somebody needs me in #general".
//   - A **thread mute** is checked *before* participation, follow and
//     authorship. Muting a thread you started is the whole reason thread mutes
//     exist: the loudest thread in a room is usually one you are in.
//
// Reorder either and every individual rule still passes its own test while the
// product behaves wrongly. That is why `decide()` walks a numbered list rather
// than composing booleans, and why the tests assert *which* rule fired rather
// than only the outcome. A suppression that runs after a delivery decision is a
// suppression that does not work.
//
// ## Two layers, one vocabulary
//
// `shouldNotifyForEvent` is §7.1: does this event bear on me at all, given what
// I have muted and which threads I am in? It knows nothing about settings,
// sessions or screens.
//
// `decide` is §7.6: the eleven things that suppress a notification, of which
// three (8, 9 and 11) *are* the predicate's steps 3, 5 and 9. They are not
// restated here — one call, one answer, so a mute can never mean two things.
//
// Nothing in this file touches the DOM, `Notification`, an audio element or a
// clock. `Date.now()` in a predicate is how a test becomes flaky at midnight.

// ---------------------------------------------------------------------------
// The event, as this file needs to see it
// ---------------------------------------------------------------------------

/**
 * A Nostr event, narrowed to the fields a notification decision reads.
 *
 * Deliberately structural rather than importing the log's row type: the same
 * decision is made in the browser (over an event off a subscription), on the
 * server (over a row being written) and in a test (over a literal). A shape
 * that only one of those can produce would push the other two into adapters.
 */
export type NotifyEvent = {
  id: string;
  pubkey: string;
  kind: number;
  /** NIP-01 seconds, not milliseconds. Compared against `subscriptionStartedAt`. */
  created_at: number;
  tags: readonly (readonly string[])[];
  content?: string;
};

// ---------------------------------------------------------------------------
// Kind sets (§0.2) — rebuilt exactly, because they are load-bearing
// ---------------------------------------------------------------------------

/**
 * "Human-visible new content" — the unread *and* notification trigger set.
 *
 * Reactions, edits, deletions, diffs and system rows are deliberately absent.
 * They can land long after the last human-visible message, and treating one as
 * new content produces a notification (and an unread badge) for a room where
 * nobody said anything.
 */
export const CHANNEL_MESSAGE_EVENT_KINDS: readonly number[] = [9, 40002, 45001, 45003];

/**
 * The same set plus huddle-start, for a DM only.
 *
 * §0.2's reason, kept verbatim: in a DM the "huddle started" card *is* the
 * invitation, so not notifying on it means the call rings nowhere.
 */
export const DM_NOTIFIABLE_EVENT_KINDS: readonly number[] = [
  ...CHANNEL_MESSAGE_EVENT_KINDS,
  48100,
];

const CHANNEL_MESSAGE_KIND_SET: ReadonlySet<number> = new Set(CHANNEL_MESSAGE_EVENT_KINDS);
const DM_NOTIFIABLE_KIND_SET: ReadonlySet<number> = new Set(DM_NOTIFIABLE_EVENT_KINDS);

/** §7.6 item 10, as a predicate. A DM notifies on one more kind than a room. */
export function isNotifiableKind(kind: number, isDm: boolean): boolean {
  return isDm ? DM_NOTIFIABLE_KIND_SET.has(kind) : CHANNEL_MESSAGE_KIND_SET.has(kind);
}

// ---------------------------------------------------------------------------
// Tag reading (§2.2) — the grammar, restated pure
// ---------------------------------------------------------------------------

/**
 * The thread reference in an event's tags. §2.2's `getThreadReference`.
 *
 * The asymmetry — **first** `root` marker, **last** `reply` marker — is Buzz's
 * and is deliberate. An `e` tag with no marker is a quote or a link to an
 * event, not a parent; treating one as a parent would silently reparent every
 * message that has ever pointed at another, which here would mean a reaction
 * (an unmarked `e` tag and nothing else) arriving as a reply.
 *
 * The same function exists server-side in `convex/buzz/messages.ts` because
 * `convex/` deploys as its own bundle and cannot import from the Next tree.
 * Both are covered by tests; if you change one, change both.
 */
export function threadReferenceFrom(tags: readonly (readonly string[])[]): {
  parentId: string | null;
  rootId: string | null;
} {
  const eTags = tags.filter((tag) => tag[0] === "e" && tag[1]);
  if (eTags.length === 0) return { parentId: null, rootId: null };
  const rootTag = eTags.find((tag) => tag[3] === "root");
  const replyTags = eTags.filter((tag) => tag[3] === "reply");
  const replyTag = replyTags[replyTags.length - 1];
  if (!replyTag) return { parentId: null, rootId: null };
  const parentId = replyTag[1];
  return { parentId, rootId: rootTag?.[1] ?? parentId };
}

/**
 * `["broadcast","1"]` — a reply that *also* renders top-level in the channel.
 *
 * Exactly `"1"`, not "any truthy value": the tag is part of the signed event id
 * and a relay that accepted `["broadcast","true"]` as equivalent would let two
 * different byte strings mean the same thing, which is how a message's identity
 * stops being a function of its content.
 */
export function isBroadcastReply(tags: readonly (readonly string[])[]): boolean {
  return tags.some((tag) => tag[0] === "broadcast" && tag[1] === "1");
}

/**
 * Does this event carry a `p` tag naming me?
 *
 * §7.1: any `["p", pk]` equal to the current pubkey, lowercased, and **a
 * non-empty pubkey is required**. That last clause is not defensive
 * programming: before the key bootstrap runs the reader's pubkey is `""`, and a
 * `p` tag with an empty value is a perfectly ordinary malformed tag. Without
 * the guard, one such tag anywhere in a room notifies every signed-out client.
 *
 * Note what this does **not** do: exclude the author. `messageTags` puts the
 * author's own key in the first `p` tag, so by this function every message
 * mentions its own author. Authorship is §7.6 item 3 and it is checked earlier
 * — see `decide`, and the ordering test that pins it.
 */
export function hasMentionForEvent(event: NotifyEvent, me: string): boolean {
  const reader = me.trim().toLowerCase();
  if (reader.length === 0) return false;
  return event.tags.some((tag) => tag[0] === "p" && (tag[1] ?? "").toLowerCase() === reader);
}

/** The room an event belongs to: its first `h` tag, or null. */
export function channelIdFromTags(tags: readonly (readonly string[])[]): string | null {
  for (const tag of tags) {
    if (tag[0] === "h" && tag[1]) return tag[1];
  }
  return null;
}

/** §2.2: a reply that does *not* also render top-level. */
export function isThreadReply(tags: readonly (readonly string[])[]): boolean {
  return threadReferenceFrom(tags).parentId !== null && !isBroadcastReply(tags);
}

// ---------------------------------------------------------------------------
// Reasons — one closed vocabulary for both layers
// ---------------------------------------------------------------------------

/** The six ways an event earns a notification (§7.1 steps 1, 2, 4, 6, 7, 8). */
export const NOTIFY_REASON = {
  /** Step 1 — a broadcast reply always notifies, even in a muted channel. */
  BROADCAST_REPLY: "broadcast_reply",
  /** Step 2 — a mention pierces a channel mute. */
  MENTION: "mention",
  /** Step 4 — a top-level message in a channel you are in. */
  TOP_LEVEL: "top_level",
  /** Step 6 — you have said something in this thread. */
  PARTICIPATED: "participated_thread",
  /** Step 7 — you followed this thread without speaking in it. */
  FOLLOWED: "followed_thread",
  /** Step 8 — you started this thread. */
  AUTHORED: "authored_thread",
} as const;

/**
 * The eleven ways a notification is suppressed (§7.6), each with the item
 * number it carries in the spec.
 *
 * Eleven named constants rather than a comment, because each one is the answer
 * to somebody's support ticket and "false" is not an answer. Three of them
 * (8, 9, 11) are produced by the predicate rather than by the pipeline — see
 * `decide`.
 */
export const SUPPRESSED_REASON = {
  /** 1 — the master switch is off, or the OS never granted permission. */
  ALERTS_OFF: "alerts_off",
  /** 2 — this event's sound slot is switched off. */
  SLOT_OFF: "slot_off",
  /** 3 — you wrote it. */
  SELF_AUTHORED: "self_authored",
  /** 4 — already delivered this session (reconnect replay, or two filters). */
  ALREADY_DELIVERED: "already_delivered",
  /** 5 — the first load of a feed is backlog, not news. */
  INITIAL_LOAD: "initial_load",
  /** 6 — older than the subscription; replayed history. */
  BACKLOG_REPLAY: "backlog_replay",
  /** 7 — you are looking at this room and did not ask to be told anyway. */
  VIEWING_CHANNEL: "viewing_channel",
  /** 8 — the channel is muted (predicate step 3). */
  CHANNEL_MUTED: "channel_muted",
  /** 9 — the thread root is muted (predicate step 5). */
  THREAD_MUTED: "thread_muted",
  /** 10 — the kind renders nothing a person reads as new. */
  KIND_NOT_NOTIFIABLE: "kind_not_notifiable",
  /** 11 — a reply in a thread you have no relationship with (predicate step 9). */
  UNRELATED_THREAD: "unrelated_thread",
} as const;

export type NotifyReasonName = (typeof NOTIFY_REASON)[keyof typeof NOTIFY_REASON];
export type SuppressedReasonName =
  (typeof SUPPRESSED_REASON)[keyof typeof SUPPRESSED_REASON];
export type NotifyReason = NotifyReasonName | SuppressedReasonName;

/**
 * The §7.6 item number a suppression reason carries.
 *
 * A map rather than an ordinal baked into the constant, so the numbering is
 * stated once and a test can assert the pipeline visits them in order.
 */
export const SUPPRESSION_ITEM: Record<SuppressedReasonName, number> = {
  [SUPPRESSED_REASON.ALERTS_OFF]: 1,
  [SUPPRESSED_REASON.SLOT_OFF]: 2,
  [SUPPRESSED_REASON.SELF_AUTHORED]: 3,
  [SUPPRESSED_REASON.ALREADY_DELIVERED]: 4,
  [SUPPRESSED_REASON.INITIAL_LOAD]: 5,
  [SUPPRESSED_REASON.BACKLOG_REPLAY]: 6,
  [SUPPRESSED_REASON.VIEWING_CHANNEL]: 7,
  [SUPPRESSED_REASON.CHANNEL_MUTED]: 8,
  [SUPPRESSED_REASON.THREAD_MUTED]: 9,
  [SUPPRESSED_REASON.KIND_NOT_NOTIFIABLE]: 10,
  [SUPPRESSED_REASON.UNRELATED_THREAD]: 11,
};

/** Human-readable, and honest about *whose* setting caused it. */
export const SUPPRESSION_EXPLANATION: Record<SuppressedReasonName, string> = {
  [SUPPRESSED_REASON.ALERTS_OFF]: "Alerts are turned off, or your browser has not granted permission.",
  [SUPPRESSED_REASON.SLOT_OFF]: "Alerts for this kind of message are switched off in settings.",
  [SUPPRESSED_REASON.SELF_AUTHORED]: "You wrote it.",
  [SUPPRESSED_REASON.ALREADY_DELIVERED]: "It was already delivered once this session.",
  [SUPPRESSED_REASON.INITIAL_LOAD]: "It arrived in the first load, which is history rather than news.",
  [SUPPRESSED_REASON.BACKLOG_REPLAY]: "It predates this connection — replayed backlog.",
  [SUPPRESSED_REASON.VIEWING_CHANNEL]: "You had that conversation open, and “notify while viewing” is off.",
  [SUPPRESSED_REASON.CHANNEL_MUTED]: "That channel is muted.",
  [SUPPRESSED_REASON.THREAD_MUTED]: "That thread is muted.",
  [SUPPRESSED_REASON.KIND_NOT_NOTIFIABLE]: "It is not a message — a reaction, an edit or a system row.",
  [SUPPRESSED_REASON.UNRELATED_THREAD]: "It is a reply in a thread you have not taken part in.",
};

// ---------------------------------------------------------------------------
// §7.1 — the predicate
// ---------------------------------------------------------------------------

/**
 * What the reader has muted, and which threads they have a relationship with.
 *
 * Sets rather than arrays: these are membership questions asked once per
 * incoming event, and a room busy enough to matter is one where an array scan
 * per event per thread is measurable. `ReadonlySet` also makes it structurally
 * impossible for a caller to mutate the relationship while a decision is being
 * made about it.
 */
export type NotifyRelationship = {
  mutedChannelIds?: ReadonlySet<string>;
  mutedRootIds?: ReadonlySet<string>;
  /** Threads the reader has replied in. */
  participatedRootIds?: ReadonlySet<string>;
  /** Threads the reader followed without speaking. */
  followedRootIds?: ReadonlySet<string>;
  /** Threads the reader started. */
  authoredRootIds?: ReadonlySet<string>;
};

export type NotifyDecision = {
  notify: boolean;
  /** The §7.1 step that decided, 1–9. */
  step: number;
  reason: NotifyReason;
};

const EMPTY: ReadonlySet<string> = new Set();

/**
 * §7.1, in the exact order §7.1 gives, and the order is the point.
 *
 * ```
 * 1. broadcast reply                     → notify   (pierces a channel mute)
 * 2. mentions me                         → notify   (pierces a channel mute)
 * 3. channel muted                       → suppress
 * 4. top-level message                   → notify
 * 5. thread root muted                   → suppress (outranks 6, 7, 8)
 * 6. I have replied in this thread       → notify
 * 7. I follow this thread                → notify
 * 8. I started this thread               → notify
 * 9. otherwise                           → suppress
 * ```
 *
 * The two inversions people get wrong: 1 and 2 sit *above* 3, and 5 sits
 * *above* 6–8. Written as `if (muted) return false` first — the reading that
 * feels natural — a mute would swallow the message that says somebody needs
 * you, and a thread you started would be unmutable.
 *
 * `channelId` comes from the event's `h` tag when the caller does not pass one;
 * an event with neither is treated as belonging to no channel, so step 3 cannot
 * fire on it. That is the safe direction: failing to *suppress* costs a
 * notification somebody can mute, whereas failing to notify costs a message
 * nobody ever sees.
 */
export function shouldNotifyForEvent(
  event: NotifyEvent,
  me: string,
  relationship: NotifyRelationship = {},
  channelId: string | null = channelIdFromTags(event.tags),
): NotifyDecision {
  const mutedChannels = relationship.mutedChannelIds ?? EMPTY;
  const mutedRoots = relationship.mutedRootIds ?? EMPTY;
  const participated = relationship.participatedRootIds ?? EMPTY;
  const followed = relationship.followedRootIds ?? EMPTY;
  const authored = relationship.authoredRootIds ?? EMPTY;

  // 1 — a broadcast is the room-wide announcement. It outranks everything.
  if (isBroadcastReply(event.tags)) {
    return { notify: true, step: 1, reason: NOTIFY_REASON.BROADCAST_REPLY };
  }

  // 2 — being named outranks a mute you set about a room, because it is about
  // you rather than about the room.
  if (hasMentionForEvent(event, me)) {
    return { notify: true, step: 2, reason: NOTIFY_REASON.MENTION };
  }

  // 3 — and only now does a channel mute get to speak.
  if (channelId !== null && mutedChannels.has(channelId)) {
    return { notify: false, step: 3, reason: SUPPRESSED_REASON.CHANNEL_MUTED };
  }

  const { parentId, rootId } = threadReferenceFrom(event.tags);

  // 4 — a top-level message in an unmuted room is the ordinary case.
  if (parentId === null) {
    return { notify: true, step: 4, reason: NOTIFY_REASON.TOP_LEVEL };
  }

  const root = rootId ?? parentId;

  // 5 — a thread mute outranks every relationship below it. Muting a thread you
  // started is the whole reason the control exists.
  if (mutedRoots.has(root)) {
    return { notify: false, step: 5, reason: SUPPRESSED_REASON.THREAD_MUTED };
  }

  // 6, 7, 8 — three ways of having a stake in a thread, cheapest first.
  if (participated.has(root)) {
    return { notify: true, step: 6, reason: NOTIFY_REASON.PARTICIPATED };
  }
  if (followed.has(root)) {
    return { notify: true, step: 7, reason: NOTIFY_REASON.FOLLOWED };
  }
  if (authored.has(root)) {
    return { notify: true, step: 8, reason: NOTIFY_REASON.AUTHORED };
  }

  // 9 — a reply in somebody else's conversation. Silence is correct.
  return { notify: false, step: 9, reason: SUPPRESSED_REASON.UNRELATED_THREAD };
}

/** §7.1's `isHighPriorityEventForUser` — mention ∨ broadcast. */
export function isHighPriorityEventForUser(event: NotifyEvent, me: string): boolean {
  return isBroadcastReply(event.tags) || hasMentionForEvent(event, me);
}

// ---------------------------------------------------------------------------
// Settings (§7.3)
// ---------------------------------------------------------------------------

export const SOUND_SLOTS = [
  "dm",
  "mention",
  "thread_reply",
  "needs_action",
  "job_accepted",
  "job_progress",
  "job_result",
  "job_error",
] as const;
export type SoundSlot = (typeof SOUND_SLOTS)[number];

export const SOUND_NAMES = [
  "bong",
  "boo",
  "dng",
  "doo",
  "doodone",
  "doong",
  "doop",
  "flirl",
  "flutter",
  "oh-no",
  "ping",
  "unison",
] as const;
export type SoundName = (typeof SOUND_NAMES)[number];

/**
 * The four agent slots: wired end-to-end, nothing emits them yet.
 *
 * They render disabled with a "Coming soon" chip rather than being hidden,
 * because the settings screen is also documentation of what the product is
 * about to do — and because a slot that appears the day its emitter ships is a
 * setting nobody discovers. Neither the master switch nor a bulk write may
 * touch them (see `setAllSlotAlertsEnabled`).
 */
export const COMING_SOON_SLOTS: readonly SoundSlot[] = [
  "job_accepted",
  "job_progress",
  "job_result",
  "job_error",
];

const COMING_SOON_SET: ReadonlySet<SoundSlot> = new Set(COMING_SOON_SLOTS);

export const SLOT_LABELS: Record<SoundSlot, string> = {
  dm: "Direct messages",
  mention: "@Mentions",
  thread_reply: "Thread replies",
  needs_action: "Needs action",
  job_accepted: "Agent: job accepted",
  job_progress: "Agent: progress update",
  job_result: "Agent: job result",
  job_error: "Agent: job error",
};

export const SLOT_DESCRIPTIONS: Record<SoundSlot, string> = {
  dm: "A message in a conversation with just you in it.",
  mention: "Someone — or some agent — names you.",
  thread_reply: "A reply in a thread you are part of.",
  needs_action: "Something is waiting on you.",
  job_accepted: "An agent picked up work you handed it.",
  job_progress: "An agent reported progress mid-run.",
  job_result: "An agent finished and has something for you.",
  job_error: "An agent failed or stalled.",
};

/** §7.3's `RECOMMENDED_SOUND_BY_SLOT`. Suggestions, never applied silently. */
export const RECOMMENDED_SOUND_BY_SLOT: Record<SoundSlot, SoundName> = {
  dm: "unison",
  mention: "ping",
  thread_reply: "doop",
  needs_action: "doodone",
  job_accepted: "boo",
  job_progress: "dng",
  job_result: "unison",
  job_error: "oh-no",
};

export type NotificationSettings = {
  desktopEnabled: boolean;
  homeBadgeEnabled: boolean;
  notifyWhileViewing: boolean;
  sounds: Record<SoundSlot, SoundName>;
  slotAlertsEnabled: Record<SoundSlot, boolean>;
  /**
   * What the granular rows said before the master switch was turned off.
   *
   * `null` means there is nothing to restore. Kept as its own field rather than
   * inferred, because "everything off" and "everything off because I flipped
   * the master switch" have to restore differently.
   */
  slotAlertsSnapshot: Record<SoundSlot, boolean> | null;
};

/** Every slot's sound defaults to `flutter` (§7.3). */
export const DEFAULT_SLOT_SOUNDS: Record<SoundSlot, SoundName> = Object.freeze(
  Object.fromEntries(SOUND_SLOTS.map((slot) => [slot, "flutter"])) as Record<
    SoundSlot,
    SoundName
  >,
);

/** All true except `job_progress` — the one slot that would be a firehose. */
export const DEFAULT_SLOT_ALERTS_ENABLED: Record<SoundSlot, boolean> = Object.freeze(
  Object.fromEntries(
    SOUND_SLOTS.map((slot) => [slot, slot !== "job_progress"]),
  ) as Record<SoundSlot, boolean>,
);

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = Object.freeze({
  desktopEnabled: true,
  homeBadgeEnabled: true,
  notifyWhileViewing: false,
  sounds: DEFAULT_SLOT_SOUNDS,
  slotAlertsEnabled: DEFAULT_SLOT_ALERTS_ENABLED,
  slotAlertsSnapshot: null,
});

function isSoundName(value: unknown): value is SoundName {
  return typeof value === "string" && (SOUND_NAMES as readonly string[]).includes(value);
}

function record<T>(source: unknown, fallback: Record<SoundSlot, T>, ok: (v: unknown) => v is T) {
  const raw = (source ?? {}) as Record<string, unknown>;
  const out = {} as Record<SoundSlot, T>;
  for (const slot of SOUND_SLOTS) {
    const value = typeof raw === "object" && raw !== null ? raw[slot] : undefined;
    out[slot] = ok(value) ? value : fallback[slot];
  }
  return out;
}

const isBool = (v: unknown): v is boolean => typeof v === "boolean";

/**
 * Read a stored settings blob back into a settings object, total.
 *
 * "Sanitise unknown/ill-typed values back to defaults on read" (§7.3), and
 * total for the same reason `normalizeAppearance` is: a row written by a newer
 * build, a half-migrated localStorage value or a hand-edited payload must not
 * be able to lock somebody out of their own notifications. Unknown keys are
 * dropped, unknown slots are dropped, and every known slot is present
 * afterwards — so nothing downstream needs a `?? default`.
 */
export function normalizeNotificationSettings(raw: unknown): NotificationSettings {
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const snapshotRaw = input.slotAlertsSnapshot;
  return {
    desktopEnabled: isBool(input.desktopEnabled)
      ? input.desktopEnabled
      : DEFAULT_NOTIFICATION_SETTINGS.desktopEnabled,
    homeBadgeEnabled: isBool(input.homeBadgeEnabled)
      ? input.homeBadgeEnabled
      : DEFAULT_NOTIFICATION_SETTINGS.homeBadgeEnabled,
    notifyWhileViewing: isBool(input.notifyWhileViewing)
      ? input.notifyWhileViewing
      : DEFAULT_NOTIFICATION_SETTINGS.notifyWhileViewing,
    sounds: record(input.sounds, DEFAULT_SLOT_SOUNDS, isSoundName),
    slotAlertsEnabled: record(input.slotAlertsEnabled, DEFAULT_SLOT_ALERTS_ENABLED, isBool),
    // A snapshot is either a full map or absent. A partial one would restore
    // some rows and silently default the rest, which is worse than not
    // restoring at all — so anything that is not an object becomes null.
    slotAlertsSnapshot:
      typeof snapshotRaw === "object" && snapshotRaw !== null
        ? record(snapshotRaw, DEFAULT_SLOT_ALERTS_ENABLED, isBool)
        : null,
  };
}

/**
 * The master switch — deliberately not a bulk write (§7.3).
 *
 * Off: snapshot the granular picks, then zero the live rows. On: restore the
 * snapshot **if it had anything enabled**, else enable everything — because a
 * snapshot of all-false restored faithfully would produce a master switch that
 * turns on and nothing happens, which reads as a broken control.
 *
 * `COMING_SOON_SLOTS` are never touched by either direction: they are not
 * choices anybody has made yet, and sweeping them into a snapshot means the day
 * their emitter ships, whoever once flipped this switch has them silently on.
 */
export function setAllSlotAlertsEnabled(
  settings: NotificationSettings,
  enabled: boolean,
): NotificationSettings {
  const live = { ...settings.slotAlertsEnabled };

  if (!enabled) {
    const snapshot = { ...settings.slotAlertsEnabled };
    for (const slot of SOUND_SLOTS) {
      if (COMING_SOON_SET.has(slot)) continue;
      live[slot] = false;
    }
    return { ...settings, slotAlertsEnabled: live, slotAlertsSnapshot: snapshot };
  }

  const snapshot = settings.slotAlertsSnapshot;
  const restorable =
    snapshot !== null &&
    SOUND_SLOTS.some((slot) => !COMING_SOON_SET.has(slot) && snapshot[slot]);
  for (const slot of SOUND_SLOTS) {
    if (COMING_SOON_SET.has(slot)) continue;
    live[slot] = restorable ? snapshot[slot] : true;
  }
  return { ...settings, slotAlertsEnabled: live, slotAlertsSnapshot: null };
}

/**
 * Toggle one row — and drop the snapshot while doing it.
 *
 * A manual pick supersedes a pending restore (§7.3). Keep the snapshot and the
 * next flip of the master switch overwrites the choice somebody just made by
 * hand, which is the most annoying possible way to lose a setting.
 */
export function setSlotAlertEnabled(
  settings: NotificationSettings,
  slot: SoundSlot,
  enabled: boolean,
): NotificationSettings {
  if (COMING_SOON_SET.has(slot)) return settings;
  return {
    ...settings,
    slotAlertsEnabled: { ...settings.slotAlertsEnabled, [slot]: enabled },
    slotAlertsSnapshot: null,
  };
}

export function setSlotSound(
  settings: NotificationSettings,
  slot: SoundSlot,
  sound: SoundName,
): NotificationSettings {
  return { ...settings, sounds: { ...settings.sounds, [slot]: sound } };
}

/** Are all the slots a person may actually change currently on? */
export function allSlotAlertsEnabled(settings: NotificationSettings): boolean {
  return SOUND_SLOTS.every(
    (slot) => COMING_SOON_SET.has(slot) || settings.slotAlertsEnabled[slot],
  );
}

export function resolveSlotSound(settings: NotificationSettings, slot: SoundSlot): SoundName {
  return settings.sounds[slot] ?? DEFAULT_SLOT_SOUNDS[slot];
}

// ---------------------------------------------------------------------------
// Slots, from an event
// ---------------------------------------------------------------------------

const JOB_SLOT_BY_KIND: Readonly<Record<number, SoundSlot>> = {
  43002: "job_accepted",
  43003: "job_progress",
  43004: "job_result",
  43006: "job_error",
};

/**
 * Which slot's switch and sound this event answers to.
 *
 * Order is a judgement call the spec leaves open in one place, and it is stated
 * here rather than discovered: **a mention outranks a DM.** §7.4's
 * `slotForFeedKind` puts `category === "mention"` first, and the mention slot is
 * the one people tune hardest — so a mention inside a DM should sound like a
 * mention. The alternative (slot by where it landed) makes the same event sound
 * different depending on the room, which is exactly the sort of thing that
 * makes a person distrust their own settings.
 *
 * Job kinds come first because they are a fact about the event rather than
 * about the reader, and `needs_action` is the default the spec gives.
 */
export function slotForEvent(
  event: NotifyEvent,
  opts: { isDm: boolean; mentionsMe: boolean },
): SoundSlot {
  const job = JOB_SLOT_BY_KIND[event.kind];
  if (job) return job;
  if (opts.mentionsMe) return "mention";
  if (opts.isDm) return "dm";
  if (isThreadReply(event.tags)) return "thread_reply";
  return "needs_action";
}

// ---------------------------------------------------------------------------
// §7.6 — the whole decision
// ---------------------------------------------------------------------------

export type NotificationPermissionState = "granted" | "denied" | "default" | "unsupported";

/**
 * Everything outside the event that bears on the decision.
 *
 * All of it is data. Nothing here is read from a global, a ref or a clock — a
 * decision that consults `Date.now()` or `document.hidden` is a decision no
 * test can pin, and this is the one place in Chat where an untested wrong
 * answer leaves no trace at all.
 */
export type NotifyContext = {
  /** The reader's pubkey. Empty until the key bootstrap has run. */
  me: string;
  settings: NotificationSettings;
  /**
   * The OS/browser permission. Omitted means "not a desktop-alert path" —
   * server-side delivery (email, an agent ping) has no permission to ask about,
   * and demanding a fake `"granted"` there would be a lie the caller has to
   * remember to tell.
   */
  permission?: NotificationPermissionState;
  /** A DM notifies on one more kind, and has its own slot. */
  isDm?: boolean;
  /** The room, when the caller knows it better than the `h` tag does. */
  channelId?: string | null;
  /** The room on screen right now, if any. */
  activeChannelId?: string | null;
  /** Event ids already delivered this session — §7.6 item 4's shared guard. */
  deliveredEventIds?: ReadonlySet<string>;
  /** True while the first page of a feed is being absorbed. */
  initialLoad?: boolean;
  /** Seconds. Anything older is replayed backlog (§7.6 item 6). */
  subscriptionStartedAt?: number;
  relationship?: NotifyRelationship;
};

export type DeliveryDecision = {
  deliver: boolean;
  /** The §7.6 item that suppressed it, 1–11, or null when it was delivered. */
  item: number | null;
  reason: NotifyReason;
  /** The slot whose switch and sound apply. */
  slot: SoundSlot;
  /** §7.1's own answer, when the pipeline got that far. */
  predicate: NotifyDecision | null;
  /** One sentence, for the UI and for a log line. */
  explanation: string;
};

/**
 * The eleven suppressions of §7.6, in §7.6's order, ending at the predicate.
 *
 * Two structural notes, both of which are the difference between this working
 * and this looking like it works:
 *
 * **Items 8, 9 and 11 are not restated here.** They are steps 3, 5 and 9 of
 * `shouldNotifyForEvent`, and the pipeline reports them by mapping the
 * predicate's answer onto its own numbering. Writing the mute checks twice —
 * once here, once in the predicate — is how the two eventually disagree about
 * whether a broadcast pierces a channel mute, and only one of them is the
 * documented rule.
 *
 * **Item 10 is hoisted above the predicate**, which is the one deviation from
 * reading §7.6 top to bottom, and it is forced: a reaction carries an unmarked
 * `e` tag, so `threadReferenceFrom` reports no parent, so the predicate reaches
 * step 4 and calls it a top-level message. Every reaction in the room would
 * notify. The list's numbering is preserved in the returned `item`; only the
 * evaluation position moves, and the test suite pins it.
 *
 * Everything before that runs in the spec's order, cheapest and most global
 * first, which is also the order somebody debugging wants: "alerts are off" is
 * a better answer than "you have no relationship with that thread" when both
 * are true.
 */
export function decide(event: NotifyEvent, context: NotifyContext): DeliveryDecision {
  const settings = context.settings;
  const isDm = context.isDm ?? false;
  const me = context.me.trim().toLowerCase();
  const mentionsMe = hasMentionForEvent(event, me);
  const slot = slotForEvent(event, { isDm, mentionsMe });
  const channelId = context.channelId ?? channelIdFromTags(event.tags);

  const suppress = (reason: SuppressedReasonName, predicate: NotifyDecision | null = null) => ({
    deliver: false,
    item: SUPPRESSION_ITEM[reason],
    reason,
    slot,
    predicate,
    explanation: SUPPRESSION_EXPLANATION[reason],
  });

  // 1 — the master switch, and the permission the OS actually granted. A
  // desktop path with permission still "default" has never asked; either way
  // nothing can be shown, so nothing is claimed.
  if (!settings.desktopEnabled) return suppress(SUPPRESSED_REASON.ALERTS_OFF);
  if (context.permission !== undefined && context.permission !== "granted") {
    return suppress(SUPPRESSED_REASON.ALERTS_OFF);
  }

  // 2 — the per-slot switch.
  if (!settings.slotAlertsEnabled[slot]) return suppress(SUPPRESSED_REASON.SLOT_OFF);

  // 3 — your own message. Above the predicate on purpose: `messageTags` writes
  // the author's key as the first `p` tag, so every message "mentions" its
  // author and the predicate would happily return MENTION for your own words.
  if (me.length > 0 && event.pubkey.toLowerCase() === me) {
    return suppress(SUPPRESSED_REASON.SELF_AUTHORED);
  }

  // 4 — one shared seen-guard for every side effect (§10 item 33). Reconnect
  // replay overlaps live filters by five seconds and a mention arrives through
  // both the channel filter and the mention filter; a per-callback guard lets
  // the duplicate escape through the other path.
  if (context.deliveredEventIds?.has(event.id)) {
    return suppress(SUPPRESSED_REASON.ALREADY_DELIVERED);
  }

  // 5 — the first load is history. Notifying on it fires the entire backlog at
  // once, which is how somebody turns the product off on day one.
  if (context.initialLoad) return suppress(SUPPRESSED_REASON.INITIAL_LOAD);

  // 6 — and after a reconnect, so is anything older than this connection.
  if (
    context.subscriptionStartedAt !== undefined &&
    event.created_at < context.subscriptionStartedAt
  ) {
    return suppress(SUPPRESSED_REASON.BACKLOG_REPLAY);
  }

  // 7 — you are already looking at it. Opt out with "notify while viewing".
  if (
    !settings.notifyWhileViewing &&
    channelId !== null &&
    context.activeChannelId !== undefined &&
    context.activeChannelId !== null &&
    channelId === context.activeChannelId
  ) {
    return suppress(SUPPRESSED_REASON.VIEWING_CHANNEL);
  }

  // 10, hoisted — see the note above. A reaction is not news.
  if (!isNotifiableKind(event.kind, isDm)) {
    return suppress(SUPPRESSED_REASON.KIND_NOT_NOTIFIABLE);
  }

  // 8, 9, 11 — one call, one answer.
  const predicate = shouldNotifyForEvent(event, me, context.relationship, channelId);
  if (!predicate.notify) {
    return suppress(predicate.reason as SuppressedReasonName, predicate);
  }

  return {
    deliver: true,
    item: null,
    reason: predicate.reason,
    slot,
    predicate,
    explanation: DELIVERY_EXPLANATION[predicate.reason as NotifyReasonName],
  };
}

export const DELIVERY_EXPLANATION: Record<NotifyReasonName, string> = {
  [NOTIFY_REASON.BROADCAST_REPLY]: "It was sent to the whole channel.",
  [NOTIFY_REASON.MENTION]: "You were mentioned.",
  [NOTIFY_REASON.TOP_LEVEL]: "It is a new message in a channel you are in.",
  [NOTIFY_REASON.PARTICIPATED]: "You have replied in that thread.",
  [NOTIFY_REASON.FOLLOWED]: "You follow that thread.",
  [NOTIFY_REASON.AUTHORED]: "You started that thread.",
};

// ---------------------------------------------------------------------------
// Muting (§7.5)
// ---------------------------------------------------------------------------

/**
 * A mute store: one entry per target, each carrying *when* it was decided.
 *
 * The timestamp is not bookkeeping — it is what makes the store mergeable.
 * Mutes sync across devices (Buzz syncs them as a 30078 replaceable event), and
 * two devices that disagree have to converge on something. Without a per-entry
 * clock the only available answers are "whole-store last write wins" (one
 * device's stale copy silently unmutes six channels) or "union" (nothing can
 * ever be unmuted).
 */
export type MuteEntry = { muted: boolean; updatedAt: number };
export type MuteStore = { version: 1; channels: Record<string, MuteEntry> };

export const EMPTY_MUTE_STORE: MuteStore = Object.freeze({ version: 1, channels: {} });

/**
 * Parse a synced payload, or refuse the whole thing.
 *
 * `version === 1` exactly (§7.5) — a v2 store read as v1 is a store whose
 * meaning we are guessing at, and guessing here silently unmutes rooms.
 * Malformed *entries* are dropped individually, because one bad key should not
 * cost somebody every mute they have set.
 */
export function parseMutePayload(raw: unknown): MuteStore | null {
  if (typeof raw !== "object" || raw === null) return null;
  const input = raw as { version?: unknown; channels?: unknown };
  if (input.version !== 1) return null;
  const channels: Record<string, MuteEntry> = {};
  const source =
    typeof input.channels === "object" && input.channels !== null
      ? (input.channels as Record<string, unknown>)
      : {};
  for (const [id, value] of Object.entries(source)) {
    if (id.length === 0) continue;
    if (typeof value !== "object" || value === null) continue;
    const entry = value as { muted?: unknown; updatedAt?: unknown };
    if (typeof entry.muted !== "boolean") continue;
    if (typeof entry.updatedAt !== "number" || !Number.isFinite(entry.updatedAt)) continue;
    channels[id] = { muted: entry.muted, updatedAt: entry.updatedAt };
  }
  return { version: 1, channels };
}

/**
 * Merge two stores, last-write-wins **per channel**, local winning ties.
 *
 * Per channel rather than per store: the two sides are usually both partly
 * right — you muted #noise on your laptop and unmuted #ship on your phone — and
 * a whole-store winner throws one of those away. Local wins ties because a tie
 * means the same millisecond, and the device the person is holding is the one
 * whose intent is most recent in every sense that is not the clock.
 */
export function mergeMuteStores(local: MuteStore, remote: MuteStore): MuteStore {
  const channels: Record<string, MuteEntry> = { ...remote.channels };
  for (const [id, entry] of Object.entries(local.channels)) {
    const theirs = channels[id];
    if (!theirs || entry.updatedAt >= theirs.updatedAt) channels[id] = entry;
  }
  return { version: 1, channels };
}

/** The ids currently muted — the shape `NotifyRelationship` wants. */
export function mutedIdsOf(store: MuteStore): Set<string> {
  const out = new Set<string>();
  for (const [id, entry] of Object.entries(store.channels)) {
    if (entry.muted) out.add(id);
  }
  return out;
}

export function setMuted(
  store: MuteStore,
  id: string,
  muted: boolean,
  at: number,
): MuteStore {
  return { version: 1, channels: { ...store.channels, [id]: { muted, updatedAt: at } } };
}

// ---------------------------------------------------------------------------
// Formatting (§7.4)
// ---------------------------------------------------------------------------

/** §7.4: bodies longer than this are cut. */
export const NOTIFICATION_BODY_LIMIT = 140;

/**
 * A notification body: trimmed, never empty, never long.
 *
 * The ellipsis budget is spent from the limit (`slice(0, 137)`), not added to
 * it, so the rendered string is never longer than the limit it advertises —
 * which matters because the platform truncates too, and being truncated twice
 * loses the last real word.
 */
export function truncateNotificationBody(content: string, fallback: string): string {
  const trimmed = content.trim();
  if (trimmed.length === 0) return fallback;
  if (trimmed.length <= NOTIFICATION_BODY_LIMIT) return trimmed;
  return `${trimmed.slice(0, NOTIFICATION_BODY_LIMIT - 3).trimEnd()}...`;
}

/**
 * `"#name"`, or null when the channel is not known yet.
 *
 * Null rather than a placeholder, and the caller must degrade rather than wait:
 * the channel list can legitimately arrive after the first live event on a
 * fresh connection, and a notification held until a name resolves is a
 * notification that arrives after the person has already read the message.
 */
export function resolveNotificationChannelLabel(
  channelId: string | null,
  channels: readonly { channelId: string; name: string }[],
): string | null {
  if (!channelId) return null;
  const found = channels.find((channel) => channel.channelId === channelId);
  return found ? `#${found.name}` : null;
}

/** `"Ada in #ship"`, or just `"Ada"` when the room is not known. */
export function formatNotificationTitle(opts: {
  prefix: string;
  channelLabel?: string | null;
}): string {
  return opts.channelLabel ? `${opts.prefix} in ${opts.channelLabel}` : opts.prefix;
}

// ---------------------------------------------------------------------------
// The home badge (§7.5, §7.6 item 8)
// ---------------------------------------------------------------------------

/**
 * The home-badge rule, which is **not** the live rule.
 *
 * §7.5's table: badge items in a muted channel are skipped *unless* the item is
 * a mention. Note what is missing next to §7.1 step 1 — a broadcast does not
 * pierce a channel mute here, because the home feed classifies items into
 * `mention` and `needs_action` and has no broadcast category at all.
 *
 * Kept as its own function rather than folded into `decide` for exactly that
 * reason: the two rules genuinely differ, and a shared implementation with a
 * `surface` flag would read as one rule with an exception when it is two rules
 * that happen to agree most of the time.
 */
export function isBadgeItemVisible(
  item: { channelId: string | null; category: "mention" | "needs_action" },
  settings: NotificationSettings,
  mutedChannelIds: ReadonlySet<string>,
): boolean {
  if (!settings.homeBadgeEnabled) return false;
  if (item.category === "mention") return true;
  return item.channelId === null || !mutedChannelIds.has(item.channelId);
}
