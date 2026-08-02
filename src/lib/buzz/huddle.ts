// A huddle: who is in the call, what phase the client is in, and when it ends.
//
// Everything here is pure, and that is the point of the file rather than a
// stylistic preference. A huddle has two representations that must never
// disagree: the **log** (signed lifecycle events every participant can read)
// and the **client session** (the phase machine one browser is in). The server
// folds the log to decide whether to auto-end a call; the browser folds the
// same log to draw the roster; a test folds it to prove both. One
// implementation, three callers.
//
// ---------------------------------------------------------------------------
// What is ours and what is the provider's (00-decisions.md D6)
//
// Buzz's huddle is a room on its own relay's WebSocket carrying custom binary
// Opus frames. We do not have — and on Convex cannot have — a stateful audio
// server, so the audio path is a managed SFU behind an adapter
// (`src/components/chat/huddle/transport.ts`). **Nothing in this file knows
// that adapter exists.** Identity, the roster, who started it, who left and
// when it ended are ours and live on the log, which is why all of it keeps
// working with no provider wired at all: a huddle with no audio is a call
// nobody can hear, not a call that did not happen.
//
// ---------------------------------------------------------------------------
// The identity of a huddle
//
// Buzz mints a uuid, creates an ephemeral channel under it, and puts that uuid
// in every lifecycle event's content. We do neither: **a huddle is identified
// by the id of the event that announced it** — the same rule `channels.create`
// uses for a room, and for the same reasons. An event id is the SHA-256 of the
// event, so it is unique without a CSPRNG (a Convex mutation has none),
// unforgeable, and impossible for a client to collide on purpose. The roster
// deltas point back at it with an `e` tag, which is an indexed tag, so "every
// event of this huddle" is an index range rather than a scan.
//
// And no ephemeral channel is created. It would put a disposable room in
// everyone's rail, need a second copy of `channels.create`'s transaction, and
// buy only what the `e` tag already gives us: a name for the set of events
// belonging to one call.

// ---------------------------------------------------------------------------
// Kinds (04-huddle-media §1.2)
// ---------------------------------------------------------------------------
//
// Restated here rather than imported from `convex/buzz/_kinds.ts`, for the
// reason `src/lib/buzz/timeline.ts` states: that module reaches
// `@noble/curves`, a signing library the browser has no use for and should not
// download in order to draw a call. The duplication is the hazard the codebase
// warns about, so `tests/buzz-huddle.test.ts` pins every constant below against
// the registry and fails if the two ever drift.

/** Announced by the starter, in the **parent** channel. Its id is the huddle. */
export const KIND_HUDDLE_STARTED = 48100;
/** Relay-signed. The participant is in the `p` tag, never in `pubkey`. */
export const KIND_HUDDLE_PARTICIPANT_JOINED = 48101;
/** Relay-signed. Same shape as the join. */
export const KIND_HUDDLE_PARTICIPANT_LEFT = 48102;
/** Relay-signed. The call is over — nothing after it counts. */
export const KIND_HUDDLE_ENDED = 48103;
/** The voice-mode briefing agents read on joining. Signed by the starter. */
export const KIND_HUDDLE_GUIDELINES = 48106;
/** A reaction burst. Ephemeral by number: signed, fanned out, never stored. */
export const KIND_HUDDLE_REACTION = 24810;

/**
 * The four kinds a client subscribes to in order to know a huddle exists.
 *
 * In ascending order, which is also **causal** order (start < join < left <
 * end) — `compareHuddleEvents` relies on that, so a reordering here would
 * silently change how out-of-order delivery is resolved.
 */
export const HUDDLE_LIFECYCLE_KINDS: readonly number[] = [
  KIND_HUDDLE_STARTED,
  KIND_HUDDLE_PARTICIPANT_JOINED,
  KIND_HUDDLE_PARTICIPANT_LEFT,
  KIND_HUDDLE_ENDED,
];

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

