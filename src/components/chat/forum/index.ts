// The forum, as the rest of Chat sees it.
//
// Two surfaces — the list of posts inside a forum room, and one post's page —
// plus the pure model both of them and the tests read. Everything else in this
// directory is an implementation detail of drawing a card.

export { ForumPostList } from "./post-list";
export { ForumPostScreen } from "./post-screen";
export { PostComposer } from "./post-composer";
export {
  FORUM_LIST_KINDS,
  FORUM_THREAD_KINDS,
  FORUM_SORTS,
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
  PREVIEW_CHARS,
  SUBJECT_TAG,
  buildForumCards,
  compareForumCards,
  forumPostHref,
  isForumSort,
  lastActivityOf,
  previewOf,
  replyCountLabel,
  sortForumCards,
  titleFromTags,
  type ForumCard,
  type ForumSort,
  type ForumSummary,
} from "./model";
