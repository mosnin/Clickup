// The kind registry, and the validation ladder that guards the log.
//
// A kind number is the *only* thing that decides how an event is stored, who
// may read it back, and whether it is bound to a channel — so all of that lives
// here, in one table, next to the number. The alternative (a switch in the write
// path, another in the read path, a third in search) is how a kind ends up
// stored one way and read another.
//
// **The vocabulary is closed, and that is a security boundary, not a style
// rule.** Agents write into this log. An unknown kind is refused rather than
// stored: a relay that accepts anything numbered is a relay whose read gates are
// advisory, because a gate can only protect kinds it has heard of. Adding a kind
// is one row here plus whatever handler needs it — never an `if` somewhere else.
//
// Source of truth: docs/buzz-parity/06-protocol.md §2 (storage classes),
// §3 (the registry), §4 (tags), §5 (channel scope), §9 (read gates),
// §12 (search), §16 (the invariants). Pure — no ctx, no Convex imports — so the
// write path, the read path and the tests all consult the same copy.

import { isEphemeral, isParamReplaceable, isReplaceable } from "./_nostr";

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * How a kind is stored. A function of the kind *number* (§16.4) for everything
 * the log holds — `never` is the exception, and it is not about the number: it
 * marks kinds that are executed or filed elsewhere (commands, sidecars, the
 * auth event) and must not reach `buzzEvents` at all.
 */
export type StorageClass =
  | "regular" // append-only, kept forever
  | "replaceable" // one per (kind, pubkey, scope)
  | "addressable" // NIP-33: one per (kind, pubkey, d)
  | "ephemeral" // 20000–29999: fanned out, never written
  | "never"; // command / sidecar / auth: handled by something that is not the log

/**
 * The `h` contract (§5.1). `required` and `global` are the two that bite:
 * a required-`h` kind without one is refused, and a global-only kind is stored
 * with no channel *even when it carries an `h` tag* — the event is signed, so
 * the tag cannot be stripped, but it must never bind the event to a room.
 */
export type ChannelScope =
  | "required" // refuse the event if it has no `h` tag
  | "global" // channel forced to none, whatever the tags say
  | "derived" // channel comes from the `#e` target, never from the author's `h`
  | "optional"; // `h` if present, global otherwise

/**
 * The read gate (§9.1). `open` is "anyone who can reach the scope"; everything
 * else narrows further and is enforced per event, on every read surface, by the
 * one function in log.ts (§16.12).
 */
export type ReadGate =
  | "open"
  | "author" // only the author. Existence, count and tags must not leak.
  | "p" // only a pubkey named in a `#p` tag
  | "shared"; // author-only unless the event carries exactly ["shared","true"]

export type KindSpec = {
  kind: number;
  /** The stable constant name. Buzz's, verbatim, so the two specs cross-read. */
  name: string;
  storage: StorageClass;
  scope: ChannelScope;
  gate: ReadGate;
  /**
   * Signed by the relay identity, never by a client (§16.21). In our model the
   * relay is the `system` actor, so a user or an agent submitting one is
   * refused — Buzz refuses the same submissions, some via `is_relay_only_kind`
   * and some by leaving them out of its kind→scope map.
   */
  relaySigned?: boolean;
  /**
   * Per-event `#p` check *even on a kindless `{ids:[…]}` lookup* (§16.14).
   * Knowing an event id is not authorization for these two: 30622's id is not
   * author-bound, and 44200's cleartext envelope leaks activity metadata.
   */
  resultGated?: boolean;
};

// ---------------------------------------------------------------------------
// The registry (§3), in numeric order
// ---------------------------------------------------------------------------

type Flags = {
  gate?: ReadGate;
  relaySigned?: boolean;
  resultGated?: boolean;
  /**
   * Not stored: executed transactionally by a command handler, or filed into a
   * sidecar table, or (22242/27235) an auth credential we must never keep.
   * Storage class stops being a function of the number for exactly these.
   */
  handled?: boolean;
};

