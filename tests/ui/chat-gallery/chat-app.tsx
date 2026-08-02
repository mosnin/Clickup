// The Chat shell, mounted for real, so it can be looked at.
//
// `tests/ui/design/*` belongs to the concurrent dynamic-UI build, so this is a
// second harness rather than a fifth page in that one. Same discipline: the
// stylesheet is the app's own compiled CSS, the components are the shipping
// components, and only the three modules that need a server (Convex, Clerk,
// the router) are stubbed at the module boundary.
//
// It renders a plausible community rather than one room: a rail that is
// meaningful needs more than one community, a section order that is meaningful
// needs channels *and* forums *and* DMs, and badge rules that are meaningful
// need a mention, a plain unread, a muted room and an active row all on screen
// at once. A fixture with one channel in it proves nothing about the layout.
//
// The transcript's fixture follows the same rule and is the reason it is long:
// grouping cannot be judged without consecutive messages from one author, a day
// divider cannot be judged without two days, a thread summary cannot be judged
// without replies, and the unread rule cannot be judged without something above
// and below it. Every row type the transcript can draw is on screen at once,
// because the composition is the thing being looked at.
//
// Fixtures are **raw signed events**, not finished messages. That matters: the
// gallery then exercises the same fold the app does — edits, deletions,
// reaction counting, grouping, dividers — instead of photographing a hand-built
// lookalike that cannot drift when the projector changes.

import { createRoot } from "react-dom/client";
import { ToastProvider } from "@/components/toast";
import { ChatThemeScope } from "@/components/chat/chat-theme-scope";
import { ChatShell } from "@/components/chat/shell/chat-shell";
import { ChannelScreen } from "@/components/chat/shell/channel-screen";
import { ChatHomeScreen } from "@/components/chat/shell/home-screen";
import { ChatSettingsScreen } from "@/components/chat/shell/settings-screen";
import { RoomComposer } from "@/components/chat/shell/room-composer";
import { AuxPane, ContentSurface } from "@/components/chat/shell/surfaces";
import {
  ChannelTranscript,
  MyPubkeyProvider,
} from "@/components/chat/transcript";
import {
  AgentActivityLog,
  AgentWorkingLine,
  RoomAgentsPanel,
  useRoomWorkingSignal,
  type ChatTurn,
} from "@/components/chat/agents";
import type { ChatChannelSummary } from "@/lib/buzz/channel-types";
import type { HuddleSnapshot } from "@/lib/buzz/huddle";
import { DEFAULT_NOTIFICATION_SETTINGS } from "@/lib/buzz/notify";
import type { TimelineEvent } from "@/lib/buzz/timeline";
import { galleryData } from "./stubs/convex-react";
import { gallerySignals } from "./stubs/use-ably-channel";
import { galleryRoute } from "./stubs/next-navigation";

const HOUR = 3_600_000;
const now = Date.now();

function room(
  channelId: string,
  name: string,
  over: Partial<ChatChannelSummary> = {},
): ChatChannelSummary {
  return {
    channelId,
    name,
    displayName: name,
    kind: "channel",
    visibility: "public",
    memberCount: 9,
    unread: 0,
    mentions: 0,
    muted: false,
    joined: true,
    lastActivityAt: now - HOUR,
    ...over,
  };
}

