# 06 — Protocol and backend semantics (Buzz parity spec)

Everything a client-side reimplementation must honour to be a *faithful* Nostr
event layer, not a Nostr-flavoured one. Read alongside `00-decisions.md` (D1/D2
fix the substrate: Convex tables, real BIP-340 signatures, signing inside the
mutation).

Source of truth for every claim below is the Buzz repo (`github.com/block/buzz`,
Apache 2.0). Citations are `path:symbol`.

Buzz's own layering, for orientation (`ARCHITECTURE.md` §1, §6):

| Crate | Owns |
|---|---|
| `buzz-core` | zero-I/O types: kind registry, event verification, filter matching, tenancy types |
| `buzz-db` | Postgres event store, replacement semantics, channels, tokens |
| `buzz-auth` | NIP-42, NIP-98, scopes, replay guard, rate-limit interface |
| `buzz-pubsub` | Redis topics, presence, cross-pod fan-out |
| `buzz-search` | Postgres FTS query side (index is a generated column) |
| `buzz-audit` | per-community SHA-256 hash chain |
| `buzz-relay` | the server: WS protocol, ingest pipeline, REQ/COUNT, HTTP bridge |

---

## 1. Event shape and identity

### 1.1 Wire shape

NIP-01, unchanged (`ARCHITECTURE.md` §2):

```json
{
  "id":         "<64-hex sha256 of the canonical serialization>",
  "pubkey":     "<64-hex secp256k1 x-only public key>",
  "created_at": 1735689600,
  "kind":       9,
  "tags":       [["h","<uuid>"], ["p","<64-hex>"], ...],
  "content":    "<string — plain text, or a JSON document, or NIP-44 ciphertext>",
  "sig":        "<128-hex BIP-340 Schnorr signature over id>"
}
```

`kind` is documented as `u32` in the registry (`crates/buzz-core/src/kind.rs`
module docs) but the underlying `nostr` crate v0.44 backs `Kind` with `u16`, and
`kind.rs` asserts at compile time that every Buzz constant fits
(`const _: () = assert!(KIND_AUTH <= u16::MAX as u32)`). Postgres stores `kind
INT` via `buzz_core::kind::event_kind_i32`. **Practical range: 0..=65535.**

### 1.2 Canonical serialization → `id`

Buzz does not implement this itself; it delegates to `nostr` v0.44
(`crates/buzz-core/src/verification.rs:verify_event` calls `event.verify_id()`
and re-derives with `EventId::new(pubkey, created_at, kind, tags, content)`).
The rule a reimplementation must match is NIP-01's:

```
id = sha256( utf8( JSON.stringify([
  0,
  <pubkey lowercase hex>,
  <created_at as a JSON number>,
  <kind as a JSON number>,
  <tags as an array of arrays of strings>,
  <content string>
]) ) )
```

Serialization rules that are load-bearing:

- **No whitespace anywhere** — no spaces after `,` or `:`.
- **Field order is positional**, exactly as above. It is an array, not an object.
- `created_at` and `kind` are **unquoted integers**.
- `tags` is serialized verbatim, preserving element order *and* the order of
  values inside each tag. Tags are never sorted, deduped, or normalized before
  hashing.
- **String escaping is the NIP-01 minimal set**: `\"` → `\"`, `\\` → `\\`,
  `\n` (0x0A) → `\n`, `\r` (0x0D) → `\r`, `\t` (0x09) → `\t`,
  backspace (0x08) → `\b`, form feed (0x0C) → `\f`. Every other character —
  including all other control characters and all non-ASCII — is emitted
  **literally as UTF-8**. Do *not* use `\uXXXX` escaping (JS `JSON.stringify`
  escapes ` `/` ` in some engines; that changes the id).
- The hash is over the **UTF-8 bytes** of that string.

`id` is the content address. Two events with identical fields have identical
ids, which is what makes `ON CONFLICT DO NOTHING` a correct dedup
(`crates/buzz-db/src/event.rs:insert_event`).

### 1.3 Signature

- Scheme: **secp256k1 Schnorr, BIP-340**, over the 32 raw bytes of `id` (not
  over the hex string, not over a second hash of it).
- `pubkey` is the **x-only** 32-byte public key, lowercase hex.
- `sig` is 64 bytes, lowercase hex (128 chars).
- BIP-340 permits deterministic auxiliary randomness; `00-decisions.md` D2
  relies on that to sign inside a Convex mutation. That is spec-legal and
  produces signatures any Nostr verifier accepts.

### 1.4 Verification (`crates/buzz-core/src/verification.rs:verify_event`)

Two independent checks, in this order:

1. `verify_id()` — recompute the canonical serialization and compare to `id`.
   Failure → `VerificationError::InvalidId { computed, got }`.
2. `verify_signature()` — BIP-340 verify. Failure → `InvalidSignature`.

**Both must run.** The test at `crates/buzz-core/src/event.rs:tampered_signature_fails_verify`
exists precisely because a tampered `sig` still passes `verify_id`, and a
tampered `content` still passes `verify_signature` if you only checked the id.
Verification is CPU-bound; Buzz always runs it on a blocking pool
(`spawn_blocking`) and never on the async task.

### 1.5 Relay-applied validation (`crates/buzz-relay/src/handlers/ingest.rs:ingest_event_inner`)

Applied in this order — order matters, because later checks assume earlier ones
passed:

| # | Check | Limit / rule | Rejection message |
|---|---|---|---|
| 1 | kind is `KIND_AUTH` (22242) | always rejected | `invalid: AUTH events cannot be submitted` |
| 2 | kind is 44100 / 44101 | relay-signed only | `invalid: membership notifications are relay-signed only` |
| 3 | HTTP transport + kind 1059 or 20001 | WS only | `invalid: kind {k} is only accepted via WebSocket` |
| 4 | `is_relay_only_kind(kind)` | 13534, 40901, 40902, 30622, 39005, 39006 | `restricted: relay-only kind` |
| 5 | **signature + id verification** | `verify_event` | `invalid: {err}` |
| 6 | timestamp drift | `MAX_TIMESTAMP_DRIFT_SECS = 900` (±15 min from server clock) | `invalid: event timestamp too far from server time` |
| 7 | content size | `MAX_EVENT_CONTENT_BYTES = 256 * 1024` (256 KB) | `invalid: content exceeds maximum size of …` |
| 8 | `event.pubkey == auth.pubkey` | **exempt for kind 1059** (gift wraps sign with an ephemeral key) | `invalid: event pubkey does not match authenticated identity` |
| 9 | scope for kind | `required_scope_for_kind` (§9.4); unknown kind → reject | `restricted: unknown event kind` / `restricted: insufficient scope (need …)` |
| 10 | channel-scoped token vs global kind | relay-admin (9030–9033) and 28936 need a global token | `restricted: … require a global token` |
| 11 | command routing | `is_command_kind` → `command_executor`; 42000 → feedback sidecar; 1984 → report queue; 9040–9044 → moderation | — |
| 12 | ban / timeout gate | durable `community_bans` check (9040–9044 routed *before* this so a timed-out admin can lift a timeout) | `blocked: …` / `restricted: you are timed out until …` |
| 13 | channel resolution + `h`-tag rules | §5.3 | `invalid: channel-scoped events must include an h tag` |
| 14 | membership | `check_channel_membership` (member OR open channel) | `restricted: not a channel member` |
| 15 | storage | insert / replace (§6) | — |

Other bounded validations worth mirroring:

- `d` tag ≤ **1024 bytes** (`crates/buzz-db/src/event.rs:D_TAG_MAX_LEN`).
- Reaction emoji ≤ **64 characters** (`ingest.rs`, `MAX_REACTION_EMOJI_CHARS`).
- `not_before` (kind 30300) must be a decimal integer string, no sign/whitespace/
  leading zero, `0..=9007199254740991`, at most one tag; horizon bounded by
  `SPROUT_MAX_NOT_BEFORE_DELTA` (default 1 year) — `ingest.rs:extract/validate not_before`,
  `docs/nips/NIP-ER.md`.
- SDK-side content caps (advisory, enforced by writers not the relay):
  kind 9 / 40002 / 40003 / 30620 ≤ 64 KiB, kind 40008 ≤ 60 KiB, kind 1617
  ≤ 60 KB (`crates/buzz-sdk/src/builders.rs:check_content`).
- NIP-MP project events: ≤ 64 members, name ≤ 256 B, description ≤ 2048 B,
  metadata tags ≤ 256 B, exactly-one singleton metadata tags
  (`ingest.rs:PROJECT_*`).
- NIP-44 ciphertext envelope: 132 ≤ len ≤ 87_472
  (`crates/buzz-core/src/observer.rs:content_looks_like_nip44`).

There is **no** tag-count cap and **no** proof-of-work requirement
(`nip11.rs: min_pow_difficulty: None`). The effective tag bound is the frame
size (§8.3).

---

## 2. Storage classes by kind range

`crates/buzz-core/src/kind.rs`:

| Range | Class | Predicate | Behaviour |
|---|---|---|---|
| 0, 3, 41, 10000–19999 | **replaceable** | `is_replaceable` | one row per `(community, kind, pubkey, channel_id)`; older soft-deleted |
| 20000–29999 | **ephemeral** | `is_ephemeral` | **never stored**, never audited, never searchable, never in REQ history |
| 30000–39999 | **parameterized replaceable** (addressable) | `is_parameterized_replaceable` | one row per `(community, kind, pubkey, d_tag)` |
| everything else | **regular** | — | append-only |

`is_replaceable` and `is_parameterized_replaceable` are proven disjoint over the
whole `0..=65535` space by a test (`kind.rs:replaceable_and_parameterized_are_disjoint`).

Cross-cutting kind sets (all in `kind.rs`), which the read path consults:

| Set | Members | Meaning |
|---|---|---|
| `AUTHOR_ONLY_KINDS` | 30300, 30350 | readable only by the author — existence, count, tags, schedule and FTS matches must not leak |
| `P_GATED_KINDS` | 24200, 44100, 44101, 1059, 30622, 44200 | readable only by a pubkey named in the event's `#p` |
| `RESULT_GATED_KINDS` | 30622, 44200 | per-event `#p` check even on a kindless `{ids:[…]}` lookup |
| `SHARED_GATED_KINDS` | 30175, 30178 | author-only **unless** the event carries exactly `["shared","true"]` |
| relay-only (`is_relay_only_kind`) | 13534, 40901, 40902, 30622, 39005, 39006 | client submission rejected |
| commands (`is_command_kind`) | 30620, 41010, 41011, 41012, 46020, 46030, 46031 | executed transactionally, not stored as ordinary events |
| moderation (`is_moderation_command_kind`) | 9040–9044 | validated + executed, never stored, always audited |
| relay admin (`is_relay_admin_kind`) | 9030–9033 | global-only; require a non-channel-scoped token |
| workflow execution (`is_workflow_execution_kind`) | 46001–46012 | excluded from triggering workflows (loop guard) |

---

## 3. The complete kind registry

Every constant in `crates/buzz-core/src/kind.rs`, in numeric order. "Class" is
R = regular, RP = replaceable, PR = parameterized-replaceable, E = ephemeral
(never stored), X = never stored for another reason (command/sidecar/auth).
"Scope" is the channel binding: **h** = requires an `h` tag,
**G** = forced global (`channel_id = NULL` even if an `h` tag is present),
**derived** = channel resolved from the target event, **—** = optional/other.

### 3.1 Standard NIP kinds

