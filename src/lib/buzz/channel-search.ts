// The channel browser's two hard questions, answered in one pure file:
// "which rooms may this person even see listed", and "why is this result above
// that one".
//
// Both are here rather than in the dialog because both are rules, not
// rendering. The visibility predicate is a *safety* rule — a private room's
// name is information, so a browser that lists one to a non-member has leaked
// something no join button can take back. The ranking is a *legibility* rule —
// eight named bands, each with a comment saying what it is for, so an argument
// about result order is an argument about a constant rather than about a
// library's opinion.
//
// Deliberately NOT a generic fuzzy library and deliberately no Levenshtein.
// Typo tolerance reorders results unpredictably and, worse, can push a channel
// the user can plainly see below one they were not looking for. Every band
// below is a rule a person can state out loud.

import type { ChatChannelSummary, ChatChannelKind } from "./channel-types";

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Word boundaries inside a channel name. One definition, used by the word
 * bands, by the collapse and by canonicalisation, so `release notes`,
 * `release_notes` and `release.notes` are never three different rooms.
 */
const SEPARATORS = /[\s\-_./]+/gu;

/**
 * The storage form of a name.
 *
 * The leading `#` is display-only — it is how a room is *written*, never how it
 * is *stored* — so it is stripped along with any whitespace in front of it.
 * Beyond that we are stricter than Buzz's own canonicaliser, because
 * `ChatChannelSummary.name` promises "lowercase, dashes, no spaces": one
 * separator, so the room you get is the room you meant however you typed it.
 *
 * Trailing dashes are dropped, which matters more than it looks: someone typing
 * `release ` mid-word would otherwise canonicalise to `release-` and match
 * nothing at all, so the result list would empty out on a space bar.
 */
