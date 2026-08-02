import { describe, expect, it } from "vitest";
import {
  MAX_SEARCH_QUERY_CHARS,
  MIN_SEARCH_QUERY_LENGTH,
  buildSearchRequest,
  isHexPubkey,
  looksLikeChannelId,
  normalizeFromHandle,
  normalizeInChannel,
  parseSearchQuery,
  resolveFromAuthor,
  resolveInChannel,
  searchIsLive,
  searchTextForIndex,
  searchTextIsQueryable,
  startOfLocalDay,
  unresolvedOperator,
} from "../src/lib/buzz/search-query";

// The grammar is pure, so this suite is the executable half of spec 01 §6.1.
// Two properties get the most attention, because they are the two whose failure
// is silent: an operator must anchor at a token boundary (so a URL is not
// mangled into a filter), and nothing a person types may ever be *dropped* — an
// operator we decline to interpret has to come back as text, or the search
// answers a question that was never asked and looks confident doing it.

/** The same clock the parser uses, so this suite is timezone-independent. */
function localDay(year: number, month: number, day: number): number {
  return Math.floor(new Date(year, month - 1, day, 0, 0, 0, 0).getTime() / 1000);
}

const HEX = "a".repeat(64);

describe("parseSearchQuery — totality", () => {
  it("never throws, whatever is typed", () => {
    const inputs = [
      "",
      " ",
      "\n\t  \n",
      ":",
      "from:",
      "in:",
      "after:",
      "before:",
      "from::",
      "from:@",
      "in:#",
      "in:,",
      "from:,,,",
      "::::from:in:after:",
      "after:2026-13-01 before:not-a-date",
      "a".repeat(10_000),
      "🙂 from:🙂 in:🙂",
      "from:ada from:bo from:cy",
      "\\ ( ) [ ] { } * ? + | ^ $",
    ];
    for (const input of inputs) {
      expect(() => parseSearchQuery(input)).not.toThrow();
    }
  });

  it("survives a non-string, because a controlled input can hand one over", () => {
    // Deliberately lying to the compiler: the guard exists for the runtime, and
    // a test that only passes strings never exercises it.
    const parsed = parseSearchQuery(undefined as unknown as string);
    expect(parsed.text).toBe("");
    expect(parsed.operators).toEqual([]);
  });

  it("is not stateful across calls despite the global regex", () => {
    const first = parseSearchQuery("in:design hello");
    const second = parseSearchQuery("in:design hello");
    expect(second).toEqual(first);
  });
});

describe("parseSearchQuery — plain text", () => {
  it("returns text unchanged when there are no operators", () => {
    expect(parseSearchQuery("release notes").text).toBe("release notes");
  });

  it("collapses and trims whitespace", () => {
    expect(parseSearchQuery("  release   \n notes  ").text).toBe("release notes");
  });

  it("leaves a colon that is not an operator alone", () => {
    expect(parseSearchQuery("TODO: ship it").text).toBe("TODO: ship it");
  });
});

describe("parseSearchQuery — from:", () => {
  it("captures a handle and strips the @", () => {
    const parsed = parseSearchQuery("from:@ada deploy");
    expect(parsed.from).toBe("ada");
    expect(parsed.text).toBe("deploy");
    expect(parsed.operators).toEqual(["from"]);
  });

  it("captures a bare handle", () => {
    expect(parseSearchQuery("from:ada").from).toBe("ada");
  });

  it("captures a hex pubkey verbatim", () => {
    expect(parseSearchQuery(`from:${HEX}`).from).toBe(HEX);
  });

  it("is case-insensitive on the operator name", () => {
    expect(parseSearchQuery("FROM:ada").from).toBe("ada");
    expect(parseSearchQuery("From:ada").from).toBe("ada");
  });

  it("keeps only the first whitespace-delimited token of a multi-word handle", () => {
    // Buzz's documented limitation, kept rather than guessed at: a value that
    // could span spaces would have to decide where it ends.
    const parsed = parseSearchQuery("from:@Will Pfleger");
    expect(parsed.from).toBe("Will");
    expect(parsed.text).toBe("Pfleger");
  });

  it("falls back to text when the value is only sigils", () => {
    const parsed = parseSearchQuery("from:@ hello");
    expect(parsed.from).toBeNull();
    expect(parsed.text).toBe("from:@ hello");
  });
});

