// The search query grammar — spec 01 §6.1, and nothing else.
//
// One raw string in, a structured question out: `from:`, `in:`, `after:`,
// `before:`, plus whatever is left over as free text. It is pure, it is total,
// and both of those are load-bearing rather than tidiness.
//
// **Total** because this runs on every keystroke over whatever somebody is
// typing, which means it runs over *half* of everything somebody is typing.
// `after:2026-` is a legitimate intermediate state of `after:2026-01-05`, and a
// parser that throws on it turns a search box into a crash. There is no input to
// this function that is an error; there are only inputs that produce more or
// less structure.
//
// **Nothing is ever dropped.** An operator we do not recognise, an operator with
// no value, a date that is not a date — every one of them stays in `text` and
// keeps participating in the search. That is the single most important property
// in this file: a query that silently loses part of what a person typed returns
// results that are *confidently wrong*, which is strictly worse than returning
// nothing, because there is no way to tell from the results that it happened.
// So `after:yesterday` searches for the words "after yesterday", and
// `built-in:react` searches for "built-in:react" — both of which are what the
// person appears to have meant, and neither of which is a silent narrowing.
//
// Resolution — turning `in:general` into a channel id, `from:@ada` into a
// pubkey — is here too, and it is deliberately *three*-valued. "No operator",
// "resolved to this", and "you named something and I could not find it" are
// three different situations, and collapsing the third into the first is how a
// filtered search silently becomes an unfiltered one. §6.2 is explicit: an
// unresolved operator disables the query rather than widening it.

import type { ChatChannelSummary } from "./channel-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The one length floor (§6.2, rule 95).
 *
 * Exported so every call site imports it rather than restating `2`. Buzz keeps
 * exactly one copy for the same reason: two floors drift, and the symptom is a
 * surface that searches on one character while another waits for two.
 */
export const MIN_SEARCH_QUERY_LENGTH = 2;

/** §6.2 — the debounce before a query goes to the server. */
export const SEARCH_DEBOUNCE_MS = 300;

/** §12 — the query text is clamped before it reaches an index. */
export const MAX_SEARCH_QUERY_CHARS = 4096;

export type SearchOperator = "from" | "in" | "after" | "before";

/**
 * A parsed query.
 *
 * `from` and `in` are single-valued because §6.1 says later occurrences of the
 * same operator win — a repeated operator is a person correcting themselves, not
 * a person asking for a union. `since`/`until` are unix **seconds**, matching
 * NIP-01 and therefore matching the `createdAt` column the server ranges on.
 */
export type ParsedSearchQuery = {
  /** Everything that was not an operator, whitespace-collapsed and trimmed. */
  text: string;
  /** `from:` — a handle with its `@` stripped, or a hex pubkey. */
  from: string | null;
  /** `in:` — a channel name with its `#` stripped, or a channel id. */
  in: string | null;
  /** `after:` — inclusive lower bound, unix seconds at local start of day. */
  since: number | null;
  /** `before:` — inclusive upper bound, one second before local start of day. */
  until: number | null;
  /** Which operators actually took effect. Drives `searchIsLive`. */
  operators: SearchOperator[];
};

/**
 * The three-state resolution result (§6.1).
 *
 * `unresolved` exists so a caller can tell "they filtered by a channel I cannot
 * find" apart from "they did not filter by channel", and refuse rather than
 * widen. A two-state `T | null` cannot express the difference, which is exactly
 * how a search for `in:acquisitions` ends up returning the whole community.
 */
export type OperatorResolveResult<T> =
  | { status: "none" }
  | { status: "resolved"; value: T }
  | { status: "unresolved" };

// ---------------------------------------------------------------------------
// The grammar
// ---------------------------------------------------------------------------

/**
 * The operator pattern.
 *
 * `(?:^|\s)` and **not** `\b` (§6.1, rule 90). `\b` matches between `-` and `i`,
 * and between `/` and `i`, so with a word boundary `built-in:react` parses as an
 * `in:` operator and `https://x.com/in:foo` parses as another one — both of them
 * silently deleting most of what the person typed. A token boundary is the rule
 * that says "an operator starts a word".
 *
 * `(\S+)` for the value: an operator value runs to the next space. That is why
 * `from:@Will Pfleger` captures only `@Will`, which is a known limitation of
 * Buzz's own grammar and is kept rather than quietly fixed — a value that could
 * span spaces would have to guess where it ends, and guessing is the thing this
 * file is built not to do.
 */
