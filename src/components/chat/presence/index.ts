// Presence, typing and status — the one import surface.
//
// Wiring, in three lines, for whoever composes the room (none of these files
// reach into the shell or the transcript themselves, so that the surfaces that
// own those files stay theirs):
//
//   1. Wrap the room (or the shell) in `<PresenceProvider scope={scope} seed={members} />`
//      and call `useMyPresence(scope, pubkey)` once beside it. One subscription
//      and one heartbeat for the whole surface.
//   2. Draw `<PresenceRow actorId={…} />` in the member list and DM rail, or
//      `<PresenceAvatarDot status={…} />` on any avatar you already render.
//   3. Call `useRoomTyping({…})` in the room, feed `notifyTyping` from the
//      composer's `onChange` and `notifyMessageSent` from its send callback,
//      and render `<TypingLine typists={…} />` between transcript and composer.
//
// `MyPresenceControl` is the profile-card popover: the three preferences and
// the status editor.

export {
  PresenceDot,
  PresenceAvatarDot,
  PresenceBadge,
  StatusEmoji,
} from "./presence-dot";
export {
  PresenceProvider,
  useCommunityRoster,
  useMyPresence,
  useMyPubkey,
  useRoster,
  type MyPresence,
  type RosterState,
} from "./presence-provider";
export { PresenceRow, MyPresenceControl } from "./presence-row";
export { StatusEditor } from "./status-editor";
export { TypingLine, splitTypists } from "./typing-line";
export { useRoomTyping, type RoomTyping } from "./use-typing";
export type { RosterEntry, RosterSeed } from "./refs";