| Kind | Name | Meaning | Class | Scope | Tags | `content` |
|---|---|---|---|---|---|---|
| 0 | `KIND_PROFILE` | NIP-01 user metadata; synced into `users` (display_name, avatar, about, nip05) | RP | G | none required | JSON object: `{display_name?, name?, picture?, about?, nip05?}` (`buzz-sdk/src/builders.rs:build_profile`). NIP-05 handle must canonicalize to the relay's domain or it is silently cleared |
| 1 | `KIND_TEXT_NOTE` | global social note | R | G | optional `["e",<id>,"","reply"]` | plain text |
| 3 | `KIND_CONTACT_LIST` | NIP-02 follow list; full replacement, read-before-write for deltas | RP | G | `["p",<64hex>,<relay|"">,<petname|"">]` × N (max `MAX_CONTACTS`, deduped, lowercased) | `""` |
| 5 | `KIND_DELETION` | NIP-09 deletion request. Self-authored only (or by the NIP-OA owner of an agent). Admin deletion is 9005 | R | derived (from `#e` target); `h` optional | `["e",<id>]` × N **or** one `["a","<kind>:<pubkey>:<d>"]` | free-text reason |
| 7 | `KIND_REACTION` | NIP-25 reaction | R | **derived from the `#e` target — a client `h` tag is ignored for channel determination**; unknown target ⇒ reject | `["e",<target>]` (last one wins), optional NIP-30 `["emoji",<shortcode>,<url>]` | emoji char, or `+`/`-`, or `:shortcode:`; ≤64 chars |
| 9 | `KIND_STREAM_MESSAGE` | NIP-29 group chat message — the primary message kind. Convention: owner sends content `"!shutdown"` with `#p` = agent to stop an agent | R | **h required** | `["h",<uuid>]`; NIP-10 `e` markers; `["p",…]` mentions (≤50, deduped); `["broadcast","1"]`; `["imeta", …]` | plain text ≤64 KiB |
| 41 | `KIND_CHANNEL_METADATA` | NIP-01 channel metadata | RP | — | — | **Registered but unused by Buzz** |
| 1059 | `KIND_GIFT_WRAP` | NIP-17 private DM envelope. Signed with an **ephemeral** key, so the pubkey≠auth-pubkey check is waived. WS only | R | G | `["p",<recipient>]` | NIP-44 ciphertext. **Excluded from FTS** |
| 1063 | `KIND_FILE_METADATA` | NIP-94 file attachment metadata | R | — | NIP-94 tags | NIP-94 |
| 1617 | `KIND_GIT_PATCH` | NIP-34 patch | R | G | `["a",<repo coord>]`, `["r",<euc>]`, `["p",…]`, `["e",<prev>,"","reply"]`, `["t","root"\|"root-revision"]`, `["commit",…]`, `["parent-commit",…]`, `["committer",name,email,ts,tzoffset]` | verbatim `git format-patch` output |
| 1618 | `KIND_GIT_PULL_REQUEST` | NIP-34 pull request (points at a branch tip) | R | G | `["a",…]`, `["subject",…]`, `["c",<tip>]`, `["clone",<url>…]`, `["branch-name",…]`, `["merge-base",…]`, `["t",<label>]`, `["h",<channel>]` (metadata only) | markdown description |
| 1619 | `KIND_GIT_PR_UPDATE` | NIP-34 PR tip change | R | G | NIP-22 roots `["E",<pr id>]`, `["P",<pr author>]`, `["c",<tip>]`, `["clone",…]`, `["merge-base",…]` | optional markdown |
| 1621 | `KIND_GIT_ISSUE` | NIP-34 issue | R | G | `["a",…]`, `["t",<label>]`, `["p",…]` | markdown body |
| 1630 | `KIND_GIT_STATUS_OPEN` | NIP-34 status: open | R | G | `["e",<root>,"","root"]`, optional `["e",<revision>,"","reply"]`, `["a",…]`, `["r",<euc>]`, `["p",…]` | optional markdown |
| 1631 | `KIND_GIT_STATUS_MERGED` | applied/merged (patch) or resolved (issue) | R | G | as 1630 plus `["q",<id>,<relay?>,<pubkey?>]`, `["merge-commit",…]`, `["applied-as-commit",…]` | optional markdown |
| 1632 | `KIND_GIT_STATUS_CLOSED` | closed | R | G | as 1630 | optional markdown |
| 1633 | `KIND_GIT_STATUS_DRAFT` | draft | R | G | as 1630 | optional markdown |
| 1984 | `KIND_REPORT` | NIP-56 report of an event / pubkey / blob | X (sidecar) | — | `["e",…]` or `["p",…]`, report type | free text note. **Persisted to `moderation_reports` only** — never stored as an event, never fanned out. Reports are signals, never triggers |
| 10000 | `KIND_MUTE_LIST` | NIP-51 mute list | RP | G | NIP-51 | NIP-51 (may be NIP-44 encrypted) |
| 10001 | `KIND_PIN_LIST` | NIP-51 pinned events | RP | G | `["e",…]` | NIP-51 |
| 10002 | `KIND_NIP65_RELAY_LIST_METADATA` | NIP-65 outbox relay list | RP | G | `["r",<url>]` / `["r",<url>,"read"\|"write"]` | `""` |
| 10003 | `KIND_BOOKMARK_LIST` | NIP-51 bookmarks | RP | G | NIP-51 | NIP-51 |
| 10030 | `KIND_EMOJI_LIST` | NIP-51 preferred emoji + pointers to emoji sets | RP | G | `["emoji",…]`, `["a",…]` | `""` |
| 22242 | `KIND_AUTH` | NIP-42 auth response | X | — | `["challenge",…]`, `["relay",<url>]` | `""`. **Never stored, never audited, never logged** |
| 27235 | `KIND_HTTP_AUTH` | NIP-98 HTTP auth event | X | — | `["u",<url>]`, `["method",…]`, optional `["payload",<sha256 hex>]` | `""` |
| 30023 | `KIND_LONG_FORM` | NIP-23 long-form article | PR | G | `["d",<slug>]` + NIP-23 metadata | markdown |
| 30315 | `KIND_USER_STATUS` | NIP-38 user status | PR | G | `["d","general"]` (or `music`/custom), optional `["emoji",…]` | status text (empty + no emoji clears) |

### 3.2 NIP-29 group management (Buzz's channel model)

| Kind | Name | Meaning | Class | Scope | Tags | `content` |
|---|---|---|---|---|---|---|
| 9000 | `KIND_NIP29_PUT_USER` | add a user to a channel. Open channel: anyone, subject to the target's `channel_add_policy` (`anyone`/`owner_only`/`nobody`). Private: owner/admin only. Self-add bypasses agent policy but not private-channel authz | R | h required | `["h",<uuid>]`, `["p",<target>]`, optional `["role","owner"\|"admin"\|"member"\|"guest"\|"bot"]` | `""` |
| 9001 | `KIND_NIP29_REMOVE_USER` | remove a member. Self-remove allowed; **last-owner guard** refuses orphaning | R | h required | `["h",…]`, `["p",…]` | `""` |
| 9002 | `KIND_NIP29_EDIT_METADATA` | edit channel metadata. `name`/`about`/`visibility`/`archived`/`ttl` → owner/admin (`archived` needs `AdminChannels`); `topic`/`purpose` → any member | R | h required | `["h",…]` + any of `["name",…]`, `["about",…]`, `["visibility","open"\|"private"]`, `["topic",…]`, `["purpose",…]`, `["archived","true"\|"false"]`, `["ttl",<secs or "">]` | `""` |
| 9005 | `KIND_NIP29_DELETE_EVENT` | moderator delete of another member's event. Author may always delete their own; otherwise owner/admin. Target must be in the same channel | R | h required | `["h",…]`, `["e",<target>]`, optional `["action-id",<uuid>]`, `["reason-code",…]`, `["public-reason",…]` | `""` |
| 9007 | `KIND_NIP29_CREATE_GROUP` | create a channel | R | creates the channel (h optional: a client-chosen UUID may be supplied) | `["name",…]`, optional `["visibility","open"\|"private"]`, `["channel_type","stream"\|"forum"\|"dm"\|"workflow"]`, `["ttl",<secs>]` | `""` |
| 9008 | `KIND_NIP29_DELETE_GROUP` | delete a channel. Owner only | R | h required | `["h",…]` | `""` |
| 9009 | `KIND_NIP29_CREATE_INVITE` | create a channel invite | R | h | `["h",…]` | `""`. **Accepted and stored, side-effect handler is a logged no-op** |
| 9021 | `KIND_NIP29_JOIN_REQUEST` | join an **open** channel (private ⇒ rejected at ingest). Adds the member, emits a system message, group-discovery events and a 44100 | R | h required | `["h",…]` | `""` |
| 9022 | `KIND_NIP29_LEAVE_REQUEST` | leave a channel. Last-owner guard applies | R | h required | `["h",…]` | `""` |
| 39000 | `KIND_NIP29_GROUP_METADATA` | **relay-signed** addressable channel metadata | PR | stored channel-scoped | `["d",<channel uuid>]`, `["name",…]`, `["closed"]` (always), `["public"]` or `["private"]`, `["t",<channel_type>]`; `["about",…]` if description non-empty; `["hidden"]` + `["p",…]` per participant for DMs; `["topic",…]`, `["purpose",…]`, `["archived","true"]`, `["ttl",…]`, `["ttl_deadline",<rfc3339>]` when set | `""` |
| 39001 | `KIND_NIP29_GROUP_ADMINS` | relay-signed admin roster | PR | channel-scoped | `["d",<channel uuid>]`, `["p",<pubkey>,"owner"\|"admin"]` × N | `""` |
| 39002 | `KIND_NIP29_GROUP_MEMBERS` | relay-signed member roster. `get_channels` resolves a user's channels from the `d` tag of *their* 39002 events | PR | channel-scoped | `["d",<channel uuid>]`, `["p",<pubkey>]` × N | `""` |
| 39003 | `KIND_NIP29_GROUP_ROLES` | role definitions | PR | — | `["d",…]` | **Defined but never emitted by the relay** |

Because 39000–39002 are stored *channel-scoped*, live global subscriptions never
receive them via fan-out; clients discover groups with a historical REQ
(`NOSTR.md` § Group Discovery).

### 3.3 NIP-43 relay membership, NIP-IA identity archival, moderation

| Kind | Name | Meaning | Class | Scope | Tags | `content` |
|---|---|---|---|---|---|---|
| 8000 | `KIND_NIP43_MEMBER_ADDED` | relay-signed member-added delta | R | G | `["p",…]`, `["role",…]` | — (in-process publish only; the CLI deliberately does not emit deltas) |
| 8001 | `KIND_NIP43_MEMBER_REMOVED` | relay-signed member-removed delta | R | G | `["p",…]` | — |
| 8002 | `KIND_IA_ARCHIVED` | NIP-IA archived-identity delta (relay-signed) | R | G | `["p",<archived>]`, consent metadata | see `docs/nips/NIP-IA.md` |
| 8003 | `KIND_IA_UNARCHIVED` | NIP-IA unarchived delta (relay-signed) | R | G | `["p",…]` | see NIP-IA |
| 9030 | `RELAY_ADMIN_ADD_MEMBER` | add a pubkey to the relay member list. Owner/admin only; **requires a global (non-channel-scoped) token** | X (command) | G | `["p",<64hex>]`, optional `["role","member"\|"admin"]` | `""` |
| 9031 | `RELAY_ADMIN_REMOVE_MEMBER` | remove a relay member; optional `role` acts as a guard | X | G | `["p",…]`, optional `["role",…]` | `""` |
| 9032 | `RELAY_ADMIN_CHANGE_ROLE` | change a relay member's role | X | G | `["p",…]`, `["role",…]` | `""` |
| 9033 | `RELAY_ADMIN_SET_WORKSPACE_PROFILE` | set the community icon, served as NIP-11 `icon` | X | G | `["icon",<https or data: URL>]` (empty clears) | `""` |
| 9035 | `KIND_IA_ARCHIVE_REQUEST` | request archival of an identity. Consent paths: `self`, `owner` (NIP-OA owner of an agent), `admin` | X (command) | G | `["p",<target>]`, reason / replacement metadata | see NIP-IA |
| 9036 | `KIND_IA_UNARCHIVE_REQUEST` | request unarchival | X | G | `["p",…]` | see NIP-IA |
| 9040 | `KIND_MODERATION_BAN` | ban a pubkey from the community (blocks connection auth, cascades from a NIP-OA owner to their agents) | X (command; audited) | G | `["p",<target>]`, optional `["expiration",<unix>]`, `["reason",…]` | `""` |
| 9041 | `KIND_MODERATION_UNBAN` | lift a ban | X | G | `["p",…]` | `""` |
| 9042 | `KIND_MODERATION_TIMEOUT` | write-block until `expiration` | X | G | `["p",…]`, `["expiration",<unix>]`, optional `["reason",…]` | `""` |
| 9043 | `KIND_MODERATION_UNTIMEOUT` | clear a timeout early | X | G | `["p",…]` | `""` |
| 9044 | `KIND_MODERATION_RESOLVE_REPORT` | resolve a 1984 report | X | G | `["report",<event id hex>]`, `["status","resolved"\|"dismissed"]`, `["action","delete"\|"kick"\|"ban"\|"timeout"\|"dismiss"\|"escalate"]` | `""` |
| 13534 | `KIND_NIP43_MEMBERSHIP_LIST` | relay-signed roster snapshot, republished after every membership change. **Relay-only** | RP (by convention) | G | `["p",<pubkey>,<role>]` × N | `""` |
| 13535 | `KIND_IA_ARCHIVED_LIST` | relay-signed archived-identities snapshot | RP | G | `["p",…]` × N | `""` |
| 28936 | `KIND_NIP43_LEAVE_REQUEST` | user-signed leave-the-relay request. Global-token only | E (20000–29999) | G | — | `""` |

### 3.4 Ephemeral kinds (20000–29999 — never stored)

| Kind | Name | Meaning | Delivery | Tags | `content` |
|---|---|---|---|---|---|
| 20001 | `KIND_PRESENCE_UPDATE` | presence heartbeat | verify → Redis `SET` presence (or `DEL` on `"offline"`) → **local fan-out only** (no Redis PUBLISH; multi-node presence fan-out is unimplemented) | `["status",<s>]` | status string, also read from `content`; arbitrary string truncated to 128 chars on the WS path; the structured REST/MCP surface accepts only `online`/`away`/`offline` (`buzz-core/src/presence.rs`) |
| 20002 | `KIND_TYPING_INDICATOR` | typing indicator for a channel | verify → membership → mark-local → Redis PUBLISH → local fan-out (**is** multi-node) | `["h",<uuid>]` | — |
| 24134 | `KIND_PAIRING` | NIP-AB device pairing (served by the separate `buzz-pair-relay`) | ephemeral, may be discarded after delivery | — | pairing payload |
| 24200 | `KIND_AGENT_OBSERVER_FRAME` | NIP-AO owner-scoped encrypted agent telemetry / control | ephemeral; **p-gated** | `["p",<owner>]`, `["agent",<agent pubkey>]`, `["frame","telemetry"\|"control"]` | NIP-44 v2 ciphertext, 132..=87472 bytes; plaintext JSON ≤65535 bytes |
| 24242 | `KIND_BLOSSOM_AUTH` | BUD-01 upload auth | used by `/media/upload`, not stored | BUD tags | — |
| 24243 | `KIND_NOSTR_IDENTITY_BINDING` | Buzz one-time identity-binding proof | not stored | — | — |
| 24810 | `KIND_HUDDLE_REACTION` | emoji burst inside a huddle | ephemeral, channel-scoped to the huddle channel | `["h",<ephemeral channel>]` | emoji |
| 28936 | `KIND_NIP43_LEAVE_REQUEST` | user-signed "leave this relay" request — see §3.3 | ephemeral; global-token only | — | `""` |

