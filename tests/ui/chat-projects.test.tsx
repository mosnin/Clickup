import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The project surfaces.
//
// jsdom cannot say whether a branch row reads well — that is what the gallery
// shots are for. What it can say, and what would break silently, is the set of
// rules these screens *are*: that the forge panel draws a room's patches and
// verdicts and never its conversation, that a verdict button calls the mutation
// it claims to, that the merge control explains what is missing instead of
// vanishing, and that an unbound room offers a way to become a branch room
// rather than an empty pane.
//
// The mocks are local rather than the shared `tests/ui/harness.tsx`, for the
// reason `chat-forum.test.tsx` states: the harness keys `useQuery` on
// `ref.__path`, which only the generated `api` proxy carries, and every Chat
// query is addressed with `makeFunctionReference`, whose name lives on a symbol.
// One set of mocks, keyed on the real `getFunctionName`.

type ToastCall = { message: string; opts?: { kind?: string } };

const state = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  mutations: [] as { name: string; args: unknown }[],
  toasts: [] as ToastCall[],
  pushes: [] as string[],
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
        return { eventId: "evt_new", channelId: "ch_new", name: "retry" };
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
  usePathname: () => "/chat/projects",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/toast", async () => {
  const react = await import("react");
  return {
    useToast: () => ({
      toast: (message: string, opts?: unknown) => {
        state.toasts.push({ message, opts: opts as ToastCall["opts"] });
      },
    }),
    ToastProvider: ({ children }: { children: React.ReactNode }) =>
      react.createElement(react.Fragment, null, children),
  };
});

vi.mock("@/components/chat/shell/chat-shell", () => ({
  useChatShell: () => ({
    scope: { scopeType: "workspace", scopeId: "w1" },
    scopeName: "Acme",
    auxIsOverlay: false,
  }),
}));

// The content surface is the shell's sheet; the screens under test are pure
// functions of their query results and do not need its geometry.
vi.mock("@/components/chat/shell/surfaces", async () => {
  const react = await import("react");
  return {
    ContentSurface: ({ children }: { children: React.ReactNode }) =>
      react.createElement("div", null, children),
    AuxPane: ({ children }: { children: React.ReactNode }) =>
      react.createElement("div", null, children),
  };
});

import { ProjectsScreen } from "@/components/chat/projects/projects-screen";
import { BranchPane } from "@/components/chat/projects/branch-pane";
import {
  KIND_GIT_PATCH,
  KIND_GIT_PULL_REQUEST,
  KIND_GIT_STATUS_CLOSED,
  KIND_GIT_STATUS_OPEN,
  repoAddress,
} from "@/lib/buzz/project";

const SCOPE = { scopeType: "workspace" as const, scopeId: "w1" };
const OWNER = "aa".repeat(32);
const BOB = "bb".repeat(32);
const REPO = repoAddress(OWNER, "payments-api");
const OID = "1".repeat(40);

type Event = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
};

const PROJECT = {
  id: `${OWNER}:payments-api`,
  dtag: "payments-api",
  owner: OWNER,
  name: "Payments API",
  description: "Money in, money out.",
  cloneUrls: [],
  webUrl: "",
  maintainers: [OWNER],
  projectChannelId: null,
  visibility: "listed" as const,
  repoAddress: REPO,
  createdAt: 1000,
  eventId: "p1",
};

const ACTORS = [
  { pubkey: OWNER, label: "Ada", isAgent: false },
  { pubkey: BOB, label: "Bo", isAgent: false },
];

function binding(): Event {
  return {
    id: "bind1",
    pubkey: OWNER,
    created_at: 1000,
    kind: KIND_GIT_PULL_REQUEST,
    tags: [
      ["a", REPO],
      ["branch-name", "feature/retry-budget"],
      ["target-branch", "main"],
      ["subject", "Bound the retries"],
      ["c", OID],
    ],
    content: "",
  };
}

beforeEach(() => {
  state.queries = {};
  state.mutations.length = 0;
  state.toasts.length = 0;
  state.pushes.length = 0;
  state.failing.clear();
});

