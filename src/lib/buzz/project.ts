// A branch is a room, and the room is the record of why the code exists.
//
// That sentence is the whole of 03-workflows-projects §2 and it is the only
// reason this file is small. There is no repository store here, no patch table,
// no CI table, no review table: a patch is a signed event in a channel, a check
// result is a signed event in the same channel, a review decision and the merge
// are two more. They sit in the log beside the conversation that produced them,
// which is the entire point — "search the conversation, the patch, the workflow
// run and the approval in one place" is only true if all four are one place.
//
// This module is the **vocabulary**: which kinds mean what, which tags carry
// which fact, and how a window of events folds into the four things a reader
// actually asks about (what is this branch, what has been pushed, did it pass,
// did anybody approve it). Pure — no React, no Convex, no ctx — because every
// rule below is a rule about reading a tag or ordering a list, and those are the
// rules that break silently: a status classifier that guesses, a review count
// that includes decisions made against a commit nobody has any more, a binding
// that a second event can overwrite. All three pass a rendering test and none
// pass a unit test, which is why they live here.
//
// The kind numbers are **restated** rather than imported from
// `convex/buzz/_kinds.ts`, for the reason `src/lib/buzz/timeline.ts` gives about
// its own copies: that module reaches `_nostr.ts` and therefore `@noble/curves`,
// a signing library the browser has no business downloading to draw a project
// card. The duplication is the hazard the codebase warns about, so
// `tests/buzz-projects.test.ts` pins every constant here against the registry
// and against the server's copy, and fails if any of the three drift.

// ---------------------------------------------------------------------------
// The event vocabulary (§2.2)
// ---------------------------------------------------------------------------

/** NIP-34 repository announcement. **The project.** Addressable by `(author, d)`. */
export const KIND_GIT_REPO_ANNOUNCEMENT = 30617;
/** Ref state after a push: `["refs/heads/<branch>", "<oid>"]` tags. */
export const KIND_GIT_REPO_STATE = 30618;
/** A NIP-34 patch — `git format-patch` output, posted into a branch room. */
export const KIND_GIT_PATCH = 1617;
/**
 * A pull request. Here it is **the branch-as-room binding**: the event that says
 * "this room is that branch of that repository, aimed at that base".
 *
 * Buzz's 1618 is a pull request as an object you open in a list. Ours is the
 * same event carrying the same tags (`a`, `branch-name`, `target-branch`,
 * `subject`, `c`), published *inside a channel*, which makes the room and the
 * proposal the same thing rather than two things that have to be kept in sync.
 * A PR list is then a list of rooms, and it is derived rather than stored.
 */
export const KIND_GIT_PULL_REQUEST = 1618;
/** The tip moved: a new head commit for an existing binding. */
export const KIND_GIT_PR_UPDATE = 1619;
/**
 * A NIP-34 issue.
 *
 * Named so the next phase finds the number rather than inventing a second one,
 * and **deliberately not built** — the same call `forum.ts` makes about
 * `KIND_FORUM_VOTE`. An issue tracker with no git hosting behind it and no room
 * to hold the argument is a list of text somebody has to keep tidy by hand; the
 * thing this phase is for is the branch room, and a tab that produced a stub
 * would be worse than a tab that is not there (CLAUDE.md: a control that
 * produces a stub is worse than no control).
 */
export const KIND_GIT_ISSUE = 1621;
/** Status: the good one. State `open`, CI `passed`, review `approved`. */
export const KIND_GIT_STATUS_OPEN = 1630;
/** Status: merged. Only ever a state statement — see `STATUS_OUTCOMES`. */
export const KIND_GIT_STATUS_MERGED = 1631;
/** Status: the bad one. State `closed`, CI `failed`, review `changes requested`. */
export const KIND_GIT_STATUS_CLOSED = 1632;
/** Status: the provisional one. State `draft`, CI `running`. */
export const KIND_GIT_STATUS_DRAFT = 1633;
/** NIP-MP: a project grouping several repository announcements. */
export const KIND_PROJECT = 30621;

/**
 * The kinds that draw a row in a **branch room's forge panel**.
 *
 * This set and the chat transcript's `TIMELINE_CONTENT_KINDS` are **disjoint**,
 * and that is the property rather than a filter somebody remembers to apply:
 * neither surface can show the other's rows because neither one lists them. It
 * is the same separation the forum has (a post is not a transcript row), and it
 * is what lets one room hold the argument and the artefacts without either view
 * turning into a mess of the other's events.
 *
 * `tests/buzz-projects.test.ts` asserts the intersection is empty, in both
 * directions, against the real sets.
 */
