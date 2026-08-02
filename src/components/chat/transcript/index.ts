// The transcript, as the room sees it.
//
// Two components and the identity provider they both need — everything else in
// this directory is an implementation detail of drawing a message, and a room
// that reached for `MessageRow` directly would be a second place deciding what
// a message looks like.

export { ChannelTranscript } from "./transcript";
export { ThreadPane } from "./thread-pane";
export { MyPubkeyProvider } from "./messages-data";
export { buildMessageLink, parseMessageLink, MESSAGE_PARAM } from "./message-link";