### 3.5 Buzz messaging kinds (40000–40999)

| Kind | Name | Meaning | Class | Scope | Tags | `content` |
|---|---|---|---|---|---|---|
| 40002 | `KIND_STREAM_MESSAGE_V2` | rich-content message (Buzz-only; no third-party NIP-29 client renders it) | R | h required | as kind 9 | rich text ≤64 KiB |
| 40003 | `KIND_STREAM_MESSAGE_EDIT` | edit of an existing message | R | h required | `["h",…]`, `["e",<target>]` | the new content |
| 40004 | `KIND_STREAM_MESSAGE_PINNED` | pin a message | R | h required | `["h",…]`, `["e",<target>]` | — |
| 40005 | `KIND_STREAM_MESSAGE_BOOKMARKED` | bookmark a message | R | h required | `["h",…]`, `["e",…]` | — |
| 40006 | `KIND_STREAM_MESSAGE_SCHEDULED` | message scheduled for future delivery | R | h required | `["h",…]` | — |
| 40007 | `KIND_STREAM_REMINDER` | reminder attached to a message or time. **In the NIP-PL push allowlist** | R | h required | `["h",…]`, `["e",…]` | — |
| 40008 | `KIND_STREAM_MESSAGE_DIFF` | unified-diff message | R | h required | `["h",…]`, `["repo",<http(s) url>]`, `["commit",<≥7 hex>]`, optional `["file",…]`, `["parent-commit",…]`, `["branch",<src>,<tgt>]`, `["pr",<n>]`, `["l",<language>]`, `["description",…]`, `["truncated","true"]`, `["alt",…]`, NIP-10 `e` markers | unified diff ≤60 KiB |
| 40099 | `KIND_SYSTEM_MESSAGE` | relay-signed channel state change | R | channel-scoped | `["h",<uuid>]` | JSON: `{"type":"member_joined"\|"member_left"\|"member_removed"\|…, "actor":<hex>, "target":<hex>}` |
| 40100 | `KIND_CANVAS` | shared document for a channel | R | h required | `["h",…]` | document body |
| 40901 | `KIND_CHANNEL_SUMMARY` | relay-signed channel metadata sidecar with computed fields | **relay-only** | — | — | — |
| 40902 | `KIND_PRESENCE_SNAPSHOT` | relay-signed bulk presence sidecar | **relay-only** | — | — | — |

### 3.6 DMs (41000–41999) and product feedback

| Kind | Name | Meaning | Class | Scope | Tags | `content` |
|---|---|---|---|---|---|---|
| 41001 | `KIND_DM_CREATED` | a DM conversation was created | R | — | — | — |
| 41010 | `KIND_DM_OPEN` | open/create (or re-open) a DM. 1–8 participants | X (command) | G | `["p",<64hex>]` × 1..8 | `""` |
| 41011 | `KIND_DM_ADD_MEMBER` | add a member to a group DM | X (command) | h | `["h",<uuid>]`, `["p",…]` | `""` |
| 41012 | `KIND_DM_HIDE` | hide a DM from the sidebar (membership unchanged) | X (command) | h | `["h",…]` | `""` |
| 42000 | `KIND_PRODUCT_FEEDBACK` | Buzz product feedback | X (sidecar) | G | optional category/tags | body text; row lands in `product_feedback`, never in `events`, never fanned out |

DM creation additionally emits a 39000 (with `hidden`) plus 44100 notifications
so NIP-29 clients discover DMs through the ordinary group-discovery flow.

### 3.7 Agent job protocol (43000–43999)

Deliberately **not** NIP-90 (5000–6999) — Buzz requires auth chains
(depth ≤ 3, breadth ≤ 10). These kinds are registered and appear in feed
queries (`crates/buzz-db/src/feed.rs`); no dedicated ingest handler exists, so
they travel as ordinary regular events.

| Kind | Name | Meaning | Class |
|---|---|---|---|
| 43001 | `KIND_JOB_REQUEST` | an agent job was requested | R |
| 43002 | `KIND_JOB_ACCEPTED` | an agent accepted a job | R |
| 43003 | `KIND_JOB_PROGRESS` | progress update | R |
| 43004 | `KIND_JOB_RESULT` | final result | R |
| 43005 | `KIND_JOB_CANCEL` | cancellation requested | R |
| 43006 | `KIND_JOB_ERROR` | job failed | R |

### 3.8 Notifications, metrics, forum (44000–45999)

| Kind | Name | Meaning | Class | Scope | Tags | `content` |
|---|---|---|---|---|---|---|
| 44100 | `KIND_MEMBER_ADDED_NOTIFICATION` | **relay-signed**: target pubkey was added to a channel. Stored community-globally so agents can subscribe without knowing channel UUIDs. Client submission rejected. **p-gated**, **excluded from FTS** | R | G (h tag is metadata) | `["p",<target>]`, `["h",<channel uuid>]` | JSON `{"type":"member_added","channel_id":<uuid>,"actor":<hex>}` |
| 44101 | `KIND_MEMBER_REMOVED_NOTIFICATION` | relay-signed member-removed notice; same shape | R | G | `["p",…]`, `["h",…]` | JSON `{"type":"member_removed",…}` |
| 44200 | `KIND_AGENT_TURN_METRIC` | NIP-AM durable per-turn token/cost record, one per completed turn, encrypted to the owner. Append-only, never replaced. **p-gated + result-gated + excluded from FTS.** Even the authoring agent cannot read it back — owner-only | R | G (**no `h` tag by design** — channel identity is inside the ciphertext) | exactly one `["p",<owner>]` and exactly one `["agent",<agent pubkey == event pubkey>]` | NIP-44 v2 ciphertext of the metric payload |
| 45001 | `KIND_FORUM_POST` | forum thread root | R | h required | `["h",…]`, `["p",…]` mentions, `["imeta",…]` | text ≤64 KiB |
| 45002 | `KIND_FORUM_VOTE` | vote on a forum post | R | h required | `["h",…]`, `["e",<post>]` | `"+"` or `"-"` |
| 45003 | `KIND_FORUM_COMMENT` | forum reply | R | h required | `["h",…]`, NIP-10 `e` markers, `["p",…]`, `["imeta",…]` | text ≤64 KiB |

### 3.9 Workflow engine (46000–46999)

`46001–46012` are execution events: they are **excluded from triggering
workflows** (`is_workflow_execution_kind`) so a workflow cannot loop. Also
excluded from triggering: relay-signed messages carrying a `buzz:workflow` tag,
and kind 1059.

| Kind | Name | Meaning | Class | Scope | Tags | `content` |
|---|---|---|---|---|---|---|
| 30620 | `KIND_WORKFLOW_DEF` | workflow definition (create or update — same `d` replaces) | PR (command) | h required for authorization | `["d",<workflow uuid>]`, `["h",<channel uuid>]` | workflow YAML ≤64 KiB |
| 46001 | `KIND_WORKFLOW_TRIGGERED` | a workflow was triggered | R | channel | — | run context |
| 46002 | `KIND_WORKFLOW_STEP_STARTED` | step began | R | channel | — | step context |
| 46003 | `KIND_WORKFLOW_STEP_COMPLETED` | step succeeded | R | channel | — | step output |
| 46004 | `KIND_WORKFLOW_STEP_FAILED` | step failed | R | channel | — | error |
| 46005 | `KIND_WORKFLOW_COMPLETED` | workflow finished | R | channel | — | — |
| 46006 | `KIND_WORKFLOW_FAILED` | workflow failed | R | channel | — | error |
| 46007 | `KIND_WORKFLOW_CANCELLED` | cancelled before completion | R | channel | — | — |
| 46010 | `KIND_WORKFLOW_APPROVAL_REQUESTED` | a step is waiting for human approval. **In the NIP-PL push allowlist** | R | channel | — | approval context |
| 46011 | `KIND_WORKFLOW_APPROVAL_GRANTED` | approval granted | R | channel | — | — |
| 46012 | `KIND_WORKFLOW_APPROVAL_DENIED` | approval denied | R | channel | — | — |
| 46020 | `KIND_WORKFLOW_TRIGGER` | manually trigger a workflow | X (command) | — | `["d",<workflow uuid>]` | `""` |
| 46030 | `KIND_APPROVAL_GRANT` | grant a pending approval | X (command) | — | `["d",<64-hex SHA-256 of the approval token>]` | optional note |
| 46031 | `KIND_APPROVAL_DENY` | deny a pending approval | X (command) | — | `["d",<64-hex token hash>]` | optional note |

### 3.10 System, huddle, media (48000–49999)

| Kind | Name | Meaning | Class | Scope | Tags | `content` |
|---|---|---|---|---|---|---|
| 48001 | `KIND_AUDIT_ENTRY` | an audit entry was recorded | R | — | — | — |
| 48100 | `KIND_HUDDLE_STARTED` | a huddle began (emitted by the desktop client). Its content links the parent channel to the ephemeral huddle channel; the relay verifies the link is creator-signed | R | h required (parent channel) | `["h",<parent channel>]` | JSON `{"ephemeral_channel_id":"<uuid>"}`, ≤512 bytes for the link lookup |
| 48101 | `KIND_HUDDLE_PARTICIPANT_JOINED` | relay-signed on audio join | R | h (parent channel) | `["h",<parent>]`, `["p",<participant>]` | JSON `{"ephemeral_channel_id":"<uuid>"}` |
| 48102 | `KIND_HUDDLE_PARTICIPANT_LEFT` | participant left | R | h (parent) | `["h",…]`, `["p",…]` | same shape |
| 48103 | `KIND_HUDDLE_ENDED` | relay-signed when the last peer leaves; the ephemeral channel archives atomically | R | h (parent) | `["h",…]`, `["p",…]` | same shape |
| 48106 | `KIND_HUDDLE_GUIDELINES` | huddle channel guidelines document (client-emitted) | R | h required | `["h",…]` | guidelines text |
| 49001 | `KIND_MEDIA_UPLOAD` | **internal** kind for media-upload audit entries. Not a relay event kind — never submitted, never stored in `events` | — | — | — | — |

### 3.11 Buzz-defined NIP extensions (agent / device / infrastructure)