/**
 * How long a huddle stays joinable without any further evidence (1 hour).
 *
 * Buzz's `HUDDLE_JOINABLE_WINDOW_SECONDS`, matching its ephemeral channel TTL.
 * It is the decay rule, and it exists because **the end event is the one event
 * that can be missing**: the last client leaves by closing a laptop lid, the
 * mutation never runs, and without this a room says "call in progress" forever
 * with a Join button that connects you to nobody. Read at fold time, so no cron
 * has to run and no row has to be swept.
 */
export const HUDDLE_JOINABLE_WINDOW_SECONDS = 3600;

/** Buzz's `MAX_HUDDLE_AGENTS`. Twenty machines in one call is already absurd. */
export const MAX_HUDDLE_AGENTS = 20;

/**
 * Buzz's `MAX_PEERS_PER_ROOM`. A soft cap on people, not a hard limit.
 *
 * Kept even though our audio is an SFU rather than a fan-out loop: the number
 * is about a conversation being followable, not about frame copies.
 */
export const MAX_HUDDLE_PARTICIPANTS = 25;

/** A reaction is an emoji or a shortcode, never a message. */
export const MAX_REACTION_LENGTH = 64;
/** Buzz clamps the sender name carried on a reaction to 48 characters. */
export const MAX_REACTION_SENDER_NAME = 48;
/** How many caption lines the transcript pane keeps. A pane, not an archive. */
export const MAX_TRANSCRIPT_LINES = 200;

// ---------------------------------------------------------------------------
// The client phase machine (§1.3)
// ---------------------------------------------------------------------------

/**
 * Six phases, and the two in the middle are the ones that carry their weight.
 *
 * `creating` and `connecting` are both "not in the call yet" and the bar draws
 * them identically, but they are different failures: a failed `creating` has to
 * clean up a huddle nobody joined, and a failed `connecting` has nothing to
 * clean up. Collapsing them would mean deciding which of those to do by
 * inspecting state that the failure may have destroyed.
 *
 * `connected` and `active` are the seam this whole phase is built around.
 * `connected` means **the log says you are in the call** — the roster shows
 * you, everyone can see you joined, the record is complete. `active` means the
 * audio transport also came up. With no provider wired, a huddle sits at
 * `connected` forever and every one of those facts is still true, which is
 * exactly why the split exists rather than a single `joined`.
 */
export type HuddlePhase =
  | "idle"
  | "creating"
  | "connecting"
  | "connected"
  | "active"
  | "leaving";

/** Phases in which the bar is on screen. */
export const HUDDLE_VISIBLE_PHASES: ReadonlySet<HuddlePhase> = new Set<HuddlePhase>([
  "creating",
  "connecting",
  "connected",
  "active",
  "leaving",
]);

/** Phases in which the log already holds your membership of the call. */
export const HUDDLE_JOINED_PHASES: ReadonlySet<HuddlePhase> = new Set<HuddlePhase>([
  "connected",
  "active",
]);

/** How the microphone is gated. There is no third mode. */
export type VoiceInputMode = "voice_activity" | "push_to_talk";

/**
 * One browser's session.
 *
 * Split deliberately into three groups, because they have three different
 * lifetimes and `resetPreservingGeneration` has to know which is which:
 *
 *   - **the call** (`phase`, `parentChannelId`, `huddleId`, `isCreator`): dies
 *     with the huddle.
 *   - **the counters**: survive everything. See below.
 *   - **the preferences** (`micMuted`, `speakerMuted`, `inputMode`, `gain`,
 *     devices): survive a huddle, because they describe the *machine* rather
 *     than the call. Somebody who muted their agent's voice in one call did not
 *     ask to hear it in the next one.
 */