const OPERATOR_RE = /(?:^|\s)(from|in|after|before):(\S+)/gi;

/**
 * Trailing punctuation is not part of a value (§6.1): `in:general,` means the
 * room called `general`, and `(from:ada)` means the person called `ada`.
 *
 * Only trailing, and only closing punctuation. A *leading* character is often
 * part of the value — `@ada`, `#general` — and stripping symmetrically would
 * eat exactly the sigils the normalizers below are looking for.
 */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"»]+$/u;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 64 lowercase hex — a Nostr x-only pubkey, and also our channel ids. */
const HEX_64 = /^[0-9a-f]{64}$/;

export function isHexPubkey(value: string): boolean {
  return HEX_64.test(value);
}

/**
 * Does this look like a channel id rather than a channel name?
 *
 * Buzz asks "is this a UUID"; ours is "is this 64 hex", because a room's id is
 * the id of the event that created it (`buzzChannels.channelId`). Same job: let
 * somebody paste an id into `in:` and have it pass straight through instead of
 * being matched against names it will never equal.
 */
export function looksLikeChannelId(value: string): boolean {
  return HEX_64.test(value);
}

/** `@ada` → `ada`. The `@` is how a person is written, not who they are. */
export function normalizeFromHandle(value: string): string {
  return value.replace(/^@+/u, "").trim();
}