const CHANNELS: ChatChannelSummary[] = [
  room("announcements", "announcements", { unread: 3, lastActivityAt: now - 2 * HOUR }),
  room("general", "general", { unread: 12, lastActivityAt: now - HOUR / 2 }),
  room("design", "design", { lastActivityAt: now - 5 * HOUR }),
  room("flight-path", "flight-path", {
    topic: "Launch readiness — cutover Thursday",
    memberCount: 9,
    unread: 4,
    lastActivityAt: now - 60_000,
  }),
  room("mobile", "mobile", { muted: true, lastActivityAt: now - 30 * HOUR }),
  room("marketing", "marketing", { mentions: 2, unread: 6, lastActivityAt: now - 3 * HOUR }),
  room("queen-bee-launch", "queen-bee-launch", {
    visibility: "private",
    memberCount: 5,
    lastActivityAt: now - 9 * HOUR,
  }),
  room("rfcs", "rfcs", { kind: "forum", lastActivityAt: now - 26 * HOUR }),
  room("dm-jordan", "jordan-brooks", {
    kind: "dm",
    displayName: "Jordan Brooks",
    memberCount: 2,
    unread: 1,
    lastActivityAt: now - 20 * 60_000,
  }),
  room("dm-maya", "maya-chen", {
    kind: "dm",
    displayName: "Maya Chen",
    memberCount: 2,
    unread: 1,
    lastActivityAt: now - 4 * HOUR,
  }),
  room("dm-priya", "priya-shah", {
    kind: "dm",
    displayName: "Priya Shah",
    memberCount: 2,
    lastActivityAt: now - 2 * 24 * HOUR,
  }),
];

galleryData["chat:scopesForCurrentUser"] = [
  { scopeType: "user", scopeId: "u1", name: "Personal" },
  { scopeType: "workspace", scopeId: "w1", name: "Honeycomb Studios" },
  { scopeType: "workspace", scopeId: "w2", name: "Launch Swarm" },
];
galleryData["buzz/channels:list"] = CHANNELS;

// ---------------------------------------------------------------------------
// The room's log
// ---------------------------------------------------------------------------

/** Ids and pubkeys are 64 hex characters, because the projector checks. */
function hex(seed: string): string {
  let out = "";
  for (const ch of seed) out += ch.charCodeAt(0).toString(16).padStart(2, "0");
  return (out + "0".repeat(64)).slice(0, 64);
}

const ALEX = hex("alex-rivera");
const MAYA = hex("maya-chen");
const PRIYA = hex("priya-shah");
const JORDAN = hex("jordan-brooks");
const HONEY = hex("honey-agent");
const RELAY = hex("relay");

const SECOND = 1;
const MINUTE = 60;
const DAY = 24 * 60 * MINUTE;
const T = Math.floor(now / 1000);

function ev(
  id: string,
  pubkey: string,
  kind: number,
  at: number,
  content: string,
  tags: string[][] = [],
): TimelineEvent {
  return {
    id: hex(id),
    pubkey,
    kind,
    created_at: at,
    tags: [["h", "flight-path"], ...tags],
    content,
    sig: "0".repeat(128),
  };
}

const msg = (id: string, pubkey: string, at: number, body: string, tags: string[][] = []) =>
  ev(id, pubkey, 9, at, body, tags);

const react = (id: string, pubkey: string, at: number, emoji: string, target: string) =>
  ev(id, pubkey, 7, at, emoji, [["e", hex(target)]]);

const joined = (id: string, at: number, who: string, label: string) =>
  ev(id, RELAY, 40099, at, JSON.stringify({ type: "member_joined", actor: who, target: who }), [
    ["actor", who],
    ["p", who],
    ["label", label],
  ]);

const replyTags = (root: string, parent = root) => [
  ["e", hex(root), "", "root"],
  ["e", hex(parent), "", "reply"],
];

