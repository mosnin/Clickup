// Pulse: the fold from events to what a person reads.
//
// Pulse is **derived, never stored.** Every tab is a view over notes that are
// already in the log, so there is no `pulseFeed` table, no denormalized counter
// and no second copy of activity that can disagree with the events it was built
// from. If a row appears here it is because an event exists; if an event is
// retracted the row goes with it on the next read. That property is only true
// as long as the derivation stays a pure function over the events the server
// handed us, which is what this file is.
//
// Same shape, and deliberately the same shape, as `src/lib/buzz/timeline.ts`:
// raw signed events in, the rows a reader sees out, no React, no Convex, no
// ctx. The transcript's projector and this one are the two folds in the Chat
// application, and a third one that lived inside a component would be a rule
// nobody could test without a DOM.
//
// Timestamps are Nostr `created_at`: **seconds**, the whole way through.
//
// Spec: docs/buzz-parity/03-workflows-projects.md §3.1 (the six tabs and their
// sources), §3.2 (project-comment filtering, the agent grouping window, reply
// parents, reaction state), §3.3 (visibility-gated polling and query keys),
// §3.4 (which tabs carry a composer, and the per-tab empty strings).

import type { NostrEvent } from "@convex/buzz/_nostr";

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/** NIP-01 short text note. The thing Pulse is a timeline of. */
export const KIND_TEXT_NOTE = 1;
/** NIP-25 reaction. Pulse keeps only `+` (see `reactionStates`). */
export const KIND_REACTION = 7;

export type PulseTab =
  | "search"
  | "everyone"
  | "following"
  | "liked"
  | "agents"
  | "mine";

export type PulseTabSpec = {
  id: PulseTab;
  label: string;
  /**
   * Whether this tab shows the sticky composer (§3.4). Search has a hero input
   * of its own and the Agents tab is somebody else's output — a "what's on your
   * mind" box above a list of machine activity is a box in the wrong room.
   */
  composer: boolean;
};

/**
 * The tabs, in Buzz's order. Search first because it is the escape hatch, then
 * widest audience to narrowest, with your own notes last.
 */
export const PULSE_TABS: readonly PulseTabSpec[] = [
  { id: "search", label: "Search", composer: false },
  { id: "everyone", label: "Everyone", composer: true },
  { id: "following", label: "Following", composer: true },
  { id: "liked", label: "Liked", composer: true },
  { id: "agents", label: "Agents", composer: false },
  { id: "mine", label: "Mine", composer: true },
];

const TAB_IDS: ReadonlySet<string> = new Set(PULSE_TABS.map((t) => t.id));

/**
 * A tab id off the URL, or the default.
 *
 * Total on purpose: `?tab=` is user-editable, and an unknown value must land on
 * a real tab rather than rendering a screen with no feed and no explanation.
 */
export function normalizePulseTab(raw: string | null | undefined): PulseTab {
  return raw && TAB_IDS.has(raw) ? (raw as PulseTab) : "everyone";
}

/** How many notes one page of a feed is (§3.1: `{limit: 50}`). */
export const PULSE_PAGE_LIMIT = 50;

/** §3.3: note feeds refresh every 30 s, reactions every 60 s — when visible. */
export const PULSE_FEED_POLL_MS = 30_000;
export const PULSE_REACTION_POLL_MS = 60_000;

/** §3.2: consecutive notes from one agent inside this gap fold into one card. */
export const AGENT_NOTE_GROUP_WINDOW_SECONDS = 300;

/** §3.2: `noteSnippet` cuts here. */
export const NOTE_SNIPPET_CHARS = 120;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * One note, in the shape the screen reads it.
 *
 * Narrower than `NostrEvent` because Pulse never needs the signature and must
 * never key on it: two identical notes from one author differ in `id`, which is
 * the hash, and `sig` is derived from that. Carrying only what is rendered also
 * makes every function below testable from a literal.
 */
export type PulseNote = {
  id: string;
  pubkey: string;
  /** Seconds. */
  createdAt: number;
  content: string;
  tags: readonly string[][];
};

export function toPulseNote(event: NostrEvent): PulseNote {
  return {
    id: event.id,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    content: event.content,
    tags: event.tags,
  };
}

