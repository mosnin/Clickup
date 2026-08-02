import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The transcript's contract.
//
// jsdom cannot say whether a room reads well — that is what the gallery shots
// are for, and they were looked at. What it *can* say, and what breaks
// silently, is the set of rules the transcript IS: which pill lights up before
// the server answers, whether a delete waits for its undo window, what order
// the more-menu is in and which of its items a stranger's message is allowed to
// show, whether paging counts rows or events. Every one of those has exactly
// one right answer and no visual signal when it is wrong.
//
// The mocks are local rather than the shared `tests/ui/harness.tsx`, for the
// same reason `chat-shell.test.tsx` states — and it was measured rather than
// assumed. The harness keys `useQuery` on `ref.__path`, which only the
// generated `api` proxy carries; every Chat query is addressed with
// `makeFunctionReference` (the checked-in `api` stub does not know `api.buzz.*`
// until somebody runs `npx convex dev`) and those carry their name on a symbol.
// Importing the harness *and* declaring a local `convex/react` mock does not
// work: the local factory wins for the test file's own imports and the
// harness's wins for everything under `src/`, so the component under test would
// read a map this file cannot address. One set of mocks, keyed on the real
// `getFunctionName`, means the test names the function the component calls.
//
// The toast recorder below is deliberately the same shape as the harness's,
// because the assertion it exists for is the same one: this app's destructive
// actions are DEFERRED, so a test that only checked "the mutation was called"
// would pass on a delete that fires immediately — the exact bug the pattern
// prevents. The tests fire `onExpire` themselves and assert both sides of it.

type ToastCall = {
  message: string;
  opts?: {
    kind?: string;
    action?: { label: string; onClick: () => void };
    onExpire?: () => void;
  };
};

const state = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  throwing: new Set<string>(),
  mutations: [] as { name: string; args: unknown }[],
  toasts: [] as {
    message: string;
    opts?: {
      kind?: string;
      action?: { label: string; onClick: () => void };
      onExpire?: () => void;
    };
  }[],
  search: "",
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  type Ref = Parameters<typeof getFunctionName>[0];
  return {
    useQuery: (ref: Ref, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(ref);
      // A query against a function the deployment does not have throws during
      // render — the exact failure the transcript's boundary exists for.
      if (state.throwing.has(name)) {
        throw new Error(`Could not find public function ${name}`);
      }
      const key = keyFor(name, args);
      return key in state.queries ? state.queries[key] : state.queries[name];
    },
    useMutation: (ref: Ref) => {
      const name = getFunctionName(ref);
      return async (args: unknown) => {
        state.mutations.push({ name, args });
        return undefined;
      };
    },
    useAction: () => async () => undefined,
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/chat/c/flight-path",
  // The deep-link test has to SET a search parameter, which a fixed empty
  // `URLSearchParams` cannot express.
  useSearchParams: () => new URLSearchParams(state.search),
}));

vi.mock("@/components/toast", async () => {
  const react = await import("react");
  return {
    useToast: () => ({
      toast: (message: string, opts?: unknown) => {
        state.toasts.push({ message, opts: opts as never });
      },
    }),
    ToastProvider: ({ children }: { children: React.ReactNode }) =>
      react.createElement(react.Fragment, null, children),
  };
});

/** Pages are addressed by cursor, so a fixture can answer page 2 differently. */
function keyFor(name: string, args: unknown): string {
  const cursor = (args as { cursor?: string } | undefined)?.cursor;
  return cursor ? `${name}?${cursor}` : name;
}

import { ChannelTranscript } from "@/components/chat/transcript/transcript";
import { MyPubkeyProvider } from "@/components/chat/transcript/messages-data";
import {
  applyOptimisticReaction,
  selectDisplayReactions,
} from "@/components/chat/transcript/reaction-algebra";
import {
  buildMessageLink,
  parseMessageLink,
} from "@/components/chat/transcript/message-link";
import {
  canManageMessage,
  classifyDelta,
  countMessageRows,
  historyExhausted,
  needsAnotherPage,
  nextLoadingLatch,
  rowKey,
} from "@/components/chat/transcript/row-model";
import { buildThreadSummaries } from "@/components/chat/transcript/thread-summary";
import { formatDayHeading } from "@/components/chat/transcript/date-labels";
import type { ChatReaction, ChatRow } from "@/lib/buzz/message-types";
import type { TimelineEvent } from "@/lib/buzz/timeline";
import { formatTimelineMessages } from "@/lib/buzz/timeline";
import { NonMessageRow } from "@/components/chat/transcript/dividers";