describe("parseSearchQuery — in:", () => {
  it("captures a channel name and strips the #", () => {
    const parsed = parseSearchQuery("in:#design mock");
    expect(parsed.in).toBe("design");
    expect(parsed.text).toBe("mock");
  });

  it("strips trailing punctuation from the value", () => {
    expect(parseSearchQuery("in:general,").in).toBe("general");
    expect(parseSearchQuery("in:general.").in).toBe("general");
    expect(parseSearchQuery("in:general)").in).toBe("general");
  });

  it("does not treat a bracketed operator as an operator", () => {
    // The token-boundary rule cuts both ways and this is the cut people notice
    // least: `(` is not whitespace, so `(in:general)` is a parenthesised phrase,
    // not a filter. Stripping the leading punctuation too would be the obvious
    // "fix" and would resurrect exactly the `built-in:react` bug.
    expect(parseSearchQuery("(in:general)").in).toBeNull();
    expect(parseSearchQuery("(in:general)").text).toBe("(in:general)");
  });

  it("captures a channel id", () => {
    expect(parseSearchQuery(`in:${HEX}`).in).toBe(HEX);
  });
});

describe("parseSearchQuery — token boundary, not a word boundary", () => {
  // Rule 90. `\b` matches between `-` and `i`, and between `/` and `i`, so a
  // word boundary turns both of these into filters and deletes most of the query.
  it("does not treat built-in:react as an operator", () => {
    const parsed = parseSearchQuery("built-in:react");
    expect(parsed.in).toBeNull();
    expect(parsed.text).toBe("built-in:react");
  });

  it("does not treat a URL path segment as an operator", () => {
    const raw = "https://x.com/in:foo";
    const parsed = parseSearchQuery(raw);
    expect(parsed.in).toBeNull();
    expect(parsed.text).toBe(raw);
  });

  it("does not treat a suffix of a longer word as an operator", () => {
    const parsed = parseSearchQuery("uniform:one platform:two");
    expect(parsed.from).toBeNull();
    expect(parsed.text).toBe("uniform:one platform:two");
  });

  it("does match at the very start of the string", () => {
    expect(parseSearchQuery("in:design").in).toBe("design");
  });

  it("does match after a newline or a tab", () => {
    expect(parseSearchQuery("hello\nin:design").in).toBe("design");
    expect(parseSearchQuery("hello\tfrom:ada").from).toBe("ada");
  });
});

describe("parseSearchQuery — dates", () => {
  it("after: is the local start of the named day, inclusive", () => {
    expect(parseSearchQuery("after:2026-01-05").since).toBe(localDay(2026, 1, 5));
  });

  it("before: is one second before the local start of the named day", () => {
    // Rule 91: NIP-01's `until` is inclusive, so without the -1 the named day
    // is included and `before:` stops meaning "before".
    expect(parseSearchQuery("before:2026-01-05").until).toBe(localDay(2026, 1, 5) - 1);
  });

  it("keeps an unparseable date in the text (rule 92)", () => {
    const parsed = parseSearchQuery("after:yesterday standup");
    expect(parsed.since).toBeNull();
    expect(parsed.text).toBe("after:yesterday standup");
    expect(parsed.operators).toEqual([]);
  });

  it("rejects an out-of-range month", () => {
    const parsed = parseSearchQuery("after:2026-13-01");
    expect(parsed.since).toBeNull();
    expect(parsed.text).toBe("after:2026-13-01");
  });

  it("rejects a day that does not exist in that month", () => {
    // The round trip through Date is the whole point: `new Date(2026, 1, 30)`
    // does not fail, it rolls forward to March 2nd.
    const parsed = parseSearchQuery("after:2026-02-30");
    expect(parsed.since).toBeNull();
    expect(parsed.text).toBe("after:2026-02-30");
  });

  it("accepts a leap day in a leap year and rejects it otherwise", () => {
    expect(parseSearchQuery("after:2024-02-29").since).toBe(localDay(2024, 2, 29));
    expect(parseSearchQuery("after:2026-02-29").since).toBeNull();
  });

  it("rejects a date that is not zero-padded", () => {
    const parsed = parseSearchQuery("after:2026-1-5");
    expect(parsed.since).toBeNull();
    expect(parsed.text).toBe("after:2026-1-5");
  });

  it("startOfLocalDay is null for anything that is not a date", () => {
    expect(startOfLocalDay("")).toBeNull();
    expect(startOfLocalDay("2026-01-05T10:00")).toBeNull();
    expect(startOfLocalDay("tomorrow")).toBeNull();
  });
});

