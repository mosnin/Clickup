import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Agents in a room.
//
// jsdom cannot say whether a room reads well — that is what the gallery shots
// are for, and they were looked at. What it *can* say is the set of rules this
// phase IS, every one of which has exactly one right answer and no visual
// signal when it is wrong:
//
//   • whether a crashed harness's spinner ever goes away (the lease, ticked by
//     a real clock with no data arriving),
//   • whether forty tool calls draw forty rows (the two-pass fold),
//   • whether appending a step re-keys a row somebody is reading,
//   • whether a failed step can be hidden inside a summary,
//   • whether the room says the D9 silence out loud or lets it read as a bug,
//   • whether removing an agent waits for its undo window.
//
// Mocks are local rather than the shared `tests/ui/harness.tsx`, for the reason
// `chat-transcript.test.tsx` states: the harness keys `useQuery` on
// `ref.__path`, which only the generated `api` proxy carries, and every Chat
// query is addressed with `makeFunctionReference`. Keying on the real
// `getFunctionName` answers both.
//
// No jest-dom matchers anywhere: assertions read attributes and text content
// directly, the same as `mode-switcher.test.tsx`.

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
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  type Ref = Parameters<typeof getFunctionName>[0];
  return {
    useQuery: (ref: Ref, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(ref);
      // A query against a function the deployment does not have throws during
      // render — the exact failure the boundary exists for.
      if (state.throwing.has(name)) {
        throw new Error(`Could not find public function ${name}`);
      }
      return state.queries[name];
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

vi.mock("@/components/motion", async () => await import("./motion-mock"));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/chat/c/flight-path",
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

import {
  AgentActivityLog,
  AgentWorkingLine,
  RoomAgentsPanel,
  buildTurnActivity,
  classifyStep,
  collapseActivity,
  countActivityRows,
  deriveWorking,
  foldClockOffset,
  readAgentState,
  serverTime,
  splitIntoSessionRuns,
  turnIsLive,
  useRoomWorkingSignal,
  workingLabel,
  TURN_ABANDON_AFTER_MS,
  TURN_STALE_AFTER_MS,
  type ActivitySegment,
  type ChatTurn,
  type ChatTurnStep,
} from "@/components/chat/agents";
import type { ChatScope } from "@/lib/buzz/channel-types";

const SCOPE: ChatScope = { scopeType: "workspace", scopeId: "w1" };
const NOW = 1_700_000_000_000;

function step(over: Partial<ChatTurnStep> & { key: string }): ChatTurnStep {
  return {
    title: over.key,
    status: "done",
    startedAt: NOW,
    finishedAt: NOW + 500,
    ...over,
  };
}

function turn(over: Partial<ChatTurn> = {}): ChatTurn {
  return {
    turnId: "t1",
    channelId: "flight-path",
    agentId: "agent_honey",
    agentPubkey: "a".repeat(64),
    agentName: "Honey",
    startedAt: NOW - 30_000,
    lastActivityAt: NOW,
    state: "streaming",
    ...over,
  };
}

beforeEach(() => {
  for (const key of Object.keys(state.queries)) delete state.queries[key];
  state.throwing.clear();
  state.mutations.length = 0;
  state.toasts.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// The lease
// ---------------------------------------------------------------------------

describe("a turn's liveness is a lease, not an announcement", () => {
  it("is live while frames are recent", () => {
    expect(turnIsLive(turn({ lastActivityAt: NOW - 9_000 }), NOW)).toBe(true);
  });

  it("stops being live without anybody having to report the death", () => {
    // The whole point. Nothing arrives to say the harness crashed — the signal
    // goes away because its lease was not renewed.
    expect(turnIsLive(turn({ lastActivityAt: NOW - TURN_STALE_AFTER_MS }), NOW)).toBe(false);
    expect(turnIsLive(turn({ lastActivityAt: NOW - TURN_STALE_AFTER_MS + 1 }), NOW)).toBe(true);
  });

  it("believes a terminal state immediately, without waiting out the lease", () => {
    // An agent that said it finished has finished; only the ABSENCE of a
    // terminal state proves nothing.
    expect(turnIsLive(turn({ state: "finished", lastActivityAt: NOW }), NOW)).toBe(false);
    expect(turnIsLive(turn({ state: "cancelled", lastActivityAt: NOW }), NOW)).toBe(false);
  });
});

describe("the room re-derives the signal against its own clock", () => {
  it("collapses an agent's concurrent turns onto the earliest start", () => {
    // One identity, several subprocesses. "Working for four minutes" is the
    // true answer; anchoring on the newest would reset the counter every time
    // the agent started another turn.
    const derived = deriveWorking(
      [
        turn({ turnId: "a", startedAt: NOW - 240_000 }),
        turn({ turnId: "b", startedAt: NOW - 5_000 }),
      ],
      NOW,
    );
    expect(derived.length).toBe(1);
    expect(derived[0].anchorAt).toBe(NOW - 240_000);
  });

  it("drops a turn whose lease expired, and keeps the rest", () => {
    const derived = deriveWorking(
      [
        turn({ turnId: "dead", agentId: "a1", lastActivityAt: NOW - 60_000 }),
        turn({ turnId: "live", agentId: "a2", lastActivityAt: NOW - 1_000 }),
      ],
      NOW,
    );
    expect(derived.map((entry) => entry.turnId)).toEqual(["live"]);
  });

  it("names everybody until there are four, then counts", () => {
    expect(workingLabel(["Honey"])).toBe("Honey is working");
    expect(workingLabel(["Honey", "Scout"])).toBe("Honey and Scout are working");
    expect(workingLabel(["A", "B", "C"])).toBe("A, B, and C are working");
    expect(workingLabel(["A", "B", "C", "D"])).toBe("A, B, and 2 others are working");
  });
});

describe("the clock offset", () => {
  it("keeps the running MINIMUM, so one slow round trip cannot move it", () => {
    // Every sample is inflated by however long the answer spent on the wire, so
    // the smallest difference seen is the one with the least network in it. An
    // average would push every elapsed counter forward by that latency.
    let offset = foldClockOffset(null, { serverNow: 1_000, clientNow: 1_400 });
    expect(offset?.ms).toBe(400);
    offset = foldClockOffset(offset, { serverNow: 2_000, clientNow: 2_900 });
    expect(offset?.ms).toBe(400);
    offset = foldClockOffset(offset, { serverNow: 3_000, clientNow: 3_150 });
    expect(offset?.ms).toBe(150);
  });

  it("is absent rather than zero until a sample arrives", () => {
    // Pretending to a correction of zero would make an offset appearing later
    // look like every turn in the room jumping.
    expect(foldClockOffset(null, { serverNow: NaN, clientNow: 5 })).toBeNull();
    expect(serverTime(5_000, null)).toBe(5_000);
    expect(serverTime(5_000, { ms: 400 })).toBe(4_600);
  });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe("classification says what kind of thing happened", () => {
  it("separates a skill from one of its supporting files", () => {
    const skill = classifyStep(step({ key: "s1", tool: "load_skill", detail: "code-review" }));
    const file = classifyStep(
      step({ key: "s2", tool: "load_skill", detail: "code-review/checklist.md" }),
    );
    expect(skill.label).toBe("Read a skill");
    expect(file.label).toBe("Read a skill file");
  });

  it("normalizes the many spellings of one act", () => {
    for (const tool of ["shell", "bash", "run_command", "mcp__harness__shell"]) {
      expect(classifyStep(step({ key: tool, tool })).descriptor.renderClass).toBe("shell");
    }
  });

  it("reads the verb of a product tool for its tone", () => {
    expect(classifyStep(step({ key: "a", tool: "list_tasks" })).descriptor.tone).toBe("read");
    expect(classifyStep(step({ key: "b", tool: "create_task" })).descriptor.tone).toBe("write");
    expect(classifyStep(step({ key: "c", tool: "remove_member" })).descriptor.tone).toBe("admin");
  });

  it("uses the runtime's own words for a tool it has never heard of", () => {
    const unknown = classifyStep(
      step({ key: "u", tool: "quantum_flux", title: "Recalibrated the flux" }),
    );
    expect(unknown.descriptor.renderClass).toBe("generic");
    expect(unknown.label).toBe("Recalibrated the flux");
  });

  it("keeps a running step in the present tense", () => {
    expect(classifyStep(step({ key: "r", tool: "shell", status: "running" })).label).toBe(
      "Running a command",
    );
  });

  it("re-classes a failure so it can never be folded away", () => {
    const failed = classifyStep(step({ key: "f", tool: "shell", status: "failed" }));
    expect(failed.descriptor.renderClass).toBe("error");
    expect(failed.descriptor.groupKey).toBeUndefined();
    expect(failed.label).toBe("Command failed");
  });
});

// ---------------------------------------------------------------------------
// The two-pass fold
// ---------------------------------------------------------------------------

function labelsOf(segments: readonly ActivitySegment[]): string[] {
  return segments.map((segment) =>
    segment.kind === "summary" ? segment.label : segment.item.label,
  );
}

describe("the two-pass collapse", () => {
  it("folds three of a kind and leaves two alone", () => {
    const three = collapseActivity(
      ["a", "b", "c"].map((key) => classifyStep(step({ key, tool: "read_file" }))),
    );
    expect(labelsOf(three)).toEqual(["Read 3 files"]);
  });

  it("folds two file edits, because two is already a change with two parts", () => {
    const edits = collapseActivity(
      ["a", "b"].map((key) => classifyStep(step({ key, tool: "str_replace" }))),
    );
    expect(labelsOf(edits)).toEqual(["Edited 2 files"]);
  });

  it("collapses a mixed burst and flattens it to leaves, never to nested summaries", () => {
    const steps = [
      ...Array.from({ length: 12 }, (_, i) => step({ key: `r${i}`, tool: "read_file" })),
      ...Array.from({ length: 4 }, (_, i) => step({ key: `s${i}`, tool: "shell" })),
    ].map(classifyStep);

    const segments = collapseActivity(steps);
    expect(segments.length).toBe(1);
    const [burst] = segments;
    if (burst.kind !== "summary") throw new Error("expected a summary");
    expect(burst.variant).toBe("mixed");
    expect(burst.label).toBe("Ran 16 tool calls");
    // Expanding it must not produce "Read 12 files" as a child — a summary of
    // summaries is a table of contents for a paragraph.
    expect(burst.children.length).toBe(16);
  });

  it("draws forty tool calls as one row, which is the point of the phase", () => {
    const steps = Array.from({ length: 40 }, (_, i) =>
      classifyStep(step({ key: `k${i}`, tool: i % 3 === 0 ? "shell" : "read_file" })),
    );
    expect(collapseActivity(steps).length).toBe(1);
  });

  it("never hides a failed step inside a summary, and breaks the run around it", () => {
    const steps = [
      ...Array.from({ length: 3 }, (_, i) => step({ key: `a${i}`, tool: "read_file" })),
      step({ key: "boom", tool: "shell", status: "failed" }),
      ...Array.from({ length: 3 }, (_, i) => step({ key: `b${i}`, tool: "read_file" })),
    ].map(classifyStep);

    const segments = collapseActivity(steps);
    const failedRow = segments.find(
      (segment) => segment.kind === "step" && segment.item.step.key === "boom",
    );
    expect(failedRow).toBeDefined();
    // …and it separated the two runs rather than letting them merge across it.
    expect(segments.length).toBe(3);
    for (const segment of segments) {
      if (segment.kind !== "summary") continue;
      expect(segment.children.some((child) => child.step.key === "boom")).toBe(false);
    }
  });

  it("reports the strongest tone inside a fold, never the average", () => {
    const segments = collapseActivity(
      [
        step({ key: "a", tool: "list_tasks" }),
        step({ key: "b", tool: "list_pages" }),
        step({ key: "c", tool: "remove_member" }),
      ].map(classifyStep),
    );
    const [summary] = segments;
    if (summary.kind !== "summary") throw new Error("expected a summary");
    expect(summary.tone).toBe("admin");
  });

  it("keeps a summary's identity when a step is APPENDED to it", () => {
    // The house invariant from `timeline.ts:planSystemGroups`, pointed the other
    // way. Messages prepend, so that fold anchors on the newest; a run's steps
    // append, so this one anchors on the oldest. Copying the direction verbatim
    // would re-key a row on every frame — the exact bug that file exists to
    // prevent, wearing the same clothes.
    const first = ["a", "b", "c"].map((key) => classifyStep(step({ key, tool: "shell" })));
    const before = collapseActivity(first);
    const after = collapseActivity([...first, classifyStep(step({ key: "d", tool: "shell" }))]);

    expect(before[0].id).toBe(after[0].id);
    expect(labelsOf(before)).toEqual(["Ran 3 commands"]);
    expect(labelsOf(after)).toEqual(["Ran 4 commands"]);
  });
});

// ---------------------------------------------------------------------------
// Session runs
// ---------------------------------------------------------------------------

describe("session runs", () => {
  it("prepends the opening session-less frames to the run they belong to", () => {
    // The real wire order: turn started (no session) → session/new (no session)
    // → session resolved. Grouping naively draws the boundary UNDER the turn's
    // own opening.
    const runs = splitIntoSessionRuns(
      [
        step({ key: "open", sessionId: null }),
        step({ key: "new", sessionId: null }),
        step({ key: "first", sessionId: "sess-a" }),
      ].map(classifyStep),
    );
    expect(runs.length).toBe(1);
    expect(runs[0].sessionId).toBe("sess-a");
    expect(runs[0].items.map((item) => item.step.key)).toEqual(["open", "new", "first"]);
  });

  it("attributes a mid-stream session-less frame to the run already open", () => {
    const runs = splitIntoSessionRuns(
      [
        step({ key: "a", sessionId: "sess-a" }),
        step({ key: "b", sessionId: null }),
        step({ key: "c", sessionId: "sess-b" }),
      ].map(classifyStep),
    );
    expect(runs.map((run) => run.sessionId)).toEqual(["sess-a", "sess-b"]);
    expect(runs[0].items.map((item) => item.step.key)).toEqual(["a", "b"]);
  });

  it("makes an entirely session-less stream one run, not N runs of one", () => {
    const runs = splitIntoSessionRuns(["a", "b", "c"].map((key) => classifyStep(step({ key }))));
    expect(runs.length).toBe(1);
    expect(runs[0].sessionId).toBe("unknown");
  });

  it("never folds across a session boundary", () => {
    const runs = buildTurnActivity([
      ...Array.from({ length: 3 }, (_, i) =>
        step({ key: `a${i}`, tool: "shell", sessionId: "sess-a" }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        step({ key: `b${i}`, tool: "shell", sessionId: "sess-b" }),
      ),
    ]);
    expect(runs.length).toBe(2);
    expect(countActivityRows(runs)).toBe(2);
    expect(labelsOf(runs[0].segments)).toEqual(["Ran 3 commands"]);
  });
});

// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------

/** The band as a room mounts it: the connected hook plus the line it feeds. */
function WorkingBand() {
  const signal = useRoomWorkingSignal(SCOPE, "flight-path");
  return (
    <>
      {signal.subscriptions}
      <AgentWorkingLine working={signal.working} now={signal.now} />
      {signal.error ? <p data-testid="signal-error">{signal.error}</p> : null}
    </>
  );
}

describe("the working signal in the room", () => {
  it("says who is working, and for how long", () => {
    const at = Date.now();
    state.queries["buzz/agents:turnsFor"] = [
      { ...turn({ startedAt: at - 62_000, lastActivityAt: at }), liveness: "working" },
    ];
    state.queries["buzz/agents:working"] = { working: true, agents: [], anchorAt: null, now: at };
    render(<WorkingBand />);
    const line = screen.getByTestId("agent-working-line");
    expect(line.textContent).toContain("Honey is working");
    expect(line.textContent).toContain("1m 02s");
  });

  it("clears itself when the harness stops sending, with no new data at all", () => {
    // The one behaviour that cannot be tested by handing the component a
    // different query result: nothing changes on the wire. A crashed runtime
    // sends nothing, so only local time can retire the row.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    state.queries["buzz/agents:turnsFor"] = [
      { ...turn({ startedAt: NOW - 5_000, lastActivityAt: NOW }), liveness: "working" },
    ];
    state.queries["buzz/agents:working"] = {
      working: true,
      agents: [],
      anchorAt: NOW - 5_000,
      now: NOW,
    };

    render(<WorkingBand />);
    expect(screen.queryByTestId("agent-working-line")).not.toBeNull();

    act(() => {
      vi.setSystemTime(NOW + TURN_STALE_AFTER_MS + 1_000);
      vi.advanceTimersByTime(TURN_STALE_AFTER_MS + 1_000);
    });

    expect(screen.queryByTestId("agent-working-line")).toBeNull();
  });

  it("draws nothing rather than a guess when the query is not callable", () => {
    // On a deployment that has not regenerated its api stub these throw. The
    // room must degrade to silence plus a reason, never to an invented agent
    // and never to a white screen.
    state.throwing.add("buzz/agents:turnsFor");
    state.throwing.add("buzz/agents:working");
    render(<WorkingBand />);
    expect(screen.queryByTestId("agent-working-line")).toBeNull();
    expect(screen.getByTestId("signal-error").textContent).toContain(
      "Could not find public function",
    );
  });
});

// ---------------------------------------------------------------------------
// The activity transcript
// ---------------------------------------------------------------------------

describe("the activity transcript", () => {
  it("opens a fold to the leaves it summarised", () => {
    const steps = Array.from({ length: 4 }, (_, i) =>
      step({ key: `k${i}`, tool: "shell", detail: `npm test ${i}` }),
    );
    render(<AgentActivityLog turn={turn()} steps={steps} now={NOW} />);

    const summary = screen.getByRole("button", { name: /Ran 4 commands/ });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("npm test 0")).toBeNull();

    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByText("npm test 0")).not.toBeNull();
  });

  it("says a turn reported nothing, rather than drawing a skeleton forever", () => {
    // Today nobody supplies a step stream: the turn record carries a sentence,
    // not a transcript. A skeleton would be a promise that rows are coming.
    render(<AgentActivityLog turn={turn()} now={NOW} />);
    expect(screen.getByText("No steps reported yet.")).toBeTruthy();
  });

  it("says stalled rather than finished for a turn that stopped mid-sentence", () => {
    const stalled = turn({ lastActivityAt: NOW - TURN_STALE_AFTER_MS - 1_000 });
    render(<AgentActivityLog turn={stalled} now={NOW} />);
    const section = document.querySelector("[data-agent-activity]");
    expect(section?.getAttribute("data-liveness")).toBe("stalled");
  });
});

// ---------------------------------------------------------------------------
// The member list, and D9
// ---------------------------------------------------------------------------

function attachable(over: Record<string, unknown> = {}) {
  return {
    agentId: "agent_honey",
    name: "Honey",
    attached: true,
    hasKey: true,
    pubkey: "a".repeat(64),
    blockedReason: null,
    ...over,
  };
}

function roster() {
  return [
    {
      actorId: "agent_honey",
      actorType: "agent",
      name: "Honey",
      pubkey: "a".repeat(64),
      status: "offline",
      lastSeenAt: null,
      statusText: null,
      statusEmoji: null,
      statusExpiresAt: null,
    },
  ];
}

function Panel() {
  return <RoomAgentsPanel scope={SCOPE} channelId="flight-path" roomLabel="#flight-path" />;
}

describe("an agent in the member list", () => {
  beforeEach(() => {
    state.queries["buzz/agents:turnsFor"] = [];
    state.queries["buzz/agents:working"] = {
      working: false,
      agents: [],
      anchorAt: null,
      now: Date.now(),
    };
    state.queries["buzz/presence:roster"] = roster();
    state.queries["buzz/agents:attachable"] = [attachable()];
  });

  it("says the D9 silence out loud when nothing has ever run the agent", () => {
    // The single most likely thing in this product to be mistaken for a bug.
    render(<Panel />);

    const notice = screen.getByTestId("harness-silence");
    expect(notice.textContent).toContain("Nothing is running Honey yet");
    // The cause…
    expect(notice.textContent).toContain("its own runtime");
    // …and the next action, not just a diagnosis.
    expect(notice.textContent).toContain("/api/mcp");
    expect(
      screen.getByRole("link", { name: /Manage keys in Agents/ }).getAttribute("href"),
    ).toBe("/dashboard/agents");
  });

  it("does not re-teach setup to somebody whose agent has answered before", () => {
    state.queries["buzz/agents:attachable"] = [attachable({ lastSeenAt: NOW - 3_600_000 })];
    render(<Panel />);
    expect(screen.queryByTestId("harness-silence")).toBeNull();
    const row = document.querySelector('[data-agent-member="agent_honey"]');
    expect(row?.getAttribute("data-reading")).toBe("idle");
  });

  it("distinguishes a turn that stopped mid-sentence from one that ended", () => {
    const at = Date.now();
    state.queries["buzz/agents:attachable"] = [attachable({ lastSeenAt: at - 60_000 })];
    state.queries["buzz/agents:turnsFor"] = [
      {
        ...turn({ startedAt: at - 120_000, lastActivityAt: at - TURN_STALE_AFTER_MS - 5_000 }),
        liveness: "stalled",
      },
    ];
    render(<Panel />);
    const row = document.querySelector('[data-agent-member="agent_honey"]');
    expect(row?.getAttribute("data-reading")).toBe("stalled");
    expect(row?.textContent).toContain("Stopped responding");
  });

  it("forgets a turn nobody has heard from past the recovery window", () => {
    // `stalled` is recoverable and says so; past three minutes the turn can
    // never come back, so continuing to draw it would be drawing work that is
    // not happening.
    const at = Date.now();
    state.queries["buzz/agents:attachable"] = [attachable({ lastSeenAt: at - 600_000 })];
    state.queries["buzz/agents:turnsFor"] = [
      {
        ...turn({ startedAt: at - 900_000, lastActivityAt: at - TURN_ABANDON_AFTER_MS - 1_000 }),
        liveness: "abandoned",
      },
    ];
    render(<Panel />);
    const row = document.querySelector('[data-agent-member="agent_honey"]');
    expect(row?.getAttribute("data-reading")).toBe("idle");
  });

  it("shows what the agent is doing, and opens its activity", () => {
    const at = Date.now();
    state.queries["buzz/agents:attachable"] = [attachable({ lastSeenAt: at })];
    state.queries["buzz/agents:turnsFor"] = [
      {
        ...turn({ startedAt: at - 20_000, lastActivityAt: at, narration: "Reading the diff" }),
        liveness: "working",
      },
    ];
    render(<Panel />);

    const row = document.querySelector('[data-agent-member="agent_honey"]');
    expect(row?.getAttribute("data-reading")).toBe("working");
    expect(row?.textContent).toContain("Reading the diff");
    expect(screen.queryByTestId("harness-silence")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Reading the diff/ }));
    expect(document.querySelector("[data-agent-activity]")).not.toBeNull();
  });

  it("draws the agent with the same row a person gets, plus what only it needs", () => {
    render(<Panel />);
    const row = document.querySelector('[data-agent-member="agent_honey"]') as HTMLElement;
    expect(row).not.toBeNull();
    // The name comes from the same PresenceRow a human is drawn with…
    expect(within(row).getByText("Honey")).toBeTruthy();
    // …and the agent chip is the same word the transcript uses on a message.
    expect(within(row).getByText("agent")).toBeTruthy();
  });

  it("defers the removal until the undo window closes", () => {
    render(<Panel />);

    fireEvent.click(screen.getByRole("button", { name: /Remove Honey/ }));
    // Gone from the list immediately…
    expect(document.querySelector('[data-agent-member="agent_honey"]')).toBeNull();
    // …but nothing has been written. A remove that fired now would make Undo a
    // second mutation that can fail on its own.
    expect(state.mutations.length).toBe(0);

    const last = state.toasts[state.toasts.length - 1];
    expect(last.opts?.action?.label).toBe("Undo");
    last.opts?.onExpire?.();
    expect(state.mutations.map((call) => call.name)).toEqual(["buzz/agents:detach"]);
    expect(state.mutations[0].args).toMatchObject({
      channelId: "flight-path",
      agentId: "agent_honey",
    });
  });

  it("undoes without writing anything", () => {
    render(<Panel />);
    fireEvent.click(screen.getByRole("button", { name: /Remove Honey/ }));
    const last = state.toasts[state.toasts.length - 1];
    act(() => last.opts?.action?.onClick());
    expect(document.querySelector('[data-agent-member="agent_honey"]')).not.toBeNull();
    expect(state.mutations.length).toBe(0);
  });
});

describe("adding an agent to a room", () => {
  beforeEach(() => {
    state.queries["buzz/agents:turnsFor"] = [];
    state.queries["buzz/agents:working"] = {
      working: false,
      agents: [],
      anchorAt: null,
      now: Date.now(),
    };
    state.queries["buzz/presence:roster"] = roster();
  });

  it("says so when everybody is already here", () => {
    state.queries["buzz/agents:attachable"] = [attachable({ lastSeenAt: NOW })];
    render(<Panel />);
    expect(screen.getByText(/already here/)).toBeTruthy();
  });

  it("attaches the agent that was picked", async () => {
    state.queries["buzz/agents:attachable"] = [
      attachable({ lastSeenAt: NOW }),
      attachable({ agentId: "agent_scout", name: "Scout", attached: false }),
    ];
    render(<Panel />);

    fireEvent.click(screen.getByRole("button", { name: /Add an agent/ }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("option", { name: /Scout/ })).getByRole("button"));
    });

    expect(state.mutations.map((call) => call.name)).toEqual(["buzz/agents:attach"]);
    expect(state.mutations[0].args).toMatchObject({
      scopeType: "workspace",
      scopeId: "w1",
      channelId: "flight-path",
      agentId: "agent_scout",
    });
  });

  it("offers a blocked agent WITH its reason, and refuses out loud", () => {
    // An agent missing from a picker is indistinguishable from an agent that
    // does not exist, and the next thing somebody does is create a second one.
    state.queries["buzz/agents:attachable"] = [
      attachable({ lastSeenAt: NOW }),
      attachable({
        agentId: "agent_pilot",
        name: "Pilot",
        attached: false,
        hasKey: false,
        pubkey: null,
        blockedReason: "No Chat identity yet",
      }),
    ];
    render(<Panel />);

    fireEvent.click(screen.getByRole("button", { name: /Add an agent/ }));
    expect(screen.getByText("No Chat identity yet")).toBeTruthy();

    fireEvent.click(within(screen.getByRole("option", { name: /Pilot/ })).getByRole("button"));
    expect(state.mutations.length).toBe(0);
    const last = state.toasts[state.toasts.length - 1];
    expect(last.opts?.kind).toBe("error");
    expect(last.message).toContain("No Chat identity yet");
  });

  it("reports the reason the server gave when an attach is refused", () => {
    state.queries["buzz/agents:attachable"] = [];
    state.throwing.add("buzz/agents:attachable");
    render(<Panel />);
    expect(screen.getByText(/Agent activity is unavailable/).textContent).toContain(
      "Could not find public function",
    );
  });
});

describe("what a room may say about an agent", () => {
  it("separates never-connected from every other kind of quiet", () => {
    expect(readAgentState({ lastSeenAt: null, now: NOW })).toBe("never-connected");
    expect(readAgentState({ lastSeenAt: NOW - 1_000, now: NOW })).toBe("idle");
    expect(readAgentState({ turns: [turn()], lastSeenAt: null, now: NOW })).toBe("working");
    expect(
      readAgentState({
        turns: [turn({ lastActivityAt: NOW - TURN_STALE_AFTER_MS - 1 })],
        lastSeenAt: null,
        now: NOW,
      }),
    ).toBe("stalled");
  });

  it("treats a turn on the record as proof a runtime once connected", () => {
    // Even with no heartbeat on the agent row: something ran it, so the setup
    // instructions would be wrong.
    expect(
      readAgentState({
        turns: [turn({ state: "finished", lastActivityAt: NOW - 900_000 })],
        lastSeenAt: null,
        now: NOW,
      }),
    ).toBe("idle");
  });
});