const EVENTS: TimelineEvent[] = [
  // Yesterday — proves the day divider, and gives the unread rule something above it.
  msg("y1", MAYA, T - DAY - 3 * MINUTE, "Staging is green across the board. Cutover checklist is in the canvas."),
  msg("y2", MAYA, T - DAY - 2 * MINUTE, "Two things left: the migration dry run, and someone to own comms."),
  msg("y3", ALEX, T - DAY - MINUTE, "I'll take comms. Dry run tomorrow morning?"),

  // A run of joins — folded into one system-group row rather than four.
  joined("j1", T - 90 * MINUTE, PRIYA, "Priya Shah"),
  joined("j2", T - 89 * MINUTE, JORDAN, "Jordan Brooks"),
  joined("j3", T - 88 * MINUTE, HONEY, "Honey"),

  // Today.
  msg("m1", PRIYA, T - 62 * MINUTE, "Dry run finished. 4m12s, no data drift."),
  msg("m2", PRIYA, T - 61 * MINUTE, "Report is attached to the migration task."),
  msg("m3", ALEX, T - 48 * MINUTE, "Beautiful. Shall we ship Thursday?"),

  // A thread hangs off m3 — the summary row is the thing being looked at.
  msg("t1", HONEY, T - 44 * MINUTE, "Checking the release gates now.", replyTags("m3")),
  msg("t2", JORDAN, T - 41 * MINUTE, "Docs are ready to publish.", replyTags("m3", "t1")),
  msg("t3", MAYA, T - 36 * MINUTE, "Then Thursday works for me.", replyTags("m3", "t2")),

  msg(
    "m4",
    HONEY,
    T - 30 * MINUTE,
    "Release gates: 12 green, 1 pending. The pending one is the SOC2 evidence upload — @[Alex Rivera](" +
      ALEX +
      ") that one is yours.",
  ),
  msg("m5", ALEX, T - 12 * MINUTE, "Uploading now."),
  msg("m6", ALEX, T - 11 * MINUTE, "Done. Everything is green."),

  // Reactions: one the reader gave, one they did not.
  react("r1", MAYA, T - 10 * MINUTE, "🎉", "m6"),
  react("r2", PRIYA, T - 10 * MINUTE + 20 * SECOND, "🎉", "m6"),
  react("r3", ALEX, T - 9 * MINUTE, "🎉", "m6"),
  react("r4", JORDAN, T - 9 * MINUTE, "🚀", "m6"),

  msg("m7", JORDAN, T - 4 * MINUTE, "Comms draft is in the doc — one read-through and it goes out Thursday 09:00."),
];

const ACTORS = [
  { pubkey: ALEX, label: "Alex Rivera" },
  { pubkey: MAYA, label: "Maya Chen" },
  { pubkey: PRIYA, label: "Priya Shah" },
  { pubkey: JORDAN, label: "Jordan Brooks" },
  { pubkey: HONEY, label: "Honey", isAgent: true, ownerLabel: "Alex Rivera" },
];

const screen = new URLSearchParams(location.search).get("screen") ?? "room";

galleryData["buzz/identity:myPubkey"] = { pubkey: ALEX };
// "Why didn't I get notified about this?" — the answer is the server re-running
// the same `decide()` the delivery path ran, so a fixture is the shape that
// function returns and nothing more. The rule number is part of the answer on
// purpose: it is the difference between something a person can look up and
// something they have to take on faith.
galleryData["buzz/notifications:explain"] = {
  deliver: true,
  item: null,
  reason: "mention",
  slot: "mention",
  predicateStep: null,
  explanation:
    "You are named in this message, and mentions are set to notify in #flight-path.",
};
galleryData["buzz/messages:thread"] = {
  events: EVENTS.filter((e) =>
    [hex("m3"), hex("t1"), hex("t2"), hex("t3")].includes(e.id ?? ""),
  ),
  actors: ACTORS,
};

/**
 * A room with real history in it.
 *
 * Not for a photograph — for `shoot.mjs` to check that the list is actually
 * windowing. Twelve rows can be drawn by any list; the claim "this is
 * virtualized" is only true above the threshold, and a claim nobody has watched
 * be true is the thing the house rule exists to stop.
 */
function longRoom(): TimelineEvent[] {
  const authors = [ALEX, MAYA, PRIYA, JORDAN, HONEY];
  return Array.from({ length: 400 }, (_, i) =>
    msg(
      `long-${i}`,
      authors[i % authors.length],
      T - (400 - i) * 3 * MINUTE,
      `Checkpoint ${i}: the migration replayed cleanly and the gate stayed green.`,
    ),
  );
}

if (screen === "long") {
  galleryData["buzz/messages:list"] = { events: longRoom(), actors: ACTORS };
} else if (screen === "empty") {
  galleryData["buzz/messages:list"] = { events: [], actors: [] };
} else if (screen === "loading") {
  // Left unset on purpose: an unanswered query is the cold-load state, and the
  // skeleton is the thing being photographed.
} else {
  galleryData["buzz/messages:list"] = { events: EVENTS, actors: ACTORS };
}