describe("the projects screen", () => {
  it("says what it is for and draws a card per repository", () => {
    state.queries["buzz/projects:list"] = {
      projects: [{ project: PROJECT, branchRooms: 2, lastActivityAt: Date.now() }],
      groups: [],
      actors: ACTORS,
    };
    render(<ProjectsScreen />);
    expect(screen.getByText("Payments API")).toBeTruthy();
    expect(screen.getByText(/2 branch rooms/)).toBeTruthy();
    // Announced-by resolves to a name, never a 64-hex string.
    expect(screen.getByText(/Ada/)).toBeTruthy();
  });

  it("groups cards under a collection and draws each card once", () => {
    const other = { ...PROJECT, id: `${OWNER}:ledger`, dtag: "ledger", name: "Ledger" };
    state.queries["buzz/projects:list"] = {
      projects: [
        { project: PROJECT, branchRooms: 0, lastActivityAt: 0 },
        { project: { ...other, repoAddress: repoAddress(OWNER, "ledger") }, branchRooms: 0, lastActivityAt: 0 },
      ],
      groups: [{ slug: "platform", name: "Platform", by: OWNER, memberAddresses: [REPO] }],
      actors: ACTORS,
    };
    render(<ProjectsScreen />);
    expect(screen.getByText("Platform")).toBeTruthy();
    expect(screen.getByText("Everything else")).toBeTruthy();
    expect(screen.getAllByText("Payments API")).toHaveLength(1);
  });

  it("announces in place, on the screen the result lands on", async () => {
    state.queries["buzz/projects:list"] = { projects: [], groups: [], actors: [] };
    render(<ProjectsScreen />);
    expect(screen.getByText(/No projects yet/)).toBeTruthy();

    fireEvent.click(screen.getByText("Announce a repository…"));
    const name = screen.getByPlaceholderText("Payments API");
    fireEvent.change(name, { target: { value: "Payments API" } });
    // The slug is shown as it is derived, not asked for.
    expect(screen.getByText("Addressed as payments-api")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("Announce"));
    });
    expect(state.mutations).toEqual([
      {
        name: "buzz/projects:announce",
        args: { ...SCOPE, name: "Payments API" },
      },
    ]);
    expect(state.toasts[0].message).toBe("Repository announced");
  });

  it("shows the server's own refusal rather than a generic one", async () => {
    state.queries["buzz/projects:list"] = { projects: [], groups: [], actors: [] };
    state.failing.add("buzz/projects:announce");
    render(<ProjectsScreen />);
    fireEvent.click(screen.getByText("Announce a repository…"));
    fireEvent.change(screen.getByPlaceholderText("Payments API"), {
      target: { value: "X" },
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Announce"));
    });
    expect(state.toasts[0]).toEqual({
      message: "refused by the server",
      opts: { kind: "error" },
    });
  });
});

