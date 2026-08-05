import { render, screen, within, fireEvent, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { ChatChannelSummary } from "@/lib/buzz/channel-types";

// The Chat shell's structural contract.
//
// jsdom cannot tell anyone whether this looks like a room — that is what the
// gallery shots are for. What it *can* answer, and what breaks silently, is
// the set of rules the shell is: which regions exist, which row the URL marks
// active, which mark a room's unread state draws, and what the navigation
// turns into at 390px. Every one of those has exactly one right answer and no
// visual signal when it is wrong.
//
// The mocks are local rather than the shared `harness.tsx` because the channel
// query is addressed by `makeFunctionReference`, which carries its name on a
// symbol rather than the `__path` the harness reads. Keying on the real
// `getFunctionName` means the test says the same name the shell does.

const state = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  throwing: new Set<string>(),
  mutations: [] as { name: string; args: unknown }[],
  pathname: "/chat",
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  type Ref = Parameters<typeof getFunctionName>[0];
  return {
    useQuery: (ref: Ref, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(ref);
      // A query against a function the deployment does not have throws
      // during render — the exact failure the sidebar's boundary exists for.
      if (state.throwing.has(name)) {
        throw new Error(`Could not find public function ${name}`);
      }
      return state.queries[name];
    },
    useMutation: (ref: Ref) => async (args: unknown) => {
      state.mutations.push({ name: getFunctionName(ref), args });
    },
    // Typing signals and the realtime token are actions, and the room now
    // mounts the typing hook that issues them. They answer nothing here: with
    // no Ably token the hook reports `unavailable` and the room draws no dots,
    // which is the supported degraded state rather than a failure.
    useAction: () => async () => null,
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({ user: { fullName: "Ada Lovelace", firstName: "Ada" } }),
  UserButton: () => <span data-testid="user-button" />,
}));

vi.mock("@/components/toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
  ToastProvider: ({ children }: { children: ReactNode }) => children,
}));

// The palette is a whole other surface with its own queries; the shell's job
// is only to mount it.
vi.mock("@/components/command-palette", () => ({
  CommandPalette: () => null,
}));

vi.mock("@/components/motion", () => ({
  MotionConfig: ({ children }: { children: ReactNode }) => children,
  Stagger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  StaggerItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { ChatShell } from "@/components/chat/shell/chat-shell";
import { ChannelScreen } from "@/components/chat/shell/channel-screen";
import { ChatHomeScreen } from "@/components/chat/shell/home-screen";
import {
  activeChannelId,
  channelHref,
  clampSidebarWidth,
  magneticSidebarWidth,
  auxMaxWidth,
  SIDEBAR_DEFAULT_PX,
  SIDEBAR_MIN_PX,
  SIDEBAR_MAX_PX,
  AUX_MAX_FLOOR_PX,
} from "@/components/chat/shell/layout";
import {
  sidebarSections,
  unreadMark,
  communityMark,
  unreadOverflow,
  initials,
} from "@/components/chat/shell/sections";

const CHANNELS = "buzz/channels:list";
const SCOPES = "chat:scopesForCurrentUser";

function room(over: Partial<ChatChannelSummary> = {}): ChatChannelSummary {
  const merged: ChatChannelSummary = {
    channelId: "c1",
    name: "general",
    displayName: "",
    kind: "channel",
    visibility: "public",
    memberCount: 4,
    unread: 0,
    mentions: 0,
    muted: false,
    joined: true,
    ...over,
  };
  // A room's display name follows its name unless a test says otherwise —
  // otherwise every fixture is called "general" and the ones asserting on
  // labels pass by coincidence.
  if (over.displayName === undefined) merged.displayName = merged.name;
  return merged;
}

/** A matchMedia that actually answers, so the drawer breakpoint is testable. */
function setViewport(width: number) {
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    return {
      matches: min ? width >= Number(min[1]) : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    };
  }) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  state.queries = {};
  state.throwing = new Set();
  state.mutations = [];
  state.pathname = "/chat";
  setViewport(1280);
  localStorage.clear();
});

// ── The regions ───────────────────────────────────────────────────────────

