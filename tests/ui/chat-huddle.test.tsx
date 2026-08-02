import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Huddles, in the one environment that can answer the questions jsdom can
// answer.
//
// The interesting property of this phase is negative, and it is the one the
// gallery cannot check because it is about what a control *does* rather than
// how it looks: **with no voice provider wired, no control claims to work.**
// A mute button that mutes nothing looks identical to a mute button that
// works, and a person who spends one call believing they were muted stops
// trusting every other control in the product. So the assertions below are
// mostly about `disabled`, about the sentence shown instead, and about the
// fact that everything which lives on the log keeps working anyway.
//
// The rest is the set of rules with exactly one right answer and no visual
// signal when they are wrong: that the bar is absent when there is no call,
// that a stale huddle card offers no Join, that the roster is drawn from the
// log rather than from a transport that does not exist, and that Leave
// publishes.
//
// Mocks are local rather than the shared `tests/ui/harness.tsx`, for the reason
// `chat-agents.test.tsx` states: the harness keys `useQuery` on `ref.__path`,
// which only the generated `api` proxy carries, and every Chat query is
// addressed with `makeFunctionReference`. Keying on the real `getFunctionName`
// answers both.

type ToastCall = { message: string; opts?: { kind?: string } };

const state = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  mutationResults: {} as Record<string, unknown>,
  mutations: [] as { name: string; args: unknown }[],
  toasts: [] as ToastCall[],
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
        return state.mutationResults[name];
      };
    },
    useAction: (ref: Ref) => {
      const name = getFunctionName(ref);
      return async (args: unknown) => {
        state.mutations.push({ name, args });
        return state.mutationResults[name] ?? null;
      };
    },
  };
});

vi.mock("@/components/motion", async () => await import("./motion-mock"));

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

import type { ReactNode } from "react";
import {
  HuddleBar,
  HuddleCard,
  HuddleProvider,
  HuddleStartButton,
  HuddleTransportContext,
  NULL_HUDDLE_TRANSPORT,
  huddleCardStatus,
  type HuddleTransport,
} from "@/components/chat/huddle";
import {
  HUDDLE_JOINABLE_WINDOW_SECONDS,
  foldHuddles,
  type HuddleLogEvent,
  type HuddleSnapshot,
} from "@/lib/buzz/huddle";
import type { ChatScope } from "@/lib/buzz/channel-types";

const SCOPE: ChatScope = { scopeType: "workspace", scopeId: "w1" };
const CHANNEL = "flight-path";
const ME = "a".repeat(64);
const SCOUT = "b".repeat(64);

const HUDDLES = "buzz/huddle:forChannel";
const START = "buzz/huddle:start";
const JOIN = "buzz/huddle:join";
const LEAVE = "buzz/huddle:leave";
const ATTACHABLE = "buzz/agents:attachable";

function snapshot(over: Partial<HuddleSnapshot> = {}): HuddleSnapshot {
  return {
    huddleId: "h1",
    parentChannelId: CHANNEL,
    startedByPubkey: ME,
    startedAt: 1700,
    endedAt: null,
    live: true,
    endReason: null,
    participants: [
      { pubkey: ME, isAgent: false, joinedAt: 1700 },
      { pubkey: SCOUT, isAgent: true, joinedAt: 1701 },
    ],
    participantCount: 2,
    inferred: false,
    ...over,
  };
}

function setView(huddles: HuddleSnapshot[]) {
  state.queries[HUDDLES] = {
    huddles,
    names: {
      [ME]: { name: "Ada", isAgent: false },
      [SCOUT]: { name: "Scout", isAgent: true },
    },
    viewerPubkey: ME,
  };
}

function Room({ children }: { children: ReactNode }) {
  return (
    <HuddleProvider scope={SCOPE} channelId={CHANNEL} selfPubkey={ME} selfName="Ada">
      {children}
    </HuddleProvider>
  );
}

/** A provider that *can* carry audio, for the half that is not about absence. */
const FAKE_ROOM = {
  setMicrophoneEnabled: vi.fn(async () => {}),
  setTransmitting: vi.fn(),
  setInputGain: vi.fn(),
  setInputDevice: vi.fn(async () => {}),
  setOutputDevice: vi.fn(async () => {}),
  setAgentSpeechEnabled: vi.fn(async () => {}),
  setCaptionsEnabled: vi.fn(async () => {}),
  leave: vi.fn(async () => {}),
};

const WORKING_TRANSPORT: HuddleTransport = {
  id: "test",
  label: "Test transport",
  capabilities: {
    microphone: true,
    deviceSelection: true,
    captions: true,
    agentSpeech: true,
  },
  unavailableReason: null,
  join: async () => FAKE_ROOM,
};