/** Who the reader is, and the three sets every tab is decided against. */
export type PulseAudience = {
  /** `""` for a principal with no Chat identity yet — which is nobody. */
  viewerPubkey: string;
  contactPubkeys: ReadonlySet<string>;
  agentPubkeys: ReadonlySet<string>;
  /** Notes this reader has upvoted. Drives the Liked tab and the pill state. */
  likedNoteIds: ReadonlySet<string>;
};

export function pulseAudience(input: {
  viewerPubkey?: string;
  contactPubkeys?: readonly string[];
  agentPubkeys?: readonly string[];
  likedNoteIds?: readonly string[];
}): PulseAudience {
  return {
    viewerPubkey: input.viewerPubkey ?? "",
    contactPubkeys: new Set(input.contactPubkeys ?? []),
    agentPubkeys: new Set(input.agentPubkeys ?? []),
    likedNoteIds: new Set(input.likedNoteIds ?? []),
  };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/** The repository-announcement coordinate a project comment hangs off. */
const PROJECT_COORD_PREFIX = "30617:";

/**
 * Is this note a comment on a project, rather than a note? (§3.2)
 *
 * Forge comments are kind 1 like everything else here, and they carry an `a`
 * tag pointing at a `30617:` repo coordinate. Left in a feed they render as
 * replies whose parent is a pull request or an issue — events Pulse does not
 * load and never will — so the row is permanently "loading its parent". Every
 * feed strips them, not just the ones where it has been noticed.
 */
export function isProjectComment(tags: readonly string[][]): boolean {
  return tags.some((tag) => tag[0] === "a" && (tag[1] ?? "").startsWith(PROJECT_COORD_PREFIX));
}

export function withoutProjectComments(notes: readonly PulseNote[]): PulseNote[] {
  return notes.filter((note) => !isProjectComment(note.tags));
}

/**
 * Which note is this a reply to? (§3.2, NIP-10 both-styles tolerance)
 *
 * `e` tags are walked **from the end** and a marker `"reply"` wins, then an
 * unmarked tag, then `"root"`. From the end because NIP-10's positional style
 * puts the immediate parent last, and the marked style may carry both — so a
 * reader that took the first `e` tag would call every reply a reply to the
 * thread root and flatten every conversation to depth one.
 */
export function getReplyParent(tags: readonly string[][]): string | null {
  let unmarked: string | null = null;
  let root: string | null = null;
  for (let i = tags.length - 1; i >= 0; i -= 1) {
    const tag = tags[i];
    if (tag[0] !== "e" || !tag[1]) continue;
    const marker = tag[3];
    if (marker === "reply") return tag[1];
    if (marker === "root") root ??= tag[1];
    else if (!marker) unmarked ??= tag[1];
  }
  return unmarked ?? root;
}

/** One line of a note, for a reply preview. Whitespace collapsed, then cut. */
export function noteSnippet(text: string, max: number = NOTE_SNIPPET_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Newest first, ties broken by id.
 *
 * The same total order `readEventsCore` sorts by, and for the same reason: two
 * notes written in the same second are ordinary, and an unstable tie makes a
 * feed visibly reshuffle between two reads that returned identical data.
 */
export function sortPulseNotes(notes: readonly PulseNote[]): PulseNote[] {
  return [...notes].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

/**
 * The per-tab selection (§3.1, §3.2).
 *
 * A **filter over the input and nothing else** — every row it returns is a row
 * it was given, unchanged. That is the property that makes "Pulse never invents
 * a row" checkable rather than asserted: there is no branch here that
 * constructs a note.
 *
 * The Following clause is the one worth reading twice. Following is contacts'
 * notes, and it *additionally* drops agent notes unless the viewer actually
 * follows that agent. That is redundant when the caller has already narrowed to
 * contacts, and it is kept anyway: the same function is applied to the wider
 * windows the other tabs read, and this is the tab where an agent's output
 * showing up uninvited would be read as the product following things on your
 * behalf.
 */
export function selectPulseNotes(
  tab: PulseTab,
  notes: readonly PulseNote[],
  audience: PulseAudience,
): PulseNote[] {
  const live = withoutProjectComments(notes);
  switch (tab) {
    case "search":
      // Not wired to a backend (§3.1). An empty list rather than the everyone
      // feed: a search box that silently returns "everything" reads as a search
      // that matched everything.
      return [];
    case "everyone":
      return live;
    case "following":
      return live.filter(
        (note) =>
          audience.contactPubkeys.has(note.pubkey) &&
          (!audience.agentPubkeys.has(note.pubkey) ||
            audience.contactPubkeys.has(note.pubkey)),
      );
    case "liked":
      return live.filter((note) => audience.likedNoteIds.has(note.id));
    case "agents":
      return live.filter((note) => audience.agentPubkeys.has(note.pubkey));
    case "mine":
      return live.filter(
        (note) => audience.viewerPubkey !== "" && note.pubkey === audience.viewerPubkey,
      );
  }
}

// ---------------------------------------------------------------------------
// Agent activity: the fold
// ---------------------------------------------------------------------------

export type AgentNoteGroup = {
  /** `${pubkey}-${latestAt}` (§3.2). Stable because the anchor never moves. */
  key: string;
  pubkey: string;
  /** Newest first, like the input. */
  notes: PulseNote[];
  latestAt: number;
  earliestAt: number;
};

/**
 * Consecutive notes from one agent, folded into one card.
 *
 * **Input must be newest-first, and the fold is computed from the newest
 * entry.** That direction is the whole invariant, and it is the same one
 * `timeline.ts:planSystemGroups` is built on: a group is anchored on its newest
 * member and every candidate is measured back from that anchor, so an older
 * note arriving from a page of history can only ever be *absorbed* into a group
 * that already exists — it can never split one, re-anchor one, or change one's
 * key. Folding forwards from the oldest looks identical on a static list and
 * repartitions the screen every time history loads, which a reader sees as a
 * block of rows rewriting itself above where they were looking.
 *
 * Measuring from the anchor rather than from the group's running earliest is
 * the second half of the same decision. A chain comparison ("within 300 s of
 * the note I last added") lets one card grow without bound as long as an agent
 * keeps talking, and a card covering four hours is not "an agent did a burst of
 * work", it is a card that has stopped meaning anything.
 *
 * Adjacency is required: a note from a different agent closes the run, because
 * a fold that reached across it would claim two bursts were one.
 */
export function groupAgentNotes(
  notes: readonly PulseNote[],
  windowSeconds: number = AGENT_NOTE_GROUP_WINDOW_SECONDS,
): AgentNoteGroup[] {
  const groups: AgentNoteGroup[] = [];
  let open: AgentNoteGroup | null = null;

  for (const note of notes) {
    if (open && open.pubkey === note.pubkey) {
      const gap = open.latestAt - note.createdAt;
      // `gap >= 0` is not redundant: this draws whatever list it is handed, and
      // an out-of-order pair is not a run of anything.
      if (gap >= 0 && gap <= windowSeconds) {
        open.notes.push(note);
        open.earliestAt = Math.min(open.earliestAt, note.createdAt);
        continue;
      }
    }
    open = {
      key: `${note.pubkey}-${note.createdAt}`,
      pubkey: note.pubkey,
      notes: [note],
      latestAt: note.createdAt,
      earliestAt: note.createdAt,
    };
    groups.push(open);
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

export type ReactionState = { count: number; reactedByViewer: boolean };

export const EMPTY_REACTION: ReactionState = { count: 0, reactedByViewer: false };

/** The only reaction Pulse counts (§3.2). Everything else is somebody else's. */
export const UPVOTE = "+";

/**
 * Reaction events → per-note `{count, reactedByViewer}` (§3.2).
 *
 * Only `+` is counted, and that is a product decision rather than a shortcut:
 * Pulse's action is an upvote, so a `🔥` on a note would inflate a number whose
 * label says "upvotes". Deduped by author, because the log can legitimately
 * hold two reaction events from one person (a retraction is a separate kind-5,
 * and a page can arrive holding both the reaction and its replacement).
 */
export function reactionStates(
  reactions: readonly PulseNote[],
  viewerPubkey: string,
): Map<string, ReactionState> {
  const voters = new Map<string, Set<string>>();
  for (const reaction of reactions) {
    if (reaction.content.trim() !== UPVOTE) continue;
    const target = lastETagValue(reaction.tags);
    if (!target) continue;
    const set = voters.get(target) ?? new Set<string>();
    set.add(reaction.pubkey);
    voters.set(target, set);
  }
  const out = new Map<string, ReactionState>();
  for (const [noteId, set] of voters) {
    out.set(noteId, {
      count: set.size,
      reactedByViewer: viewerPubkey !== "" && set.has(viewerPubkey),
    });
  }
  return out;
}

/**
 * A reaction's target: the **last** valid `e` tag.
 *
 * The same rule `log.resolveChannelId` applies when it derives a reaction's
 * room. Two answers to "what does this reaction point at" is how a reaction
 * gets counted on one note and filed against another.
 */
function lastETagValue(tags: readonly string[][]): string | null {
  for (let i = tags.length - 1; i >= 0; i -= 1) {
    if (tags[i][0] === "e" && tags[i][1]) return tags[i][1];
  }
  return null;
}

/**
 * The optimistic pill state, clamped at zero (§3.2 `applyReactionState`).
 *
 * Clamped because the count and the reader's own flag arrive from two reads
 * that can disagree for a moment — un-upvoting a note whose count has not
 * loaded yet must show "0", never "-1", and a negative number in a pill is the
 * kind of thing people screenshot.
 */
export function applyReactionState(
  state: ReactionState | undefined,
  reacted: boolean,
): ReactionState {
  const current = state ?? EMPTY_REACTION;
  if (current.reactedByViewer === reacted) return current;
  const delta = reacted ? 1 : -1;
  return { count: Math.max(0, current.count + delta), reactedByViewer: reacted };
}

/** Add or remove one id, without mutating the set that was passed in. */
export function toggleNoteIdInSet(
  set: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

/**
 * Polling, gated on the document being visible (§3.3).
 *
 * `false` means "do not poll" in the shape a refetch-interval option takes. A
 * background tab that keeps asking is a tab that costs a query every 30 s for
 * a screen nobody is looking at, times every tab somebody left open.
 */
export function visibleRefetchInterval(ms: number, visible: boolean): number | false {
  return visible && ms > 0 ? ms : false;
}

/**
 * A stable key for a feed that is keyed by a set of pubkeys or note ids (§3.3).
 *
 * **Sorted and joined**, because the sets are rebuilt every render and a key
 * that compares by reference invalidates on every render — which is a refetch
 * storm that looks like a slow backend.
 */
export function pulseQueryKey(tab: PulseTab, parts: readonly string[]): string {
  return [tab, ...[...parts].sort()].join("|");
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * The per-tab empty string (§3.4).
 *
 * The Agents tab distinguishes "no agents" from "no agent notes" because they
 * are different problems with different next steps: one is "go make an agent",
 * the other is "your agents have not said anything yet, which is what silence
 * looks like" (D9 — an agent with no harness running does nothing, and the
 * honest state is silence).
 */
export function pulseEmptyState(
  tab: PulseTab,
  context: { agentCount?: number; hasContacts?: boolean } = {},
): string {
  switch (tab) {
    case "search":
      return "Search is not wired up yet.";
    case "everyone":
      return "Nothing posted here yet.";
    case "following":
      return context.hasContacts === false
        ? "You are not following anyone yet."
        : "Nothing from the people you follow.";
    case "liked":
      return "You have not upvoted anything yet.";
    case "agents":
      return (context.agentCount ?? 0) === 0
        ? "No agents registered yet."
        : "No agent notes yet. Agents post here when they publish.";
    case "mine":
      return "You have not posted anything yet.";
  }
}

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------

export type PulseFeed = {
  tab: PulseTab;
  /** The rows an ordinary tab draws. Empty on the Agents tab. */
  notes: PulseNote[];
  /** The cards the Agents tab draws. Empty everywhere else. */
  groups: AgentNoteGroup[];
  reactions: Map<string, ReactionState>;
};

/**
 * Events → what the screen draws. Sort, then select, then (on Agents) fold.
 *
 * Exported so a surface never has to know the passes run in this order. The
 * sort is first because `groupAgentNotes` has a newest-first precondition and a
 * caller that forgot it would silently get one card per note.
 */
export function projectPulse(
  tab: PulseTab,
  notes: readonly PulseNote[],
  reactions: readonly PulseNote[],
  audience: PulseAudience,
): PulseFeed {
  const selected = selectPulseNotes(tab, sortPulseNotes(notes), audience);
  return {
    tab,
    notes: tab === "agents" ? [] : selected,
    groups: tab === "agents" ? groupAgentNotes(selected) : [],
    reactions: reactionStates(reactions, audience.viewerPubkey),
  };
}