export function canonicalChannelName(input: string): string {
  return input
    .replace(/^[#\s]+/u, "")
    .trim()
    .toLowerCase()
    .replace(SEPARATORS, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/** Do two names refer to the same room? The duplicate check, everywhere. */
export function channelNamesMatch(a: string, b: string): boolean {
  const left = canonicalChannelName(a);
  return left.length > 0 && left === canonicalChannelName(b);
}

/** Separators removed entirely: `release-notes` → `releasenotes`. */
function collapse(value: string): string {
  return value.replace(SEPARATORS, "");
}

/** Is `needle` an in-order subsequence of `haystack`? */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

// ---------------------------------------------------------------------------
// The eight bands
// ---------------------------------------------------------------------------
//
// Lower is better. The numbers are contiguous on purpose: a caller sorts on
// them ascending and nothing else, so inserting a band later means renumbering
// here and nowhere else.

/** The room they named. Nothing outranks typing a name exactly. */
export const SCORE_NAME_EXACT = 0;
/** They are typing the name from the front — `rel` → `release-notes`. */
export const SCORE_NAME_PREFIX = 1;
/** A whole word of the name is the query — `notes` → `release-notes`. */
export const SCORE_WORD_EXACT = 2;
/** A word starts with the query — `not` → `release-notes`. */
export const SCORE_WORD_PREFIX = 3;
/** The query appears somewhere in the name, mid-word — `ease` → `release`. */
export const SCORE_NAME_SUBSTRING = 4;
/**
 * The separator-collapsed name contains the collapsed query:
 * `releasenotes` finds `release-notes`. This is the band that forgives someone
 * for not knowing where the dashes are.
 */
export const SCORE_COLLAPSED_SUBSTRING = 5;
/**
 * The collapsed query is an in-order subsequence of the collapsed name:
 * `reln` → `release-notes`. The only genuinely fuzzy band, and it needs two
 * characters — a single letter is a subsequence of nearly every room, which
 * would turn one keystroke into an unranked list of everything.
 */
export const SCORE_COLLAPSED_SUBSEQUENCE = 6;
/**
 * The description contains the query as plain text. Last, and never fuzzy: a
 * description is prose, and subsequence-matching prose matches everything.
 */
export const SCORE_DESCRIPTION = 7;

/** The worst score a match can carry. Callers clamping or bucketing use this. */
export const SCORE_WORST = SCORE_DESCRIPTION;

/** Just enough of a channel to rank it. Structural so tests need no fixture. */
export type ScorableChannel = { name: string; description?: string };

/**
 * Rank one channel against one query. `null` means "not a match" — which is
 * different from a bad match, and is what removes a row from the list.
 *
 * An empty query scores 0 for everything, so "no search" is not a special case
 * at the call site: the sort is simply stable and the chosen sort mode wins.
 */
export function scoreChannelMatch(
  channel: ScorableChannel,
  query: string,
): number | null {
  // Two readings of the query, because two different things are being matched.
  // The name is a canonical slug, so the query is canonicalised to compare
  // like with like. A description is prose, so it is matched against what the
  // person actually typed — canonicalising "release notes" into
  // "release-notes" would stop it ever being found in a sentence.
  const q = canonicalChannelName(query);
  if (q.length === 0) return SCORE_NAME_EXACT;
  const raw = query.trim().toLowerCase();

  const name = canonicalChannelName(channel.name);
  const words = name.split(SEPARATORS).filter(Boolean);

  if (name === q) return SCORE_NAME_EXACT;
  if (name.startsWith(q)) return SCORE_NAME_PREFIX;
  if (words.some((w) => w === q)) return SCORE_WORD_EXACT;
  if (words.some((w) => w.startsWith(q))) return SCORE_WORD_PREFIX;
  if (name.includes(q)) return SCORE_NAME_SUBSTRING;

  const collapsedName = collapse(name);
  const collapsedQuery = collapse(q);
  if (collapsedQuery.length > 0 && collapsedName.includes(collapsedQuery)) {
    return SCORE_COLLAPSED_SUBSTRING;
  }
  if (collapsedQuery.length >= 2 && isSubsequence(collapsedQuery, collapsedName)) {
    return SCORE_COLLAPSED_SUBSEQUENCE;
  }

  const description = channel.description?.toLowerCase() ?? "";
  if (raw.length > 0 && description.includes(raw)) return SCORE_DESCRIPTION;

  return null;
}

// ---------------------------------------------------------------------------
// Who may see what
// ---------------------------------------------------------------------------

/** The two kinds the browser lists. A DM is not browsable — see below. */
export type BrowsableChannelKind = Extract<ChatChannelKind, "channel" | "forum">;

/** DMs are conversations, not rooms: you do not browse or join one. */
function isDirect(kind: ChatChannelKind): boolean {
  return kind === "dm" || kind === "group_dm";
}

function isArchived(channel: Pick<ChatChannelSummary, "archivedAt">): boolean {
  return channel.archivedAt !== undefined && channel.archivedAt !== null;
}

/** Just enough of a channel to decide whether it may be listed. */
export type VisibilityCandidate = Pick<
  ChatChannelSummary,
  "kind" | "visibility" | "joined" | "archivedAt"
>;

/**
 * May this room appear in the browser at all?
 *
 * Three clauses, and the middle one is the one that matters:
 *
 *  - a DM is never browsable;
 *  - an **archived** room is visible only to its members — archiving is how a
 *    room leaves the commons, so it must not stay discoverable to people who
 *    were never in it;
 *  - an unarchived room is visible if it is public, or if you are in it. A
 *    private room you are not in must never be listed, because its *name* is
 *    the leak. That is why this is a predicate in a tested file and not an
 *    `&&` buried in a `.filter()` inside a component.
 *
 * The client-side check is a second fence, not the fence: the backend's `list`
 * decides what leaves the server. Both apply the same rule so a bug in either
 * one is visible as a disagreement rather than as a disclosure.
 */
export function channelIsBrowsable(
  channel: VisibilityCandidate,
  kindFilter?: BrowsableChannelKind,
): boolean {
  if (isDirect(channel.kind)) return false;
  if (kindFilter && channel.kind !== kindFilter) return false;
  return isArchived(channel)
    ? channel.joined
    : channel.visibility === "public" || channel.joined;
}

// ---------------------------------------------------------------------------
// Tabs and sorting
// ---------------------------------------------------------------------------

export type ChannelBrowseTab = "all" | "joined" | "archived";
export type ChannelSortMode = "alpha" | "recent" | "members";

/**
 * The tabs partition what the visibility predicate already allowed — they are
 * never a second chance to see something. `all` is deliberately everything
 * visible *including* archived rooms you are in, because "all" that quietly
 * omits a category is the reason people think the browser is broken.
 */
export function channelMatchesTab(
  channel: Pick<ChatChannelSummary, "joined" | "archivedAt">,
  tab: ChannelBrowseTab,
): boolean {
  if (tab === "joined") return !isArchived(channel) && channel.joined;
  if (tab === "archived") return isArchived(channel);
  return true;
}

/** Ties break on name in every mode, so the order is total and reproducible. */
export function compareChannels(
  a: ChatChannelSummary,
  b: ChatChannelSummary,
  mode: ChannelSortMode,
): number {
  if (mode === "recent") {
    const delta = (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
    if (delta !== 0) return delta;
  }
  if (mode === "members") {
    const delta = b.memberCount - a.memberCount;
    if (delta !== 0) return delta;
  }
  return a.name.localeCompare(b.name);
}

export type BrowseOptions = {
  query: string;
  tab: ChannelBrowseTab;
  sort: ChannelSortMode;
  kindFilter?: BrowsableChannelKind;
};

/**
 * The whole browse pipeline: visibility → tab → search → order.
 *
 * The ordering rule is two passes on purpose. Sort by the chosen mode first,
 * then — only when there is a query — re-sort by score ascending. `Array.sort`
 * is stable, so the mode's order survives inside a band: two rooms that match
 * equally well stay in the order the person asked for, rather than in whatever
 * order the scorer happened to visit them.
 */
export function browseChannels(
  channels: readonly ChatChannelSummary[],
  { query, tab, sort, kindFilter }: BrowseOptions,
): ChatChannelSummary[] {
  const visible = channels
    .filter((c) => channelIsBrowsable(c, kindFilter))
    .filter((c) => channelMatchesTab(c, tab));

  const ordered = [...visible].sort((a, b) => compareChannels(a, b, sort));
  if (canonicalChannelName(query).length === 0) return ordered;

  const scored: { channel: ChatChannelSummary; score: number }[] = [];
  for (const channel of ordered) {
    const score = scoreChannelMatch(channel, query);
    if (score !== null) scored.push({ channel, score });
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.channel);
}

// ---------------------------------------------------------------------------
// The create row
// ---------------------------------------------------------------------------

/**
 * Should the pinned "create" row be offered?
 *
 * Yes whenever creation is available and no room of this kind already carries
 * the typed name. It is offered from the moment the dialog opens — with no
 * query it reads "Create a new channel", which is what tells you the dialog is
 * both a browser *and* the way to make one — and it specialises to the typed
 * name as you go.
 *
 * The duplicate check runs over every channel the caller was handed, not only
 * the ones the current tab is showing: a room you are in but have filtered out
 * of view is still a room whose name is taken, and offering to create it would
 * produce a refusal from the server instead of a room.
 *
 * Note what this cannot do: a private room you are not a member of never
 * reaches this list, so it cannot suppress the row. That is the correct trade —
 * the alternative leaks the room's existence, and the server refuses the
 * duplicate anyway.
 */
export function createRowIsOffered({
  channels,
  query,
  kindFilter,
  canCreate = true,
}: {
  channels: readonly ChatChannelSummary[];
  query: string;
  kindFilter?: BrowsableChannelKind;
  canCreate?: boolean;
}): boolean {
  if (!canCreate) return false;
  if (canonicalChannelName(query).length === 0) return true;
  return !channels.some(
    (c) =>
      !isDirect(c.kind) &&
      (!kindFilter || c.kind === kindFilter) &&
      channelNamesMatch(c.name, query),
  );
}

// ---------------------------------------------------------------------------
// Keyboard geometry
// ---------------------------------------------------------------------------

/**
 * The create row is **virtual index 0** and channels shift down by one.
 *
 * This is the detail that makes the design work rather than a nicety: type a
 * name that does not exist, press Enter, get the room. If the create row sat
 * anywhere but first, the arrow keys and the eye would disagree the moment the
 * result list emptied, and "press Enter to make it" would become "press Enter
 * to do nothing".
 */
export function navGeometry({
  createRowShown,
  resultCount,
}: {
  createRowShown: boolean;
  resultCount: number;
}): { offset: number; count: number } {
  const offset = createRowShown ? 1 : 0;
  return { offset, count: offset + resultCount };
}

/** ArrowDown/ArrowUp, clamped. `null` is "nothing selected yet". */
export function moveSelection(
  current: number | null,
  direction: 1 | -1,
  count: number,
): number | null {
  if (count === 0) return null;
  if (current === null) return direction === 1 ? 0 : count - 1;
  const next = current + direction;
  return Math.min(Math.max(next, 0), count - 1);
}