const home = screen === "home";
galleryRoute.pathname = home ? "/chat" : "/chat/c/flight-path";

/**
 * The unread rule, which the room cannot show yet.
 *
 * `firstUnreadId` comes from read state (C5), so `ChannelScreen` has nothing to
 * pass. Rather than leave the divider unphotographed until then, this variant
 * mounts the transcript directly with the id supplied — the same component, in
 * the same surface, with one prop the room will supply for it later.
 */
function UnreadRoom() {
  return (
    <MyPubkeyProvider>
      <ContentSurface>
        <header className="flex h-13 shrink-0 items-center gap-2 px-5">
          <h1 className="text-[0.9375rem] font-semibold">flight-path</h1>
        </header>
        <ChannelTranscript
          scope={{ scopeType: "workspace", scopeId: "w1" }}
          channelId="flight-path"
          channelLabel="#flight-path"
          firstUnreadId={hex("m4")}
          unreadCount={4}
        />
      </ContentSurface>
    </MyPubkeyProvider>
  );
}

// ---------------------------------------------------------------------------
// Agents in the room (C6c)
// ---------------------------------------------------------------------------
//
// Four states, because the interesting thing about this phase is which of them
// a person is looking at and whether they can tell:
//
//   `agents`  — one agent working, one that has never been connected. The
//               working band under the transcript, the panel beside it.
//   `silent`  — nobody has ever run anything. D9's accepted cost, said out
//               loud, where the silence is.
//   `stalled` — a turn that stopped reporting. Recoverable, and named, because
//               a harness that died mid-sentence must not read as an agent
//               deciding not to answer.
//   `dead`    — a turn past the recovery window. NOT drawn at all, and that is
//               the shot: a crashed harness leaves no spinner behind.
//
// The turn is a fixture rather than a hand-drawn row, so the gallery runs the
// same liveness ladder and the same fold the room does.

const AGENT_SCREENS = new Set(["agents", "silent", "stalled", "dead"]);
/**
 * Screens that want the agent fixtures without the hand-composed room.
 *
 * `live` renders `ChannelScreen` itself — the point of that shot is that the
 * room composes what it now mounts, which a screen built here could not show.
 */
const AGENT_FIXTURE_SCREENS = new Set([...AGENT_SCREENS, "live"]);

const SCOUT = hex("scout-agent");

function turnFixture(lastActivityAgoMs: number): ChatTurn {
  const at = Date.now();
  return {
    turnId: "turn-1",
    channelId: "flight-path",
    agentId: "agent_honey",
    agentPubkey: HONEY,
    agentName: "Honey",
    state: "streaming",
    // Started before its own last frame, always. `nextTurnState` guarantees it
    // server-side (`endedClock` clamps), and a fixture that broke the invariant
    // would photograph a negative duration nothing can actually produce.
    startedAt: at - lastActivityAgoMs - 94_000,
    lastActivityAt: at - lastActivityAgoMs,
    narration: "Checking the release gates against the cutover checklist",
  };
}

/**
 * A runtime's account of its own work.
 *
 * A fixture, and it has to be: the turn record carries a sentence rather than a
 * transcript, so nothing in Chat supplies a step stream yet. The fold is the
 * shipping fold — eleven reads and four commands collapse to one row, a failed
 * step stands alone in the middle of them — which is the composition being
 * looked at.
 */