| Kind | Name | NIP | Meaning | Class | Scope | Tags | `content` |
|---|---|---|---|---|---|---|---|
| 10100 | `KIND_AGENT_PROFILE` | — | agent metadata + owner reference, agent-authored | RP | G | owner reference | agent profile JSON |
| 30000 | `KIND_FOLLOW_SET` | NIP-51 | named curated follow list | PR | G | `["d",<name>]`, `["p",…]` | NIP-51 |
| 30003 | `KIND_BOOKMARK_SET` | NIP-51 | named bookmark collection. **Also carries Buzz mesh status** at `d = "buzz-mesh-member-status:<…>"` with `["k","buzz-mesh-status"]` — a 45-second heartbeat whose superseded payload is **hard-deleted** (see §6.3) | PR | G | `["d",…]`; mesh variant adds `["k","buzz-mesh-status"]` | NIP-51 / mesh status JSON |
| 30030 | `KIND_EMOJI_SET` | NIP-30/51 | a member's own custom emoji set; the workspace palette is the **client-side union** of every member's set, deduped by `(shortcode, url)`. Buzz's own d-tag is `"buzz:custom-emoji"` | PR | G | `["d",…]`, `["emoji",<shortcode lowercased>,<url>]` × N | `""` |
| 30078 | `KIND_READ_STATE` | NIP-78 / NIP-RS | per-client read position for cross-device sync | PR | G | `["d","read-state:<32 lowercase hex>"]` (exactly one `d`), exactly one `["t","read-state"]` | **NIP-44 encrypted to the author's own key.** Superseded payloads are hard-deleted and replaced by an ordering watermark (§6.3) |
| 30174 | `KIND_AGENT_ENGRAM` | NIP-AE | encrypted agent memory record, one per `(agent, owner)` slug | PR | G | `["d",<64-hex HMAC>]`, `["p",<owner>]` | NIP-44 ciphertext (conversation key). `d = hex(HMAC-SHA256(K_c, "agent-memory/v1/d-tag" ‖ 0x00 ‖ slug))`; the slug is never in a tag. Read gate: `authors=[self]` **or** `#p=[self]` |
| 30175 | `KIND_PERSONA` | NIP-AP | agent persona definition (system prompt, model, runtime), owner-authored | PR | G | exactly one non-empty `["d",<persona slug>]`; optional `["shared","true"]` (**exactly 2 elements**, at most one, value exactly `"true"` — ingest rejects any other shape); optional `["alt",…]` | plaintext JSON `{display_name, system_prompt, avatar_url, runtime, model, provider, name_pool, …}`. **shared-gated**: author-only unless `["shared","true"]` |
| 30176 | `KIND_TEAM` | NIP-AP | a team = a named grouping of personas, owner-authored | PR | G | `["d",<team id>]` | JSON `{name, description, persona_ids}`. **Deliberately NOT shared-gated** (its writers never emit `shared`) |
| 30177 | `KIND_MANAGED_AGENT` | NIP-AP | managed-agent definition | PR | G | `["d",<agent pubkey>]` | explicit opt-**in** allowlist projection. MUST never carry the agent's secret key, NIP-OA auth tag, env vars, or runtime fields — these events are world-readable |
| 30178 | `KIND_TEAM_CATALOG` | NIP-AP | shareable projection of a team with **embedded** member projections (so a foreign reader can hydrate members whose 30175 is private) | PR | G | exactly one non-empty bounded `["d",<team id>]` (may contain `:`, e.g. `builtin-team:welcome`), optional `["shared","true"]` | versioned sanitized JSON: no env vars, no `respond_to` pubkeys, no local ids, no paths, no secrets. **shared-gated** |
| 30300 | `KIND_EVENT_REMINDER` | NIP-ER | encrypted author-only reminder | PR | G | `["d",<random ≥128-bit id>]` (exactly one), `["not_before",<unix secs>]` (at most one; omitted for bookmarks/terminal states), `["alt","Encrypted reminder"]` | NIP-44 to self: target, note, status (`pending`/`done`/`cancelled`). **author-only + excluded from FTS** |
| 30350 | `KIND_PUSH_LEASE` | NIP-PL | encrypted push lease (endpoint-bearing) | PR | G | `["d",…]` | NIP-44 ciphertext. **author-only.** Effective state lives in `push_leases` |
| 30617 | `KIND_GIT_REPO_ANNOUNCEMENT` | NIP-34 | repository announcement / update | PR | G | `["d",<repo-id: `[A-Za-z0-9._-]{1,64}`, no leading dot, no `..`>]`, `["name",…]`, `["description",…]`, `["clone",<url>…]`, `["web",…]`, `["relays",…]`, `["r",<euc>]`, `["maintainers",…]` | — |
| 30618 | `KIND_GIT_REPO_STATE` | NIP-34 | current branch/tag refs | PR | G | `["d",<repo-id>]`, ref tags | — |
| 30621 | `KIND_PROJECT` | NIP-MP | multi-repo project: a named grouping of 30617 announcements, possibly across owners. **The signer gains no authority over any member repo** — push policy always reads the repository's own announcement | PR | G | `["d",<project slug>]`, `["a","30617:<lowercase 64-hex owner>:<repo-d>"]` × ≤64 (no duplicates), singleton `["name"]`/`["description"]`/`["buzz-channel"]`/`["buzz-visibility"]` | — |
| 30622 | `KIND_DM_VISIBILITY` | NIP-DV | **relay-signed** per-viewer snapshot of hidden DMs, republished on every hide/unhide | PR | G | `["d",<viewer pubkey hex>]`, `["p",<viewer>]`, one `["h",<channel uuid>]` per hidden DM | `""`. **relay-only + p-gated + result-gated + excluded from FTS** |
| 39005 | `KIND_THREAD_SUMMARY` | — | relay-signed thread rollup overlay, synthesized at query time and also pushed live | PR (**never stored**) | channel | `["e",<root id>]`, `["d",<root id>]`, `["h",<channel>]` | JSON `{"reply_count":n,"descendant_count":n,"last_reply_at":<unix|null>,"participants":[<hex>…]}` |
| 39006 | `KIND_WINDOW_BOUNDS` | — | relay-signed pagination-exhaustion overlay. **The only authority on `has_more`** — clients must not infer it from row counts | PR (never stored) | — | `["d","<channel_id>:<cursor-or-head>"]` | JSON `{"has_more":bool,"next_cursor":<…>}` |

---

## 4. Tag conventions

Tags are `string[]` with a non-empty first element (the tag name). Single-letter
lowercase names are the indexed/filterable ones (`#e`, `#p`, `#h`, `#d`, `#a`,
`#t`, `#r`, `#l`, `#c`, `#q`, `#u`, `#E`, `#P`).

| Tag | Positional shape | Semantics |
|---|---|---|
| `e` | `["e", <64-hex event id>]` or `["e", <id>, <relay-url or "">, <marker>]` | reference to an event. Markers: `"root"`, `"reply"`, `"mention"`. Buzz reads position 3 for the marker and requires position 1 to be exactly 64 hex chars (`ingest.rs:resolve_nip10_thread_meta`). Direct reply to a root: one `["e",<root>,"","reply"]`. Nested reply: `["e",<root>,"","root"]` + `["e",<parent>,"","reply"]` (`buzz-sdk:thread_tags`) |
| `p` | `["p", <64-hex pubkey>]`, or `["p", <pubkey>, <relay>, <petname>]` (kind 3), or `["p", <pubkey>, <role>]` (kind 39001) | mention / recipient / target. **`p` is also the read-authorization key for `P_GATED_KINDS`.** Denormalized into `event_mentions` at write time |
| `h` | `["h", <channel UUID>]` | NIP-29 group tag — **the channel scope**. Buzz uses UUIDs, not group ids. Required by §5.3 kinds, forced to nothing on global-only kinds |
| `d` | `["d", <identifier>]` | NIP-33 addressable identifier. Missing `d` on a 30000–39999 kind maps to the **empty string**, not to "no coordinate" (`buzz-db/src/event.rs:extract_d_tag`) — so an event without a `d` collapses into the `""` slot. Some kinds (30175, 30178, 30300, 30078) reject missing/duplicate `d` at ingest. Max 1024 bytes |
| `a` | `["a", "<kind>:<pubkey-hex>:<d-tag>"]` | addressable-event coordinate. Used by kind 5 (coordinate deletion), NIP-34 repo references, NIP-MP project members. Buzz splits with `splitn(3, ':')` so a `d` containing `:` is preserved. **The owner segment must be lowercase hex** (NIP-MP), or the head becomes invisible to lowercase-coordinate queries |
| `t` | `["t", <label>]` | hashtag / label. Also carries the channel type on 39000 (`["t","stream"]`) and `["t","read-state"]` on 30078, `["t","root"]`/`["t","root-revision"]` on git patches |
| `r` | `["r", <url>]`, `["r", <url>, "read"\|"write"]` (NIP-65), `["r", <euc>]` (NIP-34) | relay / reference |
| `k` | `["k", "buzz-mesh-status"]` | Buzz mesh-status discriminator on kind 30003 |
| `shared` | `["shared", "true"]` | **exactly two elements, at most one occurrence, value exactly `"true"`.** Opts a `SHARED_GATED_KINDS` event into community reads. Any other shape fails closed (`kind.rs:event_is_shared`). It is a *tag*, not a content field, so toggling sharing does not change content bytes or any content hash |
| `role` | `["role", "owner"\|"admin"\|"member"\|"guest"\|"bot"]` | membership role on 9000 / 9030 / 9032 |
| `broadcast` | `["broadcast", "1"]` | message is a broadcast; recorded on `thread_metadata.broadcast` |
| `imeta` | `["imeta", "url …", "m …", "x …", "size …", …]` | NIP-92 inline media. Each element after the tag name is `"<key> <value>"`. Allowed keys: `url, m, x, size, dim, blurhash, alt, thumb, fallback, duration, bitrate, image, filename`; all but `fallback` are singletons; `url` must be a local `/media/` path and must not be a `.thumb.` path (`handlers/imeta.rs`) |
| `not_before` | `["not_before", "<unix secs>"]` | NIP-ER due time. Materialized into `events.not_before` |
| `emoji` | `["emoji", <shortcode>, <url>]` | NIP-30 custom emoji. Shortcodes are lowercased for the relay-global set |
| `challenge`, `relay` | — | NIP-42 AUTH event tags |
| `u`, `method`, `payload` | — | NIP-98 HTTP auth tags |
| `auth` | `["auth", …]` | NIP-OA owner attestation, carried on the AUTH event. **At most one** — more than one is treated as none |
| `agent`, `frame` | `["agent",<pubkey>]`, `["frame","telemetry"\|"control"]` | NIP-AO observer frames and NIP-AM metrics |
| `E`, `P` | `["E",<root event id>]`, `["P",<root author>]` | NIP-22 uppercase root references (git PR updates) |
| `expiration`, `reason`, `report`, `status`, `action` | — | moderation-command vocabulary, pinned by `handlers/moderation_commands.rs` |
| `name`, `about`, `topic`, `purpose`, `visibility`, `archived`, `ttl`, `ttl_deadline`, `closed`, `public`, `private`, `hidden`, `icon` | — | channel metadata vocabulary (9002 / 9007 / 39000 / 9033) |

**Global-only kinds still carry their tags.** Events are signed, so the relay
cannot strip a stray `h` tag from a global-only kind; it merely sets
`channel_id = NULL`. The filter layer still treats an explicit `h` tag as
authoritative, so a stray `h` can match a `#h` query. This is a known, documented
limitation (`ingest.rs:is_global_only_kind` doc comment) — a reimplementation
should either reject stray `h` tags at ingest or replicate the behaviour, but
must not silently do a third thing.

---

## 5. Channel scoping (the `h` contract)

### 5.1 Three classes

- **`requires_h_channel_scope(kind)`** (`ingest.rs`): 9, 40002, 40003, 40004,
  40005, 40006, 40007, 40008, 40100, 45001, 45002, 45003, 9000, 9001, 9002,
  9005, 9008, 9022, 48100, 48101, 48102, 48103, 48106. Missing `h` ⇒
  `invalid: channel-scoped events must include an h tag`.
- **`is_global_only_kind(kind)`**: `channel_id` forced to `NULL` — 0, 1, 3,
  30023, 30315, 30078, 10000, 10001, 10002, 10003, 30000, 30003, 30030, 10030,
  30174, 30300, 10100, 30175, 30176, 30177, 30178, 30617, 30618, 1617, 1618,
  1619, 1621, 1630–1633, 30621, 9040–9044, 9030–9033, 28936, 9035, 9036, 44200,
  30350.
- Everything else: `h` optional (kind 5, kind 7 — see below).

### 5.2 Derived channels

Kind 7 (reaction) and kind 5 (deletion) derive their channel from the **target
event** named by `#e`; a client-supplied `h` is ignored for channel
determination. A reaction to an unknown event is **rejected** (fail-closed).
`derive_reaction_channel` takes the **last** valid 64-hex `e` tag.

### 5.3 Filter-side consequence (`crates/buzz-core/src/filter.rs:filter_match_one`)

`#h` matching has a documented fallback:

1. If the event has **any** `h` tag: those are authoritative. A non-match is a
   strict rejection — the stored `channel_id` must not override.
2. If the event has **no** `h` tag at all: fall back to the stored
   `channel_id`. This is what makes `{"kinds":[7],"#h":[…]}` match tagless
   reactions.
3. If it has no `h` tag *and* no stored `channel_id`: no match.

---

## 6. Replacement semantics

### 6.1 Replaceable (kinds 0, 3, 41, 10000–19999, plus relay-signed 39000–39002)

`crates/buzz-db/src/lib.rs:replace_addressable_event`.

Key: `(community_id, kind, pubkey, channel_id)` — `channel_id` **is** part of
the key here (it exists to serve relay-signed NIP-29 group state where the relay
is the author and the channel distinguishes groups). Comparison uses
`IS NOT DISTINCT FROM` so `NULL` matches `NULL`.

Algorithm, inside one transaction under a `pg_advisory_xact_lock` derived from
the key:

1. Read the current head: `ORDER BY created_at DESC, id ASC LIMIT 1`.
2. **Domination test** — reject the incoming event if
   `incoming.created_at < head.created_at`
   **OR** (`incoming.created_at == head.created_at` **AND**
   `incoming.id >= head.id` bytewise).
   In words: **newer `created_at` wins; on a same-second tie the lexicographically
   lowest event id wins.** Rejected writes return `was_inserted = false` and the
   caller must skip fan-out.
3. Soft-delete every live row for the key (`deleted_at = NOW()`).
4. Insert the new row `ON CONFLICT DO NOTHING`. If the insert conflicts (the id
   already exists), **roll back** — otherwise the previous head would be lost.

### 6.2 Parameterized replaceable (30000–39999)

`crates/buzz-db/src/lib.rs:replace_parameterized_event`.

Key: `(community_id, kind, pubkey, d_tag)`. **`channel_id` is NOT part of the
key** — an author's addressable event is a single global resource identified by
its d-tag regardless of which channel it was submitted through. `channel_id` is
stored on the new row for query scoping only.

Same lock, same domination rule (newest `created_at`, lowest id on tie), same
conflict rollback.

### 6.3 Two hard-delete exceptions

Some coordinates carry no historical value and their superseded payload is
**physically deleted** rather than soft-deleted:

- **NIP-RS read state (30078)** — recognised by: exactly one `d` tag whose value
  equals the coordinate and matches `^read-state:[0-9a-f]{32}$`, and exactly one
  `["t","read-state"]` tag. The superseded row and its `event_mentions` are
  deleted, and a compact ordering **watermark** is written to
  `parameterized_event_watermarks (community_id, kind, pubkey, d_tag,
  created_at, event_id)`.
  The domination test then considers **both** the live head *and* the watermark,
  so a NIP-09 deletion cannot reopen a replay window — a previously accepted
  blob can never be resurrected. Exact replay of the watermark tuple is a silent
  no-op. Enforced in the database too, for mixed-version deployments:
  `migrations/0009` … `0011` install `guard_nip_rs_watermark`,
  `purge_soft_deleted_nip_rs`, `guard_nip_rs_hard_delete` (which requires the
  transaction-local GUC `buzz.nip_rs_hard_delete = 'on'`), and
  `guard_event_mention_live`.