function k(kind: number, name: string, scope: ChannelScope, flags: Flags = {}): KindSpec {
  return {
    kind,
    name,
    storage: flags.handled ? "never" : storageClassForKind(kind),
    scope,
    gate: flags.gate ?? "open",
    ...(flags.relaySigned ? { relaySigned: true } : {}),
    ...(flags.resultGated ? { resultGated: true } : {}),
  };
}

/**
 * Storage class from the number alone (§2, §16.4). Ephemeral and the two
 * replaceable classes are disjoint over the whole 0..65535 space, which is what
 * lets a single number answer "where does this go" with no lookup.
 */
export function storageClassForKind(kind: number): StorageClass {
  if (isEphemeral(kind)) return "ephemeral";
  if (isReplaceable(kind)) return "replaceable";
  if (isParamReplaceable(kind)) return "addressable";
  return "regular";
}

const REGISTRY: KindSpec[] = [
  // ── §3.1 Standard NIP kinds ──────────────────────────────────────────────
  k(0, "KIND_PROFILE", "global"),
  k(1, "KIND_TEXT_NOTE", "global"),
  k(3, "KIND_CONTACT_LIST", "global"),
  // 5 and 7 take their channel from the event they point at, never from their
  // own `h` tag: a reaction that could name its own room could plant itself in
  // a room its target is not in.
  k(5, "KIND_DELETION", "derived"),
  k(7, "KIND_REACTION", "derived"),
  k(9, "KIND_STREAM_MESSAGE", "required"),
  k(41, "KIND_CHANNEL_METADATA", "optional"),
  // A gift wrap is signed with an ephemeral key and addressed by `#p`; the
  // envelope is all a non-recipient may ever see, and not even that.
  k(1059, "KIND_GIFT_WRAP", "global", { gate: "p" }),
  k(1063, "KIND_FILE_METADATA", "optional"),
  // The forge band, and the `optional` scope on six of them is C9's one change
  // to this registry. Buzz stores every NIP-34 event community-wide because its
  // forge is addressed by the repo coordinate (`a`) rather than by a room. Ours
  // is addressed by both: **a branch is a room** (03-workflows-projects §2.3),
  // so a patch, a check result, a review decision and the merge are events *in
  // that room*, sitting in the same log as the argument about them.
  //
  // The scope is what makes that true rather than decorative. A `global` kind is
  // stored with no channel whatever its tags say, so a patch would be readable
  // by the whole community and invisible to the room's own timeline — a private
  // branch room would be private in the product and porous in the log, which is
  // the exact failure §16.9 exists to prevent. `optional` means "the `h` tag if
  // there is one, community-wide otherwise", so a project-level patch with no
  // room still behaves the way Buzz's does.
  //
  // 1621 stays global: an issue belongs to a repository, not to a branch, and
  // there is no room for it to be in. 30617/30618/30621 stay global for the same
  // reason — a repository announcement is the thing rooms hang off.
  k(1617, "KIND_GIT_PATCH", "optional"),
  k(1618, "KIND_GIT_PULL_REQUEST", "optional"),
  k(1619, "KIND_GIT_PR_UPDATE", "optional"),
  k(1621, "KIND_GIT_ISSUE", "global"),
  k(1630, "KIND_GIT_STATUS_OPEN", "optional"),
  k(1631, "KIND_GIT_STATUS_MERGED", "optional"),
  k(1632, "KIND_GIT_STATUS_CLOSED", "optional"),
  k(1633, "KIND_GIT_STATUS_DRAFT", "optional"),
  // A report is a signal, never a trigger: it lands in the moderation queue and
  // never in the log, so reporting somebody cannot itself publish anything.
  k(1984, "KIND_REPORT", "optional", { handled: true }),
  k(10000, "KIND_MUTE_LIST", "global"),
  k(10001, "KIND_PIN_LIST", "global"),
  k(10002, "KIND_NIP65_RELAY_LIST_METADATA", "global"),
  k(10003, "KIND_BOOKMARK_LIST", "global"),
  k(10030, "KIND_EMOJI_LIST", "global"),
  // Never stored, never audited, never logged (§16.21) — an AUTH event carries
  // bearer material, so a copy of one is a copy of a credential.
  k(22242, "KIND_AUTH", "optional", { handled: true }),
  k(27235, "KIND_HTTP_AUTH", "optional", { handled: true }),
  k(30023, "KIND_LONG_FORM", "global"),
  k(30315, "KIND_USER_STATUS", "global"),

  // ── §3.2 NIP-29 group management ─────────────────────────────────────────
  k(9000, "KIND_NIP29_PUT_USER", "required"),
  k(9001, "KIND_NIP29_REMOVE_USER", "required"),
  k(9002, "KIND_NIP29_EDIT_METADATA", "required"),
  k(9005, "KIND_NIP29_DELETE_EVENT", "required"),
  // 9007 creates the channel, so it cannot require one to exist.
  k(9007, "KIND_NIP29_CREATE_GROUP", "optional"),
  k(9008, "KIND_NIP29_DELETE_GROUP", "required"),
  // 9009 and 9021 are documented "h required" in §3.2 but are absent from
  // §5.1's `requires_h_channel_scope` enumeration. We follow §5.1 — it is the
  // named predicate, and the ladder is the place a disagreement gets decided
  // once rather than per call site. C3 owns join/invite semantics and can
  // refuse a tagless one there, where the refusal means something.
  k(9009, "KIND_NIP29_CREATE_INVITE", "optional"),
  k(9021, "KIND_NIP29_JOIN_REQUEST", "optional"),
  k(9022, "KIND_NIP29_LEAVE_REQUEST", "required"),
  k(39000, "KIND_NIP29_GROUP_METADATA", "optional", { relaySigned: true }),
  k(39001, "KIND_NIP29_GROUP_ADMINS", "optional", { relaySigned: true }),
  k(39002, "KIND_NIP29_GROUP_MEMBERS", "optional", { relaySigned: true }),
  k(39003, "KIND_NIP29_GROUP_ROLES", "optional", { relaySigned: true }),

  // ── §3.3 Membership, identity archival, moderation ───────────────────────
  k(8000, "KIND_NIP43_MEMBER_ADDED", "global", { relaySigned: true }),
  k(8001, "KIND_NIP43_MEMBER_REMOVED", "global", { relaySigned: true }),
  k(8002, "KIND_IA_ARCHIVED", "global", { relaySigned: true }),
  k(8003, "KIND_IA_UNARCHIVED", "global", { relaySigned: true }),
  k(9030, "RELAY_ADMIN_ADD_MEMBER", "global", { handled: true }),
  k(9031, "RELAY_ADMIN_REMOVE_MEMBER", "global", { handled: true }),
  k(9032, "RELAY_ADMIN_CHANGE_ROLE", "global", { handled: true }),
  k(9033, "RELAY_ADMIN_SET_WORKSPACE_PROFILE", "global", { handled: true }),
  k(9035, "KIND_IA_ARCHIVE_REQUEST", "global", { handled: true }),
  k(9036, "KIND_IA_UNARCHIVE_REQUEST", "global", { handled: true }),
  k(9040, "KIND_MODERATION_BAN", "global", { handled: true }),
  k(9041, "KIND_MODERATION_UNBAN", "global", { handled: true }),
  k(9042, "KIND_MODERATION_TIMEOUT", "global", { handled: true }),
  k(9043, "KIND_MODERATION_UNTIMEOUT", "global", { handled: true }),
  k(9044, "KIND_MODERATION_RESOLVE_REPORT", "global", { handled: true }),
  k(13534, "KIND_NIP43_MEMBERSHIP_LIST", "global", { relaySigned: true }),
  k(13535, "KIND_IA_ARCHIVED_LIST", "global", { relaySigned: true }),

  // ── §3.4 Ephemeral (20000–29999) ─────────────────────────────────────────
  // Nothing here is ever written (§16.22). They are signed and handed back for
  // fan-out; presence and typing must not touch the durable log, because a
  // heartbeat that lands in an append-only table is an append-only table that
  // grows at the rate of a heartbeat.
  k(20001, "KIND_PRESENCE_UPDATE", "optional"),
  k(20002, "KIND_TYPING_INDICATOR", "required"),
  k(24134, "KIND_PAIRING", "optional"),
  k(24200, "KIND_AGENT_OBSERVER_FRAME", "global", { gate: "p" }),
  k(24242, "KIND_BLOSSOM_AUTH", "optional"),
  k(24243, "KIND_NOSTR_IDENTITY_BINDING", "optional"),
  k(24810, "KIND_HUDDLE_REACTION", "required"),
  k(28936, "KIND_NIP43_LEAVE_REQUEST", "global"),

  // ── §3.5 Buzz messaging (40000–40999) ────────────────────────────────────
  k(40002, "KIND_STREAM_MESSAGE_V2", "required"),
  k(40003, "KIND_STREAM_MESSAGE_EDIT", "required"),
  k(40004, "KIND_STREAM_MESSAGE_PINNED", "required"),
  k(40005, "KIND_STREAM_MESSAGE_BOOKMARKED", "required"),
  k(40006, "KIND_STREAM_MESSAGE_SCHEDULED", "required"),
  k(40007, "KIND_STREAM_REMINDER", "required"),
  k(40008, "KIND_STREAM_MESSAGE_DIFF", "required"),
  k(40099, "KIND_SYSTEM_MESSAGE", "required", { relaySigned: true }),
  k(40100, "KIND_CANVAS", "required"),
  // Synthesized sidecars: relay-only *and* never stored. They are computed from
  // the log at read time, so a stored copy could only ever be a stale one.
  k(40901, "KIND_CHANNEL_SUMMARY", "optional", { relaySigned: true, handled: true }),
  k(40902, "KIND_PRESENCE_SNAPSHOT", "optional", { relaySigned: true, handled: true }),

  // ── §3.6 DMs and feedback ────────────────────────────────────────────────
  k(41001, "KIND_DM_CREATED", "optional"),
  k(41010, "KIND_DM_OPEN", "global", { handled: true }),
  k(41011, "KIND_DM_ADD_MEMBER", "optional", { handled: true }),
  k(41012, "KIND_DM_HIDE", "optional", { handled: true }),
  k(42000, "KIND_PRODUCT_FEEDBACK", "global", { handled: true }),

  // ── §3.7 Agent job protocol ──────────────────────────────────────────────
  k(43001, "KIND_JOB_REQUEST", "optional"),
  k(43002, "KIND_JOB_ACCEPTED", "optional"),
  k(43003, "KIND_JOB_PROGRESS", "optional"),
  k(43004, "KIND_JOB_RESULT", "optional"),
  k(43005, "KIND_JOB_CANCEL", "optional"),
  k(43006, "KIND_JOB_ERROR", "optional"),

  // ── §3.8 Notifications, metrics, forum ───────────────────────────────────
  k(44100, "KIND_MEMBER_ADDED_NOTIFICATION", "global", { gate: "p", relaySigned: true }),
  k(44101, "KIND_MEMBER_REMOVED_NOTIFICATION", "global", { gate: "p", relaySigned: true }),
  // Owner-only, and that includes the agent that wrote it: a turn metric is the
  // record of what an agent cost its owner, and an agent that can read its own
  // back can tune what it reports.
  k(44200, "KIND_AGENT_TURN_METRIC", "global", { gate: "p", resultGated: true }),
  k(45001, "KIND_FORUM_POST", "required"),
  k(45002, "KIND_FORUM_VOTE", "required"),
  k(45003, "KIND_FORUM_COMMENT", "required"),

  // ── §3.9 Workflow engine ─────────────────────────────────────────────────
  k(30620, "KIND_WORKFLOW_DEF", "required", { handled: true }),
  k(46001, "KIND_WORKFLOW_TRIGGERED", "optional"),
  k(46002, "KIND_WORKFLOW_STEP_STARTED", "optional"),
  k(46003, "KIND_WORKFLOW_STEP_COMPLETED", "optional"),
  k(46004, "KIND_WORKFLOW_STEP_FAILED", "optional"),
  k(46005, "KIND_WORKFLOW_COMPLETED", "optional"),
  k(46006, "KIND_WORKFLOW_FAILED", "optional"),
  k(46007, "KIND_WORKFLOW_CANCELLED", "optional"),
  k(46010, "KIND_WORKFLOW_APPROVAL_REQUESTED", "optional"),
  k(46011, "KIND_WORKFLOW_APPROVAL_GRANTED", "optional"),
  k(46012, "KIND_WORKFLOW_APPROVAL_DENIED", "optional"),
  k(46020, "KIND_WORKFLOW_TRIGGER", "optional", { handled: true }),
  k(46030, "KIND_APPROVAL_GRANT", "optional", { handled: true }),
  k(46031, "KIND_APPROVAL_DENY", "optional", { handled: true }),

  // ── §3.10 System, huddle, media ──────────────────────────────────────────
  k(48001, "KIND_AUDIT_ENTRY", "optional"),
  k(48100, "KIND_HUDDLE_STARTED", "required"),
  k(48101, "KIND_HUDDLE_PARTICIPANT_JOINED", "required", { relaySigned: true }),
  k(48102, "KIND_HUDDLE_PARTICIPANT_LEFT", "required", { relaySigned: true }),
  k(48103, "KIND_HUDDLE_ENDED", "required", { relaySigned: true }),
  k(48106, "KIND_HUDDLE_GUIDELINES", "required"),
  k(49001, "KIND_MEDIA_UPLOAD", "optional", { handled: true }),

  // ── §3.11 Buzz-defined NIP extensions ────────────────────────────────────
  k(10100, "KIND_AGENT_PROFILE", "global"),
  k(30000, "KIND_FOLLOW_SET", "global"),
  k(30003, "KIND_BOOKMARK_SET", "global"),
  k(30030, "KIND_EMOJI_SET", "global"),
  // Author-gated. Buzz encrypts this blob to itself, which defends against a
  // relay operator; we do not have one, since the server holds every key by
  // construction. What encryption would ALSO have defended against is a fellow
  // community member reading it back — and that threat is real here, because a
  // read-state blob says which rooms you opened and when you last looked at
  // them, which is a record of your attention. Left "open" it was readable by
  // anyone in the community. There is no cipher in this repo to encrypt with,
  // and there does not need to be: the gate that reminders and push leases
  // already use says only the author may read it, and it is enforced in the one
  // per-event visibility function rather than at any call site.
  k(30078, "KIND_READ_STATE", "global", { gate: "author" }),
  // The engram gate is filter-level (`authors` all-self *or* `#p` all-self) and
  // has no per-event form, because an engram is encrypted to the conversation
  // key: reaching one without the key buys nothing.
  k(30174, "KIND_AGENT_ENGRAM", "global"),
  k(30175, "KIND_PERSONA", "global", { gate: "shared" }),
  // 30176 is deliberately NOT shared-gated: its writers never emit `shared`, so
  // gating it would make every team invisible to everyone including its author's
  // own teammates.
  k(30176, "KIND_TEAM", "global"),
  k(30177, "KIND_MANAGED_AGENT", "global"),
  k(30178, "KIND_TEAM_CATALOG", "global", { gate: "shared" }),
  k(30300, "KIND_EVENT_REMINDER", "global", { gate: "author" }),
  k(30350, "KIND_PUSH_LEASE", "global", { gate: "author" }),
  k(30617, "KIND_GIT_REPO_ANNOUNCEMENT", "global"),
  k(30618, "KIND_GIT_REPO_STATE", "global"),
  k(30621, "KIND_PROJECT", "global"),
  k(30622, "KIND_DM_VISIBILITY", "global", {
    gate: "p",
    relaySigned: true,
    resultGated: true,
  }),
  // Overlays: synthesized at query time and pushed live, never stored. 39006 is
  // the only authority on `has_more` — a client that infers it from a row count
  // is wrong at exactly the page boundary where it matters.
  k(39005, "KIND_THREAD_SUMMARY", "optional", { relaySigned: true, handled: true }),
  k(39006, "KIND_WINDOW_BOUNDS", "optional", { relaySigned: true, handled: true }),
];