function stepsFixture() {
  const at = Date.now();
  const tool = (key: string, name: string, detail: string, secondsAgo: number) => ({
    key,
    title: name,
    tool: name,
    detail,
    status: "done" as const,
    startedAt: at - secondsAgo * 1000,
    finishedAt: at - (secondsAgo - 1) * 1000,
    sessionId: "sess-4f21c9",
  });

  return [
    tool("s1", "load_skill", "release-readiness", 92),
    ...Array.from({ length: 11 }, (_, i) =>
      tool(`r${i}`, "read_file", `convex/buzz/messages.ts:${120 + i * 40}`, 88 - i * 2),
    ),
    ...Array.from({ length: 4 }, (_, i) =>
      tool(`c${i}`, "shell", `npm test -- tests/buzz-${i}.test.ts`, 60 - i * 4),
    ),
    {
      key: "fail",
      title: "shell",
      tool: "shell",
      detail: "npm run typecheck",
      status: "failed" as const,
      startedAt: at - 40_000,
      finishedAt: at - 34_000,
      sessionId: "sess-4f21c9",
    },
    tool("e1", "str_replace", "convex/buzz/messages.ts", 30),
    tool("e2", "str_replace", "src/lib/buzz/timeline.ts", 24),
    tool("p1", "create_comment", "Release gates: 12 green, 1 pending", 12),
    {
      key: "now",
      title: "shell",
      tool: "shell",
      detail: "npm run build",
      status: "running" as const,
      startedAt: at - 8_000,
      sessionId: "sess-4f21c9",
    },
  ];
}

if (AGENT_FIXTURE_SCREENS.has(screen)) {
  const at = Date.now();
  const working = screen === "agents" || screen === "live";
  const silence = working ? 2_000 : screen === "stalled" ? 40_000 : 600_000;

  galleryData["buzz/agents:turnsFor"] =
    screen === "silent" ? [] : [{ ...turnFixture(silence), liveness: "working" }];
  galleryData["buzz/agents:working"] = {
    working,
    agents: [],
    anchorAt: at - 94_000,
    now: at,
  };
  galleryData["buzz/presence:roster"] = [
    {
      actorId: "agent_honey",
      actorType: "agent",
      name: "Honey",
      pubkey: HONEY,
      status: working ? "online" : "offline",
      lastSeenAt: screen === "silent" ? null : at - 6 * 60_000,
      statusText: null,
      statusEmoji: null,
      statusExpiresAt: null,
    },
    {
      actorId: "agent_scout",
      actorType: "agent",
      name: "Scout",
      pubkey: SCOUT,
      status: "offline",
      lastSeenAt: null,
      statusText: null,
      statusEmoji: null,
      statusExpiresAt: null,
    },
  ];
  galleryData["buzz/agents:attachable"] = [
    {
      agentId: "agent_honey",
      name: "Honey",
      attached: true,
      hasKey: true,
      pubkey: HONEY,
      blockedReason: null,
      ...(screen === "silent" ? {} : { lastSeenAt: at - 6 * 60_000 }),
    },
    {
      agentId: "agent_scout",
      name: "Scout",
      attached: true,
      hasKey: true,
      pubkey: SCOUT,
      blockedReason: null,
    },
    {
      agentId: "agent_pilot",
      name: "Pilot",
      attached: false,
      hasKey: false,
      pubkey: null,
      blockedReason: "No Chat identity yet",
    },
  ];
}

// ---------------------------------------------------------------------------
// The room with everything it now mounts (C13's wiring pass)
// ---------------------------------------------------------------------------
//
// Every surface below was finished, tested and had no call site. Photographing
// them one at a time would have proved each renders and none of what the shot
// is actually for, which is whether they COMPOSE: a call bar, a working line, a
// typing line and a pane all want the same 100px under one transcript, and
// three sentences saying "somebody is about to speak" stacked on each other is
// the failure that only a picture shows.
//
//   `live`    — a huddle on the log, an agent mid-turn, somebody typing. The
//               band resolves to a bar and ONE line, and the line the machine
//               wins is the one that changes whether you wait.
//   `typing`  — the same room with no turn running, so the line the person owns
//               is the one drawn. Same 20px band either way; the transcript
//               above it does not move.
//   `settings`— `/chat/settings`, which did not exist.

/** The 48100 is the huddle: its event id *is* the huddle id. */
const HUDDLE_ID = hex("h1");

function huddleSnapshot(): HuddleSnapshot {
  return {
    huddleId: HUDDLE_ID,
    parentChannelId: "flight-path",
    startedByPubkey: MAYA,
    startedAt: T - 8 * MINUTE,
    endedAt: null,
    live: true,
    endReason: null,
    participants: [
      { pubkey: MAYA, isAgent: false, joinedAt: T - 8 * MINUTE },
      { pubkey: PRIYA, isAgent: false, joinedAt: T - 7 * MINUTE },
      { pubkey: HONEY, isAgent: true, joinedAt: T - 6 * MINUTE },
    ],
    participantCount: 3,
    inferred: false,
  };
}