export type HuddleSession = {
  phase: HuddlePhase;
  /** The room the huddle was announced in. */
  parentChannelId: string | null;
  /** The 48100's event id. Null until the log says which call this is. */
  huddleId: string | null;
  isCreator: boolean;

  /**
   * Bumped once per start/join **attempt**.
   *
   * Answers "does this async result still belong to the huddle that started
   * it?". Every await in the connect path is a window in which the person can
   * hang up and dial again — and a rejoin to the *same* room takes a new
   * generation, so an id comparison alone would not catch it. Without this,
   * a slow first attempt's success commits over the second attempt's state, or
   * its failure tears down a call that is already up.
   */
  huddleGeneration: number;

  /**
   * Bumped on every teardown, and on every capture-pipeline replacement.
   *
   * Answers "may this background producer still publish?". A caption tap, a
   * level meter and a speaking-detector all outlive the frame that cancelled
   * them by however long their current chunk takes; each captures this number
   * when it starts and stops the moment it differs. Without it a torn-down
   * huddle posts one more caption into a room the person has already left —
   * the failure that is invisible in testing because it needs a real audio
   * chunk in flight at the exact moment of hangup.
   *
   * Two counters and not one, because they answer different questions at
   * different rates: a rejoin bumps the first and not the second (the
   * pipelines are the same ones), and replacing the capture tap mid-call bumps
   * the second and not the first (it is the same call).
   */
  sessionGeneration: number;

  /** The local mute. In push-to-talk it overrides the gate — see §1.16. */
  micMuted: boolean;
  /**
   * Synthesized agent speech, silenced.
   *
   * The closest thing to "deafen" that exists here, and it is deliberately not
   * one: **no control mutes another human** (§1.21). Naming it `speakerMuted`
   * rather than `deafened` is the difference.
   */
  speakerMuted: boolean;
  inputMode: VoiceInputMode;
  /** Whether the push-to-talk key is down right now. Never persisted. */
  pushToTalkHeld: boolean;
  /** Input gain, 0..1, applied live. */
  gain: number;
  inputDeviceId: string | null;
  outputDeviceId: string | null;

  /** Captions on. See `shouldAutoEnableTranscription` for who turns it on. */
  transcriptionEnabled: boolean;
  /**
   * Has the person touched the caption control in this session?
   *
   * The auto-enable rule must never override a deliberate choice, and "off
   * because I turned it off" is indistinguishable from "off because it has
   * always been off" without remembering this.
   */
  transcriptionUserControlled: boolean;
};

export const IDLE_HUDDLE_SESSION: HuddleSession = {
  phase: "idle",
  parentChannelId: null,
  huddleId: null,
  isCreator: false,
  huddleGeneration: 0,
  sessionGeneration: 0,
  micMuted: false,
  speakerMuted: false,
  inputMode: "voice_activity",
  pushToTalkHeld: false,
  gain: 1,
  inputDeviceId: null,
  outputDeviceId: null,
  transcriptionEnabled: false,
  transcriptionUserControlled: false,
};

/**
 * The things that happen to a session.
 *
 * `confirm_media` is the only one a *transport* raises, and it is separate from
 * `connected` for the reason the phase split exists: the log and the audio come
 * up independently, and with the null adapter the second one never does.
 */
export type HuddleAction =
  | { type: "start"; parentChannelId: string }
  | { type: "join"; parentChannelId: string; huddleId: string }
  /** The log write landed: this is which huddle it turned out to be. */
  | { type: "joined"; huddleId: string }
  /** The transport reported a live audio room. */
  | { type: "confirm_media" }
  | { type: "leave" }
  | { type: "teardown" }
  /** Replace the capture pipeline (device change, mode change). */
  | { type: "invalidate_capture" }
  | { type: "set_mic_muted"; muted: boolean }
  | { type: "set_speaker_muted"; muted: boolean }
  | { type: "set_input_mode"; mode: VoiceInputMode }
  | { type: "set_push_to_talk"; held: boolean }
  | { type: "set_gain"; gain: number }
  | { type: "set_input_device"; deviceId: string | null }
  | { type: "set_output_device"; deviceId: string | null }
  /** `byUser` false is the auto-enable rule; true records a deliberate choice. */
  | { type: "set_transcription"; enabled: boolean; byUser: boolean };

/**
 * A refusal is a value, not an exception — the same choice `turn.ts` made.
 *
 * `benign` is Buzz's `isRedundantHuddlePhaseError`: pressing Join twice, or a
 * provider remount replaying a start, is a refusal the UI must **swallow**
 * rather than show. A caller that cannot tell the two apart either shows an
 * error for a double click or hides a real failure, and both are worse than
 * carrying one boolean.
 */