/** The registry, by number. Closed: a lookup miss is a refusal, not a default. */
export const KINDS: ReadonlyMap<number, KindSpec> = new Map(
  REGISTRY.map((spec) => [spec.kind, spec]),
);

export function kindSpec(kind: number): KindSpec | undefined {
  return KINDS.get(kind);
}

// ---------------------------------------------------------------------------
// The cross-cutting sets the read path consults (§2, §9.1)
// ---------------------------------------------------------------------------

function kindsWhere(pred: (spec: KindSpec) => boolean): ReadonlySet<number> {
  return new Set(REGISTRY.filter(pred).map((s) => s.kind));
}

/** 30300, 30350 — readable only by the author. Existence itself must not leak. */
export const AUTHOR_ONLY_KINDS = kindsWhere((s) => s.gate === "author");
/** 24200, 44100, 44101, 1059, 30622, 44200 — readable only by a named `#p`. */
export const P_GATED_KINDS = kindsWhere((s) => s.gate === "p");
/** 30175, 30178 — author-only unless the event carries exactly ["shared","true"]. */
export const SHARED_GATED_KINDS = kindsWhere((s) => s.gate === "shared");
/** 30622, 44200 — per-event `#p` check even on a kindless `{ids:[…]}` lookup. */
export const RESULT_GATED_KINDS = kindsWhere((s) => s.resultGated === true);
/** 30174 — its own filter-level rule: `authors` all-self or `#p` all-self. */
export const KIND_AGENT_ENGRAM = 30174;