const toastCalls: ToastCall[] = state.toasts;

// ---------------------------------------------------------------------------
// Fixtures — raw signed events, because that is what the surface consumes
// ---------------------------------------------------------------------------

const ME = "aa".repeat(32);
const ADA = "bb".repeat(32);
const FIZZ = "cc".repeat(32);

const NOW = Math.floor(Date.parse("2026-04-02T14:34:00Z") / 1000);

/**
 * A real-shaped event id.
 *
 * Not decoration: the projector validates every `e` tag against 64 hex
 * characters (`asEventId`) precisely so a malformed reference cannot turn a
 * quoted link into a thread parent. Fixtures with ids like `"m1"` would be
 * silently dropped by that check and the test would be asserting against a
 * shape the app never sees.
 */
function eid(name: string): string {
  const hex = [...name]
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
  return (hex + "0".repeat(64)).slice(0, 64);
}

function message(
  id: string,
  pubkey: string,
  content: string,
  over: Partial<TimelineEvent> = {},
): TimelineEvent {
  return {
    id: eid(id),
    pubkey,
    kind: 9,
    created_at: NOW,
    tags: [["h", "flight-path"]],
    content,
    sig: "0".repeat(128),
    ...over,
  };
}

function reply(
  id: string,
  pubkey: string,
  content: string,
  rootId: string,
  parentId = rootId,
  over: Partial<TimelineEvent> = {},
): TimelineEvent {
  return message(id, pubkey, content, {
    tags: [
      ["h", "flight-path"],
      ["e", eid(rootId), "", "root"],
      ["e", eid(parentId), "", "reply"],
    ],
    ...over,
  });
}

function reaction(
  id: string,
  pubkey: string,
  emoji: string,
  targetId: string,
  at = NOW,
): TimelineEvent {
  return {
    id: eid(id),
    pubkey,
    kind: 7,
    created_at: at,
    tags: [
      ["h", "flight-path"],
      ["e", eid(targetId)],
    ],
    content: emoji,
    sig: "0".repeat(128),
  };
}

const ACTORS = [
  { pubkey: ME, label: "You" },
  { pubkey: ADA, label: "Ada Lovelace" },
  { pubkey: FIZZ, label: "Fizz", isAgent: true, ownerLabel: "Ada Lovelace" },
];

/**
 * The same actors as a directory.
 *
 * The window carries a LIST (that is the wire shape) and the projector takes a
 * MAP; the transcript is the thing that converts between them, so a test
 * calling the projector directly has to do the same conversion rather than
 * hand it the wire shape and quietly get truncated pubkeys back.
 */
const DIRECTORY = new Map(ACTORS.map((a) => [a.pubkey, a]));

function seedWindow(events: TimelineEvent[], nextCursor?: string) {
  state.queries["buzz/messages:list"] = {
    events,
    actors: ACTORS,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function mount(
  props: Partial<React.ComponentProps<typeof ChannelTranscript>> = {},
) {
  return render(
    <MyPubkeyProvider>
      <ChannelTranscript
        scope={{ scopeType: "workspace", scopeId: "w1" }}
        channelId="flight-path"
        channelLabel="#flight-path"
        {...props}
      />
    </MyPubkeyProvider>,
  );
}

function calls(name: string) {
  return state.mutations.filter((m) => m.name === name).map((m) => m.args);
}

/**
 * The pill for an emoji.
 *
 * Scanned rather than selected, because jsdom's CSS engine cannot match an
 * astral character inside an attribute selector — `[data-reaction="👍"]`
 * returns null against markup that plainly contains it (verified: the element
 * is found by `[data-reaction]` and its attribute reads back correctly). A test
 * that used the selector would report a missing pill and send somebody hunting
 * through the optimistic algebra for a bug that is in the DOM shim.
 */
function pill(emoji: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>("[data-reaction]")].find(
      (el) => el.getAttribute("data-reaction") === emoji,
    ) ?? null
  );
}