export const ROOM_FORGE_KINDS: ReadonlySet<number> = new Set([
  KIND_GIT_PATCH,
  KIND_GIT_PULL_REQUEST,
  KIND_GIT_PR_UPDATE,
  KIND_GIT_STATUS_OPEN,
  KIND_GIT_STATUS_MERGED,
  KIND_GIT_STATUS_CLOSED,
  KIND_GIT_STATUS_DRAFT,
]);

/** The four status kinds, as a set — "is this a status" asked once. */
export const STATUS_KINDS: ReadonlySet<number> = new Set([
  KIND_GIT_STATUS_OPEN,
  KIND_GIT_STATUS_MERGED,
  KIND_GIT_STATUS_CLOSED,
  KIND_GIT_STATUS_DRAFT,
]);

/**
 * The kinds a project is made of, and they are community-wide on purpose.
 *
 * A repository announcement is not *in* a room — rooms hang off it, one per
 * branch — so it is stored with no channel and every member of the community can
 * find it. The branch rooms it spawns are the opposite: channel-scoped, so a
 * private branch room is private in the log and not only in the product.
 */
export const PROJECT_GLOBAL_KINDS: ReadonlySet<number> = new Set([
  KIND_GIT_REPO_ANNOUNCEMENT,
  KIND_GIT_REPO_STATE,
  KIND_PROJECT,
]);

// ---------------------------------------------------------------------------
// Tags (§2.1, §2.2)
// ---------------------------------------------------------------------------

/** NIP-33 identifier: the repo slug. */
export const D_TAG = "d";
/** NIP-34 address of the repo everything else joins on: `30617:<owner>:<d>`. */
export const ADDRESS_TAG = "a";
export const NAME_TAG = "name";
export const DESCRIPTION_TAG = "description";
/** Multi-value: `["clone", url1, url2, …]`. */
export const CLONE_TAG = "clone";
export const WEB_TAG = "web";
export const MAINTAINERS_TAG = "maintainers";
/** The room a *project* is discussed in. Branch rooms carry their own binding. */
export const PROJECT_CHANNEL_TAG = "buzz-channel";
export const PROJECT_VISIBILITY_TAG = "buzz-visibility";
export const BRANCH_TAG = "branch-name";
export const TARGET_BRANCH_TAG = "target-branch";
/** The title of a binding. The same tag a forum post's title rides in. */
export const SUBJECT_TAG = "subject";
/** A commit object id. NIP-34's `c`. */
export const COMMIT_TAG = "c";
export const MERGE_COMMIT_TAG = "merge-commit";
/**
 * What a status event is a statement *about*: `state`, `ci` or `review`.
 *
 * A single letter because `t` is one of the indexed tags (`_kinds.ts`
 * `INDEXED_TAGS`), so "every CI result in this room" is an index range rather
 * than a scan of every status ever posted.
 */
export const STATUS_SUBJECT_TAG = "t";

// ---------------------------------------------------------------------------
// The event shape this module folds
// ---------------------------------------------------------------------------

/**
 * Structurally the part of a signed event these rules read.
 *
 * Deliberately not `NostrEvent`: the server hands rows in, the client hands
 * subscription results in, and an optimistic row has no id yet. Everything below
 * treats a missing id as "not addressable", which is the honest reading — a
 * status event nothing can point at is a status event nothing can supersede.
 */
export type ForgeEvent = {
  id?: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
};

function tagValue(tags: readonly string[][], name: string): string | undefined {
  for (const tag of tags) if (tag[0] === name && typeof tag[1] === "string") return tag[1];
  return undefined;
}

function tagValues(tags: readonly string[][], name: string): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    if (tag[0] !== name) continue;
    // A multi-value tag (`["clone", a, b]`) contributes every element past the
    // name, which is how NIP-34 writes clone urls and relay hints.
    for (const value of tag.slice(1)) if (typeof value === "string" && value) out.push(value);
  }
  return out;
}

const HEX_64 = /^[0-9a-f]{64}$/;

/** A pubkey, normalized, or nothing. 64 lowercase hex and no other shape. */
export function asPubkey(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim().toLowerCase();
  return HEX_64.test(clean) ? clean : undefined;
}

/**
 * A commit object id, or nothing.
 *
 * 40 hex (SHA-1) or 64 hex (SHA-256), matching the relay's manifest rule (§2.4:
 * "invalid OIDs (not 40- or 64-hex) are skipped rather than failing the whole
 * event"). Skipping rather than refusing is the same call here: a tip we cannot
 * read is a tip we do not draw, not a room that fails to load.
 */
export function asCommitOid(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim().toLowerCase();
  return clean.length === 40 || clean.length === 64
    ? /^[0-9a-f]+$/.test(clean)
      ? clean
      : undefined
    : undefined;
}