describe("parseSearchQuery — combinations", () => {
  it("parses every operator at once and keeps the rest as text", () => {
    const parsed = parseSearchQuery(
      "in:#design from:@ada after:2026-01-01 before:2026-02-01 button radius",
    );
    expect(parsed).toEqual({
      text: "button radius",
      from: "ada",
      in: "design",
      since: localDay(2026, 1, 1),
      until: localDay(2026, 2, 1) - 1,
      operators: ["from", "in", "after", "before"],
    });
  });

  it("lets a later occurrence of the same operator win", () => {
    const parsed = parseSearchQuery("in:design in:release-notes");
    expect(parsed.in).toBe("release-notes");
    expect(parsed.text).toBe("");
  });

  it("keeps an earlier valid operator when a later one is rejected", () => {
    const parsed = parseSearchQuery("after:2026-01-05 after:soon");
    expect(parsed.since).toBe(localDay(2026, 1, 5));
    expect(parsed.text).toBe("after:soon");
  });

  it("handles operators sandwiched between text without joining words", () => {
    const parsed = parseSearchQuery("alpha in:design beta from:ada gamma");
    expect(parsed.text).toBe("alpha beta gamma");
    expect(parsed.in).toBe("design");
    expect(parsed.from).toBe("ada");
  });

  it("rebuilds a rejected operator without swallowing its leading space", () => {
    const parsed = parseSearchQuery("alpha before:soon beta");
    expect(parsed.text).toBe("alpha before:soon beta");
  });

  it("handles back-to-back operators", () => {
    const parsed = parseSearchQuery("from:ada in:design");
    expect(parsed.from).toBe("ada");
    expect(parsed.in).toBe("design");
    expect(parsed.text).toBe("");
  });

  it("treats an unknown operator as text while parsing the known ones beside it", () => {
    // The requirement in one test: an operator nobody implemented must not be
    // dropped, and it must not stop the ones that exist from working.
    const parsed = parseSearchQuery("has:link in:design during:standup hello");
    expect(parsed.in).toBe("design");
    expect(parsed.text).toBe("has:link during:standup hello");
  });
});

describe("liveness thresholds", () => {
  it("is not live below the minimum with no operator", () => {
    expect(searchIsLive(parseSearchQuery("a"))).toBe(false);
    expect(MIN_SEARCH_QUERY_LENGTH).toBe(2);
  });

  it("is live at the minimum", () => {
    expect(searchIsLive(parseSearchQuery("ab"))).toBe(true);
  });

  it("is live for an operator alone", () => {
    const parsed = parseSearchQuery("in:general");
    expect(searchIsLive(parsed)).toBe(true);
    // …but there is nothing to full-text search for, so the message query is not
    // runnable. Two different questions, deliberately not one.
    expect(searchTextIsQueryable(parsed)).toBe(false);
  });
});

describe("searchTextForIndex", () => {
  it("clamps to the maximum", () => {
    expect(searchTextForIndex("x".repeat(MAX_SEARCH_QUERY_CHARS + 500)).length).toBe(
      MAX_SEARCH_QUERY_CHARS,
    );
  });

  it("turns a NUL into a space rather than deleting it", () => {
    expect(searchTextForIndex("one\0two")).toBe("one two");
  });
});

describe("small predicates", () => {
  it("isHexPubkey wants exactly 64 lowercase hex", () => {
    expect(isHexPubkey(HEX)).toBe(true);
    expect(isHexPubkey(HEX.toUpperCase())).toBe(false);
    expect(isHexPubkey("a".repeat(63))).toBe(false);
    expect(isHexPubkey(`0x${"a".repeat(64)}`)).toBe(false);
  });

  it("looksLikeChannelId matches an event id", () => {
    expect(looksLikeChannelId(HEX)).toBe(true);
    expect(looksLikeChannelId("design")).toBe(false);
  });

  it("normalizers strip only the leading sigil", () => {
    expect(normalizeFromHandle("@@ada")).toBe("ada");
    expect(normalizeFromHandle("ada@example")).toBe("ada@example");
    expect(normalizeInChannel("##design")).toBe("design");
    expect(normalizeInChannel("design#1")).toBe("design#1");
  });
});

