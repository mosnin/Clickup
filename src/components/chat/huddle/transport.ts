"use client";

// The audio transport: an interface, and no provider wired.
//
// This file is the seam 00-decisions.md D6 created, and it exists in its own
// module so that the seam is obvious rather than buried in a component. Buzz
// carries huddle audio on its own relay's WebSocket with a custom binary Opus
// frame; that needs a stateful audio server, which Convex is not. We resolved
// it as a **managed SFU carrying audio, with identity, the roster and every
// lifecycle event staying ours on the log** — so the SFU is a pipe for frames,
// never the source of truth for who is in the room, and swapping provider (or
// replacing it with our own service) changes exactly one implementation of
// `HuddleTransport`.
//
// **No provider is wired here, and none is faked.** `NULL_HUDDLE_TRANSPORT`
// reports honestly that voice is not configured and refuses to join an audio
// room. That is the whole of its behaviour, and it is deliberate: a mute button
// that mutes nothing, a device list that selects nothing, a level meter driven
// by a random number — each of those is worse than a control that says it
// cannot work yet, because a person cannot tell a fake control from a broken
// one, and after one call they stop trusting the real ones too.
//
// What the null adapter costs, exactly: nobody can hear anybody. What it does
// **not** cost, because none of it is downstream of audio: starting a huddle,
// joining one, seeing who is in it, seeing who started it, leaving, the last
// human auto-ending it, reactions, captions posted by an agent, adding an agent
// to the call, and the whole record afterwards. All of that is signed events on
// the log and works with nothing configured at all.
//
// ---------------------------------------------------------------------------
// What a provider must implement, and nothing more
//
// Four verbs — join a room, publish audio, subscribe to peers, leave — plus the
// handful of local controls that can only be honoured where the audio graph
// actually is. Notably **absent**, and absent on purpose (04-huddle-media
// §1.21): no screen share, no video, no recording, and no "deafen". The
// speaker control silences *synthesized agent speech* only; there is no method
// here that mutes another human, so no implementation can grow one by accident.

import { createContext, useContext } from "react";

/** A peer in the audio room, as the transport sees them. */
export type HuddleTransportPeer = {
  /** The participant's Chat pubkey — the same identity the log's roster uses. */
  pubkey: string;
};

/**
 * What a transport tells the session while a call is up.
 *
 * Every callback is optional to *implement* and mandatory to *tolerate*: a
 * provider that cannot detect speech simply never calls `onSpeaking`, and the
 * UI draws no speaking ring rather than a wrong one.
 */
export type HuddleTransportEvents = {
  /** The audio room's membership changed. Advisory — the log is authoritative. */
  onPeers?: (peers: HuddleTransportPeer[]) => void;
  /**
   * Who has produced non-silence in the last window.
   *
   * Buzz emits this every 500 ms from **non-DTX frames only**, so comfort noise
   * never lights a speaker. A provider that cannot distinguish them should
   * rather not call this at all than light everybody.
   */
  onSpeaking?: (pubkeys: readonly string[]) => void;
  /** Local input level, 0..1, for the meter. Gated below the noise floor. */
  onLocalLevel?: (level: number) => void;
  /** A recognized line of local speech, for the transcript pane. */
  onCaption?: (text: string) => void;
  /** The audio path dropped. The huddle itself is unaffected — see the bar. */
  onDisconnected?: (reason: string) => void;
};

export type HuddleJoinRequest = {
  /** The huddle's id — the id of the 48100 that announced it. */
  huddleId: string;
  /** The room it was announced in, which is the tenancy boundary. */
  parentChannelId: string;
  /** The joiner's own Chat pubkey. A provider must publish under this identity. */
  pubkey: string;
  displayName: string;
};

/**
 * A live audio room. Every method is local to this participant.
 *
 * `setMicrophoneEnabled` is the **mute**, and it is a method rather than a flag
 * for the reason this whole file exists: mute has to reach the audio graph or
 * it is a lie. `setTransmitting` is the push-to-talk gate, which is separate
 * because mute outranks it (§1.16: "Force mute (overrides PTT)").
 */