// ---------------------------------------------------------------------------
// Addresses and slugs
// ---------------------------------------------------------------------------

/** `30617:<owner-hex>:<d>` — the join key every other forge event carries. */
export function repoAddress(owner: string, dtag: string): string {
  return `${KIND_GIT_REPO_ANNOUNCEMENT}:${owner}:${dtag}`;
}

/**
 * The inverse, strict.
 *
 * Strict because the address is an *authorization-shaped* string: it names whose
 * announcement governs a repository, and the push policy reads the repository's
 * own announcement rather than anything a grouping event says (§2.1). A lenient
 * parser that accepted `30617:ALICE:x` and `30617:alice:x` as two addresses, or
 * accepted a coordinate of another kind, is how a fork ends up answering for the
 * original.
 */
export function parseRepoAddress(
  address: string,
): { owner: string; dtag: string } | null {
  const parts = address.split(":");
  if (parts.length < 3) return null;
  if (parts[0] !== String(KIND_GIT_REPO_ANNOUNCEMENT)) return null;
  const owner = asPubkey(parts[1]);
  if (!owner) return null;
  // A `d` tag may legitimately contain colons, so everything after the second
  // one is the identifier rather than only the third field.
  const dtag = parts.slice(2).join(":");
  return dtag ? { owner, dtag } : null;
}

/**
 * A repo slug from a display name — the same shape `channels.channelSlug` uses.
 *
 * Buzz slugifies client-side in `useCreateProject`; we do it in one exported
 * function so the announce path and the "is this name taken" check cannot
 * disagree. An empty result is refused by the caller: a repo with no identifier
 * is a repo nothing can address.
 */
export function projectSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
}

/** How long a branch name may be before it stops being a name. */
export const MAX_BRANCH_CHARS = 200;

/**
 * A git ref's short name, or null.
 *
 * The subset of git's own rules that a room can actually enforce: the characters
 * git allows in a ref, no empty segment, no leading or trailing slash, no `..`,
 * bounded. Refusing rather than repairing, because a branch name is matched
 * against a real repository somewhere and a silently-rewritten one names a
 * branch that does not exist — which surfaces much later, as a push that goes
 * nowhere, rather than here as a sentence somebody can read.
 */
export function normalizeBranchName(raw: string): string | null {
  const clean = raw.trim();
  if (clean.length === 0 || clean.length > MAX_BRANCH_CHARS) return null;
  if (!/^[A-Za-z0-9._\-\/]+$/u.test(clean)) return null;
  if (clean.startsWith("/") || clean.endsWith("/")) return null;
  if (clean.includes("//") || clean.includes("..")) return null;
  return clean;
}

// ---------------------------------------------------------------------------
// The project (§2.1)
// ---------------------------------------------------------------------------

export type Project = {
  /** `<owner-hex>:<dtag>` — what a route carries. Canonical; forks share dtags. */
  id: string;
  dtag: string;
  /** The announcing pubkey. 30617 is keyed by `(author, d)`, so this is identity. */
  owner: string;
  name: string;
  description: string;
  cloneUrls: string[];
  webUrl: string;
  /** Owner first, then `maintainers` and `p`, deduped. Owner is always in it. */
  maintainers: string[];
  /** The room the project itself is discussed in, if the author bound one. */
  projectChannelId: string | null;
  visibility: "listed" | "unlisted";
  repoAddress: string;
  createdAt: number;
  eventId: string;
};

/**
 * A 30617 read as a project, or null.
 *
 * `d` falls back to the event id and `name` falls back to `d`, both of which are
 * Buzz's own tolerance (`eventToProject`) and both of which matter for the same
 * reason: **a malformed announcement must not break the list**. An announcement
 * written by another client, or by an older build, still names a repository, and
 * dropping it would make a project vanish rather than render plainly.
 *
 * The one thing that is *not* tolerated is an unreadable owner. The owner is the
 * authority half of the address, so an announcement we cannot attribute is an
 * announcement we cannot say anything true about.
 */