describe("resolution is three-valued", () => {
  const channels = [
    { channelId: HEX, name: "design", displayName: "Design" },
    { channelId: "b".repeat(64), name: "release-notes", displayName: "Release notes" },
  ];
  const authors = [
    { pubkey: "1".repeat(64), name: "Ada Lovelace" },
    { pubkey: "2".repeat(64), name: "Adam Smith" },
  ];

  it("reports none when the operator was not used", () => {
    expect(resolveInChannel(null, channels)).toEqual({ status: "none" });
    expect(resolveFromAuthor(null, authors)).toEqual({ status: "none" });
  });

  it("resolves a channel by canonical name, case-insensitively", () => {
    expect(resolveInChannel("DESIGN", channels)).toEqual({ status: "resolved", value: HEX });
  });

  it("resolves a channel by its display name", () => {
    expect(resolveInChannel("release notes", channels)).toEqual({
      status: "resolved",
      value: "b".repeat(64),
    });
  });

  it("resolves a channel id that the reader can see", () => {
    expect(resolveInChannel(HEX, channels)).toEqual({ status: "resolved", value: HEX });
  });

  it("refuses a channel id the reader cannot see", () => {
    // The list handed in is already access-filtered, so an id that is not in it
    // is a room this person cannot see — and guessing an id must not widen a
    // search into it.
    expect(resolveInChannel("f".repeat(64), channels)).toEqual({ status: "unresolved" });
  });

  it("reports unresolved for a channel name nobody has", () => {
    expect(resolveInChannel("acquisitions", channels)).toEqual({ status: "unresolved" });
  });

  it("prefers an exact author name over a prefix match", () => {
    const many = [
      { pubkey: "3".repeat(64), name: "ada" },
      ...authors,
    ];
    expect(resolveFromAuthor("ada", many)).toEqual({
      status: "resolved",
      value: "3".repeat(64),
    });
  });

  it("prefers a prefix match over a substring match", () => {
    const candidates = [
      { pubkey: "4".repeat(64), name: "Amanda Lovelace" },
      { pubkey: "5".repeat(64), name: "Ada Lovelace" },
    ];
    expect(resolveFromAuthor("ada", candidates)).toEqual({
      status: "resolved",
      value: "5".repeat(64),
    });
  });

  it("passes a hex pubkey through, lowercased", () => {
    expect(resolveFromAuthor("A".repeat(64), [])).toEqual({
      status: "resolved",
      value: "a".repeat(64),
    });
  });

  it("reports unresolved for a handle nobody answers to", () => {
    expect(resolveFromAuthor("zebediah", authors)).toEqual({ status: "unresolved" });
  });
});

describe("buildSearchRequest", () => {
  const directory = {
    channels: [{ channelId: HEX, name: "design", displayName: "Design" }],
    authors: [{ pubkey: "1".repeat(64), name: "Ada" }],
  };

  it("builds a structured request from a full query", () => {
    const parsed = parseSearchQuery("in:design from:ada after:2026-01-01 button");
    expect(buildSearchRequest(parsed, directory)).toEqual({
      text: "button",
      channelIds: [HEX],
      authors: ["1".repeat(64)],
      since: localDay(2026, 1, 1),
    });
  });

  it("omits the keys whose operators were not used", () => {
    expect(buildSearchRequest(parseSearchQuery("button"), directory)).toEqual({
      text: "button",
    });
  });

  it("returns null — never a widened query — when in: cannot be resolved", () => {
    // Rule 93, and the single most important assertion in this file: the
    // alternative to "no results" is not "all results".
    expect(buildSearchRequest(parseSearchQuery("in:acquisitions button"), directory)).toBeNull();
  });

  it("returns null when from: cannot be resolved", () => {
    expect(buildSearchRequest(parseSearchQuery("from:nobody button"), directory)).toBeNull();
  });

  it("names which operator failed, so the surface can say so", () => {
    expect(unresolvedOperator(parseSearchQuery("button"), directory)).toBeNull();
    expect(unresolvedOperator(parseSearchQuery("in:design button"), directory)).toBeNull();
    expect(unresolvedOperator(parseSearchQuery("in:nowhere button"), directory)).toBe("in");
    expect(unresolvedOperator(parseSearchQuery("from:nobody button"), directory)).toBe("from");
    // Both wrong: the room is reported, being the narrower of the two.
    expect(
      unresolvedOperator(parseSearchQuery("in:nowhere from:nobody"), directory),
    ).toBe("in");
  });
});