/** `#general` → `general`. Same argument as the `@`. */
export function normalizeInChannel(value: string): string {
  return value.replace(/^#+/u, "").trim();
}

/**
 * `YYYY-MM-DD` → unix seconds at the **local** start of that day, or null.
 *
 * Local, not UTC, and it is the same reason `src/lib/dates.ts` exists on the
 * Work side: somebody typing `after:2026-01-05` means the fifth as they
 * experienced it, and a UTC midnight is a different instant that silently
 * includes or excludes several hours of a neighbouring day.
 *
 * The round trip through `Date` is the overflow check. `new Date(2026, 1, 30)`
 * does not fail — it rolls forward to March 2nd — so validating the string
 * shape is not enough, and `2026-02-30` would otherwise become a real filter
 * for a day that does not exist.
 */
export function startOfLocalDay(value: string): number | null {
  const match = DATE_RE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (Number.isNaN(date.getTime())) return null;
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return Math.floor(date.getTime() / 1000);
}

const EMPTY: ParsedSearchQuery = {
  text: "",
  from: null,
  in: null,
  since: null,
  until: null,
  operators: [],
};

/**
 * Parse a raw query string.
 *
 * The loop keeps two things: the spans between matches, which are text by
 * definition, and any match it **declined** to interpret, which goes back into
 * the text verbatim — including the whitespace the pattern consumed in front of
 * it, so `a before:soon b` rebuilds as `a before:soon b` and not `abefore:soon b`.
 *
 * `raw` is typed `string` and checked anyway. This is called with whatever an
 * input element hands over, and one `undefined` from a controlled-component
 * mistake would otherwise take down the surface that is meant to be the calm
 * one.
 */
export function parseSearchQuery(raw: string): ParsedSearchQuery {
  if (typeof raw !== "string" || raw.length === 0) return { ...EMPTY };

  const kept: string[] = [];
  const operators = new Set<SearchOperator>();
  let cursor = 0;
  let from: string | null = null;
  let inChannel: string | null = null;
  let since: number | null = null;
  let until: number | null = null;

  // A fresh index every call: the regex is module-level and `g`-flagged, so a
  // leftover `lastIndex` from a previous call would skip the front of this one.
  OPERATOR_RE.lastIndex = 0;
  let match: RegExpExecArray | null = OPERATOR_RE.exec(raw);
  while (match !== null) {
    const whole = match[0];
    const name = match[1].toLowerCase() as SearchOperator;
    const value = match[2].replace(TRAILING_PUNCTUATION, "");

    kept.push(raw.slice(cursor, match.index));
    cursor = match.index + whole.length;

    let applied = false;
    if (value.length > 0) {
      switch (name) {
        case "from": {
          const handle = normalizeFromHandle(value);
          if (handle.length > 0) {
            from = handle;
            applied = true;
          }
          break;
        }
        case "in": {
          const channel = normalizeInChannel(value);
          if (channel.length > 0) {
            inChannel = channel;
            applied = true;
          }
          break;
        }
        case "after": {
          const start = startOfLocalDay(value);
          if (start !== null) {
            since = start;
            applied = true;
          }
          break;
        }
        case "before": {
          const start = startOfLocalDay(value);
          if (start !== null) {
            // Minus one second (§6.1, rule 91). NIP-01's `until` is an
            // *inclusive* upper bound, so `until = startOfDay` would include
            // every event stamped exactly at midnight of the named day — i.e.
            // `before:` would stop being exclusive of the day it names, which
            // is not what the word means and not what Slack does.
            until = start - 1;
            applied = true;
          }
          break;
        }
      }
    }

    if (applied) operators.add(name);
    // Not applied: the whole token goes back, verbatim, and searches as text.
    else kept.push(whole);

    match = OPERATOR_RE.exec(raw);
  }
  kept.push(raw.slice(cursor));

  return {
    text: collapseWhitespace(kept.join("")),
    from,
    in: inChannel,
    since,
    until,
    // Fixed order rather than insertion order, so the array is a set that can be
    // compared in a test without caring which operator somebody typed first.
    operators: (["from", "in", "after", "before"] as const).filter((op) =>
      operators.has(op),
    ),
  };
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * Is there a search happening at all? (§6.2)
 *
 * Two characters of text **or** any operator — so `in:general` on its own is a
 * real search even though its text is empty, and the surface shows results for
 * it rather than the empty prompt.
 */
export function searchIsLive(parsed: ParsedSearchQuery): boolean {
  return parsed.text.length >= MIN_SEARCH_QUERY_LENGTH || parsed.operators.length > 0;
}

/**
 * Is the *message* query runnable? (§6.2, rule 95)
 *
 * Distinct from `searchIsLive` on purpose, and this is Buzz's behaviour rather
 * than an accident: `in:general` alone makes the surface live — it can show you
 * the channel — but it is not a text query, and running a full-text search with
 * no terms would either return everything in the room or nothing at all
 * depending on the engine. Neither is an answer to what was asked.
 */
export function searchTextIsQueryable(parsed: ParsedSearchQuery): boolean {
  return parsed.text.length >= MIN_SEARCH_QUERY_LENGTH;
}

/**
 * The text as it goes to the index: clamped, and with NUL bytes neutralised.
 *
 * §12's clamp. A NUL becomes a space rather than being deleted because deleting
 * it would join two words that were not adjacent.
 */
export function searchTextForIndex(text: string): string {
  return collapseWhitespace(text.replace(/\0/gu, " ")).slice(0, MAX_SEARCH_QUERY_CHARS);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** What `resolveInChannel` matches against — a subset of `ChatChannelSummary`. */
export type ResolvableChannel = Pick<ChatChannelSummary, "channelId" | "name"> & {
  displayName?: string;
};

/**
 * `in:` → a channel id (§6.2).
 *
 * An id passes straight through. A name is matched case-insensitively against
 * the canonical name *and* the display name, because the display name is what
 * somebody sees in the rail and therefore what they will type.
 *
 * The candidate list is the caller's already-access-filtered channel list, which
 * is what makes this safe to do on the client: a room you cannot see is not in
 * the list, so `in:acquisitions` from a non-member resolves to `unresolved` and
 * the search is refused rather than run against a room id they guessed.
 */
export function resolveInChannel(
  value: string | null,
  channels: readonly ResolvableChannel[],
): OperatorResolveResult<string> {
  if (value === null) return { status: "none" };
  const wanted = value.toLowerCase();
  if (looksLikeChannelId(value)) {
    // An id still has to name a room this reader can see. Passing an unknown id
    // through would hand the server a filter nobody can account for; the server
    // would refuse it, but "unresolved" is the honest local answer and it keeps
    // the refusal in the surface that can explain it.
    const known = channels.find((channel) => channel.channelId === value);
    return known ? { status: "resolved", value } : { status: "unresolved" };
  }
  const hit = channels.find(
    (channel) =>
      channel.name.toLowerCase() === wanted ||
      (channel.displayName ?? "").toLowerCase() === wanted,
  );
  return hit ? { status: "resolved", value: hit.channelId } : { status: "unresolved" };
}

/** What `resolveFromAuthor` matches against. */
export type ResolvableAuthor = { pubkey: string; name: string };

/**
 * `from:` → a pubkey (§6.2).
 *
 * Hex passes through, lowercased. Otherwise the handle is ranked against the
 * candidates — exact, then prefix, then substring — and the best single match
 * wins. Deliberately not fuzzy (rule 96): typo tolerance reorders results
 * unpredictably and can rank somebody the person was not looking for above
 * somebody they can plainly see.
 *
 * `npub…` is **not** decoded. Bech32 would be a dependency and a second address
 * format to keep correct, and nothing in this product has ever shown a user an
 * npub — so accepting one would be accepting a string nobody in this app could
 * have obtained here. It falls through to the name match, finds nothing, and
 * reads as unresolved, which is true.
 */
export function resolveFromAuthor(
  value: string | null,
  candidates: readonly ResolvableAuthor[],
): OperatorResolveResult<string> {
  if (value === null) return { status: "none" };
  const lowered = value.toLowerCase();
  if (isHexPubkey(lowered)) return { status: "resolved", value: lowered };

  let best: { rank: number; name: string; pubkey: string } | null = null;
  for (const candidate of candidates) {
    const name = candidate.name.toLowerCase();
    const rank = name === lowered ? 0 : name.startsWith(lowered) ? 1 : name.includes(lowered) ? 2 : -1;
    if (rank < 0) continue;
    if (
      best === null ||
      rank < best.rank ||
      (rank === best.rank && candidate.name.localeCompare(best.name) < 0)
    ) {
      best = { rank, name: candidate.name, pubkey: candidate.pubkey };
    }
  }
  return best ? { status: "resolved", value: best.pubkey } : { status: "unresolved" };
}

/**
 * Everything the server needs, or a refusal.
 *
 * The whole point of the three-state results above lands here: if **any**
 * operator was named and could not be resolved, this returns `null` and the
 * caller runs no query at all (§6.2, rule 93). Silently widening a filtered
 * search is worse than showing nothing, because the person gets an answer to a
 * question they did not ask and has no way to notice.
 */
export type SearchRequest = {
  text: string;
  channelIds?: string[];
  authors?: string[];
  since?: number;
  until?: number;
};

/**
 * Which operator, if any, named something that could not be found.
 *
 * A sibling of `buildSearchRequest` rather than a richer return type from it,
 * because the two answers have different audiences: the request is what the
 * query needs, and this is what the *sentence* needs. A surface that says
 * "nothing matches that" when a person can see plainly that they typed
 * `in:desgin` has told them nothing; naming the operator turns a dead end into
 * a typo they can fix.
 *
 * `in` is reported first when both fail, because a room is the narrower of the
 * two and is the one somebody is more likely to have meant precisely.
 */
export function unresolvedOperator(
  parsed: ParsedSearchQuery,
  directory: {
    channels: readonly ResolvableChannel[];
    authors: readonly ResolvableAuthor[];
  },
): "in" | "from" | null {
  if (resolveInChannel(parsed.in, directory.channels).status === "unresolved") return "in";
  if (resolveFromAuthor(parsed.from, directory.authors).status === "unresolved") return "from";
  return null;
}

export function buildSearchRequest(
  parsed: ParsedSearchQuery,
  directory: {
    channels: readonly ResolvableChannel[];
    authors: readonly ResolvableAuthor[];
  },
): SearchRequest | null {
  const channel = resolveInChannel(parsed.in, directory.channels);
  if (channel.status === "unresolved") return null;
  const author = resolveFromAuthor(parsed.from, directory.authors);
  if (author.status === "unresolved") return null;

  return {
    text: searchTextForIndex(parsed.text),
    ...(channel.status === "resolved" ? { channelIds: [channel.value] } : {}),
    ...(author.status === "resolved" ? { authors: [author.value] } : {}),
    ...(parsed.since !== null ? { since: parsed.since } : {}),
    ...(parsed.until !== null ? { until: parsed.until } : {}),
  };
}