export function projectFromEvent(event: ForgeEvent): Project | null {
  if (event.kind !== KIND_GIT_REPO_ANNOUNCEMENT) return null;
  const owner = asPubkey(event.pubkey);
  if (!owner) return null;

  const dtag = (tagValue(event.tags, D_TAG) ?? event.id ?? "").trim();
  if (!dtag) return null;

  const description = (tagValue(event.tags, DESCRIPTION_TAG) ?? event.content ?? "").trim();
  const maintainers = [
    owner,
    ...tagValues(event.tags, MAINTAINERS_TAG),
    ...tagValues(event.tags, "p"),
  ]
    .map((value) => asPubkey(value))
    .filter((value): value is string => value !== undefined);

  return {
    id: `${owner}:${dtag}`,
    dtag,
    owner,
    name: (tagValue(event.tags, NAME_TAG) ?? dtag).trim() || dtag,
    description,
    cloneUrls: tagValues(event.tags, CLONE_TAG),
    webUrl: tagValue(event.tags, WEB_TAG)?.trim() ?? "",
    maintainers: [...new Set(maintainers)],
    // **First** tag only, and a malformed one binds nothing rather than falling
    // through to the next — Buzz's `RepoBinding::Broken` rule (§2.3), and its
    // reasoning applies verbatim: "find the first *parseable* tag" would let an
    // author who can append a second tag choose which channel governs the repo.
    projectChannelId: firstChannelBinding(event.tags),
    visibility:
      tagValue(event.tags, PROJECT_VISIBILITY_TAG) === "unlisted" ? "unlisted" : "listed",
    repoAddress: repoAddress(owner, dtag),
    createdAt: event.created_at,
    eventId: event.id ?? "",
  };
}

/**
 * The `buzz-channel` binding: the **first** tag, or nothing.
 *
 * `Broken` and `NotBound` collapse to the same `null` here on purpose. This
 * module draws a project; it does not authorize a push, and the distinction Buzz
 * keeps between the two is entirely about which remediation to offer a pusher.
 * A renderer that acted on the difference would be inventing a governance
 * decision it is not the place to make.
 */
function firstChannelBinding(tags: readonly string[][]): string | null {
  for (const tag of tags) {
    if (tag[0] !== PROJECT_CHANNEL_TAG) continue;
    const value = typeof tag[1] === "string" ? tag[1].trim() : "";
    return HEX_64.test(value) ? value : null;
  }
  return null;
}

/** The tags an announcement is written with. One place, so the reader matches. */
export function projectTags(input: {
  dtag: string;
  name: string;
  description?: string;
  cloneUrls?: readonly string[];
  webUrl?: string;
  maintainers?: readonly string[];
  projectChannelId?: string;
  visibility?: "listed" | "unlisted";
}): string[][] {
  const tags: string[][] = [
    [D_TAG, input.dtag],
    [NAME_TAG, input.name],
  ];
  if (input.description) tags.push([DESCRIPTION_TAG, input.description]);
  // One multi-value tag rather than one tag per url, which is NIP-34's shape and
  // is what `tagValues` reads back.
  if (input.cloneUrls && input.cloneUrls.length > 0) {
    tags.push([CLONE_TAG, ...input.cloneUrls]);
  }
  if (input.webUrl) tags.push([WEB_TAG, input.webUrl]);
  for (const maintainer of input.maintainers ?? []) tags.push([MAINTAINERS_TAG, maintainer]);
  if (input.projectChannelId) tags.push([PROJECT_CHANNEL_TAG, input.projectChannelId]);
  if (input.visibility === "unlisted") tags.push([PROJECT_VISIBILITY_TAG, "unlisted"]);
  return tags;
}

// ---------------------------------------------------------------------------
// Ref state (§2.1, kind 30618)
// ---------------------------------------------------------------------------

export type RepoState = {
  /** The default branch, from the `HEAD` tag's `ref: refs/heads/<branch>`. */
  head: string | null;
  branches: { name: string; oid: string }[];
  tags: { name: string; oid: string }[];
  at: number;
};

const HEADS_PREFIX = "refs/heads/";
const TAGS_PREFIX = "refs/tags/";

/**
 * A 30618 read as ref state.
 *
 * Refs whose oid does not parse are **skipped, not fatal** — the relay builds
 * this event from a manifest and one unreadable ref must not lose the other
 * ninety-nine (§2.4). `HEAD` carries the `"ref: "` prefix even though the
 * manifest stores it bare, so it is stripped here rather than at each reader.
 */
export function refsFromRepoState(event: ForgeEvent): RepoState | null {
  if (event.kind !== KIND_GIT_REPO_STATE) return null;
  const branches: { name: string; oid: string }[] = [];
  const tags: { name: string; oid: string }[] = [];
  let head: string | null = null;

  for (const tag of event.tags) {
    const name = tag[0];
    const value = typeof tag[1] === "string" ? tag[1].trim() : "";
    if (name === "HEAD") {
      const ref = value.startsWith("ref: ") ? value.slice(5) : value;
      head = ref.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : null;
      continue;
    }
    const oid = asCommitOid(value);
    if (!oid) continue;
    if (name.startsWith(HEADS_PREFIX)) branches.push({ name: name.slice(HEADS_PREFIX.length), oid });
    else if (name.startsWith(TAGS_PREFIX)) tags.push({ name: name.slice(TAGS_PREFIX.length), oid });
  }

  branches.sort((a, b) => a.name.localeCompare(b.name));
  tags.sort((a, b) => a.name.localeCompare(b.name));
  return { head, branches, tags, at: event.created_at };
}