// ---------------------------------------------------------------------------
// Search (§12, §16.16)
// ---------------------------------------------------------------------------

/**
 * The kinds whose content reaches the search index — an **allowlist**, which is
 * the direction Buzz is moving and the only version that is safe by default: a
 * denylist has to be updated every time a private kind is added, and the cost of
 * forgetting is that private content becomes findable.
 *
 * Enforced by *not writing* `searchText` (§16.16). A post-query exclusion is one
 * forgotten call site from leaking, and it leaks through result counts even when
 * nobody forgets.
 */
export const SEARCHABLE_KINDS: ReadonlySet<number> = new Set([
  0, // profiles — how you find a person
  9, // stream messages — the product
  40002, // rich messages
  45001, // forum posts
  45003, // forum comments
]);

// ---------------------------------------------------------------------------
// Tags (§4)
// ---------------------------------------------------------------------------

/**
 * The tag names projected into `buzzEventTags`.
 *
 * Exactly NIP-01's single-letter filterable set as Buzz uses it. Not every tag:
 * a projection row costs a write, so indexing all of them multiplies the cost of
 * a message by its tag count to answer questions nobody asks. `k`, `emoji`,
 * `role`, `imeta` and the channel-metadata vocabulary are deliberately absent —
 * they are read off the event once it has been found, never used to find it.
 *
 * Case matters: `E`/`P` are NIP-22 root references and are distinct tags from
 * `e`/`p`, not a capitalization of them.
 */