- **Buzz mesh status (30003)** — `d` starts with `buzz-mesh-member-status:` and
  the event carries `["k","buzz-mesh-status"]`. A 45-second heartbeat; only the
  live head has value (`migrations/0019`).

### 6.4 Deduplication

Ordinary inserts are `INSERT … ON CONFLICT DO NOTHING` against the PK
`(community_id, created_at, id)`, returning `(StoredEvent, was_inserted)`.
`was_inserted = false` means "already had it" and the pipeline still replies
`["OK", id, true, ""]` — resubmitting an event is not an error.

The same signed event **may exist in two communities**; dedup is per-community
by construction.

---

## 7. Filters and REQ

### 7.1 Grammar

A filter is a JSON object. Buzz parses it with `nostr::Filter`, which silently
drops unknown fields.

| Field | Type | Semantics |
|---|---|---|
| `ids` | `string[]` | event ids. **Prefix matching is supported** — `event_id_hex.starts_with(filter_id_hex)` (`filter.rs`) |
| `authors` | `string[]` | pubkeys, exact |
| `kinds` | `number[]` | exact. `[]` (explicit empty) means **match nothing**, not wildcard. Absent means all kinds |
| `since` | `number` | `created_at >= since` (inclusive) |
| `until` | `number` | `created_at <= until` (inclusive) |
| `limit` | `number` | clamped to `DEFAULT_MAX_PAGE_LIMIT = 1000`; absent also means 1000 |
| `search` | `string` | NIP-50. One-shot only (§7.5) |
| `#<single-letter>` | `string[]` | generic tag filter; matches if **any** filter value equals **any** event tag value for that tag name |

### 7.2 Matching (`crates/buzz-core/src/filter.rs`)

- **OR across filters, AND within a filter.** `filters_match(&[], ev)` is
  `false` — an empty filter *list* matches nothing.
- An empty *filter object* `{}` matches everything (every field is absent).
- Tag matching compares `tag.content()` — i.e. **element index 1 only**. A
  three-element tag matches on its second element; positions ≥2 are not
  filterable.
- `#h` has the fallback described in §5.3. Every other tag is strict.

### 7.3 REQ handling (`crates/buzz-relay/src/handlers/req.rs:handle_req`)

Order is a security property:

1. Require `AuthState::Authenticated`; require `Scope::MessagesRead` (if the
   context carries any scopes at all).
2. Enforce `MAX_SUBSCRIPTIONS = 1024` per connection (replacing an existing
   `sub_id` does not count).
3. Resolve `accessible_channel_ids` for the pubkey (10 s cache), then intersect
   with the token's `channel_ids` if the token is channel-scoped.
4. `extract_channel_id_from_filters` — `None` (⇒ "global subscription") if
   **any** filter lacks an `#h` value, or if two filters name **different**
   channels.
5. If a channel was named: confirm access **before registering**, with a
   request-local repair path (`resolve_request_local_access`) that re-checks the
   DB uncached on a cache-negative so a just-added member isn't stuck. Deny ⇒
   `["CLOSED", sub, "restricted: not a channel member"]`.
6. **Global subscriptions only**: run the three read gates (§9.2) *before*
   anything else touches the database.
7. If any filter carries `search`: all filters must (mixed ⇒ `CLOSED`); run the
   one-shot search path and return. Search REQs are **never registered** for
   fan-out.
8. Register the subscription (replacing any same-`sub_id` entry, per NIP-01),
   retain the Redis topic.
9. **One DB query per filter** (never a merged query — merging would collapse
   distinct time windows and per-filter limits), bounded to
   `FILTER_QUERY_CONCURRENCY = 4` in flight, results consumed **in filter
   order**.
10. Per event: re-run `filters_match` against **that one filter**; re-check
    channel accessibility; re-run `event_visible_to_reader` (§9.3); then dedupe
    by event id. **Dedupe happens after acceptance**, so an event rejected by
    filter A is still eligible for filter B.
11. `["EOSE", sub_id]`.

### 7.4 Fan-out (`crates/buzz-relay/src/subscription.rs`)

Six indexes, all keyed by `(community_id, …)`:

| Index | Key | Serves |
|---|---|---|
| `channel_kind_index` | `(community, channel_id, kind)` | channel sub with explicit kinds |
| `channel_wildcard_index` | `(community, channel_id)` | channel sub with no `kinds` |
| `global_kind_index` | `(community, kind)` | global sub with kinds |
| `global_p_kind_index` | `(community, kind, p-value)` | global sub fully constrained by `#p` |
| `global_wildcard_index` | `community` | global sub, no kinds |
| `subs` | `conn_id → sub_id → (filters, community, channel)` | the record itself |

**The invariant:** a channel-scoped event consults *only* the two channel
indexes; a global event consults *only* the three global indexes. A global
subscription therefore **never** receives channel-scoped events, regardless of
filter match. That is deliberate and is a security boundary
(`ARCHITECTURE.md` §5), and it is why reactions must be subscribed to as
`{"kinds":[7],"#h":[…]}` rather than `{"kinds":[7]}`.

`kinds: []` is indexed **nowhere** and receives nothing.

After index lookup, `filter_fanout_by_access` (`handlers/event.rs`) filters
recipients in this order: receiver community label → author-only kinds → shared
gate → (for private channels) live membership check, **fail-closed** on any
lookup error.

### 7.5 Search REQ (NIP-50)

- One-shot: hits, then EOSE, no subscription.
- Page size 100; at most `ceil(1000/100) = 10` pages scanned per filter.
- Candidates are refetched canonically and **re-authorized per hit** — search is
  never the access boundary.
- The p-gated / engram / author-only gates run **before** the search branch, so
  `{"search":"…","kinds":[30174]}` cannot harvest gated events.

### 7.6 COUNT (NIP-45)

`handlers/count.rs`. Same auth and gates as REQ. The fast SQL `count_events()`
path is **bypassed** (falling back to per-event filtering, bounded by
`COUNT_FALLBACK_CANDIDATE_LIMIT = 5000` candidates) whenever a filter can match
an author-only kind, a shared-gated kind, or a result-gated kind — because an
aggregate count leaks existence. The one safe pushdown for a result-gated kind
is `#p` pinned to the authenticated reader's own pubkey.

Response: `["COUNT", sub_id, {"count": n}]`.

---

## 8. Wire protocol

### 8.1 Messages (`crates/buzz-relay/src/protocol.rs`)

| Direction | Frame |
|---|---|
| C→R | `["EVENT", <event>]` |
| C→R | `["REQ", <sub_id>, <filter>, …]` |
| C→R | `["COUNT", <sub_id>, <filter>, …]` |
| C→R | `["CLOSE", <sub_id>]` |
| C→R | `["AUTH", <event>]` |
| R→C | `["EVENT", <sub_id>, <event>]` |
| R→C | `["EOSE", <sub_id>]` |
| R→C | `["OK", <event_id>, <bool>, <message>]` |
| R→C | `["CLOSED", <sub_id>, <reason>]` |
| R→C | `["NOTICE", <message>]` |
| R→C | `["AUTH", <challenge>]` |
| R→C | `["COUNT", <sub_id>, {"count": n}]` |

Parse-level rejections: non-array, empty array, non-string tag, unknown message
type, missing `sub_id`, empty `sub_id`, `sub_id` > 256 bytes, more than 10
filters on a REQ or COUNT.

Reason prefixes follow the NIP-01 machine-readable convention:
`auth-required:`, `restricted:`, `invalid:`, `blocked:`, `duplicate:`, `error:`.

### 8.2 Connection lifecycle (`ARCHITECTURE.md` §3, `connection.rs`)

0. **Community binding** from the request host, before any handler sees tenant
   data (§13).
1. `conn_semaphore.try_acquire_owned()` — reject at capacity before reading any
   data. Default `BUZZ_MAX_CONNECTIONS = 10_000`.
2. Relay sends `["AUTH", <challenge>]` immediately (proactive).
3. Client must respond `["AUTH", <signed kind 22242>]`. `AUTH_TIMEOUT = 5s`.
   State: `Pending{challenge}` → `Authenticated(AuthContext)` | `Failed`.
   A second AUTH after success or failure is refused.
4. Three loops: `recv_loop` (inline), `send_loop` (drains an mpsc, batches up to
   `MAX_WS_SEND_BATCH = 64`), `heartbeat_loop` (ping every 30 s, 3 missed pongs
   ⇒ disconnect). A `CancellationToken` coordinates shutdown.
   Slow clients: `try_send`; `SLOW_CLIENT_GRACE_LIMIT` (default 3) consecutive
   full-buffer sends cancels the connection; a successful send resets it.
5. Cleanup: cancel → await tasks → `sub_registry.remove_connection` →
   `conn_manager.deregister` → drop permit.

A separate `handler_semaphore` (default 1024) bounds concurrent EVENT/REQ
processing across all connections. CLOSE is not limited.

### 8.3 Advertised limits (`crates/buzz-relay/src/nip11.rs`)

| NIP-11 field | Value |
|---|---|
| `max_message_length` | `BUZZ_MAX_FRAME_BYTES`, default **524288** (512 KB). *(`ARCHITECTURE.md` still says 65536 — the code is authoritative)* |
| `max_subscriptions` | 1024 |
| `max_filters` | 10 |
| `max_limit` | 1000 (`buzz_db::DEFAULT_MAX_PAGE_LIMIT`; a test pins the advertised value to the enforced clamp) |
| `max_subid_length` | 256 |
| `min_pow_difficulty` | `null` |
| `auth_required` | **`true`, always** |
| `payment_required` | `false` |
| `restricted_writes` | `true` |
| `due_delivery_mode` | `"push"` (NIP-ER) |
| `max_not_before_delta` | `SPROUT_MAX_NOT_BEFORE_DELTA`, default 31 536 000 |
| `supported_nips` | `[1, 2, 10, 11, 16, 17, 23, 25, 29, 33, 38, 42, 50, 56]`, plus `43` only when membership enforcement **and** a stable signing key are both configured |
| `supported_extensions` | `["nip-er"]` |
| `self` | the relay's own signing pubkey — clients verify every relay-signed event (39000-series, 13534, 30622, 39005/39006) against it |
| `icon` | per-community workspace icon, set by kind 9033 |

### 8.4 Ingest pipeline order (`ARCHITECTURE.md` §4)

```
1  AUTH CHECK        authenticated? MessagesWrite (or kind-specific) scope?
2  PUBKEY MATCH      event.pubkey == auth pubkey (waived for 1059)
3  KIND_AUTH REJECT  22242 never stored
4  EPHEMERAL ROUTE   20000–29999 → ephemeral sub-pipeline
5  VERIFY            spawn_blocking(verify_event): id hash + Schnorr
6  MEMBERSHIP        channel in tags? → check_channel_membership
7  DB INSERT         insert / replace, ON CONFLICT DO NOTHING
8  REDIS PUBLISH     if channel-scoped (or global topic)
9  FAN-OUT           sub_registry → conn_manager
10 SEARCH INDEX      (a generated column — nothing to do out of band)
11 AUDIT LOG         spawned, non-blocking
12 WORKFLOW TRIGGER  spawned; excludes 46001–46012, `buzz:workflow`, 1059
```

Steps 10–12 are fire-and-forget: their failure does not fail the submission.
`["OK", id, true, ""]` is sent at the **end** of the pipeline, not right after
the insert.

Ephemeral sub-pipeline: presence (20001) = verify → Redis presence set/clear →
**local** fan-out only. Everything else ephemeral = verify → membership →
mark-local → Redis PUBLISH → local fan-out. Never stored, never audited, never
in REQ history.

---

## 9. Authorization and read gates

### 9.1 The four gate families