// ---------------------------------------------------------------------------
// Statuses (§2.2, §2.7, §2.8)
// ---------------------------------------------------------------------------

/** What a status event is a statement about. */
export type StatusSubject = "state" | "ci" | "review";

export type StatusOutcome =
  | "open"
  | "draft"
  | "closed"
  | "merged"
  | "passed"
  | "failed"
  | "running"
  | "approved"
  | "changes_requested";

/**
 * kind × subject → outcome. **The kind says the verdict; the `t` tag says what
 * is being judged.**
 *
 * This is the one place this build departs in spirit from Buzz, and it is worth
 * saying why rather than leaving it to be discovered. Buzz overloads 1630 to
 * mean both "this PR is open" and "CI passed", and files review decisions as
 * *labelled kind-1 notes*. Neither works here. Overloading means a room cannot
 * tell a lifecycle change from a build result without guessing; and kind 1 is
 * community-global in our registry (it is Pulse's note kind), so a review filed
 * as one would be readable by the whole workspace rather than by the branch
 * room — which is precisely the visibility rule this phase exists to keep.
 *
 * So the four NIP-34 status kinds keep their NIP-34 meanings — 1630 good, 1631
 * merged, 1632 bad, 1633 provisional — and `t` names the subject. A blank left
 * in this table is a combination that has no meaning and is refused on write
 * (there is no such thing as a "merged" build, or a "provisional" review).
 */
const STATUS_OUTCOMES: Record<StatusSubject, Partial<Record<number, StatusOutcome>>> = {
  state: {
    [KIND_GIT_STATUS_OPEN]: "open",
    [KIND_GIT_STATUS_MERGED]: "merged",
    [KIND_GIT_STATUS_CLOSED]: "closed",
    [KIND_GIT_STATUS_DRAFT]: "draft",
  },
  ci: {
    [KIND_GIT_STATUS_OPEN]: "passed",
    [KIND_GIT_STATUS_CLOSED]: "failed",
    [KIND_GIT_STATUS_DRAFT]: "running",
  },
  review: {
    [KIND_GIT_STATUS_OPEN]: "approved",
    [KIND_GIT_STATUS_CLOSED]: "changes_requested",
  },
};

/** The inverse: which kind carries this outcome. `null` for a combination that has none. */
export function statusKindFor(subject: StatusSubject, outcome: StatusOutcome): number | null {
  for (const [kind, value] of Object.entries(STATUS_OUTCOMES[subject])) {
    if (value === outcome) return Number(kind);
  }
  return null;
}

/** Is this a statement somebody is allowed to make at all? Used on write. */
export function isStatusOutcome(subject: StatusSubject, outcome: string): outcome is StatusOutcome {
  return statusKindFor(subject, outcome as StatusOutcome) !== null;
}

export function isStatusSubject(value: string): value is StatusSubject {
  return value === "state" || value === "ci" || value === "review";
}

/**
 * The `t` tag, defaulting to `state`.
 *
 * Tolerant on read and strict on write, which is the general rule for a log that
 * other clients write into: a NIP-34 status event from a foreign tool carries no
 * `t` at all and *means* a lifecycle status, so reading it as one is reading it
 * correctly rather than guessing. An unrecognised `t` is `state` for the same
 * reason — the kind still carries a NIP-34 meaning even when the subject does
 * not resolve.
 */
export function statusSubjectOf(tags: readonly string[][]): StatusSubject {
  const raw = tagValue(tags, STATUS_SUBJECT_TAG)?.trim().toLowerCase() ?? "";
  return isStatusSubject(raw) ? raw : "state";
}

// ---------------------------------------------------------------------------
// Folding a room's forge events
// ---------------------------------------------------------------------------

export type ForgeBinding = {
  type: "binding";
  id: string;
  at: number;
  by: string;
  repoAddress: string;
  branch: string;
  targetBranch: string;
  title: string;
  commit: string | null;
  reviewers: string[];
};

export type ForgePatch = {
  type: "patch";
  id: string;
  at: number;
  by: string;
  title: string;
  commit: string | null;
  /** The raw `git format-patch` text. Rendered as a diff, never as markdown. */
  body: string;
};

export type ForgeUpdate = {
  type: "update";
  id: string;
  at: number;
  by: string;
  commit: string;
};

export type ForgeStatus = {
  type: "status";
  id: string;
  at: number;
  by: string;
  subject: StatusSubject;
  outcome: StatusOutcome;
  /** The event this judges: a patch, or the binding. */
  rootId: string | null;
  /** The commit the judgement was made against, when the author named one. */
  commit: string | null;
  note: string;
  /** A merge decision's resulting commit. Only ever on `state`/`merged`. */
  mergeCommit: string | null;
};

