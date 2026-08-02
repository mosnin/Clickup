// What a search shows, in what order — spec 01 §6.2's result composition.
//
// Pure and separate from the dialog, because "which rows are there and which one
// is row zero" is the contract the keyboard depends on. The moment the visual
// order and the arrow-key order are computed in two places they disagree, and
// the symptom is Enter opening something other than the highlighted row.
//
// Buzz composes **channels → users → messages**. Ours is channels → messages,
// and the gap is deliberate rather than unfinished: there is no people directory
// on this substrate yet. Profiles (kind 0) are in the searchable allowlist and
// the index is already there, so the section drops in beside these two the day
// something publishes one — but a permanently empty "People" heading teaches
// somebody that the product cannot find people, which is a worse lie than not
// offering it.

import type { ChatChannelSummary } from "@/lib/buzz/channel-types";
import {
  channelIsBrowsable,
  compareChannels,
  scoreChannelMatch,
} from "@/lib/buzz/channel-search";
import type { ParsedSearchQuery } from "@/lib/buzz/search-query";
import type { SearchHit } from "./search-data";
import { resolveSearchHitDestination, type SearchHitDestination } from "./hit-destination";

/** §6.2 — channels are the appetiser, not the meal. */
export const MAX_CHANNEL_RESULTS = 5;

export type SearchResultRow =
  | {
      kind: "channel";
      /** Stable across renders, so the selected row survives a result update. */
      id: string;
      channel: ChatChannelSummary;
      href: string;
    }
  | {
      kind: "message";
      id: string;
      hit: SearchHit;
      destination: SearchHitDestination;
    };

/**
 * Compose the rows.
 *
 * Channels are matched on the *free text*, not on the whole raw query: somebody
 * who typed `in:design button` is asking about messages, and offering them the
 * `#design` room as the first result would put the row they did not ask for
 * above the ones they did. When the text is empty, `scoreChannelMatch` scores
 * everything equally and the ordering falls back to the channel comparator —
 * which is what makes `in:design` alone show that room rather than nothing.
 *
 * A message hit that cannot be routed anywhere (§6.3) is dropped rather than
 * drawn: a result row that does nothing when you press Enter is worse than one
 * fewer result.
 */
export function composeResults({
  parsed,
  channels,
  hits,
}: {
  parsed: ParsedSearchQuery;
  channels: readonly ChatChannelSummary[];
  hits: readonly SearchHit[];
}): SearchResultRow[] {
  const channelRows: SearchResultRow[] = channels
    .filter((channel) => channelIsBrowsable(channel))
    .map((channel) => ({ channel, score: scoreChannelMatch(channel, parsed.text) }))
    .filter(
      (entry): entry is { channel: ChatChannelSummary; score: number } =>
        entry.score !== null,
    )
    // Two passes, stable-sort, exactly as the channel browser does it: the
    // comparator decides the order inside a score band, the score decides the
    // bands. One combined comparator would make an argument about ordering an
    // argument about a lambda.
    .sort((a, b) => compareChannels(a.channel, b.channel, "recent"))
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_CHANNEL_RESULTS)
    .map(({ channel }) => ({
      kind: "channel" as const,
      id: `channel:${channel.channelId}`,
      channel,
      href: `/chat/c/${encodeURIComponent(channel.channelId)}`,
    }));

  const seen = new Set<string>();
  const messageRows: SearchResultRow[] = [];
  for (const hit of hits) {
    // Deduped by event id (§6.2). The server already dedupes across its own
    // index reads; this is the second half of the same promise, for a caller
    // that merges two responses (the find bar does).
    if (seen.has(hit.eventId)) continue;
    seen.add(hit.eventId);
    const destination = resolveSearchHitDestination(hit);
    if (!destination) continue;
    messageRows.push({
      kind: "message",
      id: `message:${hit.eventId}`,
      hit,
      destination,
    });
  }

  return [...channelRows, ...messageRows];
}

/**
 * Keep a selection pointing at something after the list changes.
 *
 * §6.2 clamps whenever the list shrinks. Following the *identity* rather than
 * the index is a little stronger and is what the surface actually needs: results
 * arrive in two waves (channels are local and instant, message hits come back
 * 300 ms later), so an index-only clamp moves the highlight out from under
 * somebody's finger the moment the server answers.
 */
export function reconcileSelection(
  previousId: string | null,
  rows: readonly SearchResultRow[],
): number | null {
  if (rows.length === 0) return null;
  if (previousId === null) return 0;
  const index = rows.findIndex((row) => row.id === previousId);
  return index >= 0 ? index : 0;
}

/**
 * A one-line preview of a hit, with the search terms kept in view.
 *
 * A message can be long and a result row is one line, so a naive truncation
 * shows the first eighty characters — which very often do not contain the word
 * that was searched for, and the row then reads as an unrelated result. This
 * centres the window on the first match instead.
 */
export function excerpt(content: string, text: string, maxLength = 140): string {
  const flat = content.replace(/\s+/gu, " ").trim();
  if (flat.length <= maxLength) return flat;

  const term = text.split(" ").filter(Boolean)[0]?.toLowerCase() ?? "";
  const at = term ? flat.toLowerCase().indexOf(term) : -1;
  if (at < 0) return `${flat.slice(0, maxLength - 1).trimEnd()}…`;

  const start = Math.max(0, at - Math.floor(maxLength / 3));
  const end = Math.min(flat.length, start + maxLength);
  const slice = flat.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${slice}${end < flat.length ? "…" : ""}`;
}