export type HuddleTransition =
  | { ok: true; session: HuddleSession }
  | { ok: false; reason: string; benign: boolean };

function redundant(phase: HuddlePhase): HuddleTransition {
  // Buzz's exact sentence, because its frontend matches on it. Ours does not
  // need to — `benign` carries the same fact structurally — but keeping the
  // words means a log line from either implementation reads the same.
  return { ok: false, reason: `cannot start huddle: already in phase ${phase}`, benign: true };
}

/**
 * The one place a session changes phase.
 *
 * The legal edges, and nothing else:
 *
 *   idle → creating (start) | connecting (join)
 *   creating → connected | leaving        connecting → connected | leaving
 *   connected → active | leaving          active → leaving
 *   leaving → idle
 *
 * Three refusals worth naming because each is a real bug rather than a
 * completeness exercise:
 *
 *   - **Starting while in a call.** Buzz's benign error. The second call would
 *     take the microphone from the first and leave the first live on the log
 *     with nobody attached.
 *   - **`confirm_media` before `connected`.** A transport that came up before
 *     the log write landed would put the bar in `active` with no huddle id, so
 *     Leave would have nothing to publish and the person would be stuck in a
 *     call they cannot leave.
 *   - **`active` → `connected`.** A phase never goes backwards. A transport
 *     that drops re-reports through the error channel; demoting the phase would
 *     make the bar redraw its whole control cluster mid-call, and would look
 *     exactly like a fresh join to anything watching the phase.
 */
export function nextHuddleSession(
  session: HuddleSession,
  action: HuddleAction,
): HuddleTransition {
  switch (action.type) {
    case "start":
      if (session.phase !== "idle") return redundant(session.phase);
      return {
        ok: true,
        session: {
          ...session,
          phase: "creating",
          parentChannelId: action.parentChannelId,
          huddleId: null,
          isCreator: true,
          huddleGeneration: session.huddleGeneration + 1,
          pushToTalkHeld: false,
        },
      };

    case "join":
      if (session.phase !== "idle") return redundant(session.phase);
      return {
        ok: true,
        session: {
          ...session,
          phase: "connecting",
          parentChannelId: action.parentChannelId,
          huddleId: action.huddleId,
          isCreator: false,
          huddleGeneration: session.huddleGeneration + 1,
          pushToTalkHeld: false,
        },
      };

    case "joined":
      if (session.phase !== "creating" && session.phase !== "connecting") {
        return {
          ok: false,
          reason: `cannot connect a huddle from phase ${session.phase}`,
          benign: session.phase === "connected" || session.phase === "active",
        };
      }
      return { ok: true, session: { ...session, phase: "connected", huddleId: action.huddleId } };

    case "confirm_media":
      // Idempotent: a transport that reports "up" twice is a transport that
      // reconnected, not a state change.
      if (session.phase === "active") return { ok: true, session };
      if (session.phase !== "connected") {
        return {
          ok: false,
          reason: `audio cannot be confirmed from phase ${session.phase}`,
          benign: false,
        };
      }
      return { ok: true, session: { ...session, phase: "active" } };

    case "leave":
      if (session.phase === "idle") {
        return { ok: false, reason: "not in a huddle", benign: true };
      }
      if (session.phase === "leaving") return { ok: true, session };
      return { ok: true, session: { ...session, phase: "leaving" } };

    case "teardown":
      return { ok: true, session: resetPreservingGeneration(session) };

    case "invalidate_capture":
      // A no-op on the phase, and that is the whole point: replacing the
      // capture tap must invalidate producers *without* looking like a rejoin.
      return { ok: true, session: { ...session, sessionGeneration: session.sessionGeneration + 1 } };

    case "set_mic_muted":
      return { ok: true, session: { ...session, micMuted: action.muted } };

    case "set_speaker_muted":
      return { ok: true, session: { ...session, speakerMuted: action.muted } };

    case "set_input_mode":
      if (session.inputMode === action.mode) return { ok: true, session };
      // Switching mode replaces the capture gate, so the counter moves with it
      // — Buzz restarts its whole STT pipeline here for the same reason (the
      // mode is captured at construction). `pushToTalkHeld` resets so that
      // leaving push-to-talk with the key down cannot leave the mic open.
      return {
        ok: true,
        session: {
          ...session,
          inputMode: action.mode,
          pushToTalkHeld: false,
          sessionGeneration: session.sessionGeneration + 1,
        },
      };

    case "set_push_to_talk":
      // **Ignored outside push-to-talk mode.** Buzz does not forward the key to
      // its worklet in voice-activity mode at all, so a stray Ctrl+Space cannot
      // mute somebody who never opted into a key.
      if (session.inputMode !== "push_to_talk") return { ok: true, session };
      return { ok: true, session: { ...session, pushToTalkHeld: action.held } };

    case "set_gain":
      return { ok: true, session: { ...session, gain: clampGain(action.gain) } };

    case "set_input_device":
      return {
        ok: true,
        session: {
          ...session,
          inputDeviceId: action.deviceId,
          sessionGeneration: session.sessionGeneration + 1,
        },
      };

    case "set_output_device":
      return { ok: true, session: { ...session, outputDeviceId: action.deviceId } };

    case "set_transcription":
      return {
        ok: true,
        session: {
          ...session,
          transcriptionEnabled: action.enabled,
          transcriptionUserControlled:
            session.transcriptionUserControlled || action.byUser,
        },
      };
  }
}