export type ForgeItem = ForgeBinding | ForgePatch | ForgeUpdate | ForgeStatus;

/**
 * One event → one item, or null for anything that is not forge vocabulary.
 *
 * Null rather than a throw, and null rather than a placeholder row: a room's
 * window contains chat messages, reactions, system rows and edits, and this
 * function is handed all of them. An "unknown event" row would put the room's
 * conversation into the panel that exists to keep it out.
 */
export function classifyForgeEvent(event: ForgeEvent): ForgeItem | null {
  const id = event.id ?? "";
  const by = asPubkey(event.pubkey) ?? "";
  const at = event.created_at;

  if (event.kind === KIND_GIT_PULL_REQUEST) {
    const address = tagValue(event.tags, ADDRESS_TAG) ?? "";
    const branch = normalizeBranchName(tagValue(event.tags, BRANCH_TAG) ?? "");
    if (!parseRepoAddress(address) || !branch) return null;
    return {
      type: "binding",
      id,
      at,
      by,
      repoAddress: address,
      branch,
      targetBranch: normalizeBranchName(tagValue(event.tags, TARGET_BRANCH_TAG) ?? "") ?? "",
      title: (tagValue(event.tags, SUBJECT_TAG) ?? branch).trim(),
      commit: asCommitOid(tagValue(event.tags, COMMIT_TAG)) ?? null,
      reviewers: tagValues(event.tags, "p")
        .map((value) => asPubkey(value))
        .filter((value): value is string => value !== undefined),
    };
  }

  if (event.kind === KIND_GIT_PATCH) {
    return {
      type: "patch",
      id,
      at,
      by,
      title: (tagValue(event.tags, SUBJECT_TAG) ?? "").trim(),
      commit: asCommitOid(tagValue(event.tags, COMMIT_TAG)) ?? null,
      body: event.content,
    };
  }

  if (event.kind === KIND_GIT_PR_UPDATE) {
    const commit = asCommitOid(tagValue(event.tags, COMMIT_TAG));
    // An update whose whole payload is "the tip is now <unreadable>" says
    // nothing, so it is not an item. Drawing it would be drawing a blank.
    if (!commit) return null;
    return { type: "update", id, at, by, commit };
  }

  if (STATUS_KINDS.has(event.kind)) {
    const subject = statusSubjectOf(event.tags);
    const outcome = STATUS_OUTCOMES[subject][event.kind];
    if (!outcome) return null;
    return {
      type: "status",
      id,
      at,
      by,
      subject,
      outcome,
      rootId: tagValue(event.tags, "e") ?? null,
      commit: asCommitOid(tagValue(event.tags, COMMIT_TAG)) ?? null,
      note: event.content,
      mergeCommit: asCommitOid(tagValue(event.tags, MERGE_COMMIT_TAG)) ?? null,
    };
  }

  return null;
}

