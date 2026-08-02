import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The forum's surfaces.
//
// jsdom cannot say whether a card reads well — that is what the gallery shots
// are for. What it can say, and what breaks silently, is the set of rules the
// two surfaces *are*: which events become cards and which are dropped, whether
// the sort control actually reorders anything, whether a delete waits for its
// undo window, and — the claim this phase rests on — that reacting to, editing
// and deleting a post go through `buzz/messages:*` rather than through anything
// this directory invented.
//
// The mocks are local rather than the shared `tests/ui/harness.tsx`, for the
// reason `chat-transcript.test.tsx` states at length: the harness keys `useQuery`
// on `ref.__path`, which only the generated `api` proxy carries, and every Chat
// query is addressed with `makeFunctionReference`, whose name lives on a symbol.
// One set of mocks, keyed on the real `getFunctionName`.

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
  mutations: [] as { name: string; args: unknown }[],
  toasts: [] as ToastCall[],
  pushes: [] as string[],
  /** Mutations that should reject, by function name. */
  failing: new Set<string>(),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  type Ref = Parameters<typeof getFunctionName>[0];
  return {
    useQuery: (ref: Ref, args: unknown) => {
      if (args === "skip") return undefined;
      return state.queries[getFunctionName(ref)];
    },
    useMutation: (ref: Ref) => {
      const name = getFunctionName(ref);
      return async (args: unknown) => {
        state.mutations.push({ name, args });
        if (state.failing.has(name)) throw new Error("refused by the server");
        return { eventId: "evt_new" };
      };
    },
    useAction: () => async () => undefined,
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => void state.pushes.push(href),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/chat/c/ch_forum",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({ user: { fullName: "Ada Lovelace" } }),
  UserButton: () => null,
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

// The post screen reads its room from the shell. Both are contexts a route
// normally provides; the components under test are pure functions of what they
// return, so they are supplied directly.
vi.mock("@/components/chat/shell/chat-shell", () => ({
  useChatShell: () => ({
    scope: { scopeType: "workspace", scopeId: "w1" },
    scopeName: "Acme",
    auxIsOverlay: false,
  }),
}));

vi.mock("@/components/chat/shell/channel-data", () => ({
  useChannels: () => ({ channels: [FORUM], error: null }),
  useChannel: () => FORUM,
}));

import { ForumPostList } from "@/components/chat/forum/post-list";
import { ForumPostScreen } from "@/components/chat/forum/post-screen";
import { KIND_FORUM_COMMENT, KIND_FORUM_POST } from "@/components/chat/forum/model";
import type { ChatChannelSummary } from "@/lib/buzz/channel-types";
import type { ComposerEditorHandle } from "@/components/chat/composer";

const SCOPE = { scopeType: "workspace" as const, scopeId: "w1" };
const ME = "aa".repeat(32);
const ADA = "bb".repeat(32);

const FORUM: ChatChannelSummary = {
  channelId: "ch_forum",
  name: "proposals",
  displayName: "Proposals",
  kind: "forum",
  visibility: "public",
  memberCount: 3,
  unread: 0,
  mentions: 0,
  muted: false,
  joined: true,
};

/** A 64-hex event id from a short label, so fixtures read as names. */
function eid(label: string): string {
  return label.padEnd(64, "0").slice(0, 64);
}

type Event = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

function post(
  label: string,
  title: string,
  body: string,
  opts: { pubkey?: string; at?: number } = {},
): Event {
  return {
    id: eid(label),
    pubkey: opts.pubkey ?? ADA,
    created_at: opts.at ?? 1_700_000_000,
    kind: KIND_FORUM_POST,
    tags: [
      ["p", opts.pubkey ?? ADA],
      ["h", FORUM.channelId],
      ["subject", title],
    ],
    content: body,
    sig: "",
  };
}

function comment(label: string, root: string, body: string, pubkey = ME): Event {
  return {
    id: eid(label),
    pubkey,
    created_at: 1_700_000_500,
    kind: KIND_FORUM_COMMENT,
    tags: [
      ["p", pubkey],
      ["h", FORUM.channelId],
      ["e", eid(root), "", "reply"],
    ],
    content: body,
    sig: "",
  };
}

function chatMessage(label: string, body: string): Event {
  return {
    id: eid(label),
    pubkey: ADA,
    created_at: 1_700_000_100,
    kind: 9,
    tags: [
      ["p", ADA],
      ["h", FORUM.channelId],
    ],
    content: body,
    sig: "",
  };
}

const ACTORS = [
  { pubkey: ADA, label: "Ada Lovelace", isAgent: false },
  { pubkey: ME, label: "You", isAgent: false },
];

function seedList(
  events: Event[],
  summaries: unknown[] = [],
  extra: Record<string, unknown> = {},
) {
  state.queries["buzz/forum:posts"] = { events, summaries, actors: ACTORS, ...extra };
}

function seedThread(events: Event[]) {
  state.queries["buzz/forum:post"] = { events, actors: ACTORS };
}

function calls(name: string): unknown[] {
  return state.mutations.filter((m) => m.name === name).map((m) => m.args);
}

beforeEach(() => {
  for (const key of Object.keys(state.queries)) delete state.queries[key];
  state.mutations.length = 0;
  state.toasts.length = 0;
  state.pushes.length = 0;
  state.failing.clear();
  state.queries["buzz/channels:members"] = [
    { actorId: "u_ada", actorType: "user", name: "Ada Lovelace", isSelf: false },
  ];
  state.queries["buzz/identity:myPubkey"] = { pubkey: ME };
});

// ---------------------------------------------------------------------------
// The post list
// ---------------------------------------------------------------------------

function mountList(onReady?: (handle: ComposerEditorHandle) => void) {
  return render(
    <ForumPostList scope={SCOPE} channel={FORUM} onComposerReady={onReady} />,
  );
}

describe("the post list", () => {
  it("holds a skeleton until a page has actually resolved", () => {
    const { container } = mountList();
    expect(container.querySelector('[data-testid="forum-skeleton"]')).toBeTruthy();
    // Not "No posts yet": a subscription that has not answered is
    // indistinguishable from a forum nobody has posted in, and only one of the
    // two is worth telling somebody about.
    expect(screen.queryByText("No posts yet")).toBeNull();
  });

  it("says a forum is empty only once a page has said so", () => {
    seedList([]);
    mountList();
    expect(screen.getByText("No posts yet")).toBeTruthy();
  });

  it("draws a card as a title, an author and a preview", () => {
    seedList([post("p1", "The migration plan", "We should move the queue first.")]);
    const { container } = mountList();
    const card = container.querySelector('[data-forum-post]') as HTMLElement;
    expect(within(card).getByRole("link", { name: "The migration plan" })).toBeTruthy();
    expect(within(card).getByText("Ada Lovelace")).toBeTruthy();
    expect(within(card).getByText("We should move the queue first.")).toBeTruthy();
    // The whole card is the target, so the link carries the post's route.
    expect(
      within(card).getByRole("link", { name: "The migration plan" }).getAttribute("href"),
    ).toBe(`/chat/c/ch_forum/p/${eid("p1")}`);
  });

  it("does not draw a chat message as a card", () => {
    // Belt and braces: the server's index range asks for one kind, and the
    // projector is told which kinds draw a row here. Either alone would be
    // enough; a surface that relied on only the query would break the moment
    // somebody widened it.
    seedList([post("p1", "The plan", "…"), chatMessage("m1", "back in ten")]);
    const { container } = mountList();
    expect(container.querySelectorAll("[data-forum-post]")).toHaveLength(1);
    expect(screen.queryByText("back in ten")).toBeNull();
  });

  it("shows the reply roll-up only when there is one", () => {
    seedList(
      [post("p1", "Answered", "…"), post("p2", "Silent", "…", { at: 1_699_000_000 })],
      [
        {
          postId: eid("p1"),
          replyCount: 3,
          lastReplyAt: 1_700_000_900,
          participants: [ADA],
          capped: false,
        },
      ],
    );
    const { container } = mountList();
    const cards = [...container.querySelectorAll("[data-forum-post]")] as HTMLElement[];
    expect(within(cards[0]).getByText("3 replies")).toBeTruthy();
    expect(within(cards[1]).queryByText(/replies/)).toBeNull();
  });

  it("reorders when the sort changes, and does so deterministically", () => {
    seedList(
      [
        post("p1", "Newest", "…", { at: 1_700_000_900 }),
        post("p2", "Busiest", "…", { at: 1_700_000_100 }),
      ],
      [
        {
          postId: eid("p2"),
          replyCount: 12,
          lastReplyAt: 1_700_000_200,
          participants: [],
          capped: false,
        },
      ],
    );
    const { container } = mountList();
    const titles = () =>
      [...container.querySelectorAll("[data-forum-post] h3")].map((h) => h.textContent);

    expect(titles()).toEqual(["Newest", "Busiest"]);
    fireEvent.click(screen.getByRole("tab", { name: "Most replies" }));
    expect(titles()).toEqual(["Busiest", "Newest"]);
    // Back again: the order is a function of the cards and the sort, not of the
    // order the tabs were pressed in.
    fireEvent.click(screen.getByRole("tab", { name: "Latest" }));
    expect(titles()).toEqual(["Newest", "Busiest"]);
  });

  it("keeps the composer collapsed until it is wanted", () => {
    seedList([]);
    const { container } = mountList();
    expect(container.querySelector('[data-forum-composer="collapsed"]')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start a new post…" }));
    expect(container.querySelector('[data-forum-composer="open"]')).toBeTruthy();
    expect(screen.getByLabelText("Post title")).toBeTruthy();
  });

  it("posts a title and a body, then opens what was just written", async () => {
    seedList([]);
    let handle: ComposerEditorHandle | null = null;
    mountList((h) => {
      handle = h;
    });
    fireEvent.click(screen.getByRole("button", { name: "Start a new post…" }));

    fireEvent.change(screen.getByLabelText("Post title"), {
      target: { value: "  The migration plan  " },
    });
    await act(async () => {
      (handle as unknown as ComposerEditorHandle).insertText("Move the queue first.");
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Post" }));
    });

    expect(calls("buzz/forum:createPost")).toEqual([
      {
        scopeType: "workspace",
        scopeId: "w1",
        channelId: "ch_forum",
        // Trimmed here as well as on the server: pressing Post and waiting for a
        // round trip to be told about leading spaces is not a conversation.
        title: "The migration plan",
        body: "Move the queue first.",
      },
    ]);
    expect(state.pushes).toEqual([`/chat/c/ch_forum/p/evt_new`]);
  });

  it("refuses to send a post with no title and says so without a round trip", async () => {
    seedList([]);
    let handle: ComposerEditorHandle | null = null;
    mountList((h) => {
      handle = h;
    });
    fireEvent.click(screen.getByRole("button", { name: "Start a new post…" }));
    await act(async () => {
      (handle as unknown as ComposerEditorHandle).insertText("body only");
    });
    // The button is off, so there is nothing to press — which is the honest
    // shape: a disabled control beats an error message for a rule this simple.
    expect(
      (screen.getByRole("button", { name: "Post" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(calls("buzz/forum:createPost")).toHaveLength(0);
  });

  it("keeps the text when the server refuses", async () => {
    seedList([]);
    state.failing.add("buzz/forum:createPost");
    let handle: ComposerEditorHandle | null = null;
    mountList((h) => {
      handle = h;
    });
    fireEvent.click(screen.getByRole("button", { name: "Start a new post…" }));
    fireEvent.change(screen.getByLabelText("Post title"), { target: { value: "Title" } });
    await act(async () => {
      (handle as unknown as ComposerEditorHandle).insertText("paragraphs of work");
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Post" }));
    });

    // A post is minutes of writing. The failure mode this guards against is the
    // one where the only copy of it was in a box that has just been cleared.
    expect((screen.getByLabelText("Post title") as HTMLInputElement).value).toBe("Title");
    expect((handle as unknown as ComposerEditorHandle).markdown()).toContain(
      "paragraphs of work",
    );
    expect(state.toasts.at(-1)?.opts?.kind).toBe("error");
  });

  it("says why the composer is off rather than drawing a dead box", () => {
    seedList([]);
    const { container, rerender } = render(
      <ForumPostList scope={SCOPE} channel={{ ...FORUM, joined: false }} />,
    );
    expect(container.querySelector('[data-forum-composer="off"]')?.textContent).toBe(
      "Join this forum to create posts.",
    );
    rerender(
      <ForumPostList scope={SCOPE} channel={{ ...FORUM, archivedAt: 1 }} />,
    );
    expect(container.querySelector('[data-forum-composer="off"]')?.textContent).toBe(
      "This forum is archived.",
    );
  });
});

// ---------------------------------------------------------------------------
// One post
// ---------------------------------------------------------------------------

function mountPost(postLabel = "p1") {
  return render(
    <ForumPostScreen channelId={FORUM.channelId} postId={eid(postLabel)} />,
  );
}

describe("one post", () => {
  it("draws the title, the post and its comments", () => {
    seedThread([
      post("p1", "The migration plan", "Move the queue first."),
      comment("c1", "p1", "agreed"),
    ]);
    mountPost();
    // The title appears twice on purpose: in the header, which survives
    // scrolling, and above the post, which is where it is read.
    expect(screen.getAllByText("The migration plan").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Move the queue first.")).toBeTruthy();
    expect(screen.getByText("agreed")).toBeTruthy();
    expect(screen.getByText("1 comment")).toBeTruthy();
  });

  it("says the post is gone rather than showing an empty page", () => {
    // A deleted post's content stops being served at all, so the thread comes
    // back with nothing to draw.
    seedThread([]);
    mountPost();
    expect(screen.getByText(/no longer available/i)).toBeTruthy();
  });

  it("comments through buzz/forum:comment, filed under the post", async () => {
    seedThread([post("p1", "The plan", "…")]);
    const { container } = mountPost();
    const box = container.querySelector('[role="textbox"]') as HTMLElement;
    expect(box).toBeTruthy();

    // Drive the composer the way the transcript's tests do: the editor's own
    // handle is not exposed here, so the send goes through the Send button after
    // text is put in by the editor's change pipeline.
    await act(async () => {
      box.textContent = "me too";
      fireEvent.input(box);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    });

    const sent = calls("buzz/forum:comment");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      scopeType: "workspace",
      scopeId: "w1",
      channelId: "ch_forum",
      parentId: eid("p1"),
      rootId: eid("p1"),
    });
    // And nothing went to the chat door.
    expect(calls("buzz/messages:post")).toHaveLength(0);
  });

  it("reacts through the message path, not through a forum one", async () => {
    seedThread([post("p1", "The plan", "…", { pubkey: ME })]);
    const { container } = mountPost();
    const row = container.querySelector(`[data-message-id="${eid("p1")}"]`) as HTMLElement;
    await act(async () => {
      fireEvent.click(within(row).getAllByRole("button", { name: "React with 👍" })[0]);
    });
    expect(calls("buzz/messages:react")).toEqual([
      {
        scopeType: "workspace",
        scopeId: "w1",
        channelId: "ch_forum",
        targetId: eid("p1"),
        emoji: "👍",
      },
    ]);
  });

  it("edits through the message path, sending the argument the server declares", async () => {
    seedThread([post("p1", "The plan", "teh body", { pubkey: ME })]);
    const { container } = mountPost();
    const row = container.querySelector(`[data-message-id="${eid("p1")}"]`) as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit message" }));
    const field = screen.getByLabelText("Edit message") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "the body" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(calls("buzz/messages:edit")).toEqual([
      {
        scopeType: "workspace",
        scopeId: "w1",
        channelId: "ch_forum",
        targetId: eid("p1"),
        body: "the body",
      },
    ]);
  });

  it("defers a delete until the undo window closes", async () => {
    seedThread([post("p1", "The plan", "…", { pubkey: ME })]);
    const { container } = mountPost();
    const row = container.querySelector(`[data-message-id="${eid("p1")}"]`) as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "More actions" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete message" }));
    });

    // The row is gone and nothing has been written: this app's destructive
    // actions run when the undo window closes, not when the menu is clicked.
    expect(container.querySelector(`[data-message-id="${eid("p1")}"]`)).toBeNull();
    expect(calls("buzz/messages:remove")).toHaveLength(0);
    const toast = state.toasts.at(-1);
    expect(toast?.message).toBe("Post deleted");
    expect(toast?.opts?.action?.label).toBe("Undo");

    await act(async () => {
      toast?.opts?.onExpire?.();
    });
    expect(calls("buzz/messages:remove")).toEqual([
      {
        scopeType: "workspace",
        scopeId: "w1",
        channelId: "ch_forum",
        targetId: eid("p1"),
      },
    ]);
  });

  it("puts the post back when the undo is taken", async () => {
    seedThread([post("p1", "The plan", "…", { pubkey: ME })]);
    const { container } = mountPost();
    const row = container.querySelector(`[data-message-id="${eid("p1")}"]`) as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "More actions" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete message" }));
    });
    await act(async () => {
      state.toasts.at(-1)?.opts?.action?.onClick();
    });
    expect(container.querySelector(`[data-message-id="${eid("p1")}"]`)).toBeTruthy();
    expect(calls("buzz/messages:remove")).toHaveLength(0);
  });
});