/** 0..1, and never NaN — a slider that reports NaN silences the microphone. */
export function clampGain(gain: number): number {
  if (!Number.isFinite(gain)) return 1;
  return Math.min(1, Math.max(0, gain));
}

/**
 * Back to idle, keeping both counters and every preference.
 *
 * Resetting the counters would be the bug they exist to prevent: a stale
 * producer from the call that just ended captured generation *n*, and a fresh
 * session that starts again at *n* would look current to it.
 */
export function resetPreservingGeneration(session: HuddleSession): HuddleSession {
  return {
    ...IDLE_HUDDLE_SESSION,
    huddleGeneration: session.huddleGeneration,
    sessionGeneration: session.sessionGeneration + 1,
    micMuted: session.micMuted,
    speakerMuted: session.speakerMuted,
    inputMode: session.inputMode,
    gain: session.gain,
    inputDeviceId: session.inputDeviceId,
    outputDeviceId: session.outputDeviceId,
  };
}

/**
 * Does this async result still belong to the call that asked for it?
 *
 * Both halves are needed. The generation catches "you hung up and dialled the
 * same room again"; the id catches "you hung up and dialled a *different* room
 * fast enough that only one attempt has completed". Checking either alone
 * lets one of those commit into the other's session.
 */
export function ownsHuddleLifetime(
  session: HuddleSession,
  huddleId: string | null,
  generation: number,
): boolean {
  if (session.huddleGeneration !== generation) return false;
  if (huddleId === null) return true;
  return session.huddleId === null || session.huddleId === huddleId;
}

/** May a producer that captured this session generation still publish? */
export function ownsSession(session: HuddleSession, generation: number): boolean {
  return session.sessionGeneration === generation;
}

/**
 * Is the microphone actually sending, right now?
 *
 * Derived rather than stored, because it is the conjunction of four things that
 * change independently — and a stored boolean is how a mute button ends up
 * disagreeing with the mute state. **Mute outranks push-to-talk**, which is why
 * the bar labels it "Force mute (overrides PTT)" in that mode: a person who
 * pressed mute has said something stronger than a person holding a key.
 */
export function isTransmitting(session: HuddleSession, mediaLive: boolean): boolean {
  if (!mediaLive) return false;
  if (!HUDDLE_JOINED_PHASES.has(session.phase)) return false;
  if (session.micMuted) return false;
  if (session.inputMode === "push_to_talk") return session.pushToTalkHeld;
  return true;
}

/**
 * Should captions turn themselves on because a machine is in the call? (§1.13)
 *
 * True **only** on the disabled→enabled transition, so a caller starts the
 * pipeline exactly once. Two rules that look small and are not: a person who
 * has touched the control this session is never overridden, and removing the
 * last agent deliberately does *not* turn it back off — an automatic on is a
 * suggestion, an automatic off would delete text somebody is reading.
 */