describe("the branch panel", () => {
  it("draws the room's patches and verdicts and never its conversation", () => {
    state.queries["buzz/projects:roomForge"] = {
      // A chat message is deliberately in this array. The panel must not draw
      // it — not because it filters one out, but because `classifyForgeEvent`
      // has nothing to say about a kind 9.
      events: [
        binding(),
        {
          id: "msg1",
          pubkey: BOB,
          created_at: 1100,
          kind: 9,
          tags: [["h", "ch1"]],
          content: "does this need a migration?",
        },
        {
          id: "patch1",
          pubkey: BOB,
          created_at: 1200,
          kind: KIND_GIT_PATCH,
          tags: [["a", REPO], ["subject", "Retry backoff"], ["c", OID]],
          content: "diff --git a/x b/x\n+retry\n",
        },
        {
          id: "ci1",
          pubkey: BOB,
          created_at: 1300,
          kind: KIND_GIT_STATUS_OPEN,
          tags: [["t", "ci"], ["e", "bind1"], ["c", OID]],
          content: "",
        },
      ],
      actors: ACTORS,
      project: PROJECT,
    };
    render(<BranchPane scope={SCOPE} channelId="ch1" />);

    expect(screen.getByText("Bound the retries")).toBeTruthy();
    expect(screen.getByText("Retry backoff")).toBeTruthy();
    expect(screen.getByText(/feature\/retry-budget → main/)).toBeTruthy();
    expect(screen.getByText("Checks passed")).toBeTruthy();
    expect(screen.getByText("Patches (1)")).toBeTruthy();
    expect(screen.queryByText(/needs a migration/)).toBeNull();
  });

  it("marks a review made against an older commit rather than dropping it", () => {
    state.queries["buzz/projects:roomForge"] = {
      events: [
        binding(),
        // The tip moved past the commit Bo judged.
        {
          id: "patch1",
          pubkey: OWNER,
          created_at: 1400,
          kind: KIND_GIT_PATCH,
          tags: [["a", REPO], ["c", "2".repeat(40)]],
          content: "diff",
        },
        {
          id: "rev1",
          pubkey: BOB,
          created_at: 1200,
          kind: KIND_GIT_STATUS_OPEN,
          tags: [["t", "review"], ["e", "bind1"], ["c", OID]],
          content: "looks right",
        },
      ],
      actors: ACTORS,
      project: PROJECT,
    };
    render(<BranchPane scope={SCOPE} channelId="ch1" />);
    expect(screen.getByText("Approved")).toBeTruthy();
    expect(screen.getByText(/against an older commit/)).toBeTruthy();
  });

  it("records a verdict through the mutation it claims to", async () => {
    state.queries["buzz/projects:roomForge"] = {
      events: [binding()],
      actors: ACTORS,
      project: PROJECT,
    };
    render(<BranchPane scope={SCOPE} channelId="ch1" />);
    await act(async () => {
      fireEvent.click(screen.getByText("Approve"));
    });
    expect(state.mutations).toEqual([
      {
        name: "buzz/projects:postReview",
        args: { ...SCOPE, channelId: "ch1", outcome: "approved" },
      },
    ]);
    expect(state.toasts[0].message).toBe("Approved");
  });

  it("says what is missing instead of hiding the merge control", () => {
    state.queries["buzz/projects:roomForge"] = {
      events: [
        binding(),
        {
          id: "ci1",
          pubkey: BOB,
          created_at: 1300,
          kind: KIND_GIT_STATUS_CLOSED,
          tags: [["t", "ci"], ["e", "bind1"], ["c", OID]],
          content: "",
        },
      ],
      actors: ACTORS,
      project: PROJECT,
    };
    render(<BranchPane scope={SCOPE} channelId="ch1" />);
    // A control that vanishes teaches nothing; one that explains itself does.
    expect(screen.getByText("Record merge")).toBeTruthy();
    expect(screen.getByText(/Checks failed · No current approval/)).toBeTruthy();
  });

  it("offers a way to become a branch room when it is not one", async () => {
    state.queries["buzz/projects:roomForge"] = {
      events: [],
      actors: [],
      project: null,
    };
    state.queries["buzz/projects:list"] = {
      projects: [{ project: PROJECT, branchRooms: 0, lastActivityAt: 0 }],
      groups: [],
      actors: ACTORS,
    };
    render(<BranchPane scope={SCOPE} channelId="ch1" />);
    fireEvent.change(screen.getByPlaceholderText("feature/retry-budget"), {
      target: { value: "feature/x" },
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Bind"));
    });
    expect(state.mutations).toEqual([
      {
        name: "buzz/projects:bindBranch",
        args: {
          ...SCOPE,
          channelId: "ch1",
          repoAddress: REPO,
          branch: "feature/x",
        },
      },
    ]);
  });

  it("says so plainly when there is no repository to bind to", () => {
    state.queries["buzz/projects:roomForge"] = { events: [], actors: [], project: null };
    state.queries["buzz/projects:list"] = { projects: [], groups: [], actors: [] };
    render(<BranchPane scope={SCOPE} channelId="ch1" />);
    expect(screen.getByText("Not a branch room")).toBeTruthy();
    expect(screen.queryByText("Bind")).toBeNull();
  });
});
