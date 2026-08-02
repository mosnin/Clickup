import { describe, expect, it } from "vitest";
import {
  SCORE_NAME_EXACT,
  SCORE_NAME_PREFIX,
  SCORE_WORD_EXACT,
  SCORE_WORD_PREFIX,
  SCORE_NAME_SUBSTRING,
  SCORE_COLLAPSED_SUBSTRING,
  SCORE_COLLAPSED_SUBSEQUENCE,
  SCORE_DESCRIPTION,
  browseChannels,
  canonicalChannelName,
  channelIsBrowsable,
  channelMatchesTab,
  channelNamesMatch,
  createRowIsOffered,
  moveSelection,
  navGeometry,
  scoreChannelMatch,
} from "@/lib/buzz/channel-search";
import type { ChatChannelSummary } from "@/lib/buzz/channel-types";

// The scorer is the executable answer to "why is this result above that one".
// Every band gets a case here, in order, because the file's whole value is
// that the ranking is arguable rather than magic — and an argument about a
// band is an argument about a line in this file.

function channel(over: Partial<ChatChannelSummary> = {}): ChatChannelSummary {
  return {
    channelId: over.name ?? "c1",
    name: "release-notes",
    displayName: "Release notes",
    kind: "channel",
    visibility: "public",
    memberCount: 3,
    unread: 0,
    mentions: 0,
    muted: false,
    joined: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

describe("canonicalChannelName", () => {
  it("strips the display-only '#' — storage never holds it", () => {
    expect(canonicalChannelName("#general")).toBe("general");
    expect(canonicalChannelName("  ## general")).toBe("general");
  });

  it("collapses every separator to one dash, so one room has one name", () => {
    expect(canonicalChannelName("Release Notes")).toBe("release-notes");
    expect(canonicalChannelName("release_notes")).toBe("release-notes");
    expect(canonicalChannelName("release.notes")).toBe("release-notes");
    expect(canonicalChannelName("release   notes")).toBe("release-notes");
  });

  it("drops a trailing dash, so a space bar mid-word does not empty the list", () => {
    // Typing "release " is a normal thing to do halfway through "release notes".
    // A canonical form of "release-" matches nothing at all, which reads as the
    // browser breaking on the space bar.
    expect(canonicalChannelName("release ")).toBe("release");
    expect(canonicalChannelName("-release-")).toBe("release");
  });

  it("treats a query of only punctuation as empty", () => {
    expect(canonicalChannelName("#")).toBe("");
    expect(canonicalChannelName("   ")).toBe("");
  });
});

describe("channelNamesMatch", () => {
  it("compares canonically, so '#Release Notes' is the existing room", () => {
    expect(channelNamesMatch("#Release Notes", "release-notes")).toBe(true);
  });

  it("never says two empty names match — that would suppress the create row", () => {
    expect(channelNamesMatch("", "")).toBe(false);
    expect(channelNamesMatch("#", "general")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The eight bands, in order
// ---------------------------------------------------------------------------

describe("the eight scoring bands", () => {
  it("band 0 — the name exactly equals the query", () => {
    expect(scoreChannelMatch({ name: "release-notes" }, "release-notes")).toBe(
      SCORE_NAME_EXACT,
    );
    // And through canonicalisation, so typing it the human way still lands here.
    expect(scoreChannelMatch({ name: "release-notes" }, "#Release Notes")).toBe(
      SCORE_NAME_EXACT,
    );
  });

  it("band 1 — the name starts with the query", () => {
    expect(scoreChannelMatch({ name: "release-notes" }, "rele")).toBe(
      SCORE_NAME_PREFIX,
    );
  });

  it("band 2 — a word of the name equals the query", () => {
    expect(scoreChannelMatch({ name: "release-notes" }, "notes")).toBe(
      SCORE_WORD_EXACT,
    );
  });

  it("band 3 — a word of the name starts with the query", () => {
    expect(scoreChannelMatch({ name: "release-notes" }, "not")).toBe(
      SCORE_WORD_PREFIX,
    );
  });

  it("band 4 — the name contains the query mid-word", () => {
    expect(scoreChannelMatch({ name: "release-notes" }, "eas")).toBe(
      SCORE_NAME_SUBSTRING,
    );
  });

  it("band 5 — the collapsed name contains the collapsed query", () => {
    // Not knowing where the dashes go is not a typo.
    expect(scoreChannelMatch({ name: "release-notes" }, "releasenotes")).toBe(
      SCORE_COLLAPSED_SUBSTRING,
    );
    expect(scoreChannelMatch({ name: "release-notes" }, "asenot")).toBe(
      SCORE_COLLAPSED_SUBSTRING,
    );
  });

  it("band 6 — the collapsed query is an in-order subsequence", () => {
    expect(scoreChannelMatch({ name: "release-notes" }, "reln")).toBe(
      SCORE_COLLAPSED_SUBSEQUENCE,
    );
  });

  it("band 6 needs two characters — one letter is a subsequence of everything", () => {
    // A single letter would turn the first keystroke into an unranked list of
    // the whole workspace, which is worse than no result at all.
    expect(scoreChannelMatch({ name: "release-notes" }, "z")).toBeNull();
    expect(scoreChannelMatch({ name: "xyz-abc" }, "x")).toBe(SCORE_NAME_PREFIX);
  });

  it("band 7 — the description contains the query, matched as plain text", () => {
    expect(
      scoreChannelMatch(
        { name: "shipping", description: "Where we announce release notes." },
        "release notes",
      ),
    ).toBe(SCORE_DESCRIPTION);
  });

  it("never fuzzy-matches a description — prose subsequences match everything", () => {
    expect(
      scoreChannelMatch(
        { name: "shipping", description: "Where we announce release notes." },
        "reln",
      ),
    ).toBeNull();
  });

  it("returns null when nothing matches at all", () => {
    expect(scoreChannelMatch({ name: "release-notes" }, "budget")).toBeNull();
  });

  it("scores everything 0 for an empty query, so 'no search' is not a special case", () => {
    expect(scoreChannelMatch({ name: "release-notes" }, "")).toBe(SCORE_NAME_EXACT);
    expect(scoreChannelMatch({ name: "anything" }, "  #  ")).toBe(SCORE_NAME_EXACT);
  });

  it("has no typo tolerance, deliberately", () => {
    // `relaese` is one transposition from `release`. A Levenshtein scorer would
    // rank it; we refuse, because typo tolerance also reorders the results a
    // person can plainly see.
    expect(scoreChannelMatch({ name: "release-notes" }, "relaese")).toBeNull();
  });

  it("puts the bands in the order the constants claim", () => {
    expect([
      SCORE_NAME_EXACT,
      SCORE_NAME_PREFIX,
      SCORE_WORD_EXACT,
      SCORE_WORD_PREFIX,
      SCORE_NAME_SUBSTRING,
      SCORE_COLLAPSED_SUBSTRING,
      SCORE_COLLAPSED_SUBSEQUENCE,
      SCORE_DESCRIPTION,
    ]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("exact match wins", () => {
  it("puts the room you named first, whatever the sort mode wanted", () => {
    // `design` is alphabetically after `design-system` is *not* true — the
    // point is the other way round: alpha order puts `design` first anyway, so
    // the honest test loads the sort against the exact match.
    const exact = channel({ channelId: "x", name: "design", memberCount: 1 });
    const prefix = channel({ channelId: "y", name: "design-system", memberCount: 99 });
    const ranked = browseChannels([prefix, exact], {
      query: "design",
      tab: "all",
      sort: "members", // would put design-system first
    });
    expect(ranked.map((c) => c.channelId)).toEqual(["x", "y"]);
  });

  it("keeps the chosen sort order inside a band — the re-sort is stable", () => {
    const a = channel({ channelId: "a", name: "design-ops", memberCount: 2 });
    const b = channel({ channelId: "b", name: "design-system", memberCount: 40 });
    expect(
      browseChannels([a, b], { query: "design", tab: "all", sort: "members" }).map(
        (c) => c.channelId,
      ),
    ).toEqual(["b", "a"]);
    expect(
      browseChannels([a, b], { query: "design", tab: "all", sort: "alpha" }).map(
        (c) => c.channelId,
      ),
    ).toEqual(["a", "b"]);
  });

  it("orders a full ladder of bands correctly in one list", () => {
    const rooms = [
      channel({ channelId: "desc", name: "shipping", description: "notes about notes" }),
      channel({ channelId: "subseq", name: "no-other-eels" }),
      channel({ channelId: "word", name: "release-notes" }),
      channel({ channelId: "exact", name: "notes" }),
      channel({ channelId: "prefix", name: "notes-archive" }),
    ];
    expect(
      browseChannels(rooms, { query: "notes", tab: "all", sort: "alpha" }).map(
        (c) => c.channelId,
      ),
    ).toEqual(["exact", "prefix", "word", "subseq", "desc"]);
  });
});

// ---------------------------------------------------------------------------
// Visibility — the rule that is a safety rule
// ---------------------------------------------------------------------------

describe("the visibility predicate", () => {
  it("never lists a private room to someone who is not in it", () => {
    // The room's *name* is the leak: a browser that shows it has disclosed the
    // existence of work the person is not part of, and no join button undoes it.
    const secret = channel({ name: "layoffs", visibility: "private", joined: false });
    expect(channelIsBrowsable(secret)).toBe(false);
    expect(
      browseChannels([secret], { query: "", tab: "all", sort: "alpha" }),
    ).toEqual([]);
    // Not even when searched for by its exact name.
    expect(
      browseChannels([secret], { query: "layoffs", tab: "all", sort: "alpha" }),
    ).toEqual([]);
    // Not on any tab.
    for (const tab of ["all", "joined", "archived"] as const) {
      expect(browseChannels([secret], { query: "", tab, sort: "alpha" })).toEqual([]);
    }
  });

  it("lists a private room to its members", () => {
    expect(
      channelIsBrowsable(channel({ visibility: "private", joined: true })),
    ).toBe(true);
  });

  it("lists an open room to everyone", () => {
    expect(channelIsBrowsable(channel({ visibility: "public", joined: false }))).toBe(
      true,
    );
  });

  it("hides an archived room from non-members even when it is public", () => {
    // Archiving is how a room leaves the commons; staying discoverable to
    // people who were never in it would make archiving cosmetic.
    const shut = channel({ visibility: "public", joined: false, archivedAt: 1 });
    expect(channelIsBrowsable(shut)).toBe(false);
    expect(channelIsBrowsable({ ...shut, joined: true })).toBe(true);
  });

  it("never lists a DM or a group DM — you do not browse a conversation", () => {
    expect(channelIsBrowsable(channel({ kind: "dm", joined: true }))).toBe(false);
    expect(channelIsBrowsable(channel({ kind: "group_dm", joined: true }))).toBe(false);
  });

  it("honours a kind filter", () => {
    expect(channelIsBrowsable(channel({ kind: "forum" }), "channel")).toBe(false);
    expect(channelIsBrowsable(channel({ kind: "forum" }), "forum")).toBe(true);
  });
});

describe("the tabs partition what visibility already allowed", () => {
  const joinedOpen = channel({ channelId: "j", joined: true });
  const unjoinedOpen = channel({ channelId: "u", joined: false });
  const archivedMine = channel({ channelId: "a", joined: true, archivedAt: 1 });

  it("'joined' is unarchived and yours", () => {
    expect(channelMatchesTab(joinedOpen, "joined")).toBe(true);
    expect(channelMatchesTab(unjoinedOpen, "joined")).toBe(false);
    expect(channelMatchesTab(archivedMine, "joined")).toBe(false);
  });

  it("'archived' is exactly the archived ones", () => {
    expect(channelMatchesTab(archivedMine, "archived")).toBe(true);
    expect(channelMatchesTab(joinedOpen, "archived")).toBe(false);
  });

  it("'all' really means all of them, archived included", () => {
    const all = browseChannels([joinedOpen, unjoinedOpen, archivedMine], {
      query: "",
      tab: "all",
      sort: "alpha",
    });
    expect(all).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe("sort modes", () => {
  const rooms = [
    channel({ channelId: "b", name: "beta", memberCount: 2, lastActivityAt: 300 }),
    channel({ channelId: "a", name: "alpha", memberCount: 9, lastActivityAt: 100 }),
    channel({ channelId: "c", name: "gamma", memberCount: 5, lastActivityAt: 200 }),
  ];
  const ids = (sort: "alpha" | "recent" | "members") =>
    browseChannels(rooms, { query: "", tab: "all", sort }).map((c) => c.channelId);

  it("alpha sorts by name", () => expect(ids("alpha")).toEqual(["a", "b", "c"]));
  it("recent sorts by last activity, newest first", () =>
    expect(ids("recent")).toEqual(["b", "c", "a"]));
  it("members sorts by member count, largest first", () =>
    expect(ids("members")).toEqual(["a", "c", "b"]));

  it("puts a room that has never been spoken in last under 'recent'", () => {
    const quiet = channel({ channelId: "q", name: "quiet" });
    expect(
      browseChannels([quiet, ...rooms], { query: "", tab: "all", sort: "recent" }).at(
        -1,
      )?.channelId,
    ).toBe("q");
  });
});

// ---------------------------------------------------------------------------
// The create row and the keyboard geometry
// ---------------------------------------------------------------------------

describe("the create row", () => {
  const general = channel({ channelId: "g", name: "general" });

  it("is offered with an empty query, so the dialog says it can make one", () => {
    expect(createRowIsOffered({ channels: [general], query: "" })).toBe(true);
  });

  it("is offered for a name nothing carries", () => {
    expect(createRowIsOffered({ channels: [general], query: "roadmap" })).toBe(true);
  });

  it("is NOT offered for a name that already exists, however it was typed", () => {
    expect(createRowIsOffered({ channels: [general], query: "general" })).toBe(false);
    expect(createRowIsOffered({ channels: [general], query: "#General " })).toBe(false);
  });

  it("counts a room you filtered out of view as a name already taken", () => {
    // Offering it would just produce a refusal from the server instead of a room.
    const archived = channel({ channelId: "x", name: "retro", joined: true, archivedAt: 5 });
    expect(createRowIsOffered({ channels: [archived], query: "retro" })).toBe(false);
  });

  it("ignores a DM with the same name — DMs are not in the name space", () => {
    const dm = channel({ channelId: "d", name: "ada", kind: "dm", joined: true });
    expect(createRowIsOffered({ channels: [dm], query: "ada" })).toBe(true);
  });

  it("disappears entirely when creation is not available", () => {
    expect(createRowIsOffered({ channels: [], query: "x", canCreate: false })).toBe(
      false,
    );
  });
});

describe("keyboard geometry", () => {
  it("makes the create row virtual index 0 and shifts channels down by one", () => {
    expect(navGeometry({ createRowShown: true, resultCount: 3 })).toEqual({
      offset: 1,
      count: 4,
    });
    expect(navGeometry({ createRowShown: false, resultCount: 3 })).toEqual({
      offset: 0,
      count: 3,
    });
  });

  it("moves down from nothing to the first item — the create row", () => {
    expect(moveSelection(null, 1, 4)).toBe(0);
  });

  it("moves up from nothing to the last item", () => {
    expect(moveSelection(null, -1, 4)).toBe(3);
  });

  it("clamps at both ends rather than wrapping", () => {
    // Wrapping past the end lands you on "create" when you were looking for the
    // bottom of a long list, which is the one row you did not mean to press.
    expect(moveSelection(3, 1, 4)).toBe(3);
    expect(moveSelection(0, -1, 4)).toBe(0);
  });

  it("selects nothing when there is nothing to select", () => {
    expect(moveSelection(null, 1, 0)).toBeNull();
  });
});