if (screen === "live" || screen === "typing") {
  // Somebody is writing. It rides Ably and is never stored, so it is the one
  // signal the Convex stub cannot supply — see `stubs/use-ably-channel.tsx`.
  gallerySignals.push({
    name: "typing",
    data: {
      pubkey: MAYA,
      name: "Maya Chen",
      isAgent: false,
      channelId: "flight-path",
      threadHeadId: null,
    },
  });
}

if (screen === "live") {
  galleryData["buzz/messages:list"] = {
    // The 48100 goes in with the rest and is folded by the projector, which
    // already treats the kind as content — the card is what goes in the row it
    // already had.
    events: [...EVENTS, ev("h1", MAYA, 48100, T - 8 * MINUTE, "")],
    actors: ACTORS,
  };
  galleryData["buzz/huddle:forChannel"] = {
    huddles: [huddleSnapshot()],
    names: {
      [MAYA]: { name: "Maya Chen", isAgent: false },
      [PRIYA]: { name: "Priya Shah", isAgent: false },
      [HONEY]: { name: "Honey", isAgent: true },
    },
    viewerPubkey: ALEX,
  };
}

if (screen === "settings") {
  galleryRoute.pathname = "/chat/settings";
  galleryData["buzz/notifications:settings"] = DEFAULT_NOTIFICATION_SETTINGS;
  galleryData["buzz/presence:myStatus"] = null;
}

// ---------------------------------------------------------------------------
// The two surfaces C14 mounts
// ---------------------------------------------------------------------------
//
// Both were finished and tested with no call site, which is the state that a
// unit test cannot report on: the question is not "does the dialog render" —
// `chat-channel-browser.test.tsx` answers that — but whether a 40px strip can
// hold a location line *and* a search control at 390px, and whether a dialog
// sized for a desktop is still a usable list on a phone. Only a picture
// settles either.
//
// The search fixture is set unconditionally: nothing else reads
// `buzz/search:messages`, and the dialog is only ever on screen in a shot that
// opened it. The roster is set only under `?screen=search`, because it changes
// what every presence surface in the room draws and the other shots have
// already been composed without it.

/**
 * Enough hits to fill the list, which is the point rather than padding.
 *
 * The results pane is a fixed `min(60vh,30rem)` so the highlight does not move
 * under somebody's finger when the server's wave lands 300 ms after the local
 * one. That is right and it means three fixture rows photograph as a third of
 * a dialog and two thirds of nothing — a picture of the fixture, not of the
 * surface. Eight rows across three rooms and four authors is what a search
 * actually returns, and it is also the only way the shot can show that the
 * pane scrolls and that `truncated` has something to be true about.
 */
const SEARCH_HITS = [
  ["m6", ALEX, "Alex Rivera", false, "flight-path", 11 * MINUTE, "Done. Everything is green."],
  [
    "m4",
    HONEY,
    "Honey",
    true,
    "flight-path",
    30 * MINUTE,
    "Release gates: 12 green, 1 pending. The pending one is the SOC2 evidence upload.",
  ],
  ["m1", PRIYA, "Priya Shah", false, "flight-path", 62 * MINUTE, "Dry run finished. 4m12s, no data drift — every gate stayed green."],
  [
    "y1",
    MAYA,
    "Maya Chen",
    false,
    "general",
    DAY + 3 * MINUTE,
    "Staging is green across the board. Cutover checklist is in the canvas.",
  ],
  ["y3", ALEX, "Alex Rivera", false, "general", DAY + MINUTE, "I'll take comms. Dry run tomorrow morning?"],
  [
    "g1",
    JORDAN,
    "Jordan Brooks",
    false,
    "marketing",
    2 * DAY,
    "Launch page is green on Lighthouse — 98 performance, 100 accessibility.",
  ],
  ["g2", HONEY, "Honey", true, "design", 3 * DAY, "Contrast pass done: every pastel chip is green against both themes."],
  ["g3", PRIYA, "Priya Shah", false, "design", 4 * DAY, "Green build on main. Merging the icon set now."],
] as const;