export function shouldAutoEnableTranscription(
  session: HuddleSession,
  agentPresent: boolean,
): boolean {
  if (!agentPresent) return false;
  if (session.transcriptionEnabled) return false;
  if (session.transcriptionUserControlled) return false;
  return true;
}

// ---------------------------------------------------------------------------
// The log, folded (§1.17)
// ---------------------------------------------------------------------------

/** A lifecycle event, in the shape both the log and the client hold it. */
export type HuddleLogEvent = {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
};

export type HuddleParticipant = {
  pubkey: string;
  /** Recorded on the join event, never looked up. See `participantIsAgent`. */
  isAgent: boolean;
  /** Seconds — the `created_at` of the join that put them in. */
  joinedAt: number;
};

/** Why a huddle is over, or null while it is live. */
export type HuddleEndReason =
  /** A 48103 was published. */
  | "ended"
  /** No 48103, but it started longer ago than the joinable window. */
  | "expired";

export type HuddleSnapshot = {
  huddleId: string;
  parentChannelId: string;
  /** The starter's pubkey, or null when the 48100 fell out of the window. */
  startedByPubkey: string | null;
  /** Seconds. */
  startedAt: number;
  /** Seconds, or null. */
  endedAt: number | null;
  live: boolean;
  endReason: HuddleEndReason | null;
  participants: HuddleParticipant[];
  /**
   * How many are in it, floored at 1 for an inferred huddle.
   *
   * Not `participants.length`: a huddle reconstructed from a join whose start
   * has scrolled out of the read window has an incomplete roster, and drawing
   * "0 people" on a call somebody is demonstrably in is worse than drawing a
   * low number.
   */
  participantCount: number;
  /** True when no 48100 was seen and the huddle was inferred from a delta. */
  inferred: boolean;
};

/**
 * Causal order: time, then kind, then id.
 *
 * The kind tie-break is what makes the fold survive out-of-order delivery and
 * reconnect replay — start, join, left and end published inside one second (a
 * short call, or a batch replay) must be applied in the order they can only
 * have happened in. The id tie-break is not cosmetic either: without a total
 * order, two clients folding the same events can reach different rosters.
 */
export function compareHuddleEvents(left: HuddleLogEvent, right: HuddleLogEvent): number {
  return (
    left.created_at - right.created_at ||
    left.kind - right.kind ||
    left.id.localeCompare(right.id)
  );
}

function tagValue(event: HuddleLogEvent, name: string): string | undefined {
  const found = event.tags.find((tag) => tag[0] === name);
  return found?.[1] || undefined;
}

/**
 * Whose join or leave is this?
 *
 * 48101–48103 are **relay-signed**, so `event.pubkey` is the community relay
 * and never the participant — that is the entire point of relay-signing them
 * (a member must not be able to write "Ada left"). The identity lives in the
 * `p` tag. A consumer that reads `pubkey` here shows the relay in the roster,
 * which is the single most likely way to get this wrong, so it is one function.
 */
export function participantPubkeyOf(event: HuddleLogEvent): string {
  return tagValue(event, "p") ?? event.pubkey;
}

/**
 * Is the principal that joined a machine?
 *
 * Read off the join event's `role` tag rather than resolved through the key
 * table, and that is deliberate: the auto-end rule counts humans, and a rule
 * evaluated from the log alone must not depend on a lookup. A person whose
 * account is later deleted must not quietly become a bot and strand a call
 * open, and the pure fold must reach the same answer in a browser as it does
 * in a mutation.
 */
export function participantIsAgent(event: HuddleLogEvent): boolean {
  return tagValue(event, "role") === "bot";
}

/** Which huddle does a delta belong to? The `e` tag naming its 48100. */
export function huddleIdOf(event: HuddleLogEvent): string | undefined {
  if (event.kind === KIND_HUDDLE_STARTED) return event.id;
  return tagValue(event, "e");
}

type Draft = {
  huddleId: string;
  parentChannelId: string;
  startedByPubkey: string | null;
  startedAt: number;
  endedAt: number | null;
  inferred: boolean;
  participants: Map<string, HuddleParticipant>;
};