/** Newest first, tie-broken on id so two events in one second never swap. */
function byNewest(a: ForgeItem, b: ForgeItem): number {
  return b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export type ReviewDecision = {
  by: string;
  outcome: "approved" | "changes_requested";
  at: number;
  note: string;
  /**
   * Was this decision made against the branch's current tip?
   *
   * §2.7's `reviewDecisionStatus`. A stale approval is kept and marked rather
   * than dropped, because "Ada approved this, two pushes ago" is a true and
   * useful sentence and silently dropping it reads as Ada never looking.
   */
  current: boolean;
};

export type BranchState = "draft" | "open" | "merged" | "closed";

export type BranchRoom = {
  channelId: string;
  /** Null when the room is an ordinary room rather than a branch. */
  binding: ForgeBinding | null;
  /** The newest commit anybody has claimed for this branch. */
  tip: string | null;
  patches: ForgePatch[];
  /** The latest CI result, whatever it says. Null when nothing has run. */
  check: ForgeStatus | null;
  /** One decision per reviewer, latest wins. Newest first. */
  reviews: ReviewDecision[];
  /** The merge, if there was one. Signed by whoever made the call. */
  merge: ForgeStatus | null;
  state: BranchState;
  lastActivityAt: number;
};

/**
 * A window of a room's events → what the branch panel draws.
 *
 * Four rules, and each of them is a thing that would otherwise be wrong in a way
 * nobody notices until it matters:
 *
 *   - **The binding is the earliest 1618 and nothing can replace it.** A room is
 *     one branch; if a later event could rebind it, anybody who can post in the
 *     room could retroactively make the record say the merged code came from
 *     somewhere else. Later bindings are ignored, silently, because refusing on
 *     read would mean a room that renders nothing.
 *   - **The tip is the newest claim, from either a 1619 or the binding.** Not
 *     "the last 1619", because a room with no update still has the tip its
 *     binding named.
 *   - **One review per reviewer, latest wins** (§2.7: "latest current-commit
 *     decision per reviewer"). A reviewer who approves and then asks for changes
 *     has asked for changes; counting both would make an approval count that
 *     only ever goes up.
 *   - **A merge is the earliest 1631, not the latest.** The first merge is the
 *     one that happened; a second is either a duplicate or somebody trying to
 *     restate the record, and the log keeps both while the panel shows the one
 *     that decided it.
 */
export function buildBranchRoom(
  channelId: string,
  events: readonly ForgeEvent[],
): BranchRoom {
  const items: ForgeItem[] = [];
  for (const event of events) {
    const item = classifyForgeEvent(event);
    if (item) items.push(item);
  }
  items.sort(byNewest);

  const bindings = items.filter((item): item is ForgeBinding => item.type === "binding");
  const binding = bindings.length > 0 ? bindings[bindings.length - 1] : null;

  const patches = items.filter((item): item is ForgePatch => item.type === "patch");
  const updates = items.filter((item): item is ForgeUpdate => item.type === "update");
  const statuses = items.filter((item): item is ForgeStatus => item.type === "status");

  const tip =
    updates[0]?.commit ??
    patches.find((patch) => patch.commit !== null)?.commit ??
    binding?.commit ??
    null;

  const check = statuses.find((status) => status.subject === "ci") ?? null;

  const latestByReviewer = new Map<string, ForgeStatus>();
  for (const status of statuses) {
    if (status.subject !== "review" || !status.by) continue;
    // `statuses` is newest-first, so the first one seen for a pubkey is theirs.
    if (!latestByReviewer.has(status.by)) latestByReviewer.set(status.by, status);
  }
  const reviews: ReviewDecision[] = [...latestByReviewer.values()].map((status) => ({
    by: status.by,
    outcome: status.outcome === "approved" ? "approved" : "changes_requested",
    at: status.at,
    note: status.note,
    // No tip and no commit means nothing to disagree with, so the decision
    // stands as current rather than being marked stale on a technicality.
    current: tip === null || status.commit === null || status.commit === tip,
  }));
  reviews.sort((a, b) => b.at - a.at || a.by.localeCompare(b.by));

  const merges = statuses.filter(
    (status) => status.subject === "state" && status.outcome === "merged",
  );
  const merge = merges.length > 0 ? merges[merges.length - 1] : null;

  const latestState = statuses.find((status) => status.subject === "state") ?? null;
  const state: BranchState = merge
    ? "merged"
    : latestState?.outcome === "closed"
      ? "closed"
      : latestState?.outcome === "draft"
        ? "draft"
        : "open";

  return {
    channelId,
    binding,
    tip,
    patches,
    check,
    reviews,
    merge,
    state,
    lastActivityAt: items.length > 0 ? items[0].at : 0,
  };
}

/**
 * What the merge control says, and whether it is offered.
 *
 * Deliberately advisory rather than a gate: this is a room, not a git server, so
 * "ready" is a reading of what the room has recorded and not a promise that a
 * push will succeed. Naming that in the type — `blockers` rather than
 * `allowed` — keeps the UI from presenting a judgement it cannot back.
 */
export function mergeReadiness(room: BranchRoom): {
  ready: boolean;
  blockers: string[];
} {
  const blockers: string[] = [];
  if (!room.binding) blockers.push("This room is not bound to a branch");
  if (room.state === "merged") blockers.push("Already merged");
  if (room.state === "closed") blockers.push("This branch was closed");
  if (room.check?.outcome === "failed") blockers.push("Checks failed");
  if (room.check?.outcome === "running") blockers.push("Checks are still running");
  if (room.reviews.some((review) => review.outcome === "changes_requested" && review.current)) {
    blockers.push("Changes were requested");
  }
  if (!room.reviews.some((review) => review.outcome === "approved" && review.current)) {
    blockers.push("No current approval");
  }
  return { ready: blockers.length === 0, blockers };
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<StatusOutcome, string> = {
  open: "Open",
  draft: "Draft",
  closed: "Closed",
  merged: "Merged",
  passed: "Checks passed",
  failed: "Checks failed",
  running: "Checks running",
  approved: "Approved",
  changes_requested: "Changes requested",
};

/**
 * One sentence per outcome, in one table.
 *
 * Here rather than in the components for the reason `timeline.ts` gives about
 * `describeSystemEvent`: the same words are read by the branch panel, the
 * project detail's branch list and the activity feed, and three private copies
 * would drift into three different vocabularies sitting on one screen.
 */
export function describeStatus(outcome: StatusOutcome): string {
  return STATUS_LABELS[outcome];
}

/** How a state reads as a chip. Same table, so a chip and a sentence agree. */
export function describeBranchState(state: BranchState): string {
  return STATUS_LABELS[state];
}

/** `a1b2c3d` — a commit, short, the way every git tool shows one. */
export function shortCommit(oid: string | null): string {
  return oid ? oid.slice(0, 7) : "";
}

// ---------------------------------------------------------------------------
// Rollups for the list screens (§2.5)
// ---------------------------------------------------------------------------

export type ProjectSummary = {
  project: Project;
  branchRooms: number;
  openBranchRooms: number;
  patches: number;
  /** Everybody who has touched this project's rooms. Pubkeys, deduped. */
  participants: string[];
  lastActivityAt: number;
};

/**
 * Per-project counts over the branch rooms the reader may see.
 *
 * "May see" is doing the load-bearing work and it is not this function's job: it
 * counts what it is handed, and the server hands it only the rooms this reader
 * is allowed into. A count computed over every room and then filtered would leak
 * the existence of a private branch through a number, which is exactly the shape
 * of leak a room-scoped log is supposed to make impossible.
 */
export function summarizeProject(
  project: Project,
  rooms: readonly BranchRoom[],
): ProjectSummary {
  const participants = new Set<string>();
  let patches = 0;
  let lastActivityAt = 0;
  let open = 0;

  for (const room of rooms) {
    patches += room.patches.length;
    if (room.state === "open" || room.state === "draft") open += 1;
    if (room.lastActivityAt > lastActivityAt) lastActivityAt = room.lastActivityAt;
    if (room.binding?.by) participants.add(room.binding.by);
    for (const patch of room.patches) if (patch.by) participants.add(patch.by);
    for (const review of room.reviews) if (review.by) participants.add(review.by);
    if (room.merge?.by) participants.add(room.merge.by);
  }

  return {
    project,
    branchRooms: rooms.length,
    openBranchRooms: open,
    patches,
    participants: [...participants],
    lastActivityAt: Math.max(lastActivityAt, project.createdAt),
  };
}

export type ActivityItem = {
  id: string;
  at: number;
  by: string;
  /** "opened a branch", "pushed a patch", "approved". Verb-first (§3.2). */
  verb: string;
  detail: string;
  channelId: string;
};

/** How many rows the feed will ever draw. Buzz's `ACTIVITY_LIMIT`, in spirit. */
export const ACTIVITY_LIMIT = 40;

/**
 * The unified feed, newest first: "verb, object, outcome" (VISION_ACTIVITY, via
 * §3.2).
 *
 * Every row is derived from an item that is already on the screen somewhere
 * else, which is deliberate — a feed with its own store is a feed that can
 * disagree with the thing it summarises. Nothing is narrated by a model and
 * nothing is stored; the sentence is computed from the event every time.
 */
export function projectActivity(rooms: readonly BranchRoom[]): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const room of rooms) {
    const branch = room.binding?.branch ?? "";
    if (room.binding) {
      out.push({
        id: room.binding.id,
        at: room.binding.at,
        by: room.binding.by,
        verb: "opened a branch room",
        detail: room.binding.title || branch,
        channelId: room.channelId,
      });
    }
    for (const patch of room.patches) {
      out.push({
        id: patch.id,
        at: patch.at,
        by: patch.by,
        verb: "pushed a patch",
        detail: patch.title || shortCommit(patch.commit) || branch,
        channelId: room.channelId,
      });
    }
    for (const review of room.reviews) {
      out.push({
        id: `${room.channelId}:${review.by}:${review.at}`,
        at: review.at,
        by: review.by,
        verb: review.outcome === "approved" ? "approved" : "requested changes on",
        detail: branch,
        channelId: room.channelId,
      });
    }
    if (room.check) {
      out.push({
        id: room.check.id,
        at: room.check.at,
        by: room.check.by,
        verb: describeStatus(room.check.outcome).toLowerCase(),
        detail: branch,
        channelId: room.channelId,
      });
    }
    if (room.merge) {
      out.push({
        id: room.merge.id,
        at: room.merge.at,
        by: room.merge.by,
        verb: "merged",
        detail: branch,
        channelId: room.channelId,
      });
    }
  }
  return out
    .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, ACTIVITY_LIMIT);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** `/chat/projects/<owner>:<dtag>`. Encoded, because a dtag is author-supplied. */
export function projectHref(projectId: string): string {
  return `/chat/projects/${encodeURIComponent(projectId)}`;
}

export const PROJECTS_HREF = "/chat/projects";