describe("the Chat shell's regions", () => {
  it("renders top chrome, navigation and the screen, and pins the viewport", () => {
    state.queries[SCOPES] = [
      { scopeType: "user", scopeId: "u1", name: "Personal" },
    ];
    state.queries[CHANNELS] = [room()];
    const { container } = render(
      <ChatShell>
        <div>the screen</div>
      </ChatShell>,
    );

    const shell = container.querySelector("[data-chat-shell]");
    expect(shell).not.toBeNull();
    // The whole point of the shell: the document never scrolls, so the
    // composer cannot walk off the bottom of the screen.
    expect(shell?.className).toContain("h-svh");
    expect(shell?.className).toContain("overflow-hidden");

    expect(container.querySelector("[data-chat-top-chrome]")).not.toBeNull();
    expect(screen.getByRole("navigation", { name: "Chat navigation" })).toBeTruthy();
    expect(container.querySelector("[data-chat-sidebar]")).not.toBeNull();
    expect(screen.getByText("the screen")).toBeTruthy();
  });

  it("names the current community in the header, with one entry per community", () => {
    // There is no community rail any more. A community IS a workspace, and
    // Work already asks "which workspace" with a dropdown at the top of the
    // sidebar — a second, differently-shaped navigation for the same question
    // is what made the two halves of the product look like two products.
    // See src/components/chat/shell/community-switcher.tsx.
    state.queries[SCOPES] = [
      { scopeType: "user", scopeId: "u1", name: "Personal" },
    ];
    state.queries[CHANNELS] = [];
    const solo = render(<ChatShell>{null}</ChatShell>);
    expect(solo.container.querySelector("[data-chat-rail]")).toBeNull();
    // The current community is named even when it is the only one — the
    // header is where you look to know where you are, and a control that
    // appears only once you have two of something teaches nobody anything.
    // Scoped to the sidebar: the top chrome names the community too, and an
    // unscoped query would pass on the breadcrumb alone.
    const soloNav = solo.container.querySelector("[data-chat-sidebar]");
    expect(
      within(soloNav as HTMLElement).getByText("Personal"),
    ).toBeTruthy();
    solo.unmount();

    state.queries[SCOPES] = [
      { scopeType: "user", scopeId: "u1", name: "Personal" },
      { scopeType: "workspace", scopeId: "w1", name: "Honeycomb Studios" },
    ];
    const pair = render(<ChatShell>{null}</ChatShell>);
    expect(pair.container.querySelector("[data-chat-rail]")).toBeNull();
    // Still one trigger, still naming where you are — the second community
    // lives inside the menu rather than adding a column to the screen.
    const pairNav = pair.container.querySelector("[data-chat-sidebar]");
    expect(
      within(pairNav as HTMLElement).getByText("Personal"),
    ).toBeTruthy();
  });

  it("keeps the sidebar's resize grip off the drawer, where it means nothing", () => {
    state.queries[SCOPES] = [{ scopeType: "user", scopeId: "u1", name: "Personal" }];
    state.queries[CHANNELS] = [];
    const wide = render(<ChatShell>{null}</ChatShell>);
    expect(screen.queryByRole("separator", { name: "Resize sidebar" })).toBeTruthy();
    wide.unmount();

    setViewport(390);
    render(<ChatShell>{null}</ChatShell>);
    expect(screen.queryByRole("separator", { name: "Resize sidebar" })).toBeNull();
  });
});

// ── The sidebar ───────────────────────────────────────────────────────────

