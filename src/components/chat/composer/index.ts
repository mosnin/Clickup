// The composer, as the rest of Chat sees it.
//
// One component to drop into a room (`MessageComposer`) and the two pieces
// other surfaces legitimately need on their own: the emoji picker, which the
// reaction bar will open from its own trigger, and the optimistic-row helpers,
// which the transcript uses to reason about a pending message without mounting
// a composer to do it.

export {
  MessageComposer,
  postMessage,
  type MessageComposerProps,
  type ComposerEditorHandle,
  type PostMutation,
} from "./message-composer";
export { EmojiPicker } from "./emoji-picker";
export {
  EMOJI_GROUPS,
  searchEmoji,
  searchCustomEmoji,
  selectionToken,
  type CustomEmoji,
  type StandardEmoji,
} from "./emoji-data";
export type { ComposerMentionable } from "./extensions";
export {
  MESSAGE_KIND,
  acknowledgedId,
  createOptimisticMessage,
  isLocalKey,
  mentionRefsFor,
  newLocalKey,
  postArgs,
  type ComposerAuthor,
  type PostArgs,
  type SendTarget,
} from "./optimistic";
export { configureDraftStore, useDraft } from "./draft-store";