export const INDEXED_TAGS: ReadonlySet<string> = new Set([
  "e",
  "p",
  "h",
  "d",
  "a",
  "t",
  "r",
  "l",
  "c",
  "q",
  "u",
  "E",
  "P",
]);

/**
 * Kinds that must carry exactly one non-empty `d` tag (§4). Everywhere else a
 * missing `d` means the empty-string coordinate (§16.6) — but for these four the
 * `d` *is* the identity of the thing (a persona slug, a reminder's random id, a
 * read-state cursor), so collapsing a missing one into the `""` slot would make
 * two unrelated records replace each other.
 */
const REQUIRES_SINGLETON_D: ReadonlySet<number> = new Set([30078, 30175, 30178, 30300]);

/**
 * Is this event opted into community reads? (§4, §16.15)
 *
 * **Fails closed on every shape but exactly `["shared","true"]`**: two elements,
 * at most one occurrence, value exactly the string `true`. `["shared"]`,
 * `["shared","true","x"]`, `["shared","TRUE"]`, `["shared","1"]` and two of them
 * are all not-shared. The reason to be this strict is that the tag is the entire
 * difference between a private persona and a published one, so anything
 * ambiguous has to resolve to private.
 *
 * A tag and not a content field, deliberately: content bytes decide the event
 * id, so a `shared` flag inside the content would give an event a different
 * identity before and after it was shared — and nothing could then refer to
 * "that persona" across the change.
 */