/**
 * Every huddle these events describe, live or over.
 *
 * A full reconstruction on every call rather than an incremental reducer, which
 * is Buzz's choice and is the right one for a reason that is not performance:
 * an incremental reducer has to be *correct about deletions and replays*, and
 * a relay redelivering a batch after a reconnect is the normal case, not the
 * edge case. Folding the whole seen set is idempotent by construction.
 *
 * Two rules earn their place:
 *
 *   - **An ended huddle stays ended.** A 48102 for somebody who left before the
 *     end can arrive after it (they are published in one transaction but read
 *     back in whatever order a page returns), and applying it would resurrect a
 *     phantom call with one person in it.
 *   - **A delta with no start infers the huddle.** The read window is 100
 *     events; a long call's 48100 scrolls out of it. Refusing to draw the call
 *     because its announcement is old is how a room stops showing a huddle that
 *     is very much happening.
 */
export function foldHuddles(
  events: readonly HuddleLogEvent[],
  now: number,
): HuddleSnapshot[] {
  const nowSecs = Math.floor(now / 1000);
  const drafts = new Map<string, Draft>();

  for (const event of [...events].sort(compareHuddleEvents)) {
    if (!HUDDLE_LIFECYCLE_KINDS.includes(event.kind)) continue;
    const huddleId = huddleIdOf(event);
    if (!huddleId) continue;
    const parentChannelId = tagValue(event, "h");
    if (!parentChannelId) continue;

    let draft = drafts.get(huddleId);
    if (!draft) {
      draft = {
        huddleId,
        parentChannelId,
        startedByPubkey: event.kind === KIND_HUDDLE_STARTED ? event.pubkey : null,
        startedAt: event.created_at,
        endedAt: null,
        inferred: event.kind !== KIND_HUDDLE_STARTED,
        participants: new Map(),
      };
      drafts.set(huddleId, draft);
    } else if (event.kind === KIND_HUDDLE_STARTED) {
      // The start arrived after a delta (out-of-order delivery). It is the
      // authority on who started it and when, so it fills in what was inferred.
      draft.startedByPubkey = event.pubkey;
      draft.startedAt = event.created_at;
      draft.inferred = false;
    }

    // Nothing after the end counts. Ordered first, so a 48102 that sorts after
    // a 48103 in the same second cannot reopen the call either.
    if (draft.endedAt !== null) continue;

    if (event.kind === KIND_HUDDLE_PARTICIPANT_JOINED) {
      const pubkey = participantPubkeyOf(event);
      draft.participants.set(pubkey, {
        pubkey,
        isAgent: participantIsAgent(event),
        joinedAt: event.created_at,
      });
    } else if (event.kind === KIND_HUDDLE_PARTICIPANT_LEFT) {
      draft.participants.delete(participantPubkeyOf(event));
    } else if (event.kind === KIND_HUDDLE_ENDED) {
      draft.endedAt = event.created_at;
      draft.participants.clear();
    }
  }

  return [...drafts.values()]
    .map((draft) => finish(draft, nowSecs))
    .sort((left, right) => right.startedAt - left.startedAt || left.huddleId.localeCompare(right.huddleId));
}

function finish(draft: Draft, nowSecs: number): HuddleSnapshot {
  const expired = nowSecs - draft.startedAt > HUDDLE_JOINABLE_WINDOW_SECONDS;
  const endReason: HuddleEndReason | null =
    draft.endedAt !== null ? "ended" : expired ? "expired" : null;
  const participants = [...draft.participants.values()].sort(
    (left, right) => left.joinedAt - right.joinedAt || left.pubkey.localeCompare(right.pubkey),
  );
  return {
    huddleId: draft.huddleId,
    parentChannelId: draft.parentChannelId,
    startedByPubkey: draft.startedByPubkey,
    startedAt: draft.startedAt,
    endedAt: draft.endedAt,
    live: endReason === null,
    endReason,
    participants: endReason === null ? participants : [],
    participantCount:
      endReason !== null
        ? 0
        : draft.inferred
          ? Math.max(participants.length, 1)
          : participants.length,
    inferred: draft.inferred,
  };
}