beforeEach(() => {
  state.queries = { "buzz/identity:myPubkey": { pubkey: ME } };
  state.throwing = new Set();
  state.mutations.length = 0;
  state.toasts.length = 0;
  state.search = "";
});

// ---------------------------------------------------------------------------
// §3.2 Reaction algebra — the pill moves first, and reconciles without flicker
// ---------------------------------------------------------------------------

describe("optimistic reaction algebra", () => {
  const pill = (over: Partial<ChatReaction> = {}): ChatReaction => ({
    emoji: "❤️",
    count: 2,
    mine: false,
    reactors: ["Ada Lovelace", "Fizz"],
    firstAt: NOW,
    ...over,
  });

  it("appends a brand-new pill at the END, never in sorted position", () => {
    // Chronological order belongs to the projector (pills are ordered by
    // `firstAt`). A helper that inserted "correctly" would put the pill
    // somewhere the real answer then moves it away from — a visible jump.
    const next = applyOptimisticReaction([pill()], "🎉", false, { now: NOW - 500 });
    expect(next.map((r) => r.emoji)).toEqual(["❤️", "🎉"]);
    expect(next[1]).toMatchObject({ count: 1, mine: true, reactors: ["You"] });
  });

  it("adds to an existing pill and puts You first", () => {
    const next = applyOptimisticReaction([pill()], "❤️", false);
    expect(next[0].count).toBe(3);
    expect(next[0].mine).toBe(true);
    expect(next[0].reactors[0]).toBe("You");
  });

  it("is a no-op when the reader has already reacted", () => {
    // A fast double-click must not double-count.
    const already = [pill({ mine: true, count: 3, reactors: ["You", "Ada Lovelace"] })];
    expect(applyOptimisticReaction(already, "❤️", false)[0].count).toBe(3);
  });

  it("removes the reader and drops the pill when the count reaches zero", () => {
    const only = [pill({ mine: true, count: 1, reactors: ["You"] })];
    expect(applyOptimisticReaction(only, "❤️", true)).toEqual([]);
  });

  it("refuses to remove a reaction the reader never gave", () => {
    expect(applyOptimisticReaction([pill()], "❤️", true)[0].count).toBe(2);
  });

  it("discards the overlay the moment the projector emits a new array", () => {
    // The identity check is the whole reconciliation strategy: no timer, no
    // diff, and no window where a stale guess and a fresh truth are both drawn.
    const source = [pill()];
    const overlay = { source, value: applyOptimisticReaction(source, "❤️", false) };
    expect(selectDisplayReactions(overlay, source)[0].count).toBe(3);
    const fresh = [pill({ count: 3, mine: true })];
    expect(selectDisplayReactions(overlay, fresh)).toBe(fresh);
  });
});

// ---------------------------------------------------------------------------
// §2.9 Links
// ---------------------------------------------------------------------------

describe("message links", () => {
  it("round-trips a channel, a message and a thread", () => {
    const href = buildMessageLink({
      channelId: "flight-path",
      messageId: "abc",
      threadRootId: "root1",
      origin: "https://operate.to",
    });
    expect(href).toBe("https://operate.to/chat/c/flight-path?m=abc&thread=root1");
    const parsed = parseMessageLink(href);
    expect(parsed.ok && parsed.value).toEqual({
      channelId: "flight-path",
      messageId: "abc",
      threadRootId: "root1",
    });
  });

  it("treats an empty thread root as no thread, so callers need no conditional", () => {
    expect(
      buildMessageLink({ channelId: "c", messageId: "m", threadRootId: "" }),
    ).toBe("/chat/c/c?m=m");
  });

  it("answers 'no' as a value rather than throwing on somebody else's link", () => {
    // Bodies contain link-shaped strings all day; the renderer needs a result,
    // not an exception.
    expect(parseMessageLink("https://example.com/x")).toEqual({
      ok: false,
      reason: "wrong-path",
    });
    expect(parseMessageLink("/chat/c/general")).toEqual({
      ok: false,
      reason: "missing-id",
    });
  });
});

// ---------------------------------------------------------------------------
// §2.8 Rows, keys, paging
// ---------------------------------------------------------------------------