export function eventIsShared(tags: readonly string[][]): boolean {
  const found = tags.filter((t) => t[0] === "shared");
  if (found.length !== 1) return false;
  const tag = found[0];
  return tag.length === 2 && tag[1] === "true";
}

// ---------------------------------------------------------------------------
// The validation ladder (§1.5)
// ---------------------------------------------------------------------------

/** ±15 minutes from server time. Wider and replacement ordering is forgeable. */
export const MAX_TIMESTAMP_DRIFT_SECS = 900;
/** 256 KB of content. */
export const MAX_EVENT_CONTENT_BYTES = 256 * 1024;
/** A `d` tag is a coordinate, not a payload. */
export const D_TAG_MAX_LEN = 1024;
/** A reaction is an emoji, `+`/`-`, or a shortcode. */
export const MAX_REACTION_EMOJI_CHARS = 64;
/**
 * How many tag values one event may project into the index.
 *
 * Buzz has no tag-count cap — its effective bound is the 512 KB WebSocket frame.
 * Ours is this, because our bound would otherwise be "how many rows fit in a
 * Convex transaction", which is a limit that fails *during* the write. Refusing
 * is the only honest option: silently truncating the projection would make a
 * `#p` query miss an event that genuinely mentions you, and a notification that
 * is sometimes not delivered is worse than one that is refused loudly.
 */
