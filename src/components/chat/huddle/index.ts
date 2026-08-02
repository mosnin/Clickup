// Huddles — the one import surface.
//
// Wiring, in three lines, for whoever composes the room (nothing in this folder
// reaches into the shell or the transcript, so the surfaces that own those
// files stay theirs):
//
//   1. Wrap the room in
//      `<HuddleProvider scope={scope} channelId={channelId} selfPubkey={pubkey} selfName={name}>`.
//      One provider per room; it holds the phase machine and the realtime
//      subscription, and it subscribes only while a call is up.
//   2. Render `<HuddleStartButton />` in the room header, and `<HuddleBar />`
//      immediately above the composer. The bar returns null unless a call is
//      up, so it can be mounted unconditionally.
//   3. Render `<HuddleCard eventId={event.id} />` for a kind-48100 row —
//      `src/lib/buzz/timeline.ts` already treats that kind as content, so the
//      row exists and this is what goes in it.
//
// **The audio transport is a seam with no provider wired.** By default
// `NULL_HUDDLE_TRANSPORT` is in force: it reports honestly that voice is not
// configured and refuses to join an audio room, which leaves the session at
// `connected` — the phase that means "the log says you are in the call and the
// audio is not up". Everything that is on the log keeps working: who started
// it, who is in it, joining, leaving, the last human auto-ending it, reactions,
// captions written by an agent, adding an agent, and the whole record
// afterwards. To wire a real SFU, implement `HuddleTransport` and put it in
// `HuddleTransportContext`; nothing else in this folder changes.

export {
  HuddleProvider,
  useHuddle,
  useHuddleOrNull,
  type HuddleContextValue,
  type HuddleRosterEntry,
} from "./huddle-provider";
export { HuddleBar } from "./huddle-bar";
export { HuddleCard, HuddleStartButton, huddleCardStatus } from "./huddle-card";
export { MicControls, SpeakerControls, useAudioDevices, PUSH_TO_TALK_HINT } from "./controls";
export { ParticipantsControl, ParticipantStrip, pubkeyTint } from "./participants";
export { ReactionBurst, ReactionControl, HUDDLE_REACTIONS } from "./reactions";
export { TranscriptPane, TranscriptToggle } from "./transcript-pane";
export { AddAgentControl } from "./add-agent";
export {
  HuddleTransportContext,
  HuddleTransportUnavailable,
  NULL_HUDDLE_TRANSPORT,
  VOICE_NOT_CONFIGURED,
  transportCanCarryAudio,
  useHuddleTransport,
  type HuddleJoinRequest,
  type HuddleRoom,
  type HuddleTransport,
  type HuddleTransportCapabilities,
  type HuddleTransportEvents,
  type HuddleTransportPeer,
} from "./transport";