describe("the row model", () => {
  it("namespaces keys so a divider cannot inherit a message's measurement", () => {
    const day: ChatRow = { type: "day", at: 1000 };
    const sys: ChatRow = { type: "system", id: "1000", at: 1000, text: "x" };
    const group: ChatRow = {
      type: "system-group",
      id: "1000",
      at: 1000,
      kind: "joined",
      actors: ["Ada"],
      text: "3 people joined",
    };
    expect(new Set([rowKey(day), rowKey(sys), rowKey(group)]).size).toBe(3);
  });

  it("pages against visible rows, not against events", () => {
    // The bug this is: fifty events in a busy room can be forty-eight replies
    // and reactions and two rows. Paging on the event count declares the
    // timeline full while the reader is looking at a screen of white.
    const rows = formatTimelineMessages(
      [
        message("m1", ADA, "one"),
        ...Array.from({ length: 40 }, (_, i) =>
          reply(`r${i}`, ADA, `reply ${i}`, "m1"),
        ),
      ],
      {},
    );
    expect(rows.length).toBe(41);
    const timeline: ChatRow[] = [{ type: "message", message: rows[0], grouped: false }];
    expect(countMessageRows(timeline)).toBe(1);
    expect(needsAnotherPage({ visibleRowCount: 1, hasMore: true })).toBe(true);
    expect(needsAnotherPage({ visibleRowCount: 1, hasMore: false })).toBe(false);
    expect(needsAnotherPage({ visibleRowCount: 20, hasMore: true })).toBe(false);
  });

  it("separates 'no more' from 'we have proved the beginning'", () => {
    // Only a resolved page may claim a channel's start; an unloaded window
    // also reports no-more, and drawing the oldest day divider on that basis
    // is a lie about a room nobody has read yet.
    expect(historyExhausted({ resolvedPages: 0, hasMore: false })).toBe(false);
    expect(historyExhausted({ resolvedPages: 1, hasMore: false })).toBe(true);
  });

  it("calls an exact-suffix growth a prepend and nothing else", () => {
    // A prepend must never pin the reader to the bottom.
    expect(classifyDelta({ previous: ["b", "c"], current: ["a", "b", "c"] })).toBe(
      "prepend",
    );
    expect(classifyDelta({ previous: ["a", "b"], current: ["a", "b", "c"] })).toBe(
      "append",
    );
    expect(classifyDelta({ previous: ["a", "b"], current: ["x", "b", "y"] })).toBe(
      "replace",
    );
    expect(classifyDelta({ previous: ["a"], current: ["a"] })).toBe("none");
  });

  it("never re-shows the skeleton for a channel that already settled", () => {
    let latch = { channelId: null as string | null, settled: false };
    latch = nextLoadingLatch(latch, "general", true);
    expect(latch.settled).toBe(false);
    latch = nextLoadingLatch(latch, "general", false);
    expect(latch.settled).toBe(true);
    // A background refetch must not blank a list that is right there.
    latch = nextLoadingLatch(latch, "general", true);
    expect(latch.settled).toBe(true);
    // A different room genuinely has not loaded.
    latch = nextLoadingLatch(latch, "design", true);
    expect(latch.settled).toBe(false);
  });

  it("refuses edit and delete on a huddle row whoever wrote it", () => {
    expect(canManageMessage({ kind: 48100, mine: true, pubkey: ME })).toBe(false);
    expect(canManageMessage({ kind: 9, mine: true, pubkey: ME })).toBe(true);
    expect(canManageMessage({ kind: 9, mine: false, pubkey: FIZZ })).toBe(false);
    expect(
      canManageMessage(
        { kind: 9, mine: false, pubkey: FIZZ.toUpperCase() },
        { ownedAgentPubkeys: [FIZZ] },
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §2.3 Thread summaries
// ---------------------------------------------------------------------------

describe("thread summaries", () => {
  it("counts the whole subtree and draws the newest replier rightmost", () => {
    const messages = formatTimelineMessages(
      [
        message("root", ADA, "shall we ship"),
        reply("r1", FIZZ, "checking CI", "root", "root", { created_at: NOW + 10 }),
        reply("r2", ME, "looks green", "root", "r1", { created_at: NOW + 20 }),
        reply("r3", ADA, "then yes", "root", "r2", { created_at: NOW + 30 }),
      ],
      { selfPubkey: ME, actors: DIRECTORY },
    );
    const summary = buildThreadSummaries(messages).get(eid("root"));
    // Three, not one: a nested reply is still a reply to the thread, and "1
    // reply" on a conversation four deep is the number nobody wants.
    expect(summary?.replyCount).toBe(3);
    expect(summary?.participants.map((p) => p.label)).toEqual(["Fizz", "You", "Ada Lovelace"]);
    expect(summary?.lastReplyAt).toBe(NOW + 30);
  });

  it("keeps at most three faces, dropping the oldest repliers", () => {
    const events = [message("root", ADA, "poll")];
    for (let i = 0; i < 5; i += 1) {
      events.push(
        reply(`r${i}`, `${i}${i}`.repeat(32), `+1`, "root", "root", {
          created_at: NOW + i,
        }),
      );
    }
    const summary = buildThreadSummaries(
      formatTimelineMessages(events, {}),
    ).get(eid("root"));
    expect(summary?.replyCount).toBe(5);
    expect(summary?.participants).toHaveLength(3);
  });

  it("terminates on a cycle instead of hanging the render", () => {
    // Reply ids come from events this client did not create; a loop in them
    // must cost a bounded walk, not a frozen tab.
    const messages = formatTimelineMessages(
      [
        reply("a", ADA, "one", "a", "b"),
        reply("b", ADA, "two", "b", "a"),
      ],
      {},
    );
    const summaries = buildThreadSummaries(messages);
    expect(summaries.get(eid("a"))?.replyCount).toBeLessThanOrEqual(messages.length + 1);
  });
});

describe("day headings", () => {
  it("resolves against the current clock rather than baking a label", () => {
    const day = Math.floor(Date.parse("2026-04-02T12:00:00Z") / 1000);
    expect(formatDayHeading(day, day)).toBe("Today");
    expect(formatDayHeading(day, day + 86_400)).toBe("Yesterday");
    expect(formatDayHeading(day, day + 5 * 86_400)).toMatch(/April 2nd/);
  });
});

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

describe("the transcript surface", () => {
  it("holds a skeleton while the first page is in flight, never an empty room", () => {
    // "We have data" is not "we have loaded". Showing "No messages yet" over a
    // list about to stream in is the flash this guards.
    mount();
    expect(screen.getByTestId("message-skeleton")).toBeTruthy();
    expect(screen.queryByTestId("message-empty")).toBeNull();
  });

  it("says the room is empty only once a page has actually resolved", () => {
    seedWindow([]);
    mount();
    const empty = screen.getByTestId("message-empty");
    expect(empty.textContent).toContain("No messages yet");
    expect(empty.textContent).toContain("#flight-path");
  });

  it("names what is missing when the log cannot be read", () => {
    // Not "something went wrong": "Could not find public function
    // buzz/messages:list" tells whoever is looking exactly what is missing.
    state.throwing.add("buzz/messages:list");
    mount();
    expect(screen.getByText(/Messages aren't loading/)).toBeTruthy();
    expect(screen.getByText(/buzz\/messages:list/)).toBeTruthy();
  });

  it("groups a follow-up from the same author and gives it no second header", () => {
    seedWindow([
      message("m1", ADA, "morning"),
      message("m2", ADA, "one more thing", { created_at: NOW + 60 }),
      message("m3", FIZZ, "on it", { created_at: NOW + 120 }),
    ]);
    mount();
    const rows = document.querySelectorAll("[data-message-id]");
    expect(rows.length).toBe(3);
    expect(rows[0].getAttribute("data-grouped")).toBe("false");
    expect(rows[1].getAttribute("data-grouped")).toBe("true");
    // A different author always starts a new block, however close in time.
    expect(rows[2].getAttribute("data-grouped")).toBe("false");
    expect(screen.getAllByText("Ada Lovelace")).toHaveLength(1);
  });

  it("draws the unread divider above the first unread message", () => {
    seedWindow([
      message("m1", ADA, "seen"),
      message("m2", ADA, "not seen", { created_at: NOW + 600 }),
    ]);
    mount({ firstUnreadId: eid("m2"), unreadCount: 1 });
    expect(document.querySelector('[data-row="unread"]')?.textContent).toContain(
      "1 new",
    );
  });

  it("folds a run of system events and expands it to the people in it", () => {
    // The projector composes the sentence; this row must not write a second
    // one, and must not hide the members behind the summary.
    const { container } = render(
      <NonMessageRow
        row={{
          type: "system-group",
          id: "g1",
          at: NOW,
          kind: "joined",
          actors: ["Ada Lovelace", "Fizz", "Priya Shah", "Jordan Brooks"],
          text: "4 people joined the channel",
        }}
      />,
    );
    const toggle = within(container).getByRole("button");
    expect(toggle.textContent).toContain("4 people joined the channel");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(container).getByText("Jordan Brooks")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// §3.1 / §3.4 Actions
// ---------------------------------------------------------------------------

describe("the hover toolbar and its menu", () => {
  it("offers edit and delete on your own message, in the spec's order", () => {
    seedWindow([message("m1", ME, "mine")]);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    const items = screen
      .getByRole("menu", { name: "Message actions" })
      .querySelectorAll("[data-menu-item]");
    expect([...items].map((el) => el.textContent)).toEqual([
      "Edit message",
      "Copy message",
      // C12's slot 5b: the bridge sits with the other "do something with this
      // message" verbs rather than in a toolbar of its own.
      "Make a task\u2026",
      "Copy link",
      // Slot 8, and the 8b beside it: both are "this message reached me
      // wrongly", and both sit after the separator with Delete.
      "Report message",
      "Why this notified me",
      "Delete message",
    ]);
  });

  it("offers a stranger's message the copy actions and the bridge", () => {
    seedWindow([message("m1", ADA, "theirs")]);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    const items = screen
      .getByRole("menu", { name: "Message actions" })
      .querySelectorAll("[data-menu-item]");
    expect([...items].map((el) => el.textContent)).toEqual([
      "Copy message",
      // Anyone in the room can turn what was said into a task — the refusal, if
      // there is one, belongs to the list they pick, not to who wrote the
      // sentence.
      "Make a task\u2026",
      "Copy link",
      "Report message",
      "Why this notified me",
    ]);
  });

  it("lights the pill before the server has answered", async () => {
    seedWindow([message("m1", ADA, "ship it")]);
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "React with 👍" }));
    });
    // The query result has not moved — this is the optimistic overlay alone.
    expect(pill("👍")?.getAttribute("aria-pressed")).toBe("true");
    expect(pill("👍")?.textContent).toContain("1");
    expect(calls("buzz/messages:react")).toEqual([
      {
        scopeType: "workspace",
        scopeId: "w1",
        channelId: "flight-path",
        targetId: eid("m1"),
        emoji: "👍",
      },
    ]);
  });

  it("removes a reaction the reader already gave", async () => {
    seedWindow([
      message("m1", ADA, "ship it"),
      reaction("x1", ME, "👍", "m1"),
    ]);
    mount();
    const mine = pill("👍");
    expect(mine?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      fireEvent.click(mine!);
    });
    expect(pill("👍")).toBeNull();
    expect(calls("buzz/messages:unreact")).toHaveLength(1);
  });

  it("defers a delete behind its undo window and never asks for confirmation", async () => {
    seedWindow([message("m1", ME, "oops")]);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete message" }));
    });
    // The row is gone from the reader's view immediately…
    expect(document.querySelector(`[data-message-id="${eid("m1")}"]`)).toBeNull();
    // …and nothing has been sent.
    expect(calls("buzz/messages:remove")).toHaveLength(0);
    const toast = toastCalls.at(-1);
    expect(toast?.message).toBe("Message deleted");
    expect(toast?.opts?.action?.label).toBe("Undo");
    // The mutation runs only when the undo window closes.
    await act(async () => {
      toast?.opts?.onExpire?.();
    });
    expect(calls("buzz/messages:remove")).toEqual([
      {
        scopeType: "workspace",
        scopeId: "w1",
        channelId: "flight-path",
        targetId: eid("m1"),
      },
    ]);
  });

  it("puts the row back and sends nothing when the undo is taken", async () => {
    seedWindow([message("m1", ME, "oops")]);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete message" }));
    });
    await act(async () => {
      toastCalls.at(-1)?.opts?.action?.onClick();
    });
    expect(document.querySelector(`[data-message-id="${eid("m1")}"]`)).toBeTruthy();
    expect(calls("buzz/messages:remove")).toHaveLength(0);
  });

  it("edits in place and sends the new text", async () => {
    seedWindow([message("m1", ME, "teh plan")]);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit message" }));
    const field = screen.getByLabelText("Edit message") as HTMLTextAreaElement;
    expect(field.value).toBe("teh plan");
    fireEvent.change(field, { target: { value: "the plan" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(calls("buzz/messages:edit")).toEqual([
      {
        scopeType: "workspace",
        scopeId: "w1",
        channelId: "flight-path",
        targetId: eid("m1"),
        // `body`, which is what `buzz/messages:edit` declares. This assertion
        // used to say `content` and pinned a bug: the reference named an
        // argument the mutation does not take, so every Save was refused by
        // argument validation.
        body: "the plan",
      },
    ]);
  });

  it("copies an in-app link rather than a scheme nothing can open", async () => {
    const written: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    seedWindow([message("m1", ADA, "here")]);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy link" }));
    });
    expect(written[0]).toContain(`/chat/c/flight-path?m=${eid("m1")}`);
    expect(toastCalls.at(-1)?.message).toBe("Link copied to clipboard");
  });
});

// ---------------------------------------------------------------------------
// §2.3 The summary row, §2.9 the jump
// ---------------------------------------------------------------------------

describe("threads and jumps", () => {
  it("summarises replies under the root and opens the pane on click", () => {
    const onOpenThread = vi.fn();
    seedWindow([
      message("root", ADA, "shall we ship"),
      reply("r1", FIZZ, "CI is green", "root", "root", { created_at: NOW + 30 }),
      reply("r2", ME, "then yes", "root", "r1", { created_at: NOW + 60 }),
    ]);
    mount({ onOpenThread });
    // The replies are NOT rows in the channel — that is what a thread is for.
    expect(document.querySelectorAll("[data-message-id]")).toHaveLength(1);
    const summary = document.querySelector("[data-thread-summary]") as HTMLElement;
    expect(summary.textContent).toContain("2 replies");
    fireEvent.click(summary);
    expect(onOpenThread).toHaveBeenCalledWith(eid("root"));
  });

  it("marks the row a deep link points at, once", () => {
    state.search = `m=${eid("m2")}`;
    seedWindow([
      message("m1", ADA, "one"),
      message("m2", FIZZ, "two", { created_at: NOW + 900 }),
    ]);
    mount();
    const rows = document.querySelectorAll("[data-message-id]");
    // The projector sets `highlighted` from `highlightedId`; the row draws the
    // one-shot tint from it, which is what makes a jump land visibly.
    expect(rows[1].querySelector("[aria-hidden]")).toBeTruthy();
    expect(rows[1].getAttribute("data-message-id")).toBe(eid("m2"));
  });
});

// ---------------------------------------------------------------------------
// §2.8 Paging
// ---------------------------------------------------------------------------

describe("fetching older history", () => {
  it("asks for the next window when the screen is not full", async () => {
    seedWindow([message("m1", ADA, "only one")], "cursor-2");
    state.queries["buzz/messages:list?cursor-2"] = {
      events: [message("m0", ADA, "older", { created_at: NOW - 3600 })],
      actors: ACTORS,
    };
    mount();
    // One row is well under the floor, so the second page is requested without
    // the reader having to scroll — and the older message lands above.
    const rows = document.querySelectorAll("[data-message-id]");
    expect([...rows].map((r) => r.getAttribute("data-message-id"))).toEqual([
      eid("m0"),
      eid("m1"),
    ]);
    // With no cursor left, the beginning of the room is now proved.
    expect(screen.getByText(/beginning of the room/)).toBeTruthy();
  });

  it("offers a button when more history exists, for readers who do not scroll", () => {
    // 20 rows clears the floor, so nothing is auto-fetched and the affordance
    // has to be reachable — a wheel gesture is not available to everyone.
    const events = Array.from({ length: 20 }, (_, i) =>
      message(`m${i}`, i % 2 ? ADA : FIZZ, `line ${i}`, { created_at: NOW + i * 700 }),
    );
    seedWindow(events, "cursor-2");
    mount();
    expect(screen.getByRole("button", { name: "Load earlier messages" })).toBeTruthy();
  });
});