export const MAX_INDEXED_TAG_VALUES = 256;

export type ValidationOk = { ok: true; spec: KindSpec };
export type ValidationFailure = { ok: false; reason: string };
export type ValidationResult = ValidationOk | ValidationFailure;

export type ValidatableDraft = {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
};

const utf8 = new TextEncoder();

/**
 * The relay's validation ladder, in Buzz's order (§1.5).
 *
 * **Order is load-bearing**: each rung assumes the ones above it passed. The
 * kind rejections come first so that a credential-bearing AUTH event is refused
 * before anything measures, logs or reasons about it; the drift and size checks
 * come before the shape checks so a 40 MB body is refused before it is parsed.
 *
 * Two rungs of Buzz's ladder are absent because our substrate answers them by
 * construction, not because they were dropped:
 *   - signature + id verification (rung 5) and the pubkey/identity match
 *     (rung 8): we *sign* inside the mutation with the actor's own key
 *     (00-decisions.md D2), so an event cannot arrive claiming a pubkey it does
 *     not hold. There is no client-submitted `sig` to verify.
 *   - scope-for-kind, bans and membership (rungs 9–14): scopes are our workspace
 *     tenancy (`requireScopeAccess`), and channel membership arrives with C3.
 *
 * `actorType` is which principal is writing. `system` is our relay identity:
 * relay-signed kinds are refused from everyone else (§16.21).
 */