export type HuddleRoom = {
  setMicrophoneEnabled(enabled: boolean): Promise<void>;
  setTransmitting(active: boolean): void;
  setInputGain(gain: number): void;
  setInputDevice(deviceId: string | null): Promise<void>;
  setOutputDevice(deviceId: string | null): Promise<void>;
  /** Silence synthesized agent speech. The only thing near "deafen" that exists. */
  setAgentSpeechEnabled(enabled: boolean): Promise<void>;
  /** Turn the local speech-to-text tap on or off. */
  setCaptionsEnabled(enabled: boolean): Promise<void>;
  leave(): Promise<void>;
};

/** What a given provider can actually do, so the UI disables the rest. */
export type HuddleTransportCapabilities = {
  microphone: boolean;
  deviceSelection: boolean;
  captions: boolean;
  agentSpeech: boolean;
};

export type HuddleTransport = {
  /** Stable id for logs and tests: `"null"`, `"livekit"`, `"daily"`, … */
  readonly id: string;
  /** Human name for the one sentence the bar shows. */
  readonly label: string;
  readonly capabilities: HuddleTransportCapabilities;
  /**
   * Why this transport cannot carry audio, in a sentence shown **verbatim**.
   *
   * Null when it can. A string here is not an error state to be recovered from
   * — it is the honest description of a deployment, and the bar renders it
   * beside a call that is otherwise entirely real.
   */
  readonly unavailableReason: string | null;
  join(request: HuddleJoinRequest, events: HuddleTransportEvents): Promise<HuddleRoom>;
};

/** Thrown by a transport that cannot carry audio. Carries the sentence. */
export class HuddleTransportUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "HuddleTransportUnavailable";
  }
}

/**
 * The sentence a deployment with no provider shows.
 *
 * Written to say what *is* working as well as what is not, because "voice is
 * not configured" on its own reads as "this huddle is broken" — and it is not:
 * the call, the roster and the record are live and correct.
 */
export const VOICE_NOT_CONFIGURED =
  "Voice is not configured on this deployment, so nobody can be heard. The huddle itself is live: the roster, who started it and when it ends are all on the log.";

/**
 * The transport that admits it cannot carry audio.
 *
 * `join` **rejects** rather than returning a room whose methods do nothing. A
 * no-op room would put the session into `active`, light every control, and let
 * a person spend a call believing they were unmuted. Rejecting keeps the
 * session at `connected` — which is exactly the phase that means "the log says
 * you are in the call and the audio is not up" — and the bar says why.
 */
export const NULL_HUDDLE_TRANSPORT: HuddleTransport = {
  id: "null",
  label: "No voice provider",
  capabilities: {
    microphone: false,
    deviceSelection: false,
    captions: false,
    agentSpeech: false,
  },
  unavailableReason: VOICE_NOT_CONFIGURED,
  async join() {
    throw new HuddleTransportUnavailable(VOICE_NOT_CONFIGURED);
  },
};

/**
 * The transport in force.
 *
 * A context with the null adapter as its default, so mounting the bar without a
 * provider is a supported, honest state rather than a crash — and wiring a real
 * SFU later is one `<HuddleTransportContext.Provider>` at the root of `/chat`
 * and one implementation of the interface above. Nothing else in this folder
 * changes, which is the property the seam exists to have.
 */
export const HuddleTransportContext =
  createContext<HuddleTransport>(NULL_HUDDLE_TRANSPORT);

export function useHuddleTransport(): HuddleTransport {
  return useContext(HuddleTransportContext);
}

/** Can this transport carry audio at all? One question, one answer. */
export function transportCanCarryAudio(transport: HuddleTransport): boolean {
  return transport.unavailableReason === null && transport.capabilities.microphone;
}