beforeEach(() => {
  state.queries = {};
  state.mutationResults = {};
  state.mutations = [];
  state.toasts = [];
  state.mutationResults[START] = {
    huddleId: "h1",
    created: true,
    agentsInvited: [],
    agentErrors: [],
  };
  state.mutationResults[JOIN] = { huddleId: "h1", joined: true };
  state.mutationResults[LEAVE] = { huddleId: "h1", left: true, ended: false };
  state.queries[ATTACHABLE] = [];
  setView([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Start a call, and let the log catch up.
 *
 * The mocked `useQuery` is a plain read of a mutable object rather than a
 * subscription, so a test that changes what the server says has to re-render
 * to see it. That is a fact about the mock, not about the component — Convex
 * pushes the change in the real thing.
 */
async function startACall() {
  setView([]);
  // A **fresh element every time**: `rerender` with the identical element
  // object lets React bail out of the render entirely, so the new query result
  // is never read and the test measures the previous frame.
  const tree = () => (
    <Room>
      <HuddleStartButton />
      <HuddleBar />
    </Room>
  );
  const { rerender } = render(tree());
  await act(async () => {
    fireEvent.click(screen.getByTestId("huddle-start"));
  });
  // The log now holds the call, which is what makes the roster real.
  setView([snapshot()]);
  await act(async () => {
    rerender(tree());
  });
  return { rerender: async () => act(async () => rerender(tree())) };
}

// ---------------------------------------------------------------------------

describe("the bar is only there when there is a call", () => {
  it("renders nothing at rest", () => {
    render(
      <Room>
        <HuddleBar />
      </Room>,
    );
    expect(screen.queryByTestId("huddle-bar")).toBeNull();
  });

  it("appears once the log says you are in one", async () => {
    await startACall();
    await waitFor(() => expect(screen.getByTestId("huddle-bar")).toBeTruthy());
    expect(state.mutations.filter((call) => call.name === START)).toHaveLength(1);
  });
});

describe("with no voice provider", () => {
  it("says so, and disables every control that would be a lie", async () => {
    await startACall();
    const bar = await screen.findByTestId("huddle-bar");
    // The phase is the seam: the log says you are in the call, the audio is
    // not up, and the bar is honest about exactly that.
    expect(bar.getAttribute("data-phase")).toBe("connected");
    expect(bar.getAttribute("data-media")).toBe("silent");

    const notice = screen.getByTestId("huddle-media-notice").textContent ?? "";
    expect(notice).toContain("Voice is not configured");
    // And it says what still works, because "voice is not configured" alone
    // reads as "this huddle is broken", which it is not.
    expect(notice).toContain("roster");

    for (const id of ["huddle-mic-toggle", "huddle-speaker-toggle", "huddle-captions"]) {
      const control = screen.getByTestId(id) as HTMLButtonElement;
      expect(control.disabled).toBe(true);
      expect(control.getAttribute("aria-disabled")).toBe("true");
      expect(control.getAttribute("title") ?? "").toContain("Voice is not configured");
    }
  });

  it("still draws the roster, because that is on the log", async () => {
    await startACall();
    await act(async () => {
      fireEvent.click(await screen.findByTestId("huddle-participants"));
    });
    const rows = await screen.findAllByTestId("huddle-participant");
    // Agents first, then by name — the order the presence roster uses, so two
    // rails in one product cannot disagree about who leads.
    expect(rows.map((row) => row.getAttribute("data-pubkey"))).toEqual([SCOUT, ME]);
    expect(rows[0].textContent).toContain("Scout");
    expect(rows[0].textContent).toContain("Agent");
    expect(rows[1].textContent).toContain("(you)");
    // Nobody's ring lights, because nothing measured anybody speaking. A ring
    // driven by anything else would look exactly like the real thing.
    expect(rows.every((row) => row.getAttribute("data-speaking") === "false")).toBe(true);
  });

  it("says the transcript is not being captured, and why", async () => {
    await startACall();
    // Captions turn themselves on because a machine is in the call (§1.13),
    // which is what puts the pane on screen with nothing in it.
    const pane = await screen.findByTestId("huddle-transcript");
    expect(pane.textContent).toContain("Not recorded");
    expect(pane.textContent).toContain("no voice provider");
    // And it names the half that is real: an agent can write here.
    expect(pane.textContent).toContain("Agents in the huddle can still write here");
  });

  it("publishes a leave that everybody can see", async () => {
    await startACall();
    await act(async () => {
      fireEvent.click(await screen.findByTestId("huddle-leave"));
    });
    const leaves = state.mutations.filter((call) => call.name === LEAVE);
    expect(leaves).toHaveLength(1);
    expect(leaves[0].args).toMatchObject({ channelId: CHANNEL, huddleId: "h1" });
  });
});

describe("with a provider that can carry audio", () => {
  it("reaches the audio path, and the mute button reaches the microphone", async () => {
    setView([]);
    const tree = () => (
      <HuddleTransportContext.Provider value={WORKING_TRANSPORT}>
        <Room>
          <HuddleStartButton />
          <HuddleBar />
        </Room>
      </HuddleTransportContext.Provider>
    );
    const { rerender } = render(tree());
    await act(async () => {
      fireEvent.click(screen.getByTestId("huddle-start"));
    });
    setView([snapshot()]);
    await act(async () => {
      rerender(tree());
    });

    const bar = await screen.findByTestId("huddle-bar");
    await waitFor(() => expect(bar.getAttribute("data-media")).toBe("live"));
    expect(bar.getAttribute("data-phase")).toBe("active");

    const mic = screen.getByTestId("huddle-mic-toggle") as HTMLButtonElement;
    expect(mic.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(mic);
    });
    // The whole point of the adapter: mute is a method call on the audio
    // graph, not a flag in a component.
    await waitFor(() => expect(FAKE_ROOM.setMicrophoneEnabled).toHaveBeenCalledWith(false));
  });
});

describe("the huddle card", () => {
  it("offers Join while a call is live", async () => {
    setView([snapshot()]);
    render(
      <Room>
        <HuddleCard eventId="h1" />
      </Room>,
    );
    const card = screen.getByTestId("huddle-card");
    expect(card.textContent).toContain("in progress");
    await act(async () => {
      fireEvent.click(screen.getByTestId("huddle-card-join"));
    });
    expect(state.mutations.filter((call) => call.name === JOIN)).toHaveLength(1);
  });

  it("offers nothing once the call has decayed", () => {
    // A 48100 older than the joinable window with no end event: the last
    // laptop lid closed. Without the decay rule this card says "in progress"
    // forever, with a Join button that connects to nobody.
    const stale = foldHuddles(
      [
        started("h1", Math.floor(Date.now() / 1000) - HUDDLE_JOINABLE_WINDOW_SECONDS - 1),
        joined("h1", ME, Math.floor(Date.now() / 1000) - HUDDLE_JOINABLE_WINDOW_SECONDS - 1),
      ],
      Date.now(),
    );
    expect(stale[0].endReason).toBe("expired");
    setView(stale);
    render(
      <Room>
        <HuddleCard eventId="h1" />
      </Room>,
    );
    expect(screen.getByTestId("huddle-card").textContent).toContain("ended");
    expect(screen.queryByTestId("huddle-card-join")).toBeNull();
  });

  it("says one thing about state, and says it the same way everywhere", () => {
    expect(huddleCardStatus(snapshot({ participantCount: 1 }))).toContain("1 person");
    expect(huddleCardStatus(snapshot({ live: false, endReason: "ended" }))).toContain("ended");
    expect(huddleCardStatus(null)).toBe("Huddle");
  });
});

describe("controls that need you to be in the call", () => {
  it("refuse to react from outside it", () => {
    setView([snapshot()]);
    render(
      <Room>
        <HuddleBar />
      </Room>,
    );
    // No bar at all, because this browser is not in the call — the huddle is
    // somebody else's and the room shows a Join, not a control cluster.
    expect(screen.queryByTestId("huddle-bar")).toBeNull();
  });

  it("hide the start button while you are already in one", async () => {
    await startACall();
    await waitFor(() => expect(screen.queryByTestId("huddle-start")).toBeNull());
  });
});

// ---------------------------------------------------------------------------

const NULL_TRANSPORT_IS_HONEST = NULL_HUDDLE_TRANSPORT;

describe("the null transport", () => {
  it("refuses rather than returning a room that does nothing", async () => {
    // The single most important line in `transport.ts`: a no-op room would put
    // the session into `active`, light every control, and let somebody spend a
    // call believing they were unmuted.
    await expect(
      NULL_TRANSPORT_IS_HONEST.join(
        { huddleId: "h1", parentChannelId: CHANNEL, pubkey: ME, displayName: "Ada" },
        {},
      ),
    ).rejects.toThrow(/not configured/);
    expect(NULL_TRANSPORT_IS_HONEST.capabilities.microphone).toBe(false);
    expect(NULL_TRANSPORT_IS_HONEST.unavailableReason).not.toBeNull();
  });
});

function started(id: string, at: number): HuddleLogEvent {
  return {
    id,
    pubkey: ME,
    kind: 48100,
    created_at: at,
    tags: [["h", CHANNEL]],
    content: "{}",
  };
}

function joined(huddleId: string, pubkey: string, at: number): HuddleLogEvent {
  return {
    id: `join-${pubkey}-${at}`,
    pubkey: "relay",
    kind: 48101,
    created_at: at,
    tags: [
      ["h", CHANNEL],
      ["e", huddleId],
      ["p", pubkey],
      ["role", "human"],
    ],
    content: "{}",
  };
}