/** The live huddle in a room, if there is one. Newest wins. */
export function liveHuddle(snapshots: readonly HuddleSnapshot[]): HuddleSnapshot | null {
  return snapshots.find((snapshot) => snapshot.live) ?? null;
}

/** One snapshot by id, live or not — what a timeline card is drawn from. */
export function huddleById(
  snapshots: readonly HuddleSnapshot[],
  huddleId: string,
): HuddleSnapshot | null {
  return snapshots.find((snapshot) => snapshot.huddleId === huddleId) ?? null;
}

export function humansIn(snapshot: HuddleSnapshot): HuddleParticipant[] {
  return snapshot.participants.filter((participant) => !participant.isAgent);
}

export function agentsIn(snapshot: HuddleSnapshot): HuddleParticipant[] {
  return snapshot.participants.filter((participant) => participant.isAgent);
}

export function isInHuddle(snapshot: HuddleSnapshot, pubkey: string): boolean {
  return snapshot.participants.some((participant) => participant.pubkey === pubkey);
}

/**
 * Does this person leaving end the call? (§1.6)
 *
 * The rule: a huddle with no humans left in it is over, so the last human out
 * ends it, removes the machines and closes the record. Agents alone in a call
 * is not a call — it is two processes holding a room open that nobody can hear.
 *
 * **The default is "no".** Buzz defaults its human count to 2 rather than 1 on
 * a fetch failure, on the grounds that a transient error must never end
 * everybody else's huddle; ours reaches the same place structurally, by
 * refusing to end a call whose roster we could not reconstruct at all. So a
 * null snapshot, a huddle already over, or a leaver who is not in the roster
 * all answer false. Wrongly ending a call is unrecoverable and happens to
 * everyone in it; wrongly leaving one open decays on its own within the
 * joinable window.
 */
export function shouldAutoEnd(
  snapshot: HuddleSnapshot | null,
  leaverPubkey: string,
): boolean {
  if (!snapshot || !snapshot.live) return false;
  if (!isInHuddle(snapshot, leaverPubkey)) return false;
  return humansIn(snapshot).every((participant) => participant.pubkey === leaverPubkey);
}

// ---------------------------------------------------------------------------
// Reactions and captions
// ---------------------------------------------------------------------------

/** A reaction, as it rides the room's realtime channel. */
export type HuddleReaction = {
  huddleId: string;
  emoji: string;
  pubkey: string;
  senderName: string;
  at: number;
};

/**
 * A caption line.
 *
 * Deliberately **not** an event. There is no caption kind in the registry and
 * there should not be one: a durable record of everything said in a call is a
 * governance decision nobody made, and Buzz's own list of what a huddle does
 * not have ends with "no recording". So captions ride the room's realtime
 * channel exactly as typing does, are kept in memory for the length of the
 * call, and are gone when it ends. The pane says so rather than implying an
 * archive that does not exist.
 */
export type HuddleCaption = {
  huddleId: string;
  pubkey: string;
  name: string;
  isAgent: boolean;
  text: string;
  at: number;
};

/** Clamp a reaction to something that is an emoji rather than a message. */
export function normalizeReaction(emoji: string): string | null {
  const trimmed = emoji.trim();
  if (!trimmed) return null;
  const clipped = [...trimmed].slice(0, MAX_REACTION_LENGTH).join("");
  return clipped || null;
}

export function normalizeSenderName(name: string): string {
  return [...name.trim()].slice(0, MAX_REACTION_SENDER_NAME).join("");
}

/**
 * Append a caption, bounded.
 *
 * Newest last, capped by dropping the oldest — a pane, not an archive, and a
 * transcript that grows without bound in a two-hour call is a tab that dies.
 */
export function appendCaption(
  lines: readonly HuddleCaption[],
  line: HuddleCaption,
): HuddleCaption[] {
  const next = [...lines, line];
  return next.length > MAX_TRANSCRIPT_LINES ? next.slice(next.length - MAX_TRANSCRIPT_LINES) : next;
}