galleryData["buzz/search:messages"] = {
  found: 24,
  truncated: true,
  hits: SEARCH_HITS.map(
    ([id, pubkey, authorName, authorIsAgent, channel, agoSeconds, content]) => ({
      eventId: hex(id),
      kind: 9,
      pubkey,
      content,
      channelId: channel,
      channelName: channel,
      channelDisplayName: channel,
      createdAt: T - agoSeconds,
      authorName,
      authorIsAgent,
    }),
  ),
};

if (screen === "search") {
  // `from:` resolves against the roster the shell already subscribes to, so a
  // gallery with an empty one would photograph an operator that can never
  // match anybody — a supported state, but not the one worth looking at.
  galleryData["buzz/presence:roster"] = [
    { pubkey: ALEX, name: "Alex Rivera", actorId: "u1", actorType: "user" },
    { pubkey: MAYA, name: "Maya Chen", actorId: "u2", actorType: "user" },
    { pubkey: PRIYA, name: "Priya Shah", actorId: "u3", actorType: "user" },
    { pubkey: HONEY, name: "Honey", actorId: "agent_honey", actorType: "agent" },
  ].map((entry) => ({
    ...entry,
    status: "online" as const,
    lastSeenAt: now - 60_000,
    statusText: null,
    statusEmoji: null,
    statusExpiresAt: null,
  }));
}

const ROOM: ChatChannelSummary = CHANNELS.find((c) => c.channelId === "flight-path")!;

/**
 * The room as it looks once C6c is wired into it.
 *
 * Composed here rather than inside `ChannelScreen` because the shell belongs to
 * another phase — the same treatment `UnreadRoom` above gets, and for the same
 * reason: the components are the shipping components, in the shipping surface,
 * with the props the room will supply for them.
 */
function AgentsRoom() {
  const scope = { scopeType: "workspace" as const, scopeId: "w1" };
  const signal = useRoomWorkingSignal(scope, "flight-path");
  const live = signal.turns?.[0];

  return (
    <MyPubkeyProvider>
      <ContentSurface>
        <header className="flex h-13 shrink-0 items-center gap-2 px-5">
          <h1 className="text-[0.9375rem] font-semibold">flight-path</h1>
          <p className="chat-quiet min-w-0 flex-1 truncate border-l pl-3 text-xs chat-divider">
            Launch readiness — cutover Thursday
          </p>
        </header>

        <ChannelTranscript
          scope={scope}
          channelId="flight-path"
          channelLabel="#flight-path"
        />

        <div className="shrink-0 px-5 pb-4 pt-1">
          {signal.subscriptions}
          <AgentWorkingLine working={signal.working} now={signal.now} />
          <RoomComposer
            scope={scope}
            channel={ROOM}
            channelLabel="#flight-path"
            onPending={() => {}}
          />
        </div>
      </ContentSurface>

      <AuxPane title="Agents" onClose={() => {}}>
        <RoomAgentsPanel
          scope={scope}
          channelId="flight-path"
          roomLabel="#flight-path"
        />
        {/* The activity transcript, shown open so the fold can be looked at.
            Its step stream is a fixture — see `stepsFixture`. */}
        {live ? (
          <div className="mt-4 border-t pt-3 chat-divider">
            <AgentActivityLog turn={live} steps={stepsFixture()} now={signal.now} />
          </div>
        ) : null}
      </AuxPane>
    </MyPubkeyProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <ToastProvider>
    <ChatThemeScope />
    <ChatShell>
      {home ? (
        <ChatHomeScreen />
      ) : screen === "settings" ? (
        <ChatSettingsScreen />
      ) : screen === "unread" ? (
        <UnreadRoom />
      ) : AGENT_SCREENS.has(screen) ? (
        <AgentsRoom />
      ) : (
        <ChannelScreen channelId="flight-path" />
      )}
    </ChatShell>
  </ToastProvider>,
);