describe("the channel sidebar", () => {
  beforeEach(() => {
    state.queries[SCOPES] = [
      { scopeType: "user", scopeId: "u1", name: "Personal" },
    ];
  });

  it("orders its sections Channels, Forums, Direct messages", () => {
    state.queries[CHANNELS] = [
      room({ channelId: "c1", name: "general" }),
      room({ channelId: "f1", name: "rfcs", kind: "forum" }),
      room({ channelId: "d1", name: "maya", displayName: "Maya Chen", kind: "dm" }),
    ];
    const { container } = render(<ChatShell>{null}</ChatShell>);
    const sidebar = container.querySelector("[data-chat-sidebar]") as HTMLElement;
    const labels = within(sidebar)
      .getAllByRole("button", { expanded: true })
      .map((el) => el.textContent?.trim());
    expect(labels).toEqual(["Channels", "Forums", "Direct messages"]);
  });

  it("omits Forums when a community has none, rather than showing an empty one", () => {
    state.queries[CHANNELS] = [room()];
    render(<ChatShell>{null}</ChatShell>);
    expect(screen.queryByText("Forums")).toBeNull();
    expect(screen.getByText("Channels")).toBeTruthy();
  });

  it("marks the room in the URL as the current row", () => {
    state.pathname = "/chat/c/c2";
    state.queries[CHANNELS] = [
      room({ channelId: "c1", name: "general" }),
      room({ channelId: "c2", name: "flight-path" }),
    ];
    render(<ChatShell>{null}</ChatShell>);
    const active = screen.getByRole("link", { name: /flight-path/ });
    expect(active.getAttribute("aria-current")).toBe("page");
    expect(active.dataset.active).toBe("true");
    expect(
      screen.getByRole("link", { name: /general/ }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("shows the reason when rooms cannot be loaded, and keeps the shell up", () => {
    state.throwing.add(CHANNELS);
    render(
      <ChatShell>
        <div>the screen</div>
      </ChatShell>,
    );
    expect(
      screen.getByText(/Could not find public function buzz\/channels:list/),
    ).toBeTruthy();
    // A failed room list is a degraded sidebar, not a white screen.
    expect(screen.getByText("the screen")).toBeTruthy();
  });
});

// ── Badges ────────────────────────────────────────────────────────────────

describe("unread marks", () => {
  it("draws a count for a mention and a dot for plain unread", () => {
    expect(unreadMark(room({ mentions: 3, unread: 9 }), false)).toEqual({
      kind: "count",
      count: 3,
      label: "3",
    });
    expect(unreadMark(room({ unread: 9 }), false)).toEqual({ kind: "dot" });
    expect(unreadMark(room(), false)).toEqual({ kind: "none" });
  });

  it("treats every unread direct message as addressed to you", () => {
    // A DM did not need to name you; being sent to you is what makes it
    // direct. A dot here would under-report the one room that always matters.
    expect(unreadMark(room({ kind: "dm", unread: 2 }), false)).toEqual({
      kind: "count",
      count: 2,
      label: "2",
    });
  });

  it("never marks the row you are standing on", () => {
    expect(unreadMark(room({ mentions: 5, unread: 5 }), true)).toEqual({
      kind: "none",
    });
  });

  it("caps the label without lying about the count", () => {
    const mark = unreadMark(room({ mentions: 250 }), false);
    expect(mark).toMatchObject({ kind: "count", count: 250, label: "99+" });
  });

  it("renders the count in the row and leaves the active row bare", () => {
    state.pathname = "/chat/c/c2";
    state.queries[SCOPES] = [{ scopeType: "user", scopeId: "u1", name: "Personal" }];
    state.queries[CHANNELS] = [
      room({ channelId: "c1", name: "general", mentions: 4 }),
      room({ channelId: "c2", name: "flight-path", mentions: 7 }),
    ];
    render(<ChatShell>{null}</ChatShell>);
    expect(within(screen.getByRole("link", { name: /general/ })).getByText("4")).toBeTruthy();
    expect(
      within(screen.getByRole("link", { name: /flight-path/ })).queryByText("7"),
    ).toBeNull();
  });

  it("draws nothing for a community whose rooms have not been observed", () => {
    // A fabricated badge teaches people the badge means nothing, and after
    // that a real one stops being read either.
    expect(communityMark(null)).toEqual({ kind: "none" });
    expect(communityMark(undefined)).toEqual({ kind: "none" });
    expect(communityMark([room({ unread: 1 })])).toEqual({ kind: "dot" });
    expect(communityMark([room({ mentions: 2 }), room({ mentions: 1 })])).toMatchObject({
      kind: "count",
      count: 3,
    });
  });
});

// ── The drawer ────────────────────────────────────────────────────────────

describe("navigation at 390px", () => {
  beforeEach(() => {
    setViewport(390);
    state.queries[SCOPES] = [
      { scopeType: "user", scopeId: "u1", name: "Personal" },
      { scopeType: "workspace", scopeId: "w1", name: "Honeycomb" },
    ];
    state.queries[CHANNELS] = [room()];
  });

  it("becomes a drawer that starts closed", () => {
    render(<ChatShell>{null}</ChatShell>);
    const nav = screen.getByRole("navigation", { name: "Chat navigation" });
    expect(nav.dataset.layout).toBe("drawer");
    expect(nav.dataset.open).toBe("false");
    expect(screen.queryByRole("button", { name: "Close navigation" })).toBeNull();
  });

  it("opens from the top chrome and closes on Escape", () => {
    render(<ChatShell>{null}</ChatShell>);
    fireEvent.click(screen.getByRole("button", { name: "Show navigation" }));
    const nav = screen.getByRole("navigation", { name: "Chat navigation" });
    expect(nav.dataset.open).toBe("true");
    // The click-catcher exists only while the nav is over the room; on a
    // desktop column an invisible full-screen catcher would eat every click.
    expect(screen.getByRole("button", { name: "Close navigation" })).toBeTruthy();

    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(nav.dataset.open).toBe("false");
  });

  it("stays a column above the breakpoint", () => {
    setViewport(1280);
    render(<ChatShell>{null}</ChatShell>);
    expect(
      screen.getByRole("navigation", { name: "Chat navigation" }).dataset.layout,
    ).toBe("inline");
    expect(screen.getByRole("button", { name: "Toggle sidebar" })).toBeTruthy();
  });
});

// ── The screens ───────────────────────────────────────────────────────────

describe("the room screen", () => {
  beforeEach(() => {
    state.queries[SCOPES] = [{ scopeType: "user", scopeId: "u1", name: "Personal" }];
    state.pathname = "/chat/c/c1";
  });

  it("names the room in the header and the top chrome's location line", () => {
    state.queries[CHANNELS] = [room({ topic: "Ship the launch" })];
    render(
      <ChatShell>
        <ChannelScreen channelId="c1" />
      </ChatShell>,
    );
    expect(screen.getByRole("heading", { name: "general" })).toBeTruthy();
    expect(screen.getByText("Ship the launch")).toBeTruthy();
    expect(screen.getByText("#general")).toBeTruthy();
  });

  it("opens the auxiliary pane with details drawn from the room itself", () => {
    state.queries[CHANNELS] = [room({ memberCount: 9, visibility: "private" })];
    const { container } = render(
      <ChatShell>
        <ChannelScreen channelId="c1" />
      </ChatShell>,
    );
    expect(container.querySelector("[data-chat-aux]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Room details" }));
    const aux = container.querySelector("[data-chat-aux]");
    expect(aux).not.toBeNull();
    expect(aux?.getAttribute("data-mode")).toBe("docked");
    expect(within(aux as HTMLElement).getByText("Private")).toBeTruthy();
    expect(within(aux as HTMLElement).getByText("9")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close Details" }));
    expect(container.querySelector("[data-chat-aux]")).toBeNull();
  });

  it("floats the auxiliary pane over the room when two columns will not fit", () => {
    setViewport(390);
    state.queries[CHANNELS] = [room()];
    const { container } = render(
      <ChatShell>
        <ChannelScreen channelId="c1" />
      </ChatShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Room details" }));
    expect(
      container.querySelector("[data-chat-aux]")?.getAttribute("data-mode"),
    ).toBe("overlay");
    // Nothing to resize against when the pane is floating.
    expect(screen.queryByRole("separator", { name: /Resize Details/ })).toBeNull();
  });

  it("says which community a missing room is not in", () => {
    state.queries[CHANNELS] = [room({ channelId: "other" })];
    render(
      <ChatShell>
        <ChannelScreen channelId="c1" />
      </ChatShell>,
    );
    expect(screen.getByRole("heading", { name: "Room not found" })).toBeTruthy();
    expect(screen.getByText(/not in Personal/)).toBeTruthy();
  });
});

describe("the home screen", () => {
  it("lists only what is waiting, mentions first", () => {
    state.queries[SCOPES] = [{ scopeType: "user", scopeId: "u1", name: "Personal" }];
    state.queries[CHANNELS] = [
      room({ channelId: "c1", name: "quiet" }),
      room({ channelId: "c2", name: "unread-only", unread: 3 }),
      room({ channelId: "c3", name: "mentioned", mentions: 1 }),
    ];
    render(
      <ChatShell>
        <ChatHomeScreen />
      </ChatShell>,
    );
    const main = screen.getByRole("heading", { name: "Hello, Ada" }).parentElement!;
    const links = within(main)
      .getAllByRole("link")
      .map((a) => a.textContent);
    expect(links).toHaveLength(2);
    expect(links[0]).toContain("#mentioned");
    expect(links[1]).toContain("#unread-only");
  });
});

// ── The pure rules ────────────────────────────────────────────────────────

describe("shell geometry", () => {
  it("reads the room out of the URL, and only out of an exact room URL", () => {
    expect(activeChannelId("/chat/c/abc123")).toBe("abc123");
    expect(activeChannelId("/chat/c/abc123/anything")).toBe("abc123");
    expect(activeChannelId("/chat")).toBeNull();
    expect(activeChannelId("/chat/c/")).toBeNull();
    expect(activeChannelId("/dashboard/chat")).toBeNull();
    // The link and the match are the same writer, so they cannot drift.
    expect(activeChannelId(channelHref("a b"))).toBe("a b");
  });

  it("snaps to the default width, eases out of it, then tracks the pointer", () => {
    expect(magneticSidebarWidth(SIDEBAR_DEFAULT_PX + 5)).toBe(SIDEBAR_DEFAULT_PX);
    expect(magneticSidebarWidth(SIDEBAR_DEFAULT_PX - 8)).toBe(SIDEBAR_DEFAULT_PX);
    // Inside the ease zone it lags the pointer rather than jumping to it.
    const eased = magneticSidebarWidth(SIDEBAR_DEFAULT_PX + 18);
    expect(eased).toBeGreaterThan(SIDEBAR_DEFAULT_PX);
    expect(eased).toBeLessThan(SIDEBAR_DEFAULT_PX + 18);
    // And at the far edge of the zone it has caught up exactly — no step.
    expect(magneticSidebarWidth(SIDEBAR_DEFAULT_PX + 28)).toBe(
      SIDEBAR_DEFAULT_PX + 28,
    );
    expect(magneticSidebarWidth(SIDEBAR_DEFAULT_PX - 40)).toBe(
      SIDEBAR_DEFAULT_PX - 40,
    );
  });

  it("never lets the sidebar leave its bounds", () => {
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN_PX);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_PX);
    expect(magneticSidebarWidth(9999)).toBe(SIDEBAR_MAX_PX);
  });

  it("treats the auxiliary pane's maximum as a floor on wide screens", () => {
    expect(auxMaxWidth(1000)).toBe(AUX_MAX_FLOOR_PX);
    expect(auxMaxWidth(2400)).toBe(2400 - SIDEBAR_DEFAULT_PX);
  });
});

describe("sidebar grouping", () => {
  it("lists only rooms you are in and have not archived", () => {
    const sections = sidebarSections([
      room({ channelId: "a", name: "in" }),
      room({ channelId: "b", name: "not-joined", joined: false }),
      room({ channelId: "c", name: "archived", archivedAt: 1 }),
    ]);
    const names = sections[0].channels.map((c) => c.name);
    expect(names).toEqual(["in"]);
  });

  it("orders rooms by recency, with silence last and names as the tiebreak", () => {
    const sections = sidebarSections([
      room({ channelId: "a", name: "older", lastActivityAt: 10 }),
      room({ channelId: "b", name: "never" }),
      room({ channelId: "c", name: "newer", lastActivityAt: 20 }),
      room({ channelId: "d", name: "also-never" }),
    ]);
    expect(sections[0].channels.map((c) => c.name)).toEqual([
      "newer",
      "older",
      "also-never",
      "never",
    ]);
  });

  it("counts only unread rows that are fully out of view", () => {
    const view = { top: 100, bottom: 300 };
    expect(
      unreadOverflow(
        [
          { top: 10, bottom: 42, count: 2 }, // above
          { top: 90, bottom: 122, count: 5 }, // straddling — visible
          { top: 200, bottom: 232, count: 1 }, // inside
          { top: 400, bottom: 432, count: 3 }, // below
          { top: 500, bottom: 532, count: 0 }, // read
        ],
        view,
      ),
    ).toEqual({ above: 2, below: 3 });
  });

  it("makes two letters out of any community name", () => {
    expect(initials("Personal")).toBe("PE");
    expect(initials("Honeycomb Studios")).toBe("HS");
    expect(initials("  a b c  ")).toBe("AC");
    expect(initials("")).toBe("?");
  });
});
