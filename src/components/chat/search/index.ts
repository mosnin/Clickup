// The search surface's public face.
//
// One import path for the two things another surface mounts, and for the pure
// pieces a second search surface (the in-channel find bar) will want to reuse
// rather than restate.

export { ChatSearchLauncher } from "./search-launcher";
export { ChatSearchDialog } from "./search-dialog";
export { useSearch, searchMessages } from "./search-data";
export type { SearchHit, SearchResponse, SearchState } from "./search-data";
export {
  composeResults,
  excerpt,
  reconcileSelection,
  MAX_CHANNEL_RESULTS,
} from "./results";
export type { SearchResultRow } from "./results";
export {
  resolveSearchHitDestination,
  KIND_FORUM_POST,
  KIND_FORUM_COMMENT,
} from "./hit-destination";
export type { SearchHitDestination, RoutableHit } from "./hit-destination";