| Gate | Kinds | Filter-level rule | Per-event rule |
|---|---|---|---|
| **p-gated** | `P_GATED_KINDS` (24200, 44100, 44101, 1059, 30622, 44200) | a global REQ/COUNT whose filter *can* match one of these must carry a non-empty `#p` where **every** value equals the reader's pubkey. Exemption: a filter with non-empty `ids` — **except** when the filter explicitly names 30622 or 44200, which lose the exemption (their ids are not author-bound / their cleartext envelope leaks activity metadata) | — |
| **engram** | 30174 | must have `authors` non-empty and all-self, **or** `#p` non-empty and all-self. Filters with explicit `ids` exempt | — |
| **author-only** | `AUTHOR_ONLY_KINDS` (30300, 30350) | a filter targeting only these must have `authors = [self]` | `is_author_only_event`: delivered only to the author. Also enforced in fan-out, *before* channel filtering, since these are stored globally |
| **shared-gated** | `SHARED_GATED_KINDS` (30175, 30178) | — (a SQL visibility pushdown is applied **before `LIMIT`** so private events don't starve shared ones off the page) | `is_unshared_gated_event`: withheld iff kind is shared-gated **AND** reader ≠ author **AND** the event lacks exactly `["shared","true"]` |
| **result-gated** | `RESULT_GATED_KINDS` (30622, 44200) | forces the COUNT per-event fallback | `reader_authorized_for_event`: reader's hex pubkey must appear in a `#p` tag |

### 9.2 Where the gates run

Filter-level gates run in `handle_req` and `handle_count` **only for global
subscriptions** (`channel_id.is_none()`), because a channel-scoped subscription
can never receive globally-stored events by the fan-out invariant (§7.4).

### 9.3 The one per-event chokepoint

`crates/buzz-relay/src/handlers/req.rs:event_visible_to_reader(event, reader_bytes)`
= `!is_author_only_event && !is_unshared_gated_event && reader_authorized_for_event`.

Call it from **every** read surface: WS REQ historical delivery, WS live
fan-out, COUNT fallback, HTTP `/query`, HTTP `/count`, and FTS result delivery.
A reimplementation that inlines the three predicates at each site will
eventually miss one; Buzz factored it precisely for that reason.

### 9.4 Scopes (`crates/buzz-auth/src/scope.rs`)

16 scopes, wire strings `"<area>:<verb>"`:
`messages:read`, `messages:write`, `channels:read`, `channels:write`,
`admin:channels`, `users:read`, `users:write`, `admin:users`, `jobs:read`,
`jobs:write`, `subscriptions:read`, `subscriptions:write`, `files:read`,
`files:write`, `repos:read`, `repos:write`. Unrecognised strings survive as
`Scope::Unknown(s)` so a newer token doesn't lock a user out.

`required_scope_for_kind` (`handlers/ingest.rs`), the authoritative kind→scope map:

| Scope | Kinds |
|---|---|
| `users:write` | 0, 3, 30078, 30315, 30174, 30300, 30175, 30176, 30177, 30178, 30350, 10000, 10001, 10002, 10003, 30000, 30003, 30030, 10030, 10100, 9035, 9036 |
| `messages:write` | 1, 30023, 44200, 1984, 42000, 9040–9044, 5, 7, 1059, 9, 40002, 9005, 40003, 40004, 40005, 40006, 40007, 40008, 45001, 45002, 45003, 1617, 1618, 1619, 1621, 1630–1633, 41010, 41011, 41012, 30620, 46020, 46030, 46031 |
| `channels:write` | 9002 (without an `archived` tag), 9007, 40100, 48100, 48101, 48102, 48103, 48106 |
| `channels:read` | 9021, 9022, 28936 |
| `admin:channels` | 9000, 9001, 9008, 9002 **with** an `archived` tag |
| `admin:users` | 9030, 9031, 9032, 9033 |
| `repos:write` | 30617, 30618, 30621 |
| — | any other kind ⇒ `restricted: unknown event kind` |

**NIP-42 grants `Scope::all_known()`** — all 16 (`buzz-auth/src/lib.rs:verify_auth_event`).
Per-channel access is enforced by NIP-29 membership, not by scopes. Scopes only
really narrow things for API tokens.

---

## 10. Authentication

### 10.1 NIP-42 (WebSocket) — `crates/buzz-auth/src/nip42.rs`

- Challenge: **32 CSPRNG bytes, hex-encoded** (64 chars), sent proactively on
  connect.
- Client signs a **kind 22242** event with `["challenge",<challenge>]` and
  `["relay",<relay url>]`.
- Verification, in order: kind == 22242 → `verify_event` (id + Schnorr) →
  challenge equality → relay-URL equality (normalized) → `|now - created_at| ≤ 60s`.
- **Relay-URL normalization for AUTH** (deliberately narrow — it is a security
  boundary, not the runtime identity normalizer in `buzz-core/src/relay.rs`):
  parse as a URL, map host `localhost` and `::1` to `127.0.0.1`, strip a
  trailing slash from the path. **Nothing else.** The expected URL is built from
  the *tenant's* host, not from the deployment-wide `relay_url`
  (`bridge.rs:nip42_expected_relay_url`) — otherwise an AUTH signed for
  community A would pass on a connection bound to community B.
- Errors: `InvalidSignature` (also for a wrong kind), `ChallengeMismatch`,
  `RelayUrlMismatch`, `EventExpired`.
- After success the relay runs, in order: the **community-ban gate** (with a
  NIP-OA owner cascade: banning an owner bans their agents; banning an agent is
  agent-only; a DB error denies with `error: internal`, never with a ban
  message), then the pubkey allowlist (if `BUZZ_PUBKEY_ALLOWLIST=true`,
  fail-closed on DB error, generic `auth-required: verification failed`), then
  the NIP-43 relay-membership gate (if `BUZZ_REQUIRE_RELAY_MEMBERSHIP=true`),
  with a NIP-OA owner-delegation fallback.

### 10.2 NIP-98 (HTTP) — `crates/buzz-auth/src/nip98.rs`

Header: `Authorization: Nostr <base64(JSON event)>`.

1. Parse JSON → `nostr::Event`.
2. `kind == 27235`.
3. `verify_event` (id + Schnorr).
4. `|now - created_at| ≤ 60s`.
5. `["u", <url>]` must equal the expected URL after normalization
   (lowercase scheme/host via the `url` crate, trailing slash stripped).
   **No loopback aliasing here** — `localhost`, `::1` and `127.0.0.1` are three
   distinct hosts, because the `u`-tag host *is* the community binding.
   The expected URL is `{http|https}://{tenant.host()}{path}`, scheme derived
   from whether the configured relay URL is `wss://`.
6. `["method", …]` compared case-insensitively.
7. If a `["payload", <hex>]` tag is present **and** a body was supplied,
   `sha256(body)` must equal it. Some endpoints require the payload tag
   (`require_payload`).
8. Returns the event pubkey.

**Replay protection is separate and mandatory**
(`crates/buzz-auth/src/nip98_replay.rs`): after verification, atomically claim
the event id in a shared, community-scoped seen-set.

- Redis key: `buzz:{community_id}:nip98:{event_id_hex}`.
- Operation must be an **atomic set-if-absent** (`SET NX EX`); a read-then-write
  loses to concurrent inserts.
- TTL floor `DEFAULT_REPLAY_TTL_SECS = 120` (2 × the ±60 s tolerance); ceiling
  `MAX_REPLAY_TTL_SECS = 3600`. Implementations must clamp, not reject.
- **Verify first, then mark** — burning a slot on a forgery would let an attacker
  who can predict a victim's event id DoS the legitimate request.
- Any error **fails closed**. So does the whole request.

Dev-only fallback: an `X-Pubkey` header is accepted when
`require_auth_token = false`; it yields a zero event id and skips replay
checking. Never enable in production.

### 10.3 API tokens (`crates/buzz-db/src/api_token.rs`)

- Stored as **SHA-256 of the raw token** (`token_hash BYTEA CHECK length = 32`);
  the plaintext token is never persisted. Uniqueness is
  `UNIQUE (community_id, token_hash)` — a token presented on the wrong tenant
  host simply does not resolve.
- `scopes JSONB` (array of scope strings), `channel_ids JSONB` (optional
  restriction to specific channels — a **channel-scoped token**).
- Lifecycle columns: `expires_at`, `last_used_at`, `revoked_at`, `revoked_by`,
  `created_by_self_mint`.
- **Quota: 10 active tokens per `(community, owner)`**, enforced atomically by a
  conditional `INSERT … SELECT … WHERE (SELECT COUNT(*) … ) < 10` — no TOCTOU
  window.
- A channel-scoped token narrows `accessible_channels` on every REQ/COUNT and is
  refused outright for relay-admin kinds (9030–9033) and 28936.

### 10.4 Rate limiting (`crates/buzz-auth/src/rate_limit.rs`, `buzz-pubsub/src/rate_limiter.rs`)

Interface + Redis implementation exist; `ARCHITECTURE.md` §9 lists enforcement as
a known gap (the only wired implementation is the always-allow test stub).

- Algorithm: **fixed window**, atomic Lua `INCR` + conditional `EXPIRE` + `TTL`.
  Allows up to 2× burst at window boundaries. A key found with `TTL < 0` (crash
  between INCR and EXPIRE) is repaired with a fresh `EXPIRE`.
- Keys:
  `buzz:{community_id}:ratelimit:{pubkey_hex}:{msg|api|ws|conn}` (per-tenant —
  the same pubkey in two communities has two independent quotas) and
  `buzz:ratelimit:ip:{ip}:conn` (**operator-global by design**, because it gates
  connection acceptance before host→community resolution has run).
- `LimitType`: `Messages`→`msg`, `ApiCalls`→`api`, `WsEvents`→`ws`,
  `IpConnections`→`conn`.
- Configured tiers (`RateLimitConfig` defaults): human 60 msg/min, 300 api/min,
  10 ws-events/s; agent-standard 120 msg/min, 600 api/min; agent-elevated
  300 msg/min; agent-platform 600 msg/min.
- Violations land in `rate_limit_violations` (operator-global, attribution only).

---

## 11. Database schema

`schema/schema.sql` is the desired-state for a fresh install; `migrations/0001`
… `0026` are the applied history. Two lint obligations govern everything:
every tenant-scoped table has `community_id NOT NULL`, and every
UNIQUE/PK/FK on such a table **leads with `community_id`** (or joins carry the
community tuple). Deliberate exceptions are registered as rows in
`_operator_global_tables`.

### 11.1 Enums

`channel_type` (`stream|forum|dm|workflow`), `channel_visibility` (`open|private`),
`member_role` (`owner|admin|member|guest|bot`), `workflow_status`
(`active|disabled|archived`), `run_status`
(`pending|running|waiting_approval|completed|failed|cancelled`),
`approval_status` (`pending|granted|denied|expired`), `delivery_method`
(`webhook|websocket`), `subscription_status` (`active|paused|deleted`),
`pause_reason` (`user|system|rate_limit`), `channel_add_policy`
(`anyone|owner_only|nobody`).

Role hierarchy for authorization is numeric, not lexical
(`buzz-core/src/channel.rs`): owner 4 > admin 3 > member 2 > guest 1, and
**bot = 0 — outside the hierarchy, never satisfying any requirement**; bots need
explicit grants.

### 11.2 `communities` — the tenant registry (operator-global)

| Column | Type | Why |
|---|---|---|
| `id` | `UUID PK` | **is** the community key; `CHECK id <> nil-uuid` |
| `host` | `VARCHAR(255) NOT NULL` | stored already-normalized |
| `signing_key` | `BYTEA` | per-community relay identity |
| `icon` | `TEXT` | NIP-11 `icon`, set by kind 9033 |
| `created_at`, `archived_at` | `TIMESTAMPTZ` | lifecycle |

`CREATE UNIQUE INDEX idx_communities_host ON communities (lower(host))` — belt
and braces so `Relay.Example` and `relay.example` can never become two tenants.

### 11.3 `channels`

`PRIMARY KEY (community_id, id)` — **channel UUIDs are not globally unique**;
the same UUID may legitimately exist in two communities.

Columns: `id`, `community_id`, `name`, `channel_type`, `visibility`,
`description`, `canvas`, `created_by BYTEA`, `created_at`, `updated_at`,
`archived_at`, `deleted_at`, `nip29_group_id`, `topic_required`, `max_members`,
`topic` + `topic_set_by` + `topic_set_at`, `purpose` + `purpose_set_by` +
`purpose_set_at`, `participant_hash BYTEA` (DM identity), `ttl_seconds`,
`ttl_deadline`.

Indexes: unique `(community_id, nip29_group_id)` and `(community_id,
participant_hash)` where non-null; `(community_id, channel_type)`;
`(community_id, visibility)`; `(community_id, created_by)`; a partial
`(ttl_deadline)` for the ephemeral-channel sweeper.

Trigger `trg_channels_community_id_immutable` — **a channel can never be
re-tenanted**; there is no admission path, so it is a hard block.

### 11.4 `channel_members`

`PRIMARY KEY (community_id, channel_id, pubkey)`, FK to
`channels (community_id, id) ON DELETE CASCADE`. Columns: `role`, `joined_at`,
`invited_by`, `removed_at`, `removed_by`, `hidden_at` (the per-viewer DM hide
state that NIP-DV projects). **Removal is a soft delete** — re-adding reverses
`removed_at`. Index `(community_id, pubkey) WHERE removed_at IS NULL` backs
"which channels can this pubkey see".

### 11.5 `users`

`PRIMARY KEY (community_id, pubkey)`, `CHECK length(pubkey) = 32`. One profile
per `(community, pubkey)` — the same key reposts kind 0 in each community it
joins. Columns: `nip05_handle`, `display_name`, `avatar_url`, `about`,
`agent_type`, `capabilities JSONB`, `okta_user_id`, `created_at`, `updated_at`,
`deactivated_at`, `metadata_event_id`, `agent_owner_pubkey` (self-referential FK
within the same community — this is what makes an "agent"), `channel_add_policy`.
Unique on `(community_id, lower(nip05_handle))` and `(community_id, okta_user_id)`
where non-null.

### 11.6 `events` — the log

`PRIMARY KEY (community_id, created_at, id)`, **`PARTITION BY RANGE (created_at)`**
with monthly partitions plus `_p_past` / `_p_future` catch-alls.

| Column | Type | Purpose |
|---|---|---|
| `community_id` | `UUID NOT NULL` | tenant fence; leads every hot index |
| `id` | `BYTEA` | 32-byte event id |
| `pubkey` | `BYTEA` | 32-byte author |
| `created_at` | `TIMESTAMPTZ` | the event's own timestamp; also the partition key |
| `kind` | `INT` | — |
| `tags` | `JSONB` | verbatim tag array |
| `content` | `TEXT` | — |
| `search_tsv` | `TSVECTOR GENERATED ALWAYS … STORED` | §12 |
| `sig` | `BYTEA` | 64-byte signature |
| `received_at` | `TIMESTAMPTZ DEFAULT NOW()` | relay clock |
| `channel_id` | `UUID` | NULL = global |
| `deleted_at` | `TIMESTAMPTZ` | soft delete (NIP-09 and replacement) |
| `d_tag` | `TEXT` | materialized NIP-33 coordinate (NULL for non-30000-range kinds; `''` when the tag is absent) |
| `not_before` | `BIGINT` | materialized NIP-ER due time |
| `delivered_at` | `BIGINT` | reminder delivery stamp |

Indexes and why each exists:

| Index | Reason |
|---|---|
| `(community_id, id, created_at DESC)` | the PK can't serve `WHERE id = $1` because `created_at` sits between; this makes the scoped id lookup index-served instead of a partition scan |
| `(community_id, channel_id, created_at DESC, id)` | channel timeline pages (keyset cursor) |
| `(community_id, pubkey, kind, created_at DESC, id)` | author+kind reads |
| `(community_id, kind, created_at DESC, id)` | kind-only reads |
| `(community_id, deleted_at)` | live/dead partitioning |
| `(community_id, kind, pubkey, channel_id, deleted_at)` | replaceable head lookup |
| `(community_id, kind, pubkey, d_tag, created_at DESC, id) WHERE d_tag IS NOT NULL AND deleted_at IS NULL` | NIP-33 head lookup |
| `(community_id, not_before) WHERE not_before IS NOT NULL AND deleted_at IS NULL AND delivered_at IS NULL` | the reminder due scan |
| `GIN (search_tsv)` | FTS `@@`; deliberately single-column — community scoping comes from BitmapAnd with the btree filters |
| `GIN (tags jsonb_path_ops)` (migration 0004) | `tags @> '[["e","<hex>"]]'` containment. Without it the thread/e-tag closure was ~900 ms per hop on staging |

Triggers on `events`:

- `events_enqueue_push_match` (AFTER INSERT) — for kinds **7, 9, 1059, 40007,
  46010** only, and only when the community has an active, endpoint-enabled,
  unexpired push lease, insert a `push_match_queue` job under a **shared**
  advisory lock (paired with the exclusive lock lease activation takes) to close
  the lost-wake race.
- `events_refresh_channel_ttl` (deferred constraint trigger) — refresh a
  channel's `ttl_deadline` on any channel-scoped insert except kind 9007
  (which initializes its own). Failures `RAISE WARNING`, never reject the event.
- `events_created_at_floor` (deferred constraint trigger) — when the session GUC
  `buzz.created_at_floor` is set, refuse channel-bearing rows whose `created_at`
  is more than that many seconds before **commit** time (`clock_timestamp()`,
  not the transaction-frozen `now()`). This turns ingest's timestamp envelope
  into a storage invariant, which is what lets keyset pages below the replica
  fence be served from a read replica without holes. `channel_id IS NULL` is the
  only structural exemption.
- The NIP-RS guards (`trg_events_nip_rs_watermark`,
  `trg_events_purge_soft_deleted_nip_rs`, `trg_events_guard_nip_rs_hard_delete`).

### 11.7 `event_mentions` — the `#p` fan-out index

`PRIMARY KEY (community_id, pubkey_hex, event_id)`; columns
`event_created_at`, `channel_id`, `event_kind`. Denormalized from the event's
`p` tags at write time so the mention feed is O(unread), not a JSONB scan.
Indexes `(community_id, pubkey_hex, event_created_at DESC)`,
`(community_id, pubkey_hex, event_kind, event_created_at DESC)`,
`(community_id, event_id)`.

**The join back to `events` must carry the community tuple** (`e.community_id =
m.community_id AND e.id = m.event_id`); a bare `e.id = m.event_id` leaks
cross-community mentions.

`trg_event_mentions_require_live_event` locks the live event row `FOR KEY SHARE`
while inserting a 30078 mention, so a concurrent hard delete cannot orphan it.

### 11.8 `parameterized_event_watermarks` (migration 0007)

`PRIMARY KEY (community_id, kind, pubkey, d_tag)` + `created_at`, `event_id`.
The compact ordering fact retained after a NIP-RS payload is hard-deleted, so
replacement ordering survives without retaining user payloads (§6.3).

### 11.9 `thread_metadata`

`PRIMARY KEY (community_id, event_created_at, event_id)`; columns `channel_id`,
`parent_event_id` + `parent_event_created_at`, `root_event_id` +
`root_event_created_at`, `depth`, `reply_count`, `descendant_count`,
`last_reply_at`, `broadcast`.

Written atomically with the reply event (`insert_event_with_thread_metadata`).
Resolution rules (`ingest.rs:resolve_nip10_thread_meta`):

- Read `root`/`reply` markers from `e` tags (position 3), values must be 64 hex.
- `reply` only ⇒ root = parent. `root` only, or neither ⇒ no thread metadata.
- Parent must exist, must be in the **same channel**, and must have a channel.
- The client's `root` must equal the ancestry the relay derives, or
  `root tag does not match thread ancestry`.
- **Depth cap 100.**
- `reply_count` / `descendant_count` are materialized on the root; any code that
  inserts a reply must maintain them.

### 11.10 `reactions`

`PRIMARY KEY (community_id, event_created_at, event_id, pubkey, emoji)` plus
`created_at`, `removed_at`, `reaction_event_id`, with a unique
`(community_id, reaction_event_id)` where non-null. The reaction event and the
reaction row are inserted in **one transaction**
(`insert_reaction_event_with_thread_metadata`), with outcomes
`TargetMissing` / `Duplicate` / `Inserted`.

### 11.11 Auth, membership and moderation tables

| Table | Key | Purpose |
|---|---|---|
| `api_tokens` | `(community_id, id)`, unique `(community_id, token_hash)` | §10.3 |
| `pubkey_allowlist` | `(community_id, pubkey)` | optional NIP-42 pubkey allowlist; `added_by`, `note` |
| `relay_members` | `(community_id, pubkey TEXT)` | NIP-43 roster; `role IN ('owner','admin','member')` |
| `join_policy_acceptances` | `(community_id, pubkey, policy_version)` | durable evidence of the policy version accepted at invite claim; `length(policy_version) = 64`; cascades with membership |
| `relay_invites` | `(community_id, id)`, unique `(community_id, token_hash)` | use-limited invite links; stores **only SHA-256 of the code**; `role` pinned to `'member'`; `max_uses BETWEEN 1 AND 10000` (NULL = unlimited); `CHECK (max_uses IS NULL OR use_count <= max_uses)`; claimed under `FOR UPDATE` so exactly one claimant wins the last slot |
| `archived_identities` | `(community_id, pubkey)` | NIP-IA; `consent_path IN ('self','owner','admin')`, `actor`, `reason`, `replaced_by`, `request_event_id` |
| `community_bans` | `(community_id, pubkey)` | one restriction row per member: `banned` + `ban_expires_at` (NULL + banned ⇒ permanent) is a **connection** block at the NIP-42 seam; `muted_until` is a **write** block only |
| `moderation_reports` | `(community_id, id)`, unique `(community_id, report_event_id)` | 1984 queue. `target_kind IN ('event','pubkey','blob')` with a CHECK enforcing **exactly one** populated target column; `status IN ('open','resolved','dismissed','escalated')`; FK to `moderation_actions` for resolution provenance |
| `moderation_actions` | `(community_id, id)` | one row per accepted moderation action; `action` in a closed 12-value list; `reason_code` / `public_reason` (public tombstone) / `private_reason` (mod-only) / `matched_principal IN ('self','owner')` (audit-only — the client never learns which principal matched) |

### 11.12 Workflow tables

`workflows (community_id, id)` — `definition JSONB`, `definition_hash BYTEA`,
`status`, `enabled`, FKs to users and channels within the community.
`workflow_runs (community_id, id)` — `status`, `trigger_event_id`,
`current_step`, `execution_trace JSONB`, `trigger_context JSONB`, timestamps.
`workflow_approvals (community_id, token)` — **`token` is the SHA-256 hash**,
never the raw token; `step_id`, `step_index`, `approver_spec`, `status`,
`approver_pubkey`, `note`, `granted_at`, `denied_at`, `expires_at`. Single use is
enforced with `AND status = 'pending'` in the UPDATE.
`scheduled_workflow_fires (community_id, workflow_id, scheduled_for)` — the
at-most-once cron claim: only the pod that wins the claim insert creates the run.

### 11.13 Subscriptions and delivery

`subscriptions (community_id, id)` — persisted webhook/websocket subscriptions
with `filter_kinds`/`filter_authors`/`filter_channel_ids`/`filter_since`/
`filter_until` as JSONB, `delivery_method`, `delivery_url`, `status`,
`pause_reason`, counters.
`delivery_log` — partitioned monthly by `delivered_at`, `PRIMARY KEY
(delivered_at, id)`.

### 11.14 Push (NIP-PL)

`push_leases (community_id, author, installation_id)`, unique
`(community_id, source_event_id)`, plus a partial unique
`(community_id, author, app_profile, endpoint_hash) WHERE active`. A CHECK
enforces the two coherent shapes: active ⇒ all endpoint fields present;
inactive ⇒ all NULL. `endpoint_enabled` is generation-scoped transport
invalidation that does not rewrite the signed lease state.
`push_wake_outbox` — durable wake queue, unique `(community_id, endpoint_hash,
event_id)` for idempotency, states `pending|sending|delivered|failed`.
`push_match_queue (community_id, event_id)` — the crash-safe follower written by
the insert trigger.
`push_gateway_*` (challenges, installations, delegations, endpoint quotas, two
replay tables) are **deployment-global**, registered in
`_operator_global_tables`, because installations may authorize several relay
deployments.

### 11.15 Other

`git_repo_names (community_id, repo_id)` + `owner_pubkey` — repo-name uniqueness
moved off local disk so the relay is stateless; the PK *is* the atomic
"create repo" and `owner_pubkey` distinguishes idempotent re-announce from
collision.
`product_feedback` — operator-global inbox, unique on `event_id`.
`rate_limit_violations` — operator-global.
`replica_heartbeat` — exactly one row (`CHECK id = 1`) with `epoch` + `token`;
the single-row UPDATE is the serialization point that makes freshness tokens
globally commit-ordered, and `epoch` detects a restore/re-seed so a stale
retained token can't masquerade as fresh coverage.
`audit_log` — §14.
`_operator_global_tables` — the lint allowlist, kept as a table so the registry
lives next to the schema it governs.

---

## 12. Search

There is **no separate search service and no out-of-band indexer.** The index is
a generated column on `events`, so every row write *is* the index update — a
client cannot forge a tsvector out of sync with the content it signed, and there
is no consistency window.

```sql
search_tsv TSVECTOR GENERATED ALWAYS AS (
  CASE WHEN kind IN (1059, 30300, 30350, 30622, 44100, 44101, 44200)
       THEN NULL::tsvector
       ELSE to_tsvector('simple', content)
  END
) STORED
```

- Config is **`'simple'`** — no stemming, no stopwords — matching the
  substring-ish semantics the old engine had.
- The exclusion list is a **privacy boundary**: a `NULL` tsvector never matches
  `@@`, so those kinds are storage-level unsearchable. It must stay in sync with
  the p-gated/author-only kind sets; `buzz-search/tests/fts_integration.rs`
  asserts `p_gated_persistent_kinds_have_storage_null_tsvector`.
- Fresh, empty installs get a **positive allowlist** instead
  (`migrations/0008`): only kinds **0, 9, 40002, 45001, 45003** are indexed.
  Populated databases keep the denylist until an operator runs
  `scripts/maintenance/nip_rs_search_allowlist.sql`. *A reimplementation should
  pick the allowlist — it is the safer default and the direction Buzz is
  moving.*

Query side (`crates/buzz-search/src/query.rs:search`):

```sql
SELECT id, kind, pubkey, channel_id,
       EXTRACT(EPOCH FROM created_at)::bigint AS created_at_s,
       ts_rank_cd(search_tsv, search_query.query) AS rank
FROM events CROSS JOIN LATERAL (SELECT <tsquery> AS query) AS search_query
WHERE community_id = $ctx
  AND deleted_at IS NULL
  AND search_tsv @@ search_query.query
  [+ channel scope, kinds, authors, since, until]
ORDER BY rank DESC, created_at DESC, id
LIMIT $per_page OFFSET (($page - 1) * $per_page)
```

- `community_id = $ctx` is the **first** predicate and there is no code path that
  omits it (the `CommunityId` is required at the type level).
- Two modes: `FullText` uses `websearch_to_tsquery('simple', q)`;
  `Prefix` (typeahead) splits on whitespace, normalizes each token through
  `to_tsvector('simple', …)`, `quote_literal`s each lexeme (so punctuation can't
  inject tsquery operators), ANDs them, and appends `:*` to **only the trailing
  token**.
- `ChannelScope` is a 4-variant enum — `Any`, `ChannelLessOnly`,
  `Channels(ids)`, `ChannelsOrChannelLess(ids)` — replacing an
  `Option<Vec<Uuid>> + bool` matrix that could not express "empty accessible
  channels + include global" without accidentally broadening to *all* channels.
  Reproduce the enum, not the matrix.
- Clamps: query text ≤ 4096 chars (NUL bytes → space), `per_page` ≤ 500
  (0 ⇒ 100), `page` ≤ 1000. Empty/whitespace query short-circuits with zero hits
  and no SQL round trip.
- **Permission filtering is the caller's job.** `buzz-search` returns candidate
  hits; the relay refetches each canonically by `(community_id, event_id)` and
  re-runs the access predicate. Search can never widen visibility.

---

## 13. Audit log

`crates/buzz-audit`. Append-only, tamper-evident, **one independent chain per
community**.

### 13.1 Row shape (`audit_log`)

`PRIMARY KEY (community_id, seq)` + `UNIQUE (community_id, hash)`. Columns:
`hash BYTEA`, `prev_hash BYTEA` (NULL for the community's first entry),
`action VARCHAR(64)`, `actor_pubkey BYTEA`, `object_id TEXT`, `detail JSONB`,
`created_at TIMESTAMPTZ`.

### 13.2 Hash construction (`crates/buzz-audit/src/hash.rs:compute_hash`)

SHA-256 over, in this exact order:

1. `community_id` — **16 raw UUID bytes, first**, so an entry cannot be lifted
   out of one community's chain and re-verified in another.
2. `seq` — `i64` **big-endian** bytes.
3. `created_at` — `to_rfc3339()` string bytes, after
   `to_storage_precision()` = `trunc_subsecs(6)`. This truncation is mandatory
   and happens **inside** `compute_hash`: Postgres `TIMESTAMPTZ` is
   microsecond-resolution but `Utc::now()` on Linux carries nanoseconds, and
   chrono's RFC-3339 emits 0/3/6/9 sub-second digits depending on the value — so
   an untruncated timestamp is written with one preimage and verified against
   another.
4. `action` — the stable snake_case string.
5. `actor_pubkey` — a **presence tag byte** (`0x01` or `0x00`) then the raw
   bytes. The tag is what distinguishes `Some(empty)` from `None`.
6. `object_id` — presence tag then UTF-8 bytes.
7. `detail` — **canonical JSON with sorted object keys**, recursively
   (a hand-rolled serializer, not `serde_json::to_string`). A serialization
   failure is a hard error, never silently hashed as empty.
8. `prev_hash` — the previous entry's 32 bytes, or `GENESIS_HASH` = 32 zero
   bytes for the first entry (stored as NULL, hashed as zeros).

Changing the field order invalidates every existing chain.

### 13.3 Writing and verifying

- `AuditService::log` takes a **per-community** `pg_advisory_lock(hashtextextended("buzz_audit:{community}"))`
  before the transaction — so two communities never serialize each other's
  writes (which would be both a bottleneck and a cross-tenant timing oracle).
  The lock is released on every path, including panic (`catch_unwind`, then
  `resume_unwind`).
- Inside the transaction: read the community's head
  (`ORDER BY seq DESC LIMIT 1`), `seq = prev_seq + 1`, compute the hash, insert.
- `verify_chain(community, from, to)` walks ascending, checking both that each
  entry's `prev_hash` equals the previous entry's `hash` (`ChainViolation`) and
  that each recomputed hash matches the stored one (`HashMismatch`). An empty
  range returns `Ok(false)`.

### 13.4 Actions (11)

`event_created`, `event_deleted`, `channel_created`, `channel_updated`,
`channel_deleted`, `member_added`, `member_removed`, `auth_success`,
`auth_failure`, `rate_limit_exceeded`, `media_uploaded`.

Never audited: **kind 22242** (returns `AuditError::AuthEventForbidden`
immediately — AUTH events may carry bearer material) and all ephemeral kinds
(they never reach the audit pipeline). `detail` is explicitly **never** a place
for tokens or secrets.

---

## 14. Presence, typing, and pub/sub keys

All Redis keys are community-prefixed (`crates/buzz-pubsub/src/topic.rs`,
`BUZZ_PREFIX = "buzz"`):

| Key / channel | Type | TTL | Cadence | Purpose |
|---|---|---|---|---|
| `buzz:{community}:channel:{channel_uuid}` | pub/sub | — | per event | channel-scoped event fan-out across pods |
| `buzz:{community}:global` | pub/sub | — | per event | community-global event fan-out |
| `buzz:{community}:presence:{pubkey_hex}` | string (`SET … EX 180`) | **180 s** | client heartbeat every **60 s** | online/away. TTL is 3× the heartbeat so one missed beat doesn't flap presence. `"offline"` ⇒ `DEL` |
| `buzz:{community}:typing:{channel_uuid}` | sorted set | **60 s** key TTL | `ZADD` per keystroke burst; **5 s** activity window | `ZADD key <now_unix> <pubkey_hex>` / `ZREMRANGEBYSCORE key -inf <now-5.0>` / `EXPIRE key 60`. The key TTL prevents orphaned empty sets (`ARCHITECTURE.md` §6) |
| `buzz:{community}:nip98:{event_id_hex}` | string (`SET NX EX`) | 120 s (floor), 3600 s (ceiling) | per HTTP request | NIP-98 replay seen-set |
| `buzz:{community}:ratelimit:{pubkey}:{msg\|api\|ws\|conn}` | counter | window | per action | per-tenant rate limit |
| `buzz:ratelimit:ip:{ip}:conn` | counter | window | per connection | **operator-global** connection rate |
| `buzz:{community}:conn-control` | pub/sub | — | on moderation action | cross-pod `DisconnectPubkey{pubkey,event_id,reason}` / `DisconnectCommunity`. Deliberately a **separate** channel from cache invalidation: a cache drop is idempotent, a disconnect is not. The DB ban row is the durable backstop if a message is lost |
| `buzz:{community}:cache-invalidation` | pub/sub | — | on membership change | pure cache-key drop, never an evict payload |

Subscriber mechanics: a **dedicated** `redis::aio::PubSub` connection (pool
connections cannot hold subscribe state), dynamic SUBSCRIBE per topic with a
refcount and a 500 ms unsubscribe debounce, feeding a
`broadcast::channel(4096)`. Reconnect backoff 1 s → 2 s → … → 30 s, resetting to
1 s only on a **clean** stream end, not on each attempt. Local-echo dedup via
`AppState.local_event_ids` (a moka cache) so an event published by this pod is
skipped when it returns over Redis.

Presence deliberately does **not** go over Redis pub/sub — kind 20001 uses
local-only fan-out, so presence is per-pod. Typing does.

---

## 15. Community / tenancy

The single invariant everything else rests on (`crates/buzz-core/src/tenant.rs`
module docs, "row zero"):

> **A request's community is resolved from the connection host by the server,
> never supplied or influenced by the client.**

### 15.1 Resolution (`crates/buzz-relay/src/tenant.rs:bind_community`)

```
normalize_host(raw Host header) → lookup in communities.host → TenantContext
```

`normalize_host` (`buzz-core/src/tenant.rs`) is the *one* rule both sides use:
trim, ASCII-lowercase, strip a `:443` or `:80` suffix (default ports only, so
IPv6 literals survive), strip a single trailing FQDN-root dot. Non-default ports
are **kept** — a deployment may serve different communities on different ports.
So `relay.example`, `Relay.Example`, `relay.example.`, `relay.example:443` and
`relay.example:80` are one tenant, while `relay.example:8443` is another.

Fail-closed rules:

- Empty/whitespace host ⇒ `UnmappedHost` **before** the lookup (the schema does
  not forbid a `host = ''` row, so without this guard a missing Host header
  would bind to a misconfigured empty-host community).
- Unmapped host ⇒ `UnmappedHost`.
- Lookup error ⇒ `Lookup(e)`.
- All three must produce a **byte-identical generic rejection**, so an
  unauthenticated caller cannot probe which hosts exist.
- **There is no default or fallback community.**

Server-internal paths with no inbound Host (git smart-HTTP, the pre-receive hook
callback, the workflow sink, startup tasks) resolve
`relay_url_authority(config.relay_url)` through the *same* fail-closed function.
`relay_url_authority` preserves explicit non-default ports and IPv6 brackets
(`ws://[::1]:3000` → `[::1]:3000`) — a naive `Url::host_str()` drops both, and
then the bootstrapped owner lands in a community no request resolves to.

### 15.2 Enforcement

- `TenantContext` has **no `Default`, no `Deserialize`, and no parse-from-string
  constructor.** A `CommunityId` can only come from host resolution or from a DB
  row the server already scoped. This is honestly described in-repo as a
  "lint-and-review fence, not a compiler fence": `TenantContext::resolved` and
  `CommunityId::from_uuid` are `pub` so the resolver (in another crate) can call
  them, and a migration-lint harness forbids constructing one anywhere else. The
  type removes the *accidental* path; review closes the deliberate one.
- Every scoped row carries an immutable `community_id`; every unique key leads
  with it (§11).
- A client-supplied `#h` is still just a channel identifier — it is resolved as
  `(ctx.community, h)`, so it can never reach another community's channel even
  when the UUID collides.
- NIP-98 `u`-tag host and NIP-42 `relay`-tag host must agree with the
  **host-derived** community, not with the deployment-wide `relay_url` (§10.1,
  §10.2).
- Fan-out re-checks the receiver's community label at the send chokepoint, so a
  stale or injected match for a connection bound to community A can never
  deliver an event labelled community B.
- The relay owns `TenantContext` propagation; service crates take
  community-scoped inputs and never derive tenancy from client-controlled event
  tags.

---

## 16. What a faithful reimplementation must get right

Break any of these and the layer is Nostr-flavoured, not Nostr.

1. **Byte-exact canonical serialization.** `[0,pubkey,created_at,kind,tags,content]`,
   no whitespace, integers unquoted, tags verbatim and unsorted, NIP-01's
   seven-escape rule and nothing more, hashed over UTF-8 bytes. An event we
   export must verify in `nak`.
2. **Verify the id AND the signature, always, independently.** Either check
   alone passes a class of tampering the other catches.
3. **Signature is BIP-340 over the 32 raw id bytes**, with an x-only pubkey.
   Deterministic aux is fine.
4. **Storage class is a function of the kind number alone** — ephemeral
   20000–29999 is never stored, never audited, never searchable, never in
   history; replaceable and parameterized-replaceable are disjoint.
5. **Replacement tie-break: newest `created_at` wins; on an equal second the
   lexicographically lowest event id wins.** Deterministic across relays. A
   dominated write returns "not inserted" and must not fan out.
6. **NIP-33 keys on `(kind, pubkey, d_tag)` — never on the channel.** A missing
   `d` means the empty-string coordinate, not "no coordinate".
7. **`kinds: []` matches nothing; an absent `kinds` matches everything.** Index
   the empty case nowhere.
8. **OR across filters, AND within one.** One query per filter, dedupe *after*
   acceptance, never merge filters into one query.
9. **Channel-scoped events never reach global subscriptions**, regardless of
   filter match. That is the security boundary, and it is why `#h` must be part
   of a reaction subscription.
10. **`#h` fallback rule**: explicit `h` tags are authoritative (non-match =
    strict reject); the stored channel is consulted only when the event has no
    `h` tag at all.
11. **Access is checked before the subscription is registered**, not after —
    otherwise a non-member receives live events in the race window.
12. **One per-event visibility function on every read surface** (author-only,
    shared-gate, `#p` result gate) — REQ history, live fan-out, COUNT, HTTP
    query, and search hits. And the filter-level gates must run *before* the
    search branch.
13. **An aggregate count leaks existence.** Any filter that can match an
    author-only, shared-gated or result-gated kind must fall back to per-event
    counting.
14. **Knowing an event id is not authorization** for 30622 and 44200. The `ids`
    exemption applies only to kinds whose id is author-bound or whose content is
    encrypted.
15. **`shared` is a tag with exactly two elements and the value `"true"`** —
    fail closed on any other shape, and never make it a content field (toggling
    sharing must not change content bytes or any content hash).
16. **Privacy-sensitive kinds are unsearchable at the storage layer**, not
    filtered after the fact. A NULL/absent index entry, not a post-query
    exclusion.
17. **NIP-42 and NIP-98 both bind to the host-derived community**, use a ±60 s
    window, and NIP-98 additionally needs an atomic, shared, community-scoped
    replay seen-set with TTL ≥ 120 s that **fails closed** — verify first, then
    mark.
18. **Secrets are stored only as SHA-256**: API tokens, invite codes, workflow
    approval tokens. Never the plaintext.
19. **The audit chain hashes `community_id` first, `prev_hash` last, with
    presence tags on optionals and canonical sorted-key JSON for `detail`, and
    timestamps truncated to storage precision.** One chain per community, one
    writer at a time, lock released even on panic.
20. **Row zero: the community comes from the host, never from the client.** No
    default tenant, no fallback, a generic rejection for every failure mode, and
    an immutable `community_id` on every scoped row with every unique key
    leading on it.
21. **AUTH events (22242) are never stored, never audited, never logged.**
    Relay-only kinds are rejected from clients. Membership notifications
    (44100/44101) and NIP-DV snapshots (30622) may be signed only by the relay
    identity.
22. **Ephemeral, presence and typing state never touches the durable log**, and
    presence TTL is 3× the heartbeat so one missed beat is not a state change.