export function validateEvent(
  draft: ValidatableDraft,
  opts: { now: number; actorType: "user" | "agent" | "system" },
): ValidationResult {
  const { kind } = draft;

  // 0. A kind is a u16. `nostr` v0.44 backs Kind with u16 and Buzz asserts at
  //    compile time that every constant fits; a fractional or negative "kind"
  //    is not a kind at all.
  if (!Number.isInteger(kind) || kind < 0 || kind > 65535) {
    return { ok: false, reason: `invalid: kind must be an integer in 0..65535` };
  }

  const spec = KINDS.get(kind);

  // 1–4. Kind-level refusals, before anything else looks at the event.
  if (kind === 22242) {
    return { ok: false, reason: "invalid: AUTH events cannot be submitted" };
  }
  if (spec?.relaySigned && opts.actorType !== "system") {
    return { ok: false, reason: `restricted: kind ${kind} is relay-signed only` };
  }

  // 6. Timestamp drift. Replacement is decided by `created_at` (§6), so an event
  //    from far in the future would sit at the head of its coordinate forever
  //    and nothing legitimate could ever replace it.
  if (!Number.isFinite(draft.created_at) || !Number.isInteger(draft.created_at)) {
    return { ok: false, reason: "invalid: created_at must be an integer (seconds)" };
  }
  if (Math.abs(opts.now - draft.created_at) > MAX_TIMESTAMP_DRIFT_SECS) {
    return { ok: false, reason: "invalid: event timestamp too far from server time" };
  }

  // 7. Content size.
  if (utf8.encode(draft.content).length > MAX_EVENT_CONTENT_BYTES) {
    return {
      ok: false,
      reason: `invalid: content exceeds maximum size of ${MAX_EVENT_CONTENT_BYTES} bytes`,
    };
  }

  // 9. Unknown kind. The closed vocabulary: refuse, never store.
  if (!spec) return { ok: false, reason: "restricted: unknown event kind" };

  // Kinds the log does not hold at all — commands, sidecars, synthesized
  // overlays. Refused rather than silently dropped, so the phase that adds a
  // handler has to say so out loud instead of discovering that its events were
  // being accepted and thrown away.
  if (spec.storage === "never") {
    return { ok: false, reason: `invalid: kind ${kind} is not written to the log` };
  }

  // Tag shape. Buzz gets "every element is a string" from its JSON parser; we
  // get it from the Convex validator, so what is left is the parts a validator
  // cannot express.
  let indexedValues = 0;
  let dTags = 0;
  for (const tag of draft.tags) {
    if (tag.length === 0 || tag[0] === "") {
      return { ok: false, reason: "invalid: a tag must start with a non-empty name" };
    }
    if (tag[0] === "d") {
      dTags += 1;
      if (utf8.encode(tag[1] ?? "").length > D_TAG_MAX_LEN) {
        return { ok: false, reason: `invalid: d tag exceeds ${D_TAG_MAX_LEN} bytes` };
      }
    }
    if (INDEXED_TAGS.has(tag[0]) && tag[1]) indexedValues += 1;
  }
  if (indexedValues > MAX_INDEXED_TAG_VALUES) {
    return {
      ok: false,
      reason: `invalid: more than ${MAX_INDEXED_TAG_VALUES} indexed tag values`,
    };
  }

  // The `shared` tag, for the kinds it governs. Ingest refuses a malformed one
  // rather than reading it as "not shared": an author who wrote `["shared"]`
  // meant to share, and silently storing it private is a lie in the safe
  // direction that they have no way to notice.
  if (SHARED_GATED_KINDS.has(kind)) {
    const sharedTags = draft.tags.filter((t) => t[0] === "shared");
    if (sharedTags.length > 1) {
      return { ok: false, reason: "invalid: at most one shared tag" };
    }
    if (sharedTags.length === 1 && !eventIsShared(draft.tags)) {
      return { ok: false, reason: 'invalid: shared tag must be exactly ["shared","true"]' };
    }
  }

  if (REQUIRES_SINGLETON_D.has(kind)) {
    if (dTags !== 1 || !draft.tags.find((t) => t[0] === "d")?.[1]) {
      return { ok: false, reason: `invalid: kind ${kind} requires exactly one non-empty d tag` };
    }
  }

  // 13. The `h` contract. A channel-scoped kind without a channel has nowhere to
  //     be — it would be stored global and become readable by the whole
  //     community, which is the opposite of what a room message means.
  if (spec.scope === "required" && !draft.tags.find((t) => t[0] === "h")?.[1]) {
    return { ok: false, reason: "invalid: channel-scoped events must include an h tag" };
  }

  if (kind === 7 && [...draft.content].length > MAX_REACTION_EMOJI_CHARS) {
    return {
      ok: false,
      reason: `invalid: reaction exceeds ${MAX_REACTION_EMOJI_CHARS} characters`,
    };
  }

  return { ok: true, spec };
}
