# Buzz Parity — 02: Agents

Rebuild specification for Buzz's **agents** module: the largest subsystem in the
repo (~301 files). Sourced exhaustively from `desktop/src/features/agents/**`,
`desktop/src/features/agent-memory/**`, `desktop/src/features/mesh-compute/**`,
`crates/buzz-acp`, `crates/buzz-agent`, `crates/buzz-persona`, plus
`VISION_AGENT.md`, `VISION_REMOTE_AGENTS.md`, `VISION_MESH.md` and the
`docs/nips/NIP-A*` protocol specs.

Every non-obvious behaviour below is traceable to a `path:symbol`. Where a pure
function has a test, the test is the spec and the rule is stated exactly.

---

## 0. The one-sentence model

> **An agent is a member of the workspace, not a bot attached to it.**

An agent has its own Nostr keypair, its own profile, its own presence, its own
durable memory, and its own reputation on the relay. It joins channels through
the same membership machinery humans use. Its process is a *body* — replaceable,
mortal, running locally or remotely — and its identity is not in that body
(`VISION_REMOTE_AGENTS.md`, "Same Agent, New Body").

Three consequences that shape the entire module:

1. **Nothing about an agent is stored "on the channel".** Membership,
   messages, mentions, DMs and jobs are the ordinary relay primitives, with an
   agent pubkey in the author slot.
2. **The desktop retains no substrate control channel after deploy.** You read
   the agent's messages to know how it's doing, you `@mention` it to steer it,
   you send `!shutdown` to stop it. There is no RPC into the running body.
3. **Telemetry is a separate, ephemeral, owner-only plane.** The
   observability stream (kind `24200`) is encrypted agent↔owner and never
   stored on any relay. It powers every "what is my agent doing right now"
   surface in the app.

---

## 1. Nostr event kinds used by agents

Authoritative registry: `crates/buzz-core/src/kind.rs`. Every constant below is
a `u32`; ranges follow NIP-01 (20000–29999 ephemeral, 30000–39999 parameterized
replaceable / addressable).

### 1.1 Agent identity & definition

| Kind | Const | Class | Author | Purpose |
|---|---|---|---|---|
| `0` | `KIND_PROFILE` | replaceable | agent | The agent's own NIP-01 profile. Carries `ownerPubkey` (declared NIP-OA owner) so the UI can answer "is this mine". |
| `10100` | `KIND_AGENT_PROFILE` | replaceable | agent | Agent metadata + owner reference. Backs the relay agent directory (`RelayAgent`: name, agentType, channels, channelIds, capabilities, status, respondTo, respondToAllowlist). |
| `30175` | `KIND_PERSONA` | param-replaceable, **shared-gated** | owner | NIP-AP agent *definition* ("persona"). `d` = plaintext slug. |
| `30176` | `KIND_TEAM` | param-replaceable | owner | Team definition (name, description, personaIds). NOT shared-gated — owner-private semantics. |
| `30177` | `KIND_MANAGED_AGENT` | param-replaceable | owner | Per-*instance* cross-device sync projection. `d` = agent pubkey. Explicit opt-IN allowlist projection: MUST NEVER carry seckey, NIP-OA auth tag, env vars, or runtime fields. |
| `30178` | `KIND_TEAM_CATALOG` | param-replaceable, **shared-gated** | owner | Shareable team projection with *embedded* sanitized member definitions. |
| `30174` | `KIND_AGENT_ENGRAM` | param-replaceable, encrypted | agent | NIP-AE durable agent memory. `d` = HMAC over the agent↔owner conversation key. |
| `44200` | `KIND_AGENT_TURN_METRIC` | regular, stored, p-gated | agent | NIP-AM per-turn token/cost record, NIP-44 encrypted to owner. |
| `24200` | `KIND_AGENT_OBSERVER_FRAME` | **ephemeral**, p-gated | agent ↔ owner | NIP-AO observability + control plane. Never persisted by relays. |

### 1.2 Turn triggers (inbound events an agent responds to)

| Kind | Const | Role |
|---|---|---|
| `9` | `KIND_STREAM_MESSAGE` | The `@mention`. Default subscribe kind. Also the carrier for owner control commands (`!shutdown` / `!cancel` / `!rotate`). |
| `46010` | `KIND_WORKFLOW_APPROVAL_REQUESTED` | Default subscribe kind. |
| `40007` | `KIND_STREAM_REMINDER` | Default subscribe kind. |
| `45001/45002/45003` | forum post / vote / comment | Opt-in via `--kinds` **and** `--no-mention-filter` (forum posts don't @mention). |
| `43001–43006` | `KIND_JOB_REQUEST` … `KIND_JOB_ERROR` | Agent job protocol: request / accepted / progress / result / cancel / error. Deliberately NOT NIP-90 kinds (5000–6999) because Buzz requires auth chains (depth ≤ 3, breadth ≤ 10). |
| `1059` | `KIND_GIFT_WRAP` | DMs. A DM channel is a channel whose metadata declares `t=dm` or carries `hidden` (`crates/buzz-acp/src/relay.rs:channel_type_from_tags`). |
| `20002` | `KIND_TYPING_INDICATOR` | Ephemeral. The *fallback* working signal when observer frames are absent. |
| `20001` | `KIND_PRESENCE_UPDATE` | Agent presence = "available for conversation", a lease the agent renews. Not substrate telemetry. |
| `44100/44101` | member added/removed notification | Relay-signed, p-gated. Running agents auto-discover new channel membership from these — **no restart is needed to add a running agent to a channel** (`desktop/src/features/agents/channelAgents.ts:attachManagedAgentToChannel`). |

### 1.3 Access-control classes the relay enforces

`crates/buzz-core/src/kind.rs`:

- `P_GATED_KINDS` = `[24200, 44100, 44101, 1059, 30622, 44200]` — readable only
  by a subscriber whose pubkey is in the event's `#p` tag; enforced at the
  *filter* layer (`p_gated_filters_authorized`), and stored kinds additionally
  get a NULL `search_tsv` so NIP-50 FTS cannot leak them.
- `RESULT_GATED_KINDS` = `[30622, 44200]` — even a reader who knows the event id
  must match `#p`; closes the kindless `{ids:[…]}` read path.
- `SHARED_GATED_KINDS` = `[30175, 30178]` — **author-only unless shared**. A
  foreign reader gets the event only if it carries *exactly* `["shared","true"]`
  (two elements, one occurrence). `kind.rs:event_is_shared` fails closed on any
  other shape; `kind.rs:is_unshared_gated_event` returns true (withhold) only
  when kind is shared-gated AND requester ≠ author AND the tag is absent.
  Enforced at REQ historical delivery (pushed down into SQL **before**
  `ORDER BY … LIMIT`, so newer private personas can't starve an older shared
  one off a catalog page), `ids` lookup, live fan-out, COUNT (fast SQL path
  bypassed), the NIP-98 `/query` and `/count` HTTP bridges, and FTS.
- `KIND_TEAM` (30176) is deliberately **not** shared-gated — its writers never
  emit `shared`, so catalog opt-in semantics don't describe it.

**Why `shared` is a tag and not a content field:** content bytes are hash-pinned
as the event id and are also the `source_version` used for persona drift
detection. A content-field toggle would look like a definition edit.

---

## 2. NIP-AO: the observer plane (kind 24200)

Spec: `docs/nips/NIP-AO.md`. This is the single most load-bearing protocol in
the module — every "is my agent working" and every activity view is derived
from it.

### 2.1 Wire envelope

```json
{
  "kind": 24200,
  "pubkey": "<sender>",
  "created_at": <unix>,
  "content": "<NIP-44 v2 ciphertext>",
  "tags": [
    ["p",     "<recipient_pubkey>"],
    ["agent", "<agent_pubkey>"],
    ["frame", "telemetry" | "control"]
  ]
}
```

Exactly one `p`, one `agent`, one `frame`. Optional `h` when the session runs
inside a NIP-29 group.

- **telemetry** (agent → owner): `pubkey`=agent, `p`=owner, encrypted with
  `(agent_privkey, owner_pubkey)`.
- **control** (owner → agent): `pubkey`=owner, `p`=agent, encrypted with
  `(owner_privkey, agent_pubkey)`.

Relay MUST verify `is_agent_owner(agent, owner)` in **both** directions — `#p`
matching alone is insufficient. Rate limit 100 events/s per agent; ±5 minute
`created_at` freshness window recommended. Decrypted payload ≤ 65,535 bytes.
Relays MUST NOT persist, index, audit-log, or write these to a DB path.

### 2.2 Telemetry payload (`ObserverEvent`)

Rust emitter: `crates/buzz-acp/src/observer.rs:ObserverEvent`.
TS consumer: `desktop/src/features/agents/ui/agentSessionTypes.ts:ObserverEvent`.

```ts
type ObserverEvent = {
  seq: number;              // monotonic, PROCESS-LOCAL — resets to 1 on restart
  timestamp: string;        // RFC3339 with sub-second precision
  kind: string;             // frame kind, see table below
  agentIndex: number | null;// pool slot index for parallel subprocesses
  channelId: string | null;
  sessionId: string | null;
  turnId: string | null;
  startedAt?: string | null;// RFC3339 turn start, attached for whole-turn frames
  payload: unknown;         // kind-specific
};
```

`seq`, `timestamp`, `kind`, `payload` are REQUIRED; the rest may be `null` and
clients MUST handle that. Unknown `kind` values MUST be ignored.

The Rust side keeps an in-process ring buffer of `OBSERVER_BUFFER_CAP = 1000`
frames plus a `tokio::broadcast` channel
(`observer.rs:ObserverHandle::{emit,snapshot,subscribe}`). `emit` writes to the
buffer first (evicting the front at cap), then broadcasts.

`observer.rs:context_for(channel, session, turn)` builds a context with no
`startedAt`; `observer.rs:context_for_turn(channel, session, turn, started_at)`
attaches the authoritative turn start to **every** frame of that turn — this is
what lets the desktop resurrect a pruned badge with its original elapsed timer
(§5.4).

### 2.3 Frame kinds (the complete emitted set)

| `kind` | Emitted at | Payload |
|---|---|---|
| `acp_read` | `crates/buzz-acp/src/acp.rs:1200,1523` | raw inbound ACP JSON-RPC frame (agent → harness) |
| `acp_write` | `acp.rs:1043` | raw outbound ACP JSON-RPC frame (harness → agent) |
| `acp_parse_error` | wire decode failure | error block text |
| `turn_started` | `pool.rs:1370` | `{ source: "channel"\|"heartbeat", triggeringEventIds: string[] }` |
| `session_resolved` | `pool.rs:1654` | `{ sessionId, isNewSession }` |
| `session_config_captured` | `pool.rs:983` | `{ configOptions, modes, models, modelOverridden, relayUrl }` — emitted AFTER desired-model resolution so the desktop caches post-switch state |
| `turn_liveness` | `pool.rs:3475` | `{}` — heartbeat every ~10 s (`BUZZ_ACP_TURN_LIVENESS_SECS`) |
| `turn_completed` | `pool.rs:3576` (`TurnCompletionGuard::drop`) | `{}` — fires on **every** exit path |
| `turn_error` | `lib.rs:3242` | `{ outcome, error, code? }` |
| `agent_panic` | `lib.rs:3471` | `{ outcome: "panic", error: "Agent task panicked: …" }` |
| `control_result` | `lib.rs:913,990` and `pool.rs:963` | `{ type: "cancel_turn"\|"switch_model", status, modelId? }` |
| `managed_agent_runtime_lifecycle` | `lib.rs:emit_runtime_lifecycle` | `{ pubkey, relayUrl, startNonce, lifecycle, error }` |
| `raw_json_rpc` | dev debugging | raw payload |

**Drop ordering matters.** In `pool.rs` the `TurnCompletionGuard` is declared
*before* the `liveness_guard`, because Rust drops locals in reverse order — so
liveness is aborted before completion makes the turn terminal. Reproduce that
ordering or you will emit a liveness frame after the completion tombstone.

### 2.4 Control payload

```json
{ "type": "cancel_turn",  "channelId": "<uuid>" }
{ "type": "switch_model", "channelId": "<uuid>", "modelId": "<string>" }
```

Handled by `crates/buzz-acp/src/lib.rs:handle_cancel_turn_control` and
`:handle_switch_model_control`. Unknown `type` values MUST be ignored.

`cancel_turn` → `signal_in_flight_task(pool, channel, ControlSignal::Cancel)`;
result `"sent"` when a task was signalled, `"no_active_turn"` otherwise.

`switch_model` has two paths:
- **busy** (a `task_map` entry exists for the channel): deliver
  `ControlSignal::SwitchModel` over the in-flight task's oneshot. The task
  cancels the turn, sets `desired_model`, and requeues the batch so it re-runs
  on a fresh session under the new model. Status `"sent"`, or `"turn_ending"`
  when the oneshot was already consumed this turn.
- **idle**: validate against the cached model catalog *before* invalidating
  (pre-cancel guard), then set `desired_model` + invalidate.
  `IdleSwitchResult` → `"switched"` / `"unsupported_model"` / `"no_active_turn"`.

A catalog miss on the busy path surfaces post-cancel from
`create_session_and_apply_model` as `control_result{status:"unsupported_model"}`;
the turn restarts on the *unchanged* model.

**Control delivery is best-effort.** Frames can be dropped during reconnect or
queue overflow; commands must be advisory and idempotent.

---

## 3. Agent as a member

### 3.1 Adding an agent to a channel

`desktop/src/features/agents/channelAgents.ts`:

- `attachManagedAgentToChannel(channelId, {agent, role="bot", ensureRunning=true})`
  1. `addChannelMembers({channelId, pubkeys:[agent.pubkey], role})` — the same
     API a human uses. Roles offered in
     `ui/AddAgentToChannelDialog.tsx`: `bot` (default), `member`, `guest`,
     `admin`. `owner` is excluded by type (`Exclude<ChannelRole,"owner">`).
  2. Any per-pubkey membership error for this agent throws.
  3. `membershipAdded` = the pubkey appears in `result.added` (normalized
     compare).
  4. If `ensureRunning`: **a running agent is left alone.** Running local
     (`status==="running"`) or deployed remote agents auto-discover new channel
     membership through the harness's membership notifications (kinds
     44100/44101). Only a not-yet-running agent gets `startManagedAgent`. For a
     local agent both the status check and the start are **pair-scoped to the
     active community**: `agent.status` reflects that community's
     `(agent, relay)` pair and `startManagedAgent` spawns that same pair.
- `ensureChannelAgentPresetInChannel` — "add the Goose preset to this channel":
  fetch members + managed agents, pick an existing agent by
  `pickPreferredChannelPresetAgent` (in-channel command match first, then
  name match `runtimeId.toLowerCase()`), else create with
  `acpCommand:"buzz-acp"`, `agentCommand: runtime.command`, `agentArgs: []`,
  `mcpCommand: runtime.mcpCommand ?? ""`, `spawnAfterCreate:false`, then attach.
- `createChannelManagedAgent` = `provisionChannelManagedAgent` + attach.
- `createChannelManagedAgents(channelId, inputs)` — batch. **Strictly
  sequential**: each agent must be fully created and its relay membership
  written before the next starts, because concurrent writes to the replaceable
  `kind:39002` channel-members event cause last-write-wins data loss. Returns
  `{successes, failures}` where a failure is
  `{kind:"generic"|"persona", name, personaId, error}`.

`desktop/src/features/agents/channelAttachmentFailure.ts:AgentChannelAttachmentFailure`
= `{channelName, error}` — the shape surfaced when a post-create attach fails.

### 3.2 Reuse rules (create-vs-reuse guardrail)

`desktop/src/features/agents/agentReuse.ts`, spec'd by `agentReuse.test.mjs`:

- `commandsMatch(a,b)` — compare **basenames**, case-insensitively, after
  normalizing `\` → `/`. `claude-code-acp` and `claude-agent-acp` both normalize
  to `claude-acp`, so they match each other and any path form of either.
  Different commands do not match.
- `parseTimestamp(v)` — `Date.parse`, returning `0` for `null` / `undefined` /
  empty / unparseable.
- `pickPreferredManagedAgent(agents)` — sort by (a) running-or-deployed first
  (`deployed` scores identically to `running`), then (b) most recent
  `updatedAt` (missing = epoch 0). Empty array → `undefined`.
- `findReusablePersonaAgent(agents, personaId, channelMemberPubkeys)` —
  candidates are agents with matching `personaId` that are **not already
  members of this channel** (case-insensitive pubkey compare), then
  `pickPreferredManagedAgent`.
- `findReusableGenericAgent(agents, command, channelMemberPubkeys)` —
  candidates have **no** `personaId`, an **empty-or-whitespace** `systemPrompt`
  (undefined and `""` both count as empty), a `commandsMatch` command, and are
  not already in the channel.
- `findReusableAgent(agents, members, input)` — routes: `personaId` present →
  persona search; otherwise if `systemPrompt` is blank/whitespace → generic
  search; otherwise (a genuinely custom agent) → `undefined`, i.e. always
  create new. A `null` personaId routes to generic.

`provisionChannelManagedAgent` applies the same two searches, honours
`forceNewInstance` to bypass them, and — critically — **applies the caller's
`respondTo` even when reusing** (`updateManagedAgent({respondTo, respondToAllowlist})`
whenever `respondTo` is set and not `owner-only`), so the user's permission
choice in the dialog is never silently dropped by a reuse.

### 3.3 Identity & keys

- Keys are generated by the desktop. `createManagedAgent` returns
  `CreateManagedAgentResponse = { agent, privateKeyNsec, profileSyncError, spawnError }`
  (`desktop/src/shared/api/types.ts`). The nsec is shown once.
- Out-of-band, `buzz-admin generate-key` prints a hex pair; the secret is not
  stored and cannot be recovered. `BUZZ_PRIVATE_KEY` is the agent's identity.
- Every agent needs its own keypair. Running N agent *subprocesses* under one
  identity is supported (`--agents 1..32`) and users see **one** bot.
- **NIP-OA owner attestation** (`docs/nips/NIP-OA.md`): the owner signs an
  `auth` tag `["auth", <owner-pubkey-hex>, <conditions>, <sig-hex>]` proving it
  authorized the agent key. Preimage is the UTF-8 bytes of
  `nostr:agent-auth:` ‖ `event.pubkey` ‖ `:` ‖ `<conditions>`; the signed
  message is `SHA256(preimage)`, signed BIP-340 with the owner key. Conditions
  are `&`-joined clauses from `kind=<n>` / `created_at<t>` / `created_at>t`,
  canonical base-10, no whitespace, no empty/leading/trailing `&`. Zero or one
  `auth` tag per event; two = invalid. Owner pubkey equal to `event.pubkey` =
  invalid. **The event remains authored by `event.pubkey`** — clients MUST NOT
  display the owner as author, MUST NOT merge the event into owner-authored
  timelines, and SHOULD render provenance only as e.g. "authorized by <owner>".
  Verification must not depend on the verifier's clock.
- **NIP-AA** (`docs/nips/NIP-AA.md`): an agent presenting a valid NIP-OA `auth`
  tag inside its NIP-42 `kind:22242` AUTH event gains *virtual membership*
  when its owner is an active relay member — no separate enrolment, and
  revoking the human revokes the agent on its next connect. AUTH freshness
  window ±120 s recommended. Step-1 failures answer `invalid:`, steps 3–5
  answer `restricted:`.
- The harness resolves its owner at startup from `BUZZ_AUTH_TAG` (the NIP-OA
  attestation) first (`crates/buzz-acp/src/lib.rs`, owner-resolution priority).

### 3.4 How an agent differs from a human in the UI

- `ChannelMember.isAgent` and `role === "bot"` are the two membership signals.
  `desktop/src/features/channels/ui/useChannelActivityTyping.ts` and
  `useMessageProfiles.ts` fold member agent flags into the profile lookup as
  `isAgent: true`, so a member-only agent with no relay directory entry still
  renders as an agent in message rows.
- `knownAgentPubkeys.ts:mergeChannelKnownAgentPubkeys(channelMembers, managed, relay)`
  — channel-scoped known-agent set = managed ∪ relay ∪ this channel's members
  with `role==="bot" || isAgent`.
- `knownAgentPubkeys.ts:mergeKnownAgentPubkeys(managed, relay)` — normalized
  union; `undefined` sources yield an empty set; case and whitespace are
  normalized so duplicates across sources collapse (test:
  `normalisesCaseAndWhitespace_dedupingAcrossSources`).
- `knownAgentPubkeys.ts:mergeOwnedAgentPubkeys(managed, profiles, currentPubkey)`
  — the *owned* set = all managed agents plus every profile whose
  `ownerPubkey` normalizes to the current pubkey. Agents controlled by someone
  else are excluded. With no `currentPubkey`, only managed agents.
- The agent gets a real avatar (`avatarUrl`), a real profile panel, and appears
  in the members sidebar and in `@`-autocomplete. An agent-specific
  "View activity log" ingress is added (§6).
- `ui/AgentStatusBadge.tsx` — badge over `ManagedAgent.status`:
  `isWorking` → "Working" (`variant:"default"`, `motion-safe:animate-pulse`);
  else if past a **15 s mount grace period** and presence has loaded and
  `status==="running"` but presence is missing/`offline` → "Starting…"
  (`variant:"warning"`); else active (`running|deployed`) → default;
  else the raw status with `_` → space.

### 3.5 Mentionability & autocomplete

`desktop/src/features/agents/lib/agentAutocompleteEligibility.ts`:

- `getSharedChannelIds(channels)` — ids of channels where `isMember` and
  `archivedAt === null`.
- `relayAgentIsSharedWithUser(agent, sharedChannelIds, currentPubkey)` —
  if `respondTo === "allowlist"` and we know our pubkey: true iff our
  normalized pubkey is in `respondToAllowlist`. Otherwise true iff
  `respondTo === "anyone"` **and** the agent shares at least one channel with
  us. (`owner-only` agents belonging to someone else are therefore never
  offered.)
- `getMentionableAgentPubkeys({...})` = managed agents ∪ relay agents passing
  the above.
- `shouldHideAgentFromMentions({isAgent,isMember,pubkey,mentionable,directory})`
  — non-agents never hidden; mentionable agents never hidden; a non-member
  non-invocable agent is hidden; a **member** agent is hidden only on an
  *explicit* not-invocable signal (present in the relay directory but absent
  from the mentionable set). Unknown invocability shows. **Both sets must come
  from the same query** (`relayAgentsQuery.data`) or a still-loading directory
  will hide agents prematurely.
- `coalesceAgentAutocompleteCandidates(candidates, {currentPubkey, getLabel, preferredPubkeys})`
  — dedupes agent identities by key:
  `persona:<personaId>` if present; else, with a normalized non-empty label and
  a known owner, `local:name:<label>` when the owner is us and
  `owner:<ownerHex>:name:<label>` otherwise; else no key (kept as-is).
  Among duplicates the winner is chosen by lexicographic rank on
  `[isMember, inPreferredPubkeys, isManagedAgent, hasPersonaId, ownerIsMe]`
  (0 = better). `coalesceAutocompleteCandidatesByKey` is the generic first-wins
  variant.

---

## 4. Agent lifecycle

### 4.1 The two-level data model: *definition* vs *instance*

| | Definition (`AgentPersona`, kind 30175) | Instance (`ManagedAgent`, kind 30177) |
|---|---|---|
| Keyed by | local id / persona slug | agent pubkey |
| Owns | display name, avatar, system prompt, runtime, model, provider, namePool, envVars, behavior defaults | keys, relay pairing, process state, per-instance overrides |
| Shareable | yes (`shared` tag → catalog) | no |

`ManagedAgent` (`desktop/src/shared/api/types.ts:307`) — the full field list:

```
pubkey, name, personaId|null, runtime|null, teamId?, relayUrl,
acpCommand, agentCommand, agentCommandOverride|null, agentArgs[], mcpCommand,
turnTimeoutSeconds, idleTimeoutSeconds|null, maxTurnDurationSeconds|null,
parallelism, systemPrompt|null, avatarUrl|null,
model|null, modelSource: "definition"|"global"|"instance_legacy"|null, provider|null,
personaOutOfDate, personaOrphaned, needsRestart,
envVars: Record<string,string>,
status: "running"|"stopped"|"deployed"|"not_deployed", pid|null,
createdAt, updatedAt, lastStartedAt|null, lastStoppedAt|null,
lastExitCode|null, lastError|null, lastErrorCode|null, logPath,
startOnAppLaunch, autoRestartOnConfigChange,
backend: {type:"local"} | {type:"provider", id, config},
backendAgentId|null,
respondTo: RespondToMode, respondToAllowlist: string[]
```

Semantics worth preserving verbatim:
- `runtime: null` and `agentCommandOverride: null` both mean **inherit from the
  linked definition**. `agentCommand` is the *resolved effective* command.
- `personaOutOfDate` — the linked definition was edited since this agent was
  created; the running process uses the older pinned snapshot. Surface an
  "out of date" marker and prompt delete + respawn. Always false for
  non-persona and orphaned agents.
- `personaOrphaned` — the linked definition is gone. Distinct from out-of-date:
  do **not** prompt respawn, there is nothing to respawn into.
- `needsRestart` — the *running process* was spawned with a config that no
  longer matches what a spawn would use today. Always false when stopped.
- `envVars` is instance **overrides only**; spawn merges the live definition env
  underneath.

`AgentPersona` (`types.ts:712`): `id, displayName, avatarUrl, systemPrompt,
runtime, model, provider, namePool[], isBuiltIn, isActive, shared,
sourceTeam?, catalogSource?, envVars, respondTo|null, respondToAllowlist[],
parallelism|null, createdAt, updatedAt`.

- `shared` is **only the active relay+owner projection returned to the UI** —
  durable heads and pending publications live in the scoped retention DB, and
  an explicit share toggle must await relay acceptance before the UI claims
  publication (`AGENTS.md` rule 10). A queued update stays visibly queued.
- `sourceTeam` set ⇒ team-imported ⇒ **non-editable**.
- `catalogSource: {ownerPubkey, personaId}` is set only on a local copy of
  *another* owner's shared catalog entry; the copy carries a fresh local id, so
  this coordinate is the only way to answer "have I already added this".

### 4.2 `RespondToMode` — the inbound author gate

`type RespondToMode = "owner-only" | "allowlist" | "anyone"` — mirrors
`buzz-acp --respond-to`. The harness also supports `nobody` (heartbeat-only),
deliberately not surfaced in the GUI.

Harness behaviour (`crates/buzz-acp/README.md`):

| Mode | Behaviour |
|---|---|
| `owner-only` (default) | Forward only events from the registered owner. **If no owner is resolved yet, all events are dropped.** |
| `allowlist` | Forward from listed pubkeys **plus the owner** (owner always implicitly included). |
| `anyone` | No author filtering. |
| `nobody` | Drop all inbound; act only on heartbeats. |

The gate applies to **all** inbound events (mentions, DMs, thread replies,
anything the relay delivers). **Owner control commands are checked BEFORE the
gate**, so the owner can always manage the harness:

| Command (kind:9 from owner, `p`-tagging this agent) | Effect |
|---|---|
| `!shutdown` | Graceful exit. |
| `!cancel` | Cancel the in-flight turn for that channel; no-op when idle. |
| `!rotate` | Rotate the channel's ACP session. In-flight → cancel + invalidate on return; idle → invalidate immediately. Next event starts a fresh session. |

These commands are *consumed* by the harness, never forwarded to the agent.

UI (`ui/RespondToField.tsx`): label **"Who can send instructions"**, options
`Only me (default)` / `Anyone` / `Selected people`. `owner-only` renders the
sub-line "Only you can send instructions."

`lib/respondToAllowlist.ts` (UI-side pre-validation only; Rust
`validate_respond_to_allowlist` is authoritative):
- `parsePubkeyInput(raw)` — split on `/[\s,]+/`, trim, require exactly 64 hex
  chars (`/^[0-9a-f]{64}$/i`), lowercase, dedupe preserving insertion order.
  Returns `{valid, invalid}` where `invalid` holds the raw rejects.
- `mergeAllowlist(existing, add)` — lowercase everything, append only valid,
  unseen entries; never reorders existing.

### 4.3 The shared-access warning (a named product rule)

`lib/agentAccessWarning.ts` + `AGENTS.md` rule 11. The warning is **persistent**
(not a toast) and shows for **both** `anyone` and `allowlist`, because both hand
the host's access to someone other than the owner; only the audience phrase
differs.

```ts
type AgentRunLocation = "local" | "remote";
runLocationForBackend(backend) // null when unknown; "local" for {type:"local"}, else "remote"
runLocationForRunOn(runOn)     // null for null/"" (blank is NOT a provider); "local" for "local", else "remote"

agentAccessWarningText(mode, runLocation): string | null
// null unless mode is "anyone" | "allowlist"
// audience = "Anyone" | "Selected people"
// target   = remote ? "the server it runs on, including any accounts and tools available there"
//                   : "your computer, including files, accounts, and connected tools"
// → `${audience} can use this agent to access ${target}.`
```

**An unknown location reads as local — never hedge with "computer or server".**
A remote host requires an installed `buzz-backend-*` provider, and without one
`WhereToRunSection` never renders; hedging would name a concept the owner has
never been shown. Placement: directly below the selector for `anyone`, but
*after* the people picker for `allowlist`, so it never sits between the user and
the selection they came to make. One sentence, leads with the audience so it
reads as a warning not an explanation.

Plumbing: `AgentDialog` is the **one** place that resolves run location for
dialog surfaces and publishes it via `ui/AgentRunLocationContext.tsx`; the field
reads context and lets an explicit `runLocation` prop win. Do not thread it as a
prop through `AgentDefinitionDialog` / `AgentInstanceEditDialog` (both already
over the 1000-line ceiling and neither uses the value). Surfaces rendered
outside `AgentDialog` pass the prop directly.

### 4.4 Dialog routing

`ui/AgentDialog.tsx:AgentDialog` — one entry point, three modes:

- `mode: "instance-edit"` → `AgentInstanceEditDialog`, wrapped in
  `AgentRunLocationProvider runLocation={runLocationForBackend(agent.backend)}`.
  Persistent mount + `open` toggle; its reset lifecycle is keyed on
  `[open, agent.pubkey]`.
- `mode: "definition-edit"` → `AgentDefinitionDialog` with the caller's
  `PersonaDialogState`-derived props passed through unchanged (edit / duplicate
  / import). Run location stays unknown → local wording.
- `mode: "definition"` (create) → `AgentCreateDialogRouter`: renders
  `AgentDefinitionDialog` with a `createRunSection` = `<WhereToRunSection>`,
  `createSubmitBlocked = !canSubmitWhereToRun(runDraft)`, and
  `AgentRunLocationProvider runLocation={runLocationForRunOn(runDraft.runOn)}`.
  Create mode **always starts the agent** (`intent: "definition_start"`).

### 4.5 Create-agent (definition) dialog fields

`ui/AgentDefinitionDialog.tsx` state: `displayName`, `avatarUrl`,
`systemPrompt`, `runtime` (harness), `model` (+ `isCustomModelEditing`),
`provider`, `aiConfigurationMode`, env vars, behavior draft
(`respondTo` / `respondToAllowlist` / `parallelism`), name pool.

- `ui/PersonaAdvancedFields.tsx`: `persona-parallelism` (placeholder `1`),
  `persona-name-pool` (comma text, placeholder `Birch, Compass, Ridge, Thistle`).
- `ui/personaDialogState.ts`: `canSubmitPersonaDialog`,
  `formatPersonaNamePoolText` / `parsePersonaNamePoolText`,
  `createPersonaDialogState()` (title / description / submitLabel for create),
  `editPersonaDialogState(persona)`.
- `ui/personaBehaviorDraft.ts`: `emptyPersonaBehaviorDraft`,
  `draftFromBehavior`, `behaviorForSubmit`, `personaBehaviorDraftValid`.
  Behaviour is a *group*: absent preserves the stored group, present replaces
  it as a unit (`PersonaBehaviorInput`).
- `ui/WhereToRunSection.tsx` + `ui/whereToRunIntent.ts`:
  `emptyWhereToRunDraft`, `canSubmitWhereToRun(draft)`,
  `resolveBackendIntent(draft) → BackendIntent | null`. Field id
  `agent-run-on`. **The section does not render at all unless a
  `buzz-backend-*` provider is installed** — which is why unknown run location
  reads as local.
- `ui/AgentCreationPreview.tsx` renders a live preview of the agent card.

### 4.6 Edit-agent (instance) dialog fields

`ui/AgentInstanceEditDialog.tsx` state: `name`, `acpCommand`, `agentCommand`
(+ `originalAgentCommand`, `inheritHarness`), `agentArgs` (comma string),
`parallelism`, `systemPrompt`, `model` (+ custom editing), `provider`,
`envVars`, `autoRestartOnConfigChange`, `respondTo`, `respondToAllowlist`,
`avatarUrl`, `showAdvancedFields`, `selectedRuntimeId` (with a
`{label:"Custom command", value:"custom"}` option and a synthesized
`"<id> (current)"` entry when the pinned runtime is not in the catalog).

`ui/EditAgentAdvancedFields.tsx` ids: `edit-agent-inherit-harness`,
`edit-agent-auto-restart`, `edit-agent-args` (placeholder `Comma-separated`),
`edit-agent-parallelism` (placeholder `1`), `edit-agent-acp-command`,
`edit-agent-system-prompt` (placeholder
`Leave blank to send no ACP system prompt`).

`UpdateManagedAgentInput` semantics (`types.ts:682`): absent = don't touch;
`envVars` present = **replace the whole map**; `respondToAllowlist` present =
replace the list (validated/normalized server-side); `harnessOverride: true`
preserves a pin that happens to equal the linked persona's runtime instead of
letting the backend drop it back to inherit.

### 4.7 Agent config core — the one-source-of-truth rule

`desktop/src/features/agents/AGENTS.md` is the contributor law; reproduce it.

> **Harness capability facts have exactly one source: the Rust runtime
> catalog.** `KnownAcpRuntime`
> (`desktop/src-tauri/src/managed_agents/discovery/runtime_metadata.rs`)
> declares each harness's model/provider/effort env keys and capabilities.
> Spawn applies them; `AcpRuntimeCatalogEntry` exposes them over IPC;
> `lib/agentConfigCore.ts` projects them into field descriptors. **The
> frontend never maintains a rival copy of this table.**

`AcpRuntimeCatalogEntry` (`types.ts:505`): `id, label, avatarUrl, availability,
command|null, binaryPath|null, defaultArgs[], mcpCommand|null, modelEnvVar|null,
providerEnvVar|null, thinkingEnvVar|null, installHint, installInstructionsUrl,
canAutoInstall, requiresExternalCli, underlyingCliPath|null, nodeRequired,
authStatus, loginHint|null, source: "builtin"|"preset"|"custom",
definitionEnv?`.
`AcpAvailabilityStatus = "available"|"adapter_missing"|"adapter_outdated"|"cli_missing"|"not_installed"`.
`AuthStatus = {status:"logged_in"|"logged_out"|"config_invalid"(+diagnostic)|"not_applicable"|"unknown"}`.
`AcpRuntime` = an entry narrowed to `availability:"available"` with non-null
`command` and `binaryPath`.

`lib/agentConfigCore.ts:deriveAgentConfigFieldModel({config, runtime, scope})`
(`scope: "onboarding"|"global"|"definition"|"instance"`) returns
`{fields, omissions, dependentValuePolicy}`:

- **provider** field iff `runtime.providerEnvVar` — `optionSource:
  "providerCatalog"`, `persistence: {kind:"normalizedField", field:"provider"}`,
  `targetApplication: {kind:"envVar", key: runtime.providerEnvVar}`,
  `render:"control"`.
- **model** field always — `optionSource:"acpModels"`,
  `persistence:{normalizedField, "model"}`,
  `targetApplication` = `{envVar, runtime.modelEnvVar}` when present, else
  `{kind:"acpNative"}`.
- **effort**:
  - if `runtime.thinkingEnvVar`: `optionSource` is `"buzzAgentCatalog"` when
    `runtime.id === "buzz-agent"`, else `"legacyProviderModelCatalog"`;
    `currentPersistence: {envVar, BUZZ_AGENT_THINKING_EFFORT}` (where the value
    lives *today*), `targetApplication: {envVar, runtime.thinkingEnvVar}` (how
    the harness *should* receive it). **These intentionally differ until the
    Goose/Claude migration — do not "fix" one to match the other.**
  - else if `runtime.id === "claude"`: `optionSource:"harnessNative"`,
    `currentPersistence:{kind:"unavailable"}`,
    `targetApplication:{acpConfigOption, id:"effort", category:"thought_level"}`,
    `render:"deferredUntilNativeOptionsAvailable"`.
  - else omission `{kind:"effort", reason: runtime?.id === "codex" ?
    "ownedByModelId" : "unsupportedByHarness"}`.
- `dependentValuePolicy = { onContextChange: "resetDependentValues",
  onCatalogMismatch: scope === "onboarding" ? "onboardingCleanup" : "explainOnly" }`.

Accessors: `hasRenderableAgentConfigField(model, kind)`,
`getRenderableEffortField(model)` — components ask the model what exists, they
never compare harness ids.

The ten rules from `AGENTS.md` that a rebuild must keep:
1. No hardcoded harness-ID checks in render code.
2. Effort reads/writes go through the descriptor's `currentPersistence` key —
   never a raw `BUZZ_AGENT_THINKING_EFFORT` literal in UI code.
3. Field absence has a **named reason**, not a boolean (`ownedByModelId`,
   `deferredUntilNativeOptionsAvailable`) — never a `showX` prop.
4. The clearing policy is the named types; never add mutation booleans like
   `clearInvalidModel`.
5. "Metadata unknown" ≠ "harness lacks the capability". `runtime: undefined`
   means fields don't render, so surfaces must gate on the catalog query
   settling rather than letting fields silently vanish.
6. One canonical behavior (`CANONICAL_CONFIG_BEHAVIORS`), visibility via
   `disclosure` presets — not new boolean props. **Exception:** the
   `onboarding-essential` preset hides happy-path helper copy, but a non-null
   model-discovery status always bypasses the preset
   (`AgentConfigFields.tsx:shouldShowModelStatusMessage`). A *successful*
   discovery that yields no usable options (`supportsSwitching:false` or empty
   list) synthesizes a warning via `synthesizeEmptyDiscoveryStatus()` and is
   deliberately **not cached** (`isCacheableDiscoveryResponse()`) so closing and
   reopening re-runs discovery after the user installs or signs in.
7. Onboarding setup **detects readiness; it does not select defaults.** The
   following defaults page is the sole surface that persists `preferred_runtime`,
   and its Finish gate consumes the shared renderer's `onValidityChange` — a
   harness selection alone does not complete onboarding when that harness needs
   provider/model/credential config. Baked build env and runtime-file config
   satisfy the gate.
8. Omit the Model control **only** after a *confirmed successful empty*
   discovery on an optional-model harness (`acpNative`: Claude Code / Codex).
   `shouldRenderModelControl` hides it while discovery is in flight and after
   IPC resolves with no usable options. **A thrown or unavailable discovery
   keeps the control** (so failure UI can render) and must not heal/clear
   persisted model or effort. Full disclosure still shows the control when a
   Custom model is available. Required-model harnesses always keep the field.
9. The defaults modal is progressively disclosed
   (`progressive-defaults` preset): unset global config starts on the
   Buzz-Agent-first fallback and carries that harness into the next saved edit;
   Provider first, then Model / Effort / Advanced only after a provider is
   configured; harnesses with no provider field skip that gate. Reveals animate
   height through Motion and are immediate under reduced motion. Once the
   Advanced toggle is visible its expanded state is **exclusively
   user-controlled** — provider/harness/required-env changes must never open it.
   Advanced-only required credentials mark the collapsed toggle without opening
   it and block incomplete saves. In Edit, selecting Custom command keeps its
   required command field beside the harness picker rather than hiding it.
10. Catalog visibility is community-scoped relay state, never a global
    definition field (see `shared` above).
11. Shared agent access names the consequence where it is selected (§4.3).

Enforcing tests: `lib/agentConfigCore.test.mjs`,
`ui/agentConfigFieldsContract.test.mjs`, `ui/usePersonaModelDiscovery.test.mjs`,
`ui/respondToFieldContract.test.mjs`, `lib/agentAccessWarning.test.mjs`,
`desktop/tests/e2e/onboarding-agent-defaults.spec.ts`, and Rust
`runtime_metadata_env_vars`.

### 4.8 Runtime resolution and harness tiers

`lib/resolvePersonaRuntime.ts`:
- `getDefaultPersonaRuntime(runtimes, preferredRuntimeId?)` — filter to
  `availability === "available"`, then: explicit `preferredRuntimeId` →
  `buzz-agent` → `goose` → first available → `null`. (Buzz-agent-first so a
  freshly installed goose never beats the bundled sidecar.)
- `resolvePersonaRuntime(personaRuntimeId, runtimes, defaultRuntime, forceOverride?)`:
  1. No preference → `defaultRuntime`, no warnings (or a "no runtimes
     available" warning when null), `isOverridden:false`.
  2. Preference available → use it; if `forceOverride` and a *different*
     default exists, use the default with
     `"Runtime override: using X instead of Y."` and `isOverridden:true`.
  3. Preference not found + default exists → default,
     `"This agent is configured for runtime "<id>" but it is not available.
     Using <label> instead."`, `isOverridden:true`.
  4. Neither → `runtime:null` with a terminal warning, `isOverridden:false`.
- `collectRuntimeWarnings(personas, runtimes, fallback, forceOverride?)` —
  returns `[]` when there is no fallback (the caller's global "no runtimes"
  state owns that case).

`lib/instanceInputForDefinition.ts`:
- `availableRuntimesForStart(query)` — **refetch-aware**: an unfetched query is
  fetched rather than treated as empty (which would spuriously refuse every
  start).
- `resolveStartRuntimeForDefinition(persona, runtimes, preferredRuntimeId?)` —
  **refuses** with an actionable error when the definition's configured runtime
  is unavailable. One consistent rule everywhere: never silently start on a
  different runtime than configured.
- `buildInstanceInputForDefinition(persona, runtime, upload?, backendIntent?)`
  — the single definition→instance mapping. Provider intent: no local
  commands, `startOnAppLaunch:false`, `spawnAfterCreate:true`,
  `harnessOverride:false`. Local: `acpCommand:"buzz-acp"`,
  `agentCommand:runtime.command`, **`agentArgs: []`**,
  `mcpCommand: runtime.mcpCommand ?? ""`,
  `harnessOverride: !persona.runtime || persona.runtime === runtime.id`,
  `model/provider` from the definition, `spawnAfterCreate:true`,
  `startOnAppLaunch:true`, `backend:{type:"local"}`.
  - **Never seed `agentArgs` from `runtime.defaultArgs`** and **never seed
    `envVars` from the definition.** Empty args let spawn resolve definition
    args live on every start; seeded env would manufacture pseudo-overrides
    that mask later definition edits.
  - `avatarUrl` goes through `ui/managedAgentAvatar.ts:resolveManagedAgentAvatarUrl`.

`ui/managedAgentAvatar.ts:resolveManagedAgentAvatarUrl(avatarUrl, upload?, fallback?)`:
non-`data:image/` URLs pass through; **percent-encoded emoji SVG data URLs
(`data:image/svg+xml,…`, not base64) pass through unchanged** so the emoji
survives deployment; base64 data URIs are `atob`'d and uploaded via
`uploadMediaBytes`, returning the hosted URL; on failure fall back to
`fallbackAvatarUrl` unless that is itself a data URI.

**Harness tiers** (`crates/buzz-acp/README.md`, "Bring Your Own Harness"):
- **Tier 1 — compiled-in**: `goose`, `claude`, `codex`, `buzz-agent`. Auto
  installers, auth probes, first-class onboarding. IDs reserved.
- **Tier 2 — preset catalog**: static `HarnessDefinition` entries in
  `desktop/src-tauri/src/managed_agents/discovery.rs:PRESET_HARNESSES`
  (Cursor, Oh My Pi, Grok Build, OpenCode, Kimi Code, Amp, Hermes Agent,
  OpenClaw). Always present, PATH-probed, not editable/deletable, bundled logos.
- **Tier 3 — user custom**: JSON files in `<app-data>/custom_harnesses/`:
  ```json
  { "id":"my-agent", "label":"My Agent", "command":"my-agent-bin",
    "args":["acp"], "env":{"MY_AGENT_MODE":"acp"},
    "installInstructionsUrl":"…", "installHint":"…" }
  ```
  `id` matches `[a-z0-9_][a-z0-9_-]*`. Definition `env` is a **floor**;
  user/persona/global env overrides it. Buzz-reserved keys (e.g.
  `BUZZ_MANAGED_AGENT`) are always stripped and cannot be overridden.
  Invalid files are skipped with a warning without breaking other discovery.
  Security guarantees: no install shell commands in preset/custom definitions;
  `can_auto_install` always false for them; **no user-supplied icon URLs** —
  icons are bundled assets keyed by id.
  Frontend: `ui/addCustomHarness.ts` (`ADD_CUSTOM_HARNESS_OPTION`,
  `runtimeDropdownAction`, `usePendingHarnessSelection`) +
  `ui/AddCustomHarnessDialog.tsx`.

### 4.9 Managed-agent runtime: spawn, reconcile, status

The backend keys a running process by the **pair** `(agent pubkey, relay URL)`
— one agent identity can be running against several communities at once.

`managedAgentRuntimeStatus.ts`:
```ts
type ManagedAgentRuntimeLifecycle =
  "starting"|"listening"|"waking"|"ready"|"failed"|"stopped";
type ManagedAgentRuntimeStatus = {
  pubkey; requestedRelayUrl?; relayUrl; localSetup; lifecycle; pid|null;
  error|null; logPath|null;
};
```
- `agentCommunityAvailability(runtime)` → the **four product labels**:
  `!localSetup` → `"Needs setup on this device"`; `starting|listening|waking` →
  `"Waking"`; `ready` → `"Here"`; `failed|stopped` → `"Unavailable"`.
  Backend-authoritative `localSetup` takes precedence over lifecycle.
- `agentCommunityStatusDetail(runtime)` → `"Set up this agent on this device to
  start it."` / `"Stopped by you"` / `runtime.error ?? "Could not connect"` /
  `null`.
- `managedAgentRuntimeKey(runtime)` = `JSON.stringify([pubkey, relayUrl])` —
  JSON so the key **cannot collide at component boundaries** (a `:` join could).
- `managedAgentPairAction(runtime)` — missing row or `stopped` → `"start"`;
  `failed` → `"restart"`; otherwise `"stop"`. Labels
  `{start:"Start", stop:"Stop", restart:"Restart"}`.
- `canonicalRelayUrl(raw)` — mirrors `crates/buzz-core/src/relay.rs:normalize_relay_url`:
  parse as URL; reject non-`ws:`/`wss:`; lowercase host; fold `localhost`,
  `[::1]`, `127.*` to `127.0.0.1`; strip the default port (80/443); strip a
  root-path trailing slash; strip trailing slashes from the rendered URL.
  Returns `null` when unparsable.
- `findManagedAgentRuntime(runtimes, pubkey, relayUrl)` — match on lowercased
  pubkey AND (`relayUrl` exact ‖ `requestedRelayUrl` exact ‖ canonical match),
  keeping the exact-string checks as a fallback for unparsable stored URLs.
  **It must not collapse same-pubkey pairs** (test: "selects one relay without
  collapsing same-pubkey pairs").

`managedAgentReconciliationPlan.ts` — the pure planning core behind
`useManagedAgentRuntimeReconciliation`. Reconciliation is **incremental and
retrying**, not one-shot-per-mount: a newly configured relay must reconcile as
soon as it appears (without depending on a community switch), and a relay whose
reconcile failed (relay unreachable at launch, laptop waking from sleep) must
retry with a capped backoff.

- `RETRY_BACKOFF_MS = [5_000, 30_000, 120_000]`;
  `reconcileRetryDelayMs(failureCount)` is 1-based and returns `null` below 1
  and past the cap (= stop retrying until the community set changes).
- `canonicalCommunityRelays(communities, canonicalize)` → `Map<canonical, rawRelayUrl>`,
  dropping unparsable entries and duplicates (**first occurrence wins**), so the
  reconcile call still speaks the community's stored spelling while all
  bookkeeping is keyed canonically.
- `pendingReconcileRelays(canonicalToRequested, reconciled, inFlight)` →
  canonical URLs not yet cleanly reconciled and not in flight.
- `classifyReconcileResult(attempted, rows, canonicalize)` —
  `rows === null` (the call threw) marks the **whole batch** failed. Otherwise a
  relay failed iff it produced a `lifecycle === "failed"` row (matched on
  `requestedRelayUrl ?? relayUrl`, canonicalized). **A relay with no rows counts
  as reconciled** (no eligible agents there).

`managedAgentRuntimeHooks.test.mjs` pins the pair-restart ordering:
`test_pair_restart_stop_success_start_failure_clear_still_ran`,
`test_pair_restart_stop_failure_neither_clear_nor_start_called`,
`test_pair_restart_strict_stop_clear_start_ordering` — i.e. **stop → clear →
start**, and a failed stop performs neither clear nor start.

`managedAgentRuntimeReconciliation.test.mjs` pins the merge:
startup reconcile must not clobber a lifecycle update received in flight; it
must replace an *unchanged baseline* row with its newer result; and it must
preserve unrelated runtime rows.

Lifecycle frames also arrive over the observer relay
(`managed_agent_runtime_lifecycle` → `putManagedAgentRuntimeLifecycle`), whose
failure is downgraded to a debug log ("Late/untracked lifecycle frame dropped").

### 4.10 Start / stop / restart / delete semantics

`lib/managedAgentControlActions.ts`:

- `isManagedAgentActive(agent)` = `status === "running" || "deployed"`.
- `getManagedAgentPrimaryActionLabel(agent)` — provider backend:
  `"Shutdown"` when active else `"Deploy"`; local: `"Stop"` when active, else
  `"Respawn"` if `status === "stopped"`, else `"Spawn"`.
- `resolveManagedAgentChannelId(agent, ctx)` — `preferredChannelId` wins; else
  the relay agent's first `channelIds` entry; else resolve its first channel
  *name* to an id **only when exactly one channel matches**; else `null`.
- `startManagedAgentWithRules` — plain start. Relay-mesh agents are **not**
  blocked client-side; the backend start preflight
  (`ensure_relay_mesh_for_record`) re-resolves a live serve target and fails
  with an actionable error when no peer serves the model.
- `respawnManagedAgentWithRules` — for a **local, active** agent: stop, fire
  `onStopped()` (used to clear stale working badges at exactly that boundary),
  then start. Otherwise just start.
- `stopManagedAgentWithRules` — provider backend: resolve a channel (throw
  `"Cannot stop: agent is not in any channel"` if none) and
  `sendChannelMessage(channelId, "!shutdown", …, [agent.pubkey])`, returning
  `noticeMessage: "Shutdown command sent. Agent will stop shortly."`. Local:
  `stopManagedAgent(pubkey)`. **There is no substrate kill switch for a remote
  agent — stopping it is a message.**
- `deleteManagedAgentWithRules` — for a deployed provider agent with a
  `backendAgentId`, first send `!shutdown` if presence is `online`/`away`, then
  confirm one of three warnings ("may still be running / will be orphaned",
  "offline but the remote deployment may still exist", "not in any channel …
  will orphan the remote deployment"), each cancellable. Then delete with
  `forceRemoteDelete: true`.

### 4.11 Auto-restart on config drift — the safety-critical predicate

`lib/autoRestartPolicy.ts`. **SAFETY-CRITICAL:** the stop command is
SIGTERM → ≤1 s → SIGKILL with no in-process drain, so this predicate is the
only thing standing between the policy loop and killing a mid-turn agent.

```ts
type AutoRestartDecision = "fire" | "arm" | "hold";
AUTO_RESTART_QUIESCENCE_MS = 3 * 60 * 1000; // 18× the 10s liveness cadence
```

`decideAutoRestart(inputs)` returns `"hold"` (resetting the continuity window)
on **any** of: `!autoRestartEnabled`, `!needsRestart`, `!isLocalBackend`,
`!isRunning`, `!connected`, `working || workingSource !== "none"`
(both are checked even though they travel together, so a partial reader can't
slip through), or `edgeConsumed`. Otherwise `"fire"` when
`quiescentForMs >= AUTO_RESTART_QUIESCENCE_MS`, else `"arm"`.

`workingSource === "none"` is **ambiguous** (idle OR the observer stream is
absent) and is therefore never sufficient to fire on its own — the `connected`
gate plus the 3-minute continuity window carry that risk. The 3-minute window
is deliberately minutes-scale while the turn store prunes at 25 s.

`nextEdgeState(previous, {needsRestart, isRunning})` — one attempt per rising
edge; the edge **re-arms** when `needsRestart` falls **or** the agent stops
(so a manual stop/start cycle re-arms it).

Scope: the stop/start commands are pair-scoped to the active community and
`needsRestart` reports drift for that same pair — a fire bounces only the
community being viewed.

### 4.12 Bot naming

`lib/pickBotName.ts:pickBotName(namePool, usedNames)`:
1. Random unused name from the persona's own `namePool` (case-insensitive
   used-set).
2. Else random unused from the 30-entry `UNIVERSAL_POOL`
   (Alder, Brook, Coral, Dawn, Echo, Frost, Gale, Heath, Ivy, Jade, Kite, Luna,
   Maple, Nova, Opal, Pyre, Quartz, Rune, Silk, Thorn, Umber, Vale, Wisp, Yarn,
   Zinc, Brine, Cove, Drift, Elm, Fjord).
3. Else `"<base>-02"` … `"<base>-99"` on a random base from whichever pool was
   in play; final fallback `"<base>-<Date.now()%1000>"`.

### 4.13 Snapshots — export, send, import, and cards

Snapshots are the portable form of an agent: definition + optionally memory.

`desktop/src/shared/api/tauriPersonas.ts`:
- `SnapshotMemoryLevel = "none" | "core" | "everything"`;
  `SnapshotFormat = "json" | "png"`.
- `exportAgentSnapshot(id, memoryLevel, format, memorySourcePubkey?, avatarPngDataUrl?)`
  — save-to-disk path (opens the OS dialog).
- `encodeAgentSnapshotForSend(...)` → `{fileBytes:number[], fileName}` — in-memory
  path for sending into a channel. **Both call the same Rust encoder**, so byte
  output is identical for identical inputs.
  `ui/snapshotAvatarPng.ts:resolveSnapshotAvatarPng(avatarUrl)` prepares the
  PNG avatar for `format === "png"`.
- `previewAgentSnapshotImport(fileBytes, fileName)` → `AgentSnapshotImportPreview`
  — **decode + validate only, zero writes**. Fields: `displayName, isBuiltIn,
  model, runtime, systemPrompt, avatarUrl, memoryLevel, memoryEntryCount,
  hasSourceAllowlist, sourceAllowlistCount, sourceAllowlist (the FULL pubkeys,
  not just a count), manifestJson (validated + pretty-printed, full payload
  disclosure), locked`. A locked card that cannot be unlocked **fails with a
  refusal error and never reaches a preview**.
- `confirmAgentSnapshotImport({fileBytes, keepAllowlist})` → imports as a
  **brand-new agent with fresh keys**. `keepAllowlist` defaults to false
  ("Clear"). Result: `{displayName, newPubkey, personaId, memoryWritten,
  memoryTotal, memoryErrors[], profileSyncError}`.
- `reconcileInboundPersonaEvent(eventJson, arrivalRelayUrl)` — patches an
  inbound persona/team/agent projection into the local store. The **arrival
  relay URL is passed** so a workspace switch mid-flight cannot retain the event
  into the newly active community's scoped store.

**Snapshot import from URL.** `openSnapshotImportFromUrlEvent.ts` — a
module-scoped pending payload plus a window event, no localStorage, no context:
`PendingSnapshotImport = {fileBytes:number[], fileName, snapshotKind:"agent"|"team"}`.
`requestOpenSnapshotImport(payload)` clears any prior pending payload (so
double-clicks don't stack) and dispatches `"buzz:open-snapshot-import"`;
`consumePendingSnapshotImport()` is **one-shot** and clears;
`subscribeSnapshotImport(handler)` handles navigations while `AgentsView` is
already mounted. The caller (an `AgentSnapshotCard` in the timeline) must have
already fetched and verified the bytes **in memory**.
Tests pin: consume with nothing pending → `null`; request-then-consume returns
the payload; consume is one-shot; double-request replaces the pending payload.

**Agent trading cards** (`cardMintStore.ts`, `ui/AgentCardMintDialog.tsx`,
`ui/AgentCardViewerDialog.tsx`, `ui/CardMintComposerChip.tsx`). A mint is one
stateless ~2–3 minute Rust call (`mint_agent_card`). Owning the in-flight
promise in a **module store** rather than in the dialog is what makes the dialog
non-blocking: it dispatches and closes, a composer activity rail shows a live
"Minting card…" chip, and completion lands as a clickable toast plus a
persistent "card ready" chip — none of which need the dialog mounted.

```ts
CardMintInput = { agentId, agentName, styleNotes?, lock?, memoryLevel? };
CardMintJob   = { jobId, input, phase:"minting"|"done"|"error", card|null, error|null, startedAt };
CardViewerState = { card, agentName, remint: CardMintInput|null, viewerSeq: number };
```
- `runCardMintJob(input, mintFn)` — `mintFn` is injectable for tests;
  `startCardMint` binds the real command and is fire-and-forget.
  On success: toast `"<name>'s card is ready"` with a **"View card"** action
  (10 s duration). On error: strip the `NO_OPENAI_KEY:` wire prefix
  (`NO_OPENAI_KEY_PREFIX`) and show the plain instruction — the dialog
  pre-checks the key, so this only happens if the key was removed mid-flight.
- `viewMintedCardJob(jobId)` opens the viewer **and removes the job chip**.
- `viewerSeq` is a monotonic per-open sequence assigned by the store; the viewer
  keys content on it so switching cards remounts. **Card bytes cannot serve as
  the key** — every card PNG shares the same header prefix and dimensions.
- `remint` is present only for fresh mints; archive views have no original style
  notes, so they cannot be rerolled.
- `lock: true` NIP-44-encrypts the embedded manifest to the (owner, agent) pair
  — only those two keys can import it. Requires a linked agent instance, as do
  memory levels other than `"none"`.
- Archive: `listAgentCards()` → `ArchivedAgentCard{storedFileName, fileName,
  agentId, agentName, designerNotes, locked, memoryLevel, mintedAt,
  thumbJpegBase64|null}`; `loadAgentCard(storedFileName)`.
- `lib/agentCardGalleryState.ts:agentCardGalleryViewState(query)` —
  `{kind:"loading"|"error"|"empty"|"cards"}`. **Error wins over everything**:
  `data` falls back to `[]` at the call site, so checking emptiness first would
  render a failure as a false empty — "No cards yet" on a permissions/IPC
  failure tells someone their paid, persisted cards do not exist.
- `cardMintKeyStatus(id)` / `cardMintSaveOpenaiKey(key)` — the latter is a
  deliberately narrow seam: validated read-modify-write of the single key
  against the latest on-disk config, and unlike the general
  `set_global_agent_config` it **never restarts running agents**.

### 4.14 Persona catalog (community sharing)

`lib/personaCatalogRelay.ts`:
- `personaEventIsShared(event)` — exactly one `shared` tag, exactly two
  elements, value `"true"`. (Mirrors the Rust `event_is_shared` fail-closed rule.)
- `catalogPublicationsFromEvents(events)` — sort newest-first
  (`created_at` desc, `id` asc as tiebreak), **claim each `(pubkey, d)`
  coordinate before parsing** so an invalid or unshared newest head cannot
  resurrect an older shared definition, then keep only shared, parseable heads.
- `parsePersonaContent(event)` — requires a non-empty `display_name`. Avatar is
  accepted only when it is a safe http(s) URL (≤2048 chars, no whitespace or
  parentheses), an inline **percent-encoded** SVG (`data:image/svg+xml,` prefix,
  ≤8 KiB — the trailing comma is what rejects `;base64`), or an inline raster
  (`data:image/(png|jpeg|gif|webp);base64,` with valid base64 shape and length
  ≤256 KiB). `respond_to === "allowlist"` from the wire is **downgraded to
  `"owner-only"`** (a foreign allowlist means nothing locally). `parallelism`
  must be an integer in 1..=32.
- `fetchPersonaCatalogPublications()` — pages backwards using `until`
  (`CATALOG_PAGE_SIZE = 500`, `MAX_CATALOG_PAGES = 40`). Because the relay treats
  `until` as **inclusive**, consecutive pages overlap on tied timestamps, so the
  implementation must (a) dedupe by event id and (b) stop when a page contributes
  nothing new — otherwise a run of tied timestamps loops forever.
- `findLocalPersonaForCatalogEntry(local, {ownerPubkey, personaId, isOwn})` —
  an own publication is found by id (its `d` tag *is* the local id); a copy of
  another owner's entry has a fresh local id, so it is found by matching the
  stored `catalogSource` coordinate. This is what stops the catalog offering
  "Add" for an entry already added (which would mint a duplicate).
- `publicationToPersona` forces `shared: true` on the projection — catalog
  membership is relay-confirmed by the shared event itself and a local pending
  toggle must not override it.

`lib/personaSaveNotice.ts:personaSaveNotice(displayName, publicationStatus)`:
`"published"` → `Updated X and published it to the community catalog.`;
`"queued"` → `Updated X. Publishing to the community catalog is queued and will
appear after the relay accepts the update.`; `null` → `Updated X.` A
"published" message for an edit still in the outbox is the promise the
"Save and publish" button was making falsely.

`lib/catalog.ts` — `isPersonaActive`, `getActivePersonas`, `getLibraryPersonas`,
`isCatalogPersonaSelected`, `getPersonaLabelsById` (all keyed on `isActive`).

`lib/teamPersonas.ts:resolveTeamPersonas(team, personas)` →
`{hasMissingPersonas, isComplete, isUsable, missingPersonaCount,
missingPersonaIds, resolvedPersonaIds, resolvedPersonas}`; a team is *usable*
iff complete AND it resolved at least one persona. `getUsableTeams` filters on
that. `emptyResolvedTeamPersonas()` is complete-but-not-usable.

### 4.15 Agent-authored management requests (agents creating agents)

`agentManagement.ts` — an agent can *draft* a new agent or an edit to a
personal definition, but the human confirms it in the ordinary dialog. The
contract is **deliberately narrow and secret-free**.

```ts
AGENT_MANAGEMENT_REQUEST = "agent_management_request";
Create: { type, action:"create", requestId, request:{channelId, displayName, systemPrompt} }
Update: { type, action:"update", requestId, request:{channelId, agentName,
          displayName?, systemPrompt?, runtime?, provider?, model?, respondTo?} }
```

`parseAgentManagementRequest(payload)` (tests: `agentManagement.test.mjs`):
- Requires `type`, a non-blank string `requestId`, `action ∈ {create,update}`,
  and an object `request`.
- **`hasOnlyKeys` rejects any extra key** — "rejects an agent-management request
  with extra secret-shaped fields". Chat creation therefore **cannot** choose
  runtime, provider, model or access.
- Create requires non-blank `channelId`, `displayName`, `systemPrompt`.
- Update requires non-blank `channelId` and `agentName`, an optional
  `respondTo ∈ {undefined,"owner-only","anyone"}` (**never `allowlist`**), and at
  least one actual change — otherwise `null`.
- `createInputFromRequest` maps to `{displayName, systemPrompt}` only, so the
  create form opens with advanced behaviour unset and collapsed.
- `requestTargetsEditablePersona(persona)` — true only for a persona with **no
  `sourceTeam`** ("allows agents to update only personal, editable profiles").
  The target is resolved by the agent's **current display name**, never an
  internal profile id.

`agentManagementBuffer.ts:classifyAgentManagementOrigin(agents, channels, agentPubkey, channelId)`
→ `"buffer" | "accept" | "reject"`:
- `"buffer"` while `agents` or `channels` is `undefined` — **the trust decision
  is deferred until both ownership and channel membership have initialized**, so
  an ephemeral request cannot be lost during startup.
- `"accept"` iff the sender is an agent this desktop owns AND the claimed origin
  channel exists with `isMember === true` AND the agent is in that channel's
  `memberPubkeys`.
- `"reject"` otherwise.

`useAgentManagement.ts` glues it together: buffered requests (cap 100, FIFO
eviction) are replayed once both queries resolve; `seenRequestIds` dedupes;
only one request is presented at a time (`pendingRequestId`).
`assertAgentCanActFromOrigin(channelId)` re-checks at submit time and throws
`"An agent can only manage agents from a channel you both belong to."`.
Update errors: more than one matching persona →
`"More than one personal agent has that name. Rename it in Agents, then ask the
agent again."`; none → `"Agents can only update a personal agent profile by its
current name."`.

### 4.16 Deep-link events

- `openCreateAgentEvent.ts` — `"buzz:open-create-agent"` with
  `{channelId?, channelName?}`; module-level pending value +
  `consumePendingOpenCreateAgent()` + `subscribeOpenCreateAgent(handler)`.
- `openEditAgentEvent.ts` — `"buzz:open-edit-agent"` with
  `{pubkey, focus?}` where
  `EditAgentFocusTarget = {type:"env_key", key} | {type:"normalized_field", field}`
  (`env_key` scrolls the env editor to the matching required-key row and focuses
  its value input; `normalized_field` focuses `agent-provider` or `agent-model`).
  `consumePendingOpenEditAgent(pubkey)` returns the focus target, or `true` when
  a matching request had none, or `false` when nothing matches — and **clears**
  on consume. Pubkey compare is case-insensitive. A live subscriber handling the
  event also clears the pending state, so a subsequent `consume` returns `false`
  (test: `subscribeOpenEditAgent_afterLiveHandle_consumeReturnsFalse`).

### 4.17 React Query surface

`desktop/src/features/agents/hooks.ts` — keys:
`relay-agents`, `managed-agents`, `personas`, `acp-runtimes`,
`acp-auth-methods`, `managed-agent-prereqs`, `backend-providers`,
`git-bash-prerequisite`, `agent-config-surface/<pubkey>`,
`runtime-file-config/<runtimeId>`, `baked-build-env`, `baked-build-env-keys`,
`managed-agent-log/<pubkey>/<lines>`.

Notable policies:
- `useStartManagedAgentMutation` writes the returned agent into the
  `managed-agents` cache optimistically on success, then invalidates in the
  background.
- Mutations that change identity (`useUpdateManagedAgentMutation`,
  `useUpdatePersonaMutation`) also invalidate `user-profile/<pubkey>` and any
  `users-batch` query containing that pubkey — an agent is a member, so its
  profile must refresh everywhere.
- `useManagedAgentLogQuery(pubkey, lineCount = 120)` — `retry:false`,
  `staleTime 3s`, `refetchInterval 30s`.
- `useAgentConfigSurface(pubkey)` — `staleTime 10s`, `refetchInterval 30s`;
  invalidated on `session_config_captured` (§2.3) via
  `observerRelayStore.setSessionConfigCapturedCallback`.
- `useBakedBuildEnvKeysQuery` / `useBakedBuildEnvQuery` — internal builds bake
  provider credentials into the binary at compile time; these return **key names
  only** (and masked values) so dialogs can treat baked keys as satisfying
  requirements, mirroring the backend readiness gate. `staleTime: Infinity`,
  `retry:false`, failing soft in web/E2E where the command doesn't exist.
- `useRuntimeFileConfigQuery(runtimeId)` — file-layer config (e.g.
  `~/.config/goose/config.yaml`) so dialogs show "Set in goose config" instead
  of a false required-field marker.

---

## 5. Turns

### 5.1 What triggers a turn

1. **`@mention`** — a kind:9 stream message with the agent's pubkey in a `#p`
   tag, in a channel the agent is a member of. This is the default
   (`SubscribeMode::Mentions`, default kinds `[9, 46010, 40007]`,
   `require_mention = !no_mention_filter`).
2. **DM** — the same event flow in a channel whose metadata resolves to
   `channel_type === "dm"` (`relay.rs:channel_type_from_tags`: declared `t=dm`
   or a `hidden` tag → `"dm"`; `t=private` or `private` → `"private"`; else
   `"stream"`).
3. **Job request kinds** — `43001` (request) and the surrounding `43002–43006`
   protocol.
4. **Forum kinds** `45001/45002/45003` — opt-in, and require
   `--no-mention-filter` / `require_mention = false` because forum posts don't
   @mention.
5. **Heartbeat** — `--heartbeat-interval` seconds on an idle agent
   (`0` = disabled; must be `0` or ≥10). Rules: lower priority than queued
   events; **skipped, never queued, when all agents are busy**; at most one
   heartbeat in flight globally; the default prompt calls `get_feed_actions()`
   and `get_feed_mentions()`.
6. **Subscription rules** (`SubscribeMode::Config`) — ordered
   `SubscriptionRule{name, channels: "all"|[uuid…], kinds[], require_mention,
   filter (evalexpr), prompt_tag}` with **first match wins**. Filters are
   pre-compiled at startup (`compiled_filter`), evaluated with a hard timeout,
   and a rule that hits `MAX_CONSECUTIVE_TIMEOUTS` consecutive timeouts is
   **treated as disabled — fail closed** (`consecutive_timeouts` is an
   `AtomicU32` so `match_event` needs only `&self`). `FilterContext` exposes
   `content, author, kind, channel_id, timestamp`.

The **author gate runs before subscription rules** (§4.2), and owner control
commands run before the gate.

### 5.2 Turn execution (buzz-acp)

`crates/buzz-acp/README.md`, "How It Works":
1. Spawn N agent subprocesses (default 1, `--agents` / `BUZZ_ACP_AGENTS` in
   `1..=32`), ACP `initialize` each, connect to the relay with NIP-42 auth.
2. Discover channels via the relay REST API (`?member=true` by default) and
   subscribe. Membership notifications auto-subscribe to new channels.
3. Event loop; events queue **per channel**.
4. When events are pending and no prompt is in flight for that channel, drain
   **all** queued events for the *oldest* channel into a single batched prompt
   (`session/prompt`).
5. The agent replies using the Buzz CLI/MCP tools.
6. Recovery: respawn a crashed agent; reconnect with a `since` filter after a
   relay drop.

**Each channel has at most one prompt in flight.** Multiple channels process
concurrently when `agents > 1`. All N subprocesses share **one** Nostr identity
— users see one bot. Cross-channel message ordering is not guaranteed for N>1.
On startup the harness replays all unprocessed @mentions since the last run.

`--lazy-pool` (`BUZZ_ACP_LAZY_POOL`): connect, subscribe and queue accepted work
*before* starting ACP/LLM subprocesses; the first accepted event wakes one pool
initialization task, and failures retry with bounded exponential backoff while
work remains.

Circuit breaker: `CIRCUIT_BREAKER_THRESHOLD = 3` crashes in a
`CIRCUIT_BREAKER_WINDOW = 60s` opens a slot's circuit. Panics count as crashes;
the panicking task already dropped the `AcpClient`, so recovery checks the
circuit and spawns a fresh agent in the background, and clears the wedged
in-flight channel (or `heartbeat_in_flight`) from the queue.

Timeouts: `BUZZ_ACP_IDLE_TIMEOUT` (default 620 s — max silence before
cancelling a turn, reset on **any** agent stdout activity) and
`BUZZ_ACP_MAX_TURN_DURATION` (default 7200 s — absolute wall-clock cap, a safety
valve). Legacy `BUZZ_ACP_TURN_TIMEOUT` is still accepted.

### 5.3 Prompt shape

`crates/buzz-acp/src/queue.rs:format_prompt(batch, args)` returns the sections
as **separate blocks**, not one joined string, so the observer frame's size
trimmer (`fit_observer_event_to_budget`) can elide an oversized section's *body*
in place while leaving every `[Header]` line at the head of its own leaf — the
desktop "Prompt context" panel therefore always counts every section.

Order:
0. `[Base]` — `base_section(base_prompt)`, **legacy agents only**
   (`protocol_version < 2`).
1. `[System]` — legacy only.
1b. `[Team Instructions]` — legacy only, when non-blank.
2. `[Agent Memory — core]` (`engram_fetch::build_core_section`) and
   `[Channel Canvas]` — legacy only. Modern agents receive base/system/team/core
   /canvas via the **system role in `session/new`**.
3. `[Context]` — scope, channel name, contextual hints, plus a **reply anchor**.
4. `[Thread Context]` / `[Conversation Context]`.
5. Cancel/re-prompt framing (see below), then `[Buzz event: <prompt_tag>]` for a
   single event or `[Buzz events — N events]` with
   `--- Event i (<prompt_tag>) ---` blocks.

**Scope is always derived from the LAST event in the batch** — the one the agent
is responding to. Thread/DM context is supplementary, never a scope override, so
a mixed batch (thread reply then a later plain message) is not mislabelled.

**Reply anchoring** keeps human-facing threads readable at layer 1: in a thread
→ anchor to the thread ROOT (no depth-2 nesting); top-level → anchor to the
triggering event (which becomes the new root). Agent↔agent turns get no forced
anchor (deep nesting is intentional there). DMs are always 1:1 with a human, so
they always anchor. A turn is human-facing when the triggering sender is a
human, OR a human other than this agent is tagged in the triggering event.

**Cancel + re-prompt framing** (`MergeFraming::for_reason(batch.cancel_reason)`):
- `CancelReason::Interrupt` — the new request *supersedes* the interrupted work.
- `CancelReason::Steer` (default) — a message arrived while the agent was
  working; it should *continue* its work and weave the message in if relevant.
Cancelled events are rendered under `framing.prior_header`, new events under
`new_header_single` / `new_header_multi_prefix`, and a `closing_note` follows.

### 5.4 The active-agent-turn store

`desktop/src/features/agents/activeAgentTurnsStore.ts` — the derived liveness
model. This is the trickiest file in the module; every constant is load-bearing.

```
LIVENESS_INTERVAL_MS  = 10_000            // BUZZ_ACP_TURN_LIVENESS_SECS
REMOVE_AFTER_MS       = 25_000            // interval * 2.5
FRAME_GAP_PAUSE_MS    = 20_000            // interval * 2  (< REMOVE_AFTER_MS)
PRUNE_PAUSE_MAX_MS    = 180_000           // 3 minutes
MAX_TURNS_PER_AGENT   = 32                // the harness's --agents upper bound
MAX_TERMINAL_TOMBSTONES = 128             // MAX_TURNS_PER_AGENT * 4
PRUNE_INTERVAL_MS     = 5_000
```

`MAX_TURNS_PER_AGENT` is at the harness's *hard* upper bound (32), not the
desktop default of 24, because any lower value silently evicts a live turn and
drops its working badge (test: "tracks every turn of a high-parallelism agent
working in 24 channels").

State: `activeTurnsByAgent: Map<agentKey, Map<turnId, ActiveTurn>>` where
`ActiveTurn = {turnId, channelId, startedAt, lastActivityAt}`;
`clockOffsetByAgent`; `lastProcessed` (watermark); `terminalAtByAgent`
(tombstones); caches `cachedTurnSummaries` / `cachedChannelTurnSummaries`.

**Watermark gating.** `processEvent` compares every event against the last
processed one with `compareObserverEvents` and drops anything not strictly
newer. With sorted buffers (the documented invariant — `syncAgentTurnsFromEvents`
must receive `(timestamp, seq)`-ascending arrays or silent data loss follows),
this makes a full-buffer replay a complete no-op, and it handles post-restart
streams for free (`seq` resets to 1, `timestamp` keeps climbing). **Evictions
are gated too**: replaying a stale `turn_error`/`agent_panic` (which may carry a
null `turnId`) would otherwise fall back to deleting the first turn in the
channel and kill the live one.

**Clock offset.** `sampleClockOffset(agentKey, timestamp)` keeps the running
**minimum** of `Date.now() - Date.parse(timestamp)`. The minimum converges on
true skew minus the smallest network/processing delay seen — a monotonically
tightening estimate immune to per-event jitter, conservative while skew is
constant or shrinking. Under *growing* skew the stored estimate goes
stale-too-small and elapsed over-reports, bounded by how far the skew grows
(sub-second over a session). Unparseable timestamps contribute no sample. A
tightened offset invalidates the cache so **every live anchor shifts
retroactively** and notifies even when the event surfaced no turn change.

**Anchors are derived at read time**, not stored: `anchorAt = startedAt + offset`.
This is why distinct agent starts yield distinct anchors (no lockstep) and a
turn started long ago anchors into the past (large elapsed) rather than resetting
to `Date.now()`.

Per-kind handling:
- `turn_started` (needs `channelId`) → `startTurn(pubkey, channelId,
  turnId ?? "seq-<seq>", timestamp)`. At cap, evict the oldest `startedAt`.
  `startedAt` falls back to `Date.now()` on an unparseable timestamp.
- `turn_completed` | `turn_error` | `agent_panic` → `endTurn(pubkey, turnId,
  channelId, Date.parse(timestamp))`. With an explicit `turnId`, **record the
  tombstone even when the live map is already gone** — the completion is
  authoritative and must outlive the active record. Without a `turnId`, fall
  back to the **first** turn matching `channelId` and tombstone that one.
- `acp_read` | `acp_write` | `turn_liveness` → `recordActivity` refreshes
  `lastActivityAt`. If the turn is not in the live map, attempt `resurrectTurn`.

**Resurrection (A) gated by completion (C).** `resurrectTurn(pubkey, event)`
requires `turnId` and `channelId`; it revives only when the frame is **strictly
newer** than any recorded terminal timestamp for that turn. The frame's original
`startedAt` envelope field is used to preserve the elapsed timer *when valid and
not later than the frame itself*; old, malformed, or impossible-future starts
fall back to the frame timestamp. Tombstones are bounded at
`MAX_TERMINAL_TOMBSTONES` with oldest-first eviction (insertion order tracks
completion order closely enough).

**Prune pause (B).** `pruneExpired` runs every 5 s. For each agent,
`shouldPausePrune(agentTurns, now)` returns true when **every** tracked turn for
that agent has been silent for more than `FRAME_GAP_PAUSE_MS` and less than
`PRUNE_PAUSE_MAX_MS` — the "all at once" signature of that agent's frame stream
being down. Other agents' activity has **no** effect. A single fresh sibling
means a stale turn is genuinely dead and still prunes at 25 s. After the
3-minute cap, a silent agent is treated as dead and prunes.

Reads:
- `getActiveTurnsForAgent(pubkey)` → `ActiveTurnSummary[] = {channelId, anchorAt}`,
  collapsing multiple turns in one channel to the **earliest** start, sorted by
  `channelId`, reference-stable while unchanged (a `useSyncExternalStore`
  requirement). Null/undefined pubkey → the shared `EMPTY_TURNS`.
- `getActiveTurnsByChannel()` → `ActiveChannelTurnSummary[] = {channelId,
  anchorAt, agentCount, agentPubkeys[], agentNames?}` across all agents,
  anchored to the earliest live turn.

Lifecycle helpers:
- `clearActiveTurnsForAgent(pubkey)` — called when Desktop itself stops or
  restarts an agent, so badges don't wait out the 3-minute backstop. It
  **preserves the watermark** (otherwise a replayed `turn_started` would
  immediately resurrect the badge) and the clock offset, and **tombstones every
  cleared turn** at the agent-clock now, so an in-flight `turn_liveness` already
  on the wire at kill time cannot resurrect it. A restarted agent's genuinely new
  turns carry new ids / newer timestamps and are unaffected.
- `resetActiveAgentTurnsStore()` — clears everything **except**
  `savedByCommunity` (community-switch snapshots must survive the reset that
  runs between save and restore).
- `saveActiveAgentTurnsForCommunity(id)` / `restoreActiveAgentTurnsForCommunity(id)`
  / `clearSavedCommunitySnapshot(id)` — deep-clones all four maps; a save with
  both turns and tombstones empty *deletes* any prior snapshot; restore
  **replaces rather than merges** (clearing first, so the function is
  self-contained), **refreshes `lastActivityAt = now` on every restored turn**
  so the 25 s prune doesn't immediately kill turns saved long ago, and
  **consumes** the snapshot (one round-trip per community).
- `syncActiveAgentTurnsFromObserver(agents)` — only agents with
  `status === "running" || "deployed"` are synced.
- `useActiveAgentTurnsBridge(agents)` re-syncs on every observer store change.

### 5.5 The unified working signal

`desktop/src/features/agents/agentWorkingSignal.ts`. **Every** surface that
shows a working affordance (sidebar channel badges, profile badges, agent rows,
composer activity bar, activity panel header, thread ingresses) must read from
this module rather than picking one of the underlying pipes.

```
1. Observer-derived active turns (kind 24200 → activeAgentTurnsStore) are the
   PRIMARY signal — they carry channel scope and a start anchor.
2. Bot typing indicators (kind 20002, mirrored in via reportChannelBotTyping)
   are the FALLBACK for agents whose observer stream is absent for that scope
   (e.g. a remote harness without a relay observer, or frames not yet arrived).
```

**Scope rule:** with a `channelId`, "working" means working *in that channel*;
without one, "working" means any active work in any channel (the all-channels
rule the activity panel uses).

```ts
type AgentWorkingSource = "observer" | "typing" | "none";
type AgentWorkingChannel = { channelId; anchorAt; source: "observer"|"typing" };
type AgentWorkingState  = { working: boolean; source; channels: AgentWorkingChannel[] };
```

- `reportChannelBotTyping(channelId, pubkeys)` — call with the **full current
  set** (empty clears the channel). First-seen timestamps are preserved across
  re-reports so elapsed anchors stay stable; an unchanged set is a no-op.
- `computeAgentWorkingState(pubkey, channelId)` — observer channels first, then
  typing channels **not already covered by observer**; sorted by `channelId`.
  `channels` is always the **unscoped** list; `source` is computed over the
  scoped subset: `"observer"` if any scoped channel is observer-backed, else
  `"typing"` if any scoped channel exists, else `"none"`. `working = source !== "none"`.
- `getWorkingChannels()` — observer-primary merge: typing-only agents fold into
  an existing observer summary (bumping `agentCount`); channels with only typing
  get a typing-sourced summary anchored to the earliest first-seen typing.
- `getWorkingAgentPubkeysForChannel(channelId)` — observer ∪ typing, normalized
  and sorted.
- All snapshots are reference-cached because **React reads a snapshot before it
  subscribes**, so they must be stable even with no listeners yet.
- `resetAgentWorkingSignal()` for community switches.

### 5.6 What the UI draws while an agent is thinking

- `ui/TurnLivenessIndicator.tsx` — three staggered `FuzzyLogo` marks
  (`STAGGER_SECONDS = 0.25`, `CYCLE_SECONDS = 1.8`, opacity `[0,1,1,0]`,
  `y [4,0,-1,-4]`, `times [0,0.3,0.7,1]`, infinite repeat) at `opacity-25`,
  `role="status"`, `aria-label="Agent turn in progress"`. When transcript
  animations are disabled **or** `prefers-reduced-motion`, it degrades to a
  single looping `FuzzyLogo` (`loop`, `loopRestSeconds: 2`). `fuzz` defaults to
  false because the indicator stays mounted for whole turns.
- `AgentStatusBadge` "Working" pill with `motion-safe:animate-pulse` (§3.4).
- Channel-level badges keyed off `useWorkingChannels()` /
  `useChannelWorkingAgentPubkeys(channelId)`, each rendering an elapsed counter
  anchored at `anchorAt`. The hooks re-render when the **channel set** changes,
  not when the clock ticks — the elapsed display ticks locally.
- Observer connection state pill (`ManagedAgentSessionPanel:ObserverStatusBadge`):
  `open`→"Live" (`CircleDot`, default), `connecting`→"Connecting" (Spinner,
  secondary), `error`→"Unavailable" (`XCircle`, destructive), `closed`→"Closed"
  (`Clock3`), `idle`→"Idle" (`Clock3`).

### 5.7 Streaming / partial output

Streaming is the ACP `session/update` notification stream, surfaced through
`acp_read` observer frames and folded into transcript items
(`ui/agentSessionTranscript.ts:processTranscriptEvent`). Update types handled:

| `sessionUpdate` | Transcript effect |
|---|---|
| `agent_message_chunk` | Append into the open assistant message keyed `assistant:<ch>:<messageId ?? turnKey>` |
| `user_message_chunk` | Append into `user:<ch>:<…>`; **suppressed** when a steer already rendered the user message for this turn (Goose echoes steered content back) |
| `agent_thought_chunk` | Append into `thinking:<ch>:<…>` (render class `thought`) |
| `tool_call` | Upsert tool item, status defaulting to `executing` |
| `tool_call_update` | Upsert same item, status defaulting to `completed`; `isError = status === "failed"` |
| `plan` | Replace plan text; on change also push a `Plan updated` marker |
| `current_mode_update` | Lifecycle "Mode" |
| `usage_update` | **Replace** (not append) `Tokens: used/size` (+ `($x.xxxx CUR)` when cost is present) |
| `available_commands_update` | Lifecycle "Commands available: N" |
| `config_option_update` | Lifecycle "Config" with `name = value` pairs |
| anything else | Only surfaced when the payload carries an explicit `title` + `text` (`describeFreeformStatus`); otherwise dropped rather than guessed at |

Message accumulation rules (`upsertMessage`): text appends into the currently
active key for that id unless the key has been **sealed**. `sealOpenMessages` is
called whenever a non-message item is pushed, so a tool call between two chunks
starts a new bubble (`<id>:c<continuationSeq>`) instead of retro-appending.

Tool merge rules (`upsertTool`): a generic title never overwrites a specific
one; the canonical Buzz tool name wins for both `toolName` and `buzzToolName`;
`mergeToolStatus` never regresses a terminal status (`completed`/`failed`) back
to non-terminal; args only replace when non-empty; `result` and `isError` are
sticky; `completedAt` is set once, at the first terminal status.

Permission round-trip: an `acp_*` frame with method
`session/request_permission` creates a `permission` lifecycle item and indexes
it by **JSON-RPC id** (`jsonRpcId` uses `JSON.stringify` so the number `1` and
string `"1"` cannot collide; objects/booleans/null return `null`). The matching
`acp_write` response (same id, **no** `method`) writes an `outcome` onto the item
via `describePermissionOutcome`: `"cancelled"` → `"Cancelled"`; `"selected"` +
optionId → `"<Approved|Denied> (<kind>)"` where any `kind` starting with
`reject` is a denial; anything else passes through. The pending entry is then
removed.

`session/new` handling: the base + persona prompts ride `params.systemPrompt`,
framed by the harness as `[Base]` / `[System]` / `[Agent Memory — core]` /
`[Channel Canvas]`. The metadata item is keyed
`system-prompt:<ch>:<seq>:<timestamp>` — the same `(seq, timestamp)` dedup pair
the store uses — so distinct sessions keep their own system-prompt card even
across archive rebuilds where two processes may emit the same `seq`. It is
stored with `turnId: null` (keeping it out of turn buckets) and
`acpSource: "session/new"` so the grouper can place it as a standalone card
before the session's first turn.

### 5.8 Cancellation

- User-initiated: `cancelManagedAgentTurn` → an owner **control** frame
  `{type:"cancel_turn", channelId}` → `CancelManagedAgentTurnResult
  {status: "sent" | "no_active_turn"}`. Best-effort: control frames can be
  dropped, so the command is advisory and idempotent.
- Owner chat command `!cancel` (kind:9, `p`-tagging the agent) — same effect,
  bypasses the author gate.
- `!rotate` — cancel + invalidate the channel session, or invalidate the cached
  idle session immediately; the next event starts fresh.
- Harness-internal: idle timeout (620 s of silence) and max-turn-duration
  (7200 s) both cancel.
- A cancellation caused by newly arrived events **re-prompts** rather than
  dropping work: the batch is requeued with `CancelReason::Steer` framing
  ("continue your work, weave this in") or `Interrupt` framing ("this supersedes
  the interrupted work").
- ACP `StopReason` maps to the NIP-AM stop reason via `pool.rs:acp_stop_to_core`:
  `EndTurn→EndTurn`, `Cancelled→Cancelled`, `MaxTokens→MaxTokens`,
  `MaxTurnRequests`/`Refusal`→`Unknown`.

### 5.9 Errors and retries

- `turn_error` payload `{outcome, error, code?}`; `agent_panic` payload
  `{outcome:"panic", error:"Agent task panicked: <join_error>"}`.
- Error classification seam (`lib/friendlyAgentLastError.ts`, documented in
  full there): **buzz-agent** classifies LLM failures into `AgentError` variants
  with JSON-RPC codes (`-32001` auth, `-32002` model-not-found, `-32000`
  generic) → **buzz-acp** preserves the code structurally in
  `AcpError::AgentError{code,message}` (Display:
  `"Agent reported error (code N): message"`) and includes `code` in
  `turn_error` → the **desktop supervisor** recovers `{message, code}` from the
  log tail into `ManagedAgent.lastError` / `lastErrorCode`.
- `friendlyAgentLastError(raw, code?)` → `null` for null/blank;
  otherwise `{severity: "denied"|"generic", copy}`. Dispatch order:
  1. Structured `code`, else a code embedded in the message via
     `/^Agent reported error \(code (-?\d+)\): /`.
  2. `-32001` → `severity:"denied"`, `RELAY_MESH_DENIED_COPY =
     "Community access denied this agent — check its community membership."`
  3. `-32002` → `severity:"denied"`, `MODEL_NOT_FOUND_COPY = "The configured
     model is not available — open agent settings and select a different one
     from the dropdown."`
  4. `-32603` → if the remainder after stripping the ACP wrapper is exactly
     `"Internal error"`, substitute `CLI_ACP_INTERNAL_ERROR_COPY` (the
     codex-acp model-support hint); **otherwise preserve the adapter's specific
     detail** rather than burying actionable information.
  5. **A structured code we don't recognize is authoritative** — string patterns
     must not cross-classify it; return the raw text as `generic`.
  6. Legacy string fallback only when there was no code: prefixes
     `"Agent reported error: llm auth:"` or `"llm auth:"` → denied.
- `friendlyTurnErrorCopy(raw, code)` — the observer-payload convenience that
  coerces an untyped `code` and falls back to the raw text.
- Retries: the harness respawns a crashed agent (subject to the circuit
  breaker) and reconnects to the relay with a `since` filter. The desktop
  retries relay reconciliation on the `[5s, 30s, 2m]` backoff (§4.9). There is
  no automatic re-prompt of a failed turn — a failed turn surfaces as a
  transcript lifecycle item and, when it exits the process, as `lastError`.

### 5.10 Attachment failures

Two distinct failure surfaces:
- **Channel attachment** — `AgentChannelAttachmentFailure {channelName, error}`
  (`channelAttachmentFailure.ts`), produced when an agent was created but its
  channel membership write failed. `useCreatedAgentChannelAttachment.ts` /
  `ui/RequestedAgentCreateDialogs.tsx` present the created agent along with the
  attach outcome so the user can retry the attach without recreating the agent.
- **Batch create** — `CreateChannelManagedAgentBatchFailure {kind, name,
  personaId, error}` per input, alongside the successes; the loop never aborts
  early.

Also note: `createManagedAgent` returns `Ok` even when deployment failed —
`spawnError` carries the message, so `provisionChannelManagedAgent` explicitly
throws on a non-null `spawnError`.

---

## 6. Agent activity — the transcript

### 6.1 Observer relay store

`desktop/src/features/agents/observerRelayStore.ts` — the single ingestion point.

```
MAX_OBSERVER_EVENTS = 3000                // per-agent live cap
MAX_PENDING_UNKNOWN_AGENT_FRAMES = 100    // startup buffer
```

Two strictly separated windows:
- `eventsByAgent: Map<agentKey, ObserverEvent[]>` — the **live** relay path,
  capped.
- `archiveEventsByChannel: Map<`${agentKey}:${channelId}`, ObserverEvent[]>` —
  paged SQLite history, **uncapped** and **never written by live events**. The
  separation is strict so loading deep history can never evict live frames or
  vice versa.

UI consumers merge the raw events from both sources and derive `TranscriptState`
**once** over the combined window, so stateful aggregates (tool start/update,
plan replacement, permission request/response) are never split across two
independent state machines.

Security gates on both the live path (`handleRelayObserverEvent`) and the
archive path (`ingestArchivedObserverEvents`):
1. Must have an `agent` tag and `frame === "telemetry"`.
2. The `agent` tag must be in the trusted set `knownAgentPubkeys` (see below).
3. **Defense in depth:** `normalizePubkey(event.pubkey)` must equal
   `normalizePubkey(agentTag)` — the relay gates on `is_agent_owner`, but a
   compromised relay could misroute.
4. Decrypt via `decryptObserverEvent`. Live decrypt failures set connection
   state to `error`; archive decrypt failures are silently dropped.

**Trusted-set union.** `knownAgentsBySubscription: Map<subscriptionId, Set>` and
`knownAgentPubkeys` = the union. Multiple `useManagedAgentObserverBridge`
callers (channel screen + profile panel) can be mounted at once with different
lists; keying each subscriber's contribution and recomputing the union stops
co-mounted callers clobbering each other.

**Startup buffering.** Ownership data arrives asynchronously. While
`knownAgentsBySubscription` is empty or the union is empty, raw signed frames for
unknown agents are buffered (FIFO, cap 100) and re-run through the same gate when
the first trusted set registers. Once initialized, unknown agents are rejected
immediately.

**Ordering.** `compareObserverEvents(l, r)` — timestamp difference first (only
when both parse finitely), then `seq`. `isObserverEventAfter(candidate, stored)`
is the strict-after variant, extracted so latest-live advancement cannot drift
from transcript ordering.

`appendAgentEvent` dedupes on `(seq, timestamp)`, sorts, trims from the front at
cap, and then takes a **fast path** (incremental `processTranscriptEvent`) when
the new event landed at the end and nothing was trimmed, else a **slow path**
(full `buildTranscriptState` rebuild) for out-of-order arrival or a trim.

`appendArchivedChannelEvent` dedupes identically, sorts (archive pages arrive
newest-first from SQLite so each new event sorts *before* existing entries), and
**never** caps. It returns whether state changed so the caller can batch a single
notify per page.

`latestLiveSessionByAgentChannel: Map<`${agent}:${channel}`, {sessionId,
timestamp, seq}>` — "latest-live" means the sessionId that most recently arrived
**via the live relay path**. It is NOT derived from `connectionState` or an
ever-live `Set` (which would incorrectly mark session A "current" after session B
started). It advances only when the parsed event sorts strictly after the stored
entry, so a late live frame from an older session can't regress it, while a
same-timestamp higher-seq frame still advances it.

Side dispatches on decrypted frames:
- `session_config_captured` → `putAgentSessionConfig(pubkey, payload)` +
  `onSessionConfigCaptured(pubkey)` (React Query invalidation).
- `control_result` → `dispatchControlResult` to per-agent subscribers
  (`subscribeControlResults`), used by the ModelPicker to learn the async
  outcome of a fire-and-forget `switch_model`.
- `managed_agent_runtime_lifecycle` → `putManagedAgentRuntimeLifecycle`.
- Any payload parsing as an `AgentManagementRequest` → agent-management
  listeners (§4.15).

`ensureRelayObserverSubscription()` — idempotent, guarded by `startPromise`, and
generation-fenced: `resetAgentObserverStore()` bumps `generation`, so an
in-flight subscribe that completes afterwards unsubscribes itself and every
handler result from the old generation is discarded. All event handling is
serialized through a promise chain (`eventProcessingQueue`).

`shouldObserveManagedAgents(agents)` = `agents.length > 0`. Tests:
observer ingestion **opens for a cold stopped managed agent** (archived frames
must be readable) and stays closed only when there are no owned agents.

`getAgentObserverSnapshot(pubkey, _enabled)` — `_enabled` gates the *relay
subscription* only, never store reads: archived frames are ingested regardless of
live status and must be readable by idle-agent panels showing channel history.

Test-only escape hatches, never exported from the feature barrel:
`injectObserverEventsForE2E`, `_testRegisterKnownAgents`,
`_testGetArchivedChannelEvents`, and `syncAgentObserverEvents` for replay
harnesses.

### 6.2 App-level ingestion

`useAgentObserverIngestion.ts` — mounted **once** in `AppShell`. The product
invariant: *if the current identity owns an agent (local managed or
declared-owned relay agent), its turn activity is ingested app-wide* — not only
while a panel that happens to mount a bridge is open.

`combineObserverIngestionAgents(managedAgents, relayAgentPubkeys, ownerByPubkey, currentPubkey)`
— managed agents keep their real status; relay agents whose profile
`ownerPubkey` normalizes to the current pubkey and which are not already managed
are folded in as `status: "deployed"` so the subscription starts and their frames
decrypt. Registering non-owned agents would be pointless: observer frames are
`#p`-addressed to the owner, so frames for agents we don't own never arrive.
The hook **mounts before identity resolves by design** (managed agents only until
then) — gating it on identity/startup readiness would drop managed-agent
observer coverage during startup.

### 6.3 Transcript model

`ui/agentSessionTypes.ts` + `ui/agentSessionTranscript.ts`.

```ts
type TranscriptState = {
  items: TranscriptItem[];
  itemsById: Map<string, TranscriptItem>;
  activeMessageKey: Map<string, string>;   // logical id → currently-open item key
  sealedKeys: Set<string>;
  triggeringEventIdsByTurn: Map<string, string[]>;
  pendingPermissions: Map<jsonRpcId, {itemId, optionNames: Map<optionId,kind>}>;
  continuationSeq: number;
  latestSessionId: string | null;
};
```

`TranscriptItem` variants: `message` (role assistant|user, `messageId`,
`authorPubkey`), `thought`, `plan` (+ `isUpdate`, `targetId`), `lifecycle`
(renderClass `status|permission|error`, optional `outcome`, optional
`descriptor`), `metadata` (renderClass `raw-rail`, `sections: PromptSection[]`),
`tool` (descriptor, `toolName`, `buzzToolName`, `status`, `args`, `result`,
`isError`, `startedAt`, `completedAt`). All carry
`{turnId?, sessionId?, channelId?}` and an `acpSource` wire label.

`AgentActivityRenderClass` = `message | relay-op | file-edit | file-read |
skill-read | image | shell | status | thought | plan | permission | error |
generic | raw-rail | suppressed`.
`AgentActivityTone` = `read | write | admin | neutral`.
`AgentActivityDescriptor` = `{renderClass, label, preview, action?{verb,object},
tone?, operation?, object?, source?: "mcp"|"shell"|"acp"|"harness"|"fallback",
groupKey?, reason?}`.

Item keys (all channel-scoped, `ch = channelId ?? "global"`):
`raw-json-rpc:<ch>:<seq>`, `turn:<ch>:<turnId ?? seq>`,
`session:<ch>:<turnId ?? seq>`, `parse-error:<ch>:<seq>`,
`<kind>:<ch>:<turnId ?? seq>` for `turn_error`/`agent_panic`,
`permission:<ch>:<turnId ?? seq>`, `prompt:<ch>:<…>`,
`prompt-context:<ch>:<…>`, `system-prompt:<ch>:<seq>:<timestamp>`,
`steer:<ch>:<…>`, `steer-context:<ch>:<…>`, `assistant|user|thinking:<ch>:<messageId ?? turnKey>`,
`tool:<ch>:<toolCallId ?? "tool:<seq>">`, `plan:<ch>:<turnKey>`,
`mode|usage|commands|config:<ch>:<turnKey>`,
`status:<ch>:<turnId ?? seq>:<statusType>`.

`turn_error`/`agent_panic` render as `"<outcome>: <friendlyTurnErrorCopy(error, code)>"`
titled `"Turn error"` / `"Agent error (crash)"`.

Lifecycle text **joins with `\n`** on update (`joinLifecycleText`), except
`replaceLifecycleItem` which **replaces** — used for coalescing fields like
`usage_update` where only the latest value is meaningful.

Plan updates: on a text change the plan item is replaced *and* a
`Plan updated` marker is pushed with a computed summary
(`summarizePlanUpdate`): if the text contains `[ ]`/`[x]` checkboxes →
`"<completed>/<total> complete"`; else count lines matching
`/^\s*(?:[-*]|\d+[.)])\s+\S/` → `"N step(s)"`; else empty.

`maybeNostrEventId(id)` — only a 64-hex string counts as a real event id.
`getSingleTriggeringEventId` returns the triggering event id only when the turn
had **exactly one** trigger (so a batched prompt doesn't mis-link).

Immutability: `TranscriptDraft` + `ensureMutable` lazily copies `items` and
`itemsById` on first mutation, so `processTranscriptEvent` returns the *same*
state object when nothing changed and `latestSessionId` is unchanged.

### 6.4 Tool classification

`ui/agentSessionToolClassifier.ts:classifyTool(input)` — ordered providers,
first non-null wins, and any error re-labels to `renderClass:"error"` with a
`"… failed"` suffix (idempotent — it won't double-append):

1. `classifyLoadSkillTool` — any of title/toolName/buzzToolName normalizing to
   `load_skill`. `renderClass:"skill-read"`; a skill ref containing `/` is a
   *supporting file* → label "Read skill file", else "Read skill".
2. `classifyDeveloperHarnessTool` — `DEVELOPER_TOOL_BASES = {shell, read_file,
   view_image, str_replace, todo, stop, postcompact}`.
3. `classifyBuzzTool` — `BUZZ_CLI_GROUPS = {messages, channels, dms, reactions,
   canvas, feed, users, workflows, social, repos, upload, mem, notes, patches,
   pr, issues, emoji, pack}`; verbs partition into
   `BUZZ_CLI_ADMIN_VERBS = {archive, unarchive, create, delete, remove,
   add-channel-member, remove-channel-member, set-channel-add-policy}` and
   `BUZZ_CLI_READ_VERBS = {get, list, thread, search, members, runs, notes}`
   (everything else is a write).
4. `genericDescriptor` fallback.

`renderClassLabel` → `{message:"Message", "relay-op":"Buzz relay op",
"file-edit":"File edit", "file-read":"File read", "skill-read":"Skill read",
image:"Image", shell:"Shell command", status:"Status", thought:"Thought",
plan:"Plan", permission:"Permission", error:"Error", generic:"Tool",
"raw-rail":"Raw event", suppressed:"Suppressed"}`.

`ui/agentSessionToolSummary.ts:buildCompactToolSummary(item)` → `CompactToolSummary
{action, kind, label, preview, fileEditSummary, fileEditDiff, fileReadContent,
imageContent, shellContent, thumbnailSrc, presentation:"inline"|"message",
descriptor}`. Label tense follows status — for `groupKey === "file-edit:str_replace"`:
failed → `"Edit failed"`, running → `"Editing file"`, else `"Edited file"`.
`preview` prefers the edited file's basename over the descriptor preview.
Shell content is only extracted when the descriptor is `shell`-class or
`source === "shell"`.

Companion builders: `agentSessionFileEditDiff.ts` (`buildFileEditDiff` →
`{path, filename, additions, deletions}` + a rendered diff),
`agentSessionFileRead.ts` (`buildFileReadContent`, `buildSkillReadContent`),
`agentSessionImageContent.ts` (`buildImageContent` → a thumbnail `src`).

### 6.5 Turn segmentation & burst collapsing

`ui/agentSessionTranscriptGrouping.ts`.

Per turn, `classifyTurnItems(items)` extracts the user prompt
(`acpSource === "session/prompt:user"`), setup lifecycle rows
(`acpSource ∈ {turn_started, session_resolved}`), the prompt context metadata
(`session/prompt:context`) and steer contexts (`session/steer:context`) into a
single `{kind:"prompt", user, context, setup}` header segment. Steer messages
become their own `prompt` segments carrying the next pending steer context —
steer context **rides behind the steer bubble's checks-icon dialog**, not as a
standalone "Prompt context" row. An unmatched steer context keeps a standalone
row so metadata is never silently dropped.

Then a **two-pass collapse** (`groupToolSegments = groupMixedToolRuns ∘ groupSameKindSegments`):

- **Pass 1 (same-kind)** — adjacent items sharing a `sameKindKey`
  (`descriptor.groupKey ?? renderClass`) collapse when the run reaches
  `minimumSummaryRunLength` = **2 for `file-edit`, 3 for everything else**.
  Labels: `Edited N file(s)`, `Read N files`, `Read N skill(s)`,
  `Ran N commands`, `Ran N Buzz relay ops`, else `<label> ×N`.
  Summary id `summary:<key>:<firstItemId>`, `variant:"same-kind"`.
- **Pass 2 (mixed burst)** — `MIXED_RUN_MINIMUM_SEGMENTS = 2`. Adjacent burst
  participants (raw eligible tool rows **and** pass-1 same-kind summaries;
  mixed summaries never re-enter) collapse into
  `{label: "Ran N tool calls", variant:"mixed"}`. Its **visible children are
  flattened back to leaf tool rows** — expanding nested same-kind summaries
  would produce redundant rows like "Ran 16 tool calls" → "Ran 12 commands".

`GROUPING_ELIGIBLE_RENDER_CLASSES = {file-read, skill-read, shell, relay-op,
file-edit, image, plan, generic}`. **Messages, permissions, failed tools
(`isError` or reclassified `error`), status and suppressed rows are never
grouped and break runs, so intervention points stay visible.**

`splitIntoSessionRuns(items)` — contiguous runs keyed by `sessionId`, with three
subtle rules:
- **Leading null-session items** (the real first-turn wire order is
  `turn_started(null) → session/new(null) → session_resolved(sess-X)`) are
  deferred and **prepended to the first run with a non-null sessionId**.
- **Restart re-anchoring:** on a restart the normalizer stamps `session/new` with
  the *old* `latestSessionId`, so under a plain grouping rule the System Prompt
  card would render **above** the session-boundary divider. `session/new`
  markers are session-START signals: when one arrives and a prior run exists, it
  (and any null-session items following it) is parked in `pendingNewRunBuffer`;
  multiple markers accumulate in order (rapid restart loops); when the next
  distinct non-null sessionId resolves, the buffer is flushed to the **head** of
  that run. If no new session ever resolves, flush back into the current run so
  nothing is dropped.
- Mid-stream null-session items (after at least one session resolved, with no
  pending buffer open) attribute to the most recent run. Only an entirely
  null-session stream forms a single fallback run keyed `"unknown"`.

`TranscriptDisplayBlock` = `{kind:"single", item}` | `{kind:"turn", turnId,
segments}` | `{kind:"session-boundary", sessionId, sessionStartTimestamp,
labelState, runIndex, firstItemId}`. `labelState`:
- `"current"` — newest-visible run **and** matches the live relay session id
  (agent actively running this session);
- `"most-recent"` — newest-visible but no live match (archived-only view or the
  session ended) — the most recently observed session, *not* current context;
- `"earlier"` — an older run.

Use **`firstItemId`** as the React key component, not the deprecated `runIndex`:
prepending older runs on an archive-page load shifts every index and causes key
churn / unnecessary remounts, while a run's first item is stable across prepend.

### 6.6 The activity panel

`ui/ManagedAgentSessionPanel.tsx` composes everything:

1. `hasObserver = isManagedAgentActive(agent)` gates the relay subscription and
   the empty-state message — **but the store is always read** so an idle agent's
   archived channel history still renders.
2. `useObserverEvents(hasObserver, pubkey)` (live) +
   `useArchivedChannelEvents(pubkey, channelId)` (archive).
3. `scopeByChannel(events, channelId)` (a null channelId means no scoping) then
   `mergeObserverEventWindows(live, archived)` — dedupe on `(seq, timestamp)`
   **preferring the live copy** (the live path may have applied incremental
   transcript mutations), then sort ascending.
4. `buildTranscriptState(combined).items` — one derivation over the combined
   window.
5. `deriveLatestSessionId(displayEvents)` scans **from the end**.
6. `resolveRawRailLayout(showRaw, rawLayout)` → `hidden` | `exclusive` (raw rail
   replaces the transcript) | `side` (responsive two-column
   `xl:grid-cols-[minmax(0,1fr)_20rem]`).
7. Header: "Live ACP session" + `ObserverStatusBadge` + `Session <shorten(id)>`
   or `"Waiting for the next agent turn."`, or, without an observer,
   `"Restart this local agent to attach the observer feed."`; plus an
   `N event(s)` badge.
8. Empty states: no observer + no transcript + no events → "Observer not
   attached / The live feed is available for local agents started after this
   update."; `connecting` with no events → a content-shaped skeleton.

`observerEventScrollId(event)` = `` `${seq}:${timestamp}` `` — the shared DOM
scroll-anchor id used by both the message list and the raw event rail. **`seq`
alone is not unique** across an agent's history (it is process-local and resets
to 1 on restart while the timestamp climbs), which is why it is paired.

`ui/AgentSessionTranscriptList.tsx` renders `TranscriptDisplayBlock`s through
the `activityRenderClasses/` components: `ActivityRow`, `MessageActivity`,
`UserMessageBubble`, `ThoughtActivity`, `PlanActivity`, `ToolActivity`,
`LifecycleActivity`, `RawRailActivity`, `SuppressedActivity`,
`TranscriptActivityItem`, `TranscriptTimestamp`, `MessageLinkHoverCue`,
plus `useTranscriptBubbleOverflow`. Preferences:
`transcriptAnimationPreference.ts`, `transcriptTimestampPreference.ts`.

### 6.7 Archive paging

`ui/useObserverEvents.ts:useLoadArchivedObserverEvents(enabled, channelId)`.

```
ARCHIVED_EVENTS_PAGE_SIZE = 200
INITIAL_HYDRATION_BUDGET_PAGES = 10        // 2000 frames; a code-review turn ≈900
```

- Reads through `observer_channel_index` so only frames attributable to this
  channel load — cross-channel contamination is impossible. Frames with a
  null/decrypt-failed channelId are excluded at the Rust level.
- **One-shot idempotent backfill** per identity mount: decrypt every
  not-yet-indexed `owner_p` kind-24200 row and write `(eventId, channelId,
  createdAt)` into the index. A status row is written for **every** processed
  event — malformed JSON and decrypt failures write `channel_id = null` so
  re-runs skip them. `fetchOlderArchived` awaits the backfill promise before its
  first read, so a scroll trigger firing early cannot return 0 rows and falsely
  mark the channel exhausted.
- Degrades cleanly: no `owner_p` save subscription, or a null `channelId`, →
  `hasOlderArchived:false` with no archive calls, and the backfill promise is
  resolved immediately so nothing awaits forever.
- **Generation fencing.** `applyChannelReset` increments `resetGeneration` on
  every channel change, so even an `A→B→A` round-trip is detected: every shared
  state write re-checks `requestGeneration === ps.resetGeneration`, and the
  `finally` block releases the fetch lock **only if this request still owns it**
  (otherwise it would steal the new channel's lock).
- Cursor is `{createdAt, id}` of the **oldest** row on the page (rows arrive
  newest-first), mirroring the compound sort key so same-second siblings are not
  skipped. A short page marks the channel exhausted.
- Eager initial hydration loops up to the page budget on open / channel switch,
  reusing `fetchOlderArchived`'s lock/cursor/backfill machinery — **no parallel
  state machine** — with a cancellation signal so a channel switch aborts it.

### 6.8 Opening an agent's activity from anywhere

`useOpenAgentActivity.ts` — the universal ingress. Inside a channel screen the
`AgentSessionContext` handler opens the pane in place; everywhere else (agents
page, home profile panel, popovers on non-channel routes) it **navigates** to a
channel with an `agentSession` search param.

- `isChannelOpenable(channel)` — the viewer can open a channel iff it exists in
  their channel list AND (`isMember` OR `visibility === "open"`).
- `resolveOpenableActivityChannelId({agentChannelIds, openableChannelIds, workingChannelIds})`
  — first openable **working** channel, else first openable **member** channel,
  else `null`.
- **Owner-global ingestion means the working signal can report activity in rooms
  the viewer can't access.** Deep-linking there would land on a screen they
  can't read, so instead: `toast.warning(INACCESSIBLE_ACTIVITY_MESSAGE)` =
  *"This agent is active in a channel you haven't joined, so its activity can't
  be opened from here."* — no channel content, no trap-door, and without leaking
  *which* room.
- An explicit `channelId` (e.g. clicking a "Working in #channel" badge) is
  checked against `isChannelOpenable` before opening in place **or**
  navigating — scoping the pane to an inaccessible room would expose that room's
  activity.
- `canOpenAgentActivity(pubkey)` stays **optimistically true while channels are
  still loading** so "View activity log" doesn't flicker in on cold start; the
  actual navigation is still guarded.
- `getAgentWorkingState(pubkey)` is read as a deliberately *unsubscribed*
  snapshot here (the callback runs on click, not in render), so its deps are
  only `[channels, relayAgents]`.

### 6.9 Prevent sleep

`preventSleepActivity.ts:createPreventSleepActivityTracker()` — per-agent
`latestEventKey = "<timestamp>:<seq>"`. `observe(agents)` returns true only when
a **previously seen** agent's latest key changed; the first observation of an
agent seeds without reporting activity (tests: "seeds existing observer events
without touching", "reports a newer observer event", "ignores unchanged latest
observer event").

`usePreventSleep.ts` — `localStorage` key `buzz-prevent-sleep` (deliberately not
per-pubkey; the setting is about the machine). `active = enabled &&
hasRunningAgents && !expired`. Only **local `running`** agents count — remote
`deployed` agents run on provider infrastructure and are unaffected by local
sleep. New observer activity clears an `expired` flag and re-asserts
`setPreventSleepActive(true)`; the backend emits `prevent-sleep-expired`.

---

## 7. Agent memory (NIP-AE engrams)

Spec `docs/nips/NIP-AE.md`; kind `30174`, addressable, agent-signed, NIP-44
encrypted with the **agent↔owner conversation key**. Because that key is
symmetric, **the owner can always read everything the agent remembers**. Memory
is scoped to a single `(pubkey_a, pubkey_o)` pair — an agent serving several
owners holds an independent memory per pair. The `d` tag is **HMAC-blinded** over
the conversation key (unlike persona slugs, which are plaintext) so memory slug
names stay confidential. A dedicated kind rather than NIP-78 so that (a) `core`
and `mem/…` slugs cannot collide with another app's `d` choices for the same
pubkey, and (b) observers can identify the events from the kind alone without
attempting decryption as a namespace demultiplexer.

### 7.1 What is stored

- **`core`** — the agent's identity profile. One per pair.
- **`mem/...`** — hierarchical slugs for everything else.
- **`mem/persona`** — the reserved slug holding the agent's private, mutable
  snapshot of its originating persona. This is where secrets (env vars, API
  keys) belong, because the public kind:30175 persona content **MUST NOT** carry
  them.

Bodies use `[[slug]]` wiki-style references. Tombstones are filtered out at the
Rust layer before the UI sees them, so a reference to a tombstoned memory
correctly surfaces as *dangling* ("this memory used to exist but doesn't
anymore").

### 7.2 When it is written / read

- **Written** by the agent, as a deliberate action (via the `mem` CLI/MCP tool
  group — see `BUZZ_CLI_GROUPS`).
- **Read at prompt time** by the harness: `crates/buzz-acp/src/engram_fetch.rs:build_core_section`
  renders `[Agent Memory — core]`. For modern agents (ACP protocol ≥ 2) it is
  delivered via the **system role in `session/new`**; legacy agents receive it in
  the user message alongside `[Base]`/`[System]`.
- **Read by the owner** in the profile panel via `get_agent_memory`.
- Snapshot export can embed memory at `"none" | "core" | "everything"`; import
  restores it, reporting `memoryWritten / memoryTotal / memoryErrors[]`.

### 7.3 Desktop API and gating

`desktop/src/shared/api/tauriEngrams.ts`:
```ts
EngramEntry       = { slug, body, eventId, createdAt /*unix s*/, outgoingRefs: string[] };
AgentMemoryListing = { core: EngramEntry|null, memories: EngramEntry[], truncated, fetchedAt };
getAgentMemory(agentPubkey): Promise<AgentMemoryListing>
```
`truncated` flags a relay cap hit (≥ 5000 events for that (agent, owner) pair).
`{core:null, memories:[]}` is the legitimate **empty** state, distinct from a
thrown error. Throws on: non-hex pubkey, viewer is not the owner, relay failure.

`desktop/src/features/agent-memory/hooks.ts`:
- `useIsManagedAgent(pubkey)` returns `boolean | undefined`, where **`undefined`
  is the loading state** (defer rendering; do not show an error). It answers
  "do I hold the seckey locally?", which is only the *fast-path* half of the
  owner check.
- The real rule: `viewerIsOwner = isCurrentUserOwner || isOwner`, where
  `isCurrentUserOwner` is the **declared NIP-OA owner** from the agent's kind:0.
  The two diverge exactly for a remote-owned agent — the owner runs it on
  another desktop, holds no local seckey, but legitimately owns it. **Engrams are
  encrypted to the owner's pubkey and decrypted with the owner's own key, never
  the agent's seckey**, so a declared owner reads their memory regardless of
  where the agent runs. The encryption is the boundary; the local predicate is
  just the no-round-trip half.
- `useAgentMemoryQuery(pubkey, {enabled})` — `staleTime: 30_000` (engrams change
  rarely; each write is a deliberate agent action), one-tap `refetch()`.
- `useAgentMemoryGraph` memoizes `buildMemoryGraph(listing)`.

### 7.4 The memory graph

`lib/buildMemoryGraph.ts:buildMemoryGraph(listing) → {rootedTree, orphans, dangling}`:

- Index `slug → entry` including `core` (so a `[[core]]` back-reference resolves).
- BFS from `core`, maintaining a `visited` set: the first time a memory is
  reached it becomes a tree node; subsequent references to it are **silently
  dropped from the tree** (the node still lives at its first appearance). **The
  tree is therefore acyclic by construction even when the underlying graph is
  cyclic.** Self-refs are skipped.
- `orphans` = memories never visited, **sorted by slug** so the UI is
  deterministic across refetches. Orphans are then walked (ref-resolution only,
  no tree) so dangling targets are complete.
- `dangling: {slug, referencedBy[]}[]` — any ref whose slug is not in the index,
  regardless of which body cited it; duplicate `[[foo]] [[foo]]` in one body
  surfaces a single referrer; sorted by slug.
- One pass produces all three, because reachable-vs-orphan and dangling
  detection fall out of the same traversal.

### 7.5 Memory UI

`ui/MemorySection.tsx` — **returns `null` for non-owners**; the parent passes
`viewerIsOwner`. State ordering is explicit and matters:
first paint with no cache → skeleton; error with no cache → error state with
Retry; **error WITH cache → keep the data and show a non-blocking "Refresh
failed." banner** so a retry never loses what was on screen; data-but-empty →
`"Build this agent's memory" / "Try telling this agent to remember something for
next time."`; else render.

Rendering: `core` first, then tree descendants (flattened), then orphans.
`MEMORY_LIST_PREVIEW_LIMIT = 3` with a `View all (N)` / `Show less` toggle.
A `truncated` listing wraps the button in a tooltip: *"This list may be
incomplete — the relay returned the maximum number of memories."* — and when
there is nothing to expand, renders a standalone warning tile with the same
tooltip. When there is no `core` but there are memories:
*"No `core` memory yet — agent identity is unrooted."*

Each entry is an accordion; the caret appears only when the title or body
exceeds two lines (measured with `getComputedStyle` line-height and a
`ResizeObserver`) **or** the entry has dangling refs. Dangling refs render an
inline warning listing `[[slug]]`s with the tooltip *"This memory links to a slug
that wasn't found in the loaded memory list."* Slug titles render segment-wise
with `/` separators and the `mem` segment dimmed. `[[…]]` refs inside bodies are
highlighted (`MEMORY_REF_PATTERN = /\[\[([^\]]+)\]\]/g`). An empty body renders
`(empty)`.

---

## 8. The ACP harness

### 8.1 The two binaries (`VISION_AGENT.md`)

```
Any ACP client (Zed, JetBrains, buzz-acp, custom)
        | stdio ACP (JSON-RPC 2.0)
  buzz-agent   (up to 8 concurrent sessions, configurable)
        | stdio MCP (JSON-RPC 2.0) — one per session
  buzz-dev-mcp (or any MCP server)
        → shell, str_replace, todo; rg + tree on PATH
```

Two pipes, two protocols, no runtime coupling between the crates. Each session
gets its own MCP server instances — fully isolated. **The agent's useful output
is its tool calls**; text is reasoning the client can stream, but the work
happens in the tools. When context fills, a session summarizes its own history
and continues (`crates/buzz-agent/src/handoff.rs`).

Design principles to preserve: minimal (delete what you can), hardened (zero
unsafe, zero panics, bounded process lifetime / output sizes / history,
process-group kill on **every** exit path, file edits resolve against the working
directory, history validity maintained on every cancellation path),
protocol-native (ACP is the only interface to the agent, MCP the only interface
to the tools), honest (the agent is a loop: prompt → execute tool calls →
repeat; when it can't proceed, it stops).

**Community scoping:** the relay URL an agent connects to *selects its
community*. A hosted operator may run many communities on shared infrastructure,
but an agent's profile, presence, DMs, memories, jobs, channel memberships and
audit trail are scoped to the community behind that URL. The same npub may join
another community and repost a profile there, but **no agent state is inherited
across hosts** — identity is portable, community state is not.

### 8.2 What a provider must implement

Minimum ACP surface (`crates/buzz-acp/README.md`, "Using Any ACP Agent"):
1. Accept `initialize` and return a result.
2. Accept `session/new` with `mcpServers` and return a `sessionId`.
3. Accept `session/prompt` with a text message and stream `session/update`
   notifications.
4. Return a `stopReason` (`end_turn`, `cancelled`, `max_tokens`, …).

Then set `BUZZ_ACP_AGENT_COMMAND` / `BUZZ_ACP_AGENT_ARGS`.

A complete `buzz-agent` transcript (`crates/buzz-agent/README.md`):
`initialize` → `{protocolVersion:1, agentCapabilities{loadSession,
promptCapabilities{image,audio,embeddedContext}, mcpCapabilities{http,sse}},
agentInfo{name,version}}`; `session/new{cwd, mcpServers[{name,command,args,env}]}`
→ `{sessionId}`; `session/prompt{sessionId, prompt:[{type:"text",text}]}` with a
stream of `session/update` notifications
(`tool_call` pending → `tool_call_update` in_progress → completed) and a final
`stopReason`.

`buzz-agent` provider env: `BUZZ_AGENT_PROVIDER ∈ {anthropic, openai,
openrouter, databricks}` with `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`,
`OPENAI_COMPAT_{API_KEY,MODEL,BASE_URL}`, `OPENROUTER_{API_KEY,MODEL}`, or
`DATABRICKS_{HOST,MODEL}` (OAuth 2.0 PKCE).

### 8.3 How Goose / Codex / Claude Code plug in

| Runtime | Command | Notes |
|---|---|---|
| **goose** | `goose acp` (default `BUZZ_ACP_AGENT_COMMAND=goose`, args `acp`) | Native. Supports `_goose/unstable/session/steer`. Crashes on unrecognized `set_config_option` values, so unsupported permission modes are skipped and the harness auto-approves via `handle_permission_request`. |
| **codex** | `@agentclientprotocol/codex-acp` (npm) | Requires `OPENAI_API_KEY` (an API key, **not** a ChatGPT subscription). It always attempts a ChatGPT WebSocket login first and logs a `426 Upgrade Required` — expected and non-fatal, it falls back to the key. **Effort is `ownedByModelId`** — no separate effort field. A `-32603 Internal error` from codex-acp usually means the configured model is unsupported by the installed adapter. |
| **claude code** | `@agentclientprotocol/claude-agent-acp` (npm), env `BUZZ_ACP_AGENT_COMMAND=claude-agent-acp`, `ANTHROPIC_API_KEY` | Older installs exposing `claude-code-acp` are also supported; **buzz-acp treats both names as the same zero-arg runtime** (mirrored in TS by `agentReuse.ts:normalizeCommandIdentity`). Effort is `deferredUntilNativeOptionsAvailable` (an ACP config option `id:"effort", category:"thought_level"`), so no effort control renders yet. Model is `acpNative`. |
| **buzz-agent** | bundled sidecar | Default preference #1. Owns `BUZZ_AGENT_THINKING_EFFORT`. |

Model switching at runtime: the desktop `ModelPicker` fires a `switch_model`
control frame **per active channel** and resolves the outcome with
`lib/liveSwitchOutcome.ts:awaitLiveSwitchOutcome({channelCount, modelId,
subscribe, sendSwitches, scheduleTimeout})`:
- Frames for a different `type` or a different `modelId` are ignored.
- **Fail fast:** any single `unsupported_model` rejects the whole pick
  immediately → `"unsupported"`.
- Every other status (`sent` / `switched` / `turn_ending`) counts as success for
  one channel; when the count reaches zero → `"ok"`.
- If the harness never replies, the injected fallback timeout resolves `"ok"` —
  the override still rides the requeued/next session, we just can't confirm it
  synchronously.
- Counting is isolated from React and the relay so it can be tested with
  synthetic frames and a fake clock; the caller injects the subscription, the
  per-channel sends, and the timeout scheduler.

### 8.4 Prevent-sleep behaviour

Covered in §6.9. In one line: **the desktop keeps the machine awake only while
the user opted in AND at least one *local, running* agent exists AND new
observer activity keeps arriving**; a backend-emitted `prevent-sleep-expired`
event turns it off, and fresh observer activity turns it back on.

The remote counterpart is inverted — a remote agent bounds its **own** lifetime:
*"a timer that owes nothing to the agent's workload watches for silence, and
after hours of quiet it finishes what's in flight, says goodbye to the relay, and
exits. Not killed — finished."* The default state of a remote agent is "not
running". Honest cost: **self-reaping needs a living reaper** — a body wedged
badly enough to stop running its own timer cannot finish itself, and the desktop
will not do it for it; that failure belongs to the substrate (a namespace TTL
policy is the backstop, not an afterthought).

### 8.5 Remote agents — the provider contract

`VISION_REMOTE_AGENTS.md`. **Axiom: after deploy, the desktop retains no
substrate control channel.** Launch is a single one-way handoff — the desktop
resolves the provider through one narrow path, stages one exact artifact for
negotiation and deploy, **refuses a protocol version it does not understand**,
and hands over a launch payload **it never persists**. From that moment
everything flows through the relay.

A provider is a small, swappable binary the desktop discovers and interrogates
(`BackendProviderCandidate {id, binaryPath}`,
`BackendProviderProbeResult {ok, name?, version?, description?, config_schema?}`).
The contract never mentions containers:
1. Preserve the agent's identity and **fail closed with its key**.
2. **Converge to a single live instance** no matter how deploys race.
3. Let presence describe **conversational availability**, not substrate health.
4. **Bound the instance's lifetime.**
5. **Keep secrets out of configuration.**

A conformance suite pins those behaviours — it establishes that a provider
honours the contract, **not** that arbitrary code is safe to hand a key.
Choosing a provider remains a deliberate trust decision.

Honest costs to reproduce verbatim in the UI's copy and expectations:
- You bring the substrate. Ownership is work.
- **Handing over the key is a decision.** On Kubernetes the key rests as a
  Secret: anyone the cluster trusts to read secrets in that namespace can read
  it. The design narrows the blast radius (immutable per-attempt secrets, no
  service-account token, digest-pinned images) rather than implying isolation it
  doesn't provide.
- **No backchannel cuts both ways.** The desktop shows presence and words, not
  CPU graphs, and holds no guaranteed emergency kill switch. Deep diagnostics
  live in the substrate's own tools.
- **The body's state is mortal.** Files, checkouts, half-finished working trees
  go with the body unless the substrate persists them. Durable knowledge belongs
  on the relay.
- **Presence can lag the truth, but not for long.** Presence is a **lease the
  agent renews**, not a flag it sets: a dead agent stops renewing and the relay
  forgets it. At most ~90 s of a wrong dot, never an indefinite one.
- **A running agent finishes on the configuration it started with.** New keys,
  models and settings take effect on the next body. An instance that never got
  far enough to run is the substrate operator's residue to clear.

---

## 9. Mesh compute

`VISION_MESH.md` + `desktop/src/features/mesh-compute/**`.

### 9.1 What it is

A Buzz community is a trust group; Buzz Mesh turns that decision into shared AI
compute. Idle GPUs across the community's machines become one pool, usable by
every agent in the community, **gated by the membership you already have** — the
mesh's admission gate and the community's membership gate are the same gate.
Because the pool is many machines, the community can run models larger than any
one member could load alone (a model can be split across several machines, each
holding a slice). Requests run **directly between machines**; the relay
coordinates trust and never sees a token. Non-members can't find it, join it,
serve to it, or use it. Boundary is the community, never the deployment: a
community on shared infrastructure pools only its own members' compute.

Honest costs: your prompts go to **people, not a vendor** — better than a
stranger's cloud for a trust group, but a different promise than "your data
never leaves your machine", and the consent screen says so plainly. The mesh is
opt-in, so it is only as capable as participation.

### 9.2 Runtime model — one slot, two roles

`shareToggleState.ts`. **The single mesh runtime slot is shared by BOTH roles:**
*serve* mode (this machine sharing compute) and *client* mode (this machine
consuming a peer's compute). Both report `state: "running"`, so the Share toggle
must key off **`mode`, not `state`** — otherwise consuming a peer's compute
lights up the Share switch and, worse, clicking it tears down the unrelated
client session.

```ts
occupiesSlot(status) = state ∈ {running, starting, failed}   // off/stopping do not
deriveMeshShareToggle(status) = {
  isSharing:    occupied && mode === "serve",
  isConsuming:  occupied && mode === "client",
  slotOccupied: occupied,
}
```
`failed` still occupies the slot (it started, then errored) so the user can turn
it off to clear/retry. A serve node that also routes a peer's model is **still
sharing** — routing is a capability, not a role. The backend supports an
intentional client→serve replacement.

### 9.3 Model refs

`classifyModelRef.ts:classifyModelRef(raw)` — mirrors mesh-llm's runtime
resolution: `hf://…` → `{kind:"huggingface"}`; leading `/`, `./`, `../`, `~`, or
a `.gguf` extension → `{kind:"local-path"}`; any other non-empty string →
`{kind:"catalog"}`; empty/whitespace → `{kind:"unknown"}`. Validation only —
canonical resolution happens server-side in `mesh_start_node`.

### 9.4 Serving usage indicator

`servingUsage.ts:deriveServingIndicator(usage, isSharing)` →
`{show, active, hasRemoteConsumers, label, detail}`. Hidden unless sharing and
usage has been fetched. The distinction that matters:

- `localAttempts` = **this machine's own agents** using the local model — not a
  "someone else is here" signal; surfaced softly as activity.
- `remoteAttempts` / `endpointAttempts` = **another member consuming this
  machine's compute** — this is the "someone connected to what I'm sharing"
  signal.

Copy, in priority order:
- remote consumers + inflight → `In use now by another member · N live`;
  detail `M peer(s) on the mesh · R tok/s` (or just tok/s with no peers).
- remote consumers, idle → `Used by another member · N request(s)`.
- local only + inflight → `Serving your agent · N live`, detail `R tok/s`.
- local only, some served → `Idle · no one using it right now`, detail
  `N request(s) served this session`.
- sharing, nothing served → `Idle · no one using it yet`, no detail.

### 9.5 What the UI exposes

`ui/MeshComputeSettingsCard.tsx` — Settings → Compute → **Share compute**. One
toggle, one model field, an "Already installed" picklist, and an Advanced group.
**User-facing copy describes the shared-compute behaviour without exposing
implementation protocols or raw mesh controls.**

- Drafts persist in `localStorage` (`buzz.mesh-compute.share.model.v1`,
  `buzz.mesh-compute.share.max-vram-gb.v1`), tolerating unavailable/full storage.
- `meshModelCatalog()` is a one-shot hardware-aware fetch; when it fails (stub
  build, survey error) the card falls back to the free-text field. With no saved
  choice, the curated `recommended` becomes the actual default so a new member
  can turn sharing on directly; **an explicit saved draft always wins**.
- **Only a SERVE runtime's model is mirrored into the field.** A client reports
  the *remote* model it is consuming; copying that would both lose the member's
  local sharing choice and can cause this machine to download the remote
  member's much larger model when sharing is enabled.
- `useMeshNodeStatus()` — adaptive poll: **750 ms while `starting`/`stopping`,
  4000 ms when steady**, so the card never shows a frozen "Starting…" for minutes
  without hammering a running node. `null` until the first success.
- `useMeshServingUsage(enabled)` — plain 4 s poll, only while sharing; a failed
  poll **leaves the last value in place** rather than flapping the indicator.
- `useMeshDownloadProgress()` — Tauri event `mesh-download-progress` with
  `{label, file, downloadedBytes, totalBytes, status:"preparing"|"downloading"|"done", done}`;
  a `done` event clears to `null`. `formatDownloadBytes` → `"2.1 GB of 5.0 GB"`
  (tolerating unknown totals); `downloadPercent` → 0..100 or `null`. Degrades
  silently where the event system is unavailable (web/E2E).
- API surface (`shared/api/tauriMesh.ts`): `meshStartNode(StartMeshNodeRequest)`,
  `meshStopNode()`, `meshNodeStatus()`, `meshServingUsage()`,
  `meshInstalledModels()`, `meshModelCatalog()`.
  `MeshModelFit = "comfortable"|"tight"|"tradeoff"|"too_large"`.
- Agents consume the mesh through `RelayMeshConfig {modelRef}` on
  `CreateManagedAgentInput`, and `ui/relayMeshModelPicker.ts`
  (`relayMeshModelPickerState`, `modelDropdownOptions`) drives the picker.
  Relay-mesh denial surfaces as JSON-RPC `-32001` →
  `"Community access denied this agent — check its community membership."` (§5.9).

---

## 10. Governance & permissions

### 10.1 What an agent can do

| Capability | Gate |
|---|---|
| Read/write channels it is a member of | Ordinary channel membership. An agent is added with a role (`bot` default, or `member`/`guest`/`admin`). |
| Connect to the relay at all | Explicit NIP-43 membership, **or** NIP-AA virtual membership derived from a valid NIP-OA `auth` tag whose owner is an active member. Revoking the human revokes the agent on its next connect. |
| Act on an inbound event | The `respondTo` author gate — evaluated **before** subscription rules. |
| Be @mentioned by another user | `relayAgentIsSharedWithUser`: `anyone` + a shared channel, or explicit membership of `respondToAllowlist`. |
| Write memory | Its own engrams, encrypted to the (agent, owner) conversation key. |
| Publish telemetry | Only to its owner, only kind 24200, relay-verified `is_agent_owner`. |
| Publish turn metrics | Kind 44200, encrypted to its owner, p-gated, `RESULT_GATED`. |
| Draft an agent create/edit | Only within the narrow `agent_management_request` contract, only from a channel the owner and agent **both** belong to, only for a personal (non-team) definition, and **only as a proposal the human confirms**. |
| Run tools | Whatever MCP servers the harness gives it. The shell runs at the operator's trust level, like bash itself. |

### 10.2 What an agent cannot do

- **Publish persona / team / managed-agent definitions.** Kinds 30175/30176/
  30177/30178 are owner-authored. "Agents do NOT author persona events; they
  consume them" (NIP-AP, Roles).
- **Grant itself relay access.** NIP-OA is authorization evidence only; a valid
  `auth` tag is never an identity override and relays MUST NOT rewrite
  authorship on the basis of it.
- **Choose runtime, provider, model, or access when drafting an agent from
  chat** — `hasOnlyKeys` rejects any such field, and `respondTo` is limited to
  `owner-only`/`anyone` (never `allowlist`).
- **Edit a team-sourced definition** (`sourceTeam` set ⇒ non-editable).
- **Carry secrets in any world-readable event.** Kind 30175 content MUST NOT
  contain `env_vars`; kind 30177 MUST NOT carry the seckey, the NIP-OA auth tag,
  env vars, or runtime fields; kind 30178 carries no env vars, no allowlist
  pubkeys, no source/local ids, no filesystem paths.
- **Depend on control-frame delivery.** Control frames are best-effort.
- **Keep running past its lifetime bound** (remote agents self-reap).

### 10.3 Scoping by identity vs. by permission flag

Two orthogonal axes, and conflating them is the classic bug:

- **Identity scoping** — what the *keys* let you read. Engrams decrypt only with
  the owner's key; observer frames are `#p`-addressed to the owner; persona
  heads are author-only unless `shared`. This is cryptography and relay filter
  law: it cannot be bypassed by a UI flag, and a UI flag cannot substitute for
  it. Example: `useIsManagedAgent` ("do I hold the seckey?") is *not* the owner
  check — `viewerIsOwner = isCurrentUserOwner || isOwner`, because the
  encryption, not the key custody, is the real boundary.
- **Permission flags** — what the *product* lets you do: `respondTo` +
  `respondToAllowlist`, channel role, `startOnAppLaunch`,
  `autoRestartOnConfigChange`, `parallelism`, `allowed_respond_to` (a deployment
  can restrict which modes are even selectable — `buzz-acp` rejects a
  `respond_to` outside `allowed_respond_to` at startup with
  `"respond_to '<x>' is not permitted on this deployment"`).

Where the two meet, identity wins and the UI must say so: an agent working in a
channel the viewer cannot open is *not* deep-linked to — it warns instead (§6.8);
memory is hidden entirely from non-owners (§7.5); observer frames from an agent
whose `event.pubkey` disagrees with its `agent` tag are dropped even though the
relay already gated them (§6.1).

### 10.4 Sharing is a governance act

- Sharing a persona (`["shared","true"]`) makes its **system prompt** and
  `respond_to_allowlist` community-readable plaintext.
- Sharing a **team** (kind 30178) exposes the team's fields **and the embedded
  projection of every member** — including members whose own kind:30175 heads are
  unshared and therefore still private. *Clients MUST make this explicit at the
  point of sharing; the relay cannot infer it.*
- Unsharing is **not** deletion: it is a newer valid head at the same coordinate
  published *without* the `shared` tag, which keeps the projection readable to
  its author while retracting it from foreign readers.

---

## Non-obvious rules worth preserving

1. **`seq` is process-local and resets to 1 on every harness restart; only
   `(timestamp, seq)` is a stable identity for an observer frame.** Every dedup
   key, scroll anchor, watermark and transcript collision guard in the module is
   built on the pair, never on `seq` alone.

2. **Gate every observer event kind on the watermark, including evictions.**
   Replaying a stale `turn_error`/`agent_panic` with a null `turnId` would fall
   back to deleting the first turn in the channel and kill a live turn. With
   sorted buffers this makes full-buffer replay a complete no-op — and the
   sortedness is an undocumented-at-your-peril *invariant* of
   `syncAgentTurnsFromEvents`.

3. **Clock skew is estimated as a running MINIMUM of `now - eventTimestamp`, and
   anchors are derived at read time, not stored.** The minimum converges on true
   skew minus the smallest observed delay, is immune to per-event jitter, and a
   later tightening retroactively corrects every live badge. Storing anchors
   would produce lockstep timers and reset long-running turns to "just started".

4. **Prune-pause is per-agent and detects "all of this agent's turns went silent
   at once".** One fresh sibling means a stale turn is genuinely dead and must
   still prune at 25 s. Another *agent's* activity must have no effect. The pause
   itself is bounded at 3 minutes so a dead agent eventually clears.

5. **A turn's badge can be resurrected, but never past its own completion.** A
   recovered liveness/ACP frame revives a pruned turn only when it is *strictly
   newer* than the recorded terminal tombstone — and completions are tombstoned
   even when the live record is already gone.

6. **Desktop-initiated stop/restart clears turns immediately but preserves the
   watermark and tombstones the cleared turns.** Without the watermark a replayed
   `turn_started` resurrects the badge; without the tombstones an in-flight
   liveness frame already on the wire does.

7. **`MAX_TURNS_PER_AGENT` sits at the harness's hard upper bound (32), not the
   desktop default (24).** Any lower value silently evicts a live turn and drops
   its working badge.

8. **`TurnCompletionGuard` must be declared before `liveness_guard`** — Rust
   drops locals in reverse order, so liveness is aborted before completion makes
   the turn terminal.

9. **The working signal has exactly two inputs with a fixed precedence**
   (observer primary, typing fallback) and one scope rule (with a channel:
   in that channel; without: anywhere). Every surface reads the module, never a
   raw pipe.

10. **`workingSource: "none"` is ambiguous** (idle OR observer stream absent) and
    can never on its own authorize a destructive action. Auto-restart's
    `connected` gate plus a 3-minute continuity window carry that risk, and every
    never-fire gate resets the window.

11. **Harness capability facts have exactly one source: the Rust runtime
    catalog.** No TypeScript lookup table, no `runtime.id === "claude"` in a
    component. New capability facts go into `KnownAcpRuntime` → the IPC entry →
    the config core.

12. **Field absence carries a named reason, not a boolean.** `ownedByModelId`,
    `deferredUntilNativeOptionsAvailable`, `unsupportedByHarness`. A `showX` prop
    loses the reason, and the reason is what the UI needs to explain itself.

13. **`currentPersistence` and `targetApplication` intentionally differ.** Where
    a value lives today is not how the harness should receive it; "fixing" one to
    match the other without doing the migration silently moves data.

14. **A *successful empty* model discovery and a *failed* discovery are
    different.** Empty → hide the control and don't cache the result (so
    reopening retries after an install/sign-in). Failed → **keep** the control so
    failure UI can render, and never heal or clear persisted model/effort.

15. **Never seed `agentArgs` from `runtime.defaultArgs`, and never seed
    `envVars` from the definition.** Empty args let spawn resolve definition args
    live on every start; seeded env manufactures pseudo-overrides that mask later
    definition edits.

16. **Batch agent creation must be strictly sequential** — concurrent writes to
    the replaceable kind:39002 channel-members event cause last-write-wins data
    loss.

17. **A running agent does not need a restart to join a channel.** Membership
    notifications (44100/44101) are how a live harness discovers it. Only a
    not-yet-running agent gets started, and the check + start are pair-scoped to
    the active community.

18. **`(agent pubkey, relay URL)` is the runtime identity, and the URL must be
    canonicalized exactly as the backend does** (loopback folding, default-port
    and trailing-slash stripping). Pair keys are JSON-encoded so components
    cannot collide.

19. **A reconcile that produced no rows counts as reconciled; a call that threw
    fails the whole batch.** Retries walk `[5 s, 30 s, 2 m]` and then stop until
    the community set changes.

20. **Reuse never silently downgrades permissions.** When an existing agent is
    reused for a channel, the caller's `respondTo` (and allowlist) is applied to
    it, because the user's choice in the dialog is a decision, not a hint.

21. **Both `anyone` and `allowlist` warn, persistently, at the point of
    selection** — and an unknown run location reads as **local**, never hedged as
    "computer or server". A remote host is only even offerable when a provider
    binary is installed.

22. **`claude-code-acp` and `claude-agent-acp` are the same runtime.** Command
    matching normalizes both to `claude-acp` after taking the basename and
    lowercasing, on both `/` and `\` paths.

23. **The observer store's live window and archive window are strictly
    separate.** Live is per-agent and capped at 3000; archive is per
    (agent, channel) and uncapped. Loading deep history must never evict live
    frames, and live frames must never grow the archive. Consumers merge the raw
    events and derive transcript state **once** over the combined window — two
    independent state machines would split tool start/update, plan replacement,
    and permission request/response pairs.

24. **Verify `event.pubkey === agent tag` on both the live and archive ingest
    paths** even though the relay already gates on `is_agent_owner`. A
    compromised relay could misroute.

25. **Buffer frames for unknown agents during startup (cap 100) and re-run the
    same gate once the first trusted set registers**, then reject immediately.
    Ownership data arrives asynchronously; dropping those frames loses the first
    seconds of every session.

26. **The trusted-agent set is a union across mounted subscribers**, keyed by
    subscription id. Co-mounted panels tracking different agent lists would
    otherwise clobber each other.

27. **`_enabled` gates the relay subscription, never store reads.** An idle,
    stopped agent still has archived history and must render it.

28. **"latest live session" is the session that most recently arrived on the
    live path**, advanced only by strictly-after ordering — not an ever-live
    `Set` (which marks A "current" after B started) and not derived from
    connection state.

29. **`session/new` markers are session-START signals and must be re-anchored to
    the next resolved session.** On a restart they carry the *stale* session id,
    so a naive grouping puts the System Prompt card above the boundary divider.
    Multiple markers can arrive before resolution; accumulate them all, and flush
    back into the current run if the stream ends mid-restart.

30. **Use `firstItemId`, not `runIndex`, as the session-boundary React key.**
    Prepending older runs on an archive-page load shifts every index and churns
    keys for nodes that did not change.

31. **Messages, permissions, failed tools, status and suppressed rows never join
    a grouping run and always break one.** Collapsing them would hide exactly the
    intervention points a human is scanning for. `file-edit` collapses at 2, all
    other kinds at 3, and mixed bursts flatten their visible children to leaf
    rows so you never see "Ran 16 tool calls → Ran 12 commands".

32. **A `usage_update` replaces; every other lifecycle text appends.** Repeated
    token counts must not accumulate into a wall.

33. **`jsonRpcId` uses `JSON.stringify`** so the JSON-RPC number `1` and the
    string `"1"` cannot collide in the pending-permission map.

34. **Unknown ACP/session-update shapes are dropped, not guessed at.** Only
    payloads carrying an explicit `title` **and** `text` surface as free-form
    status.

35. **A structured error code is authoritative.** Once a code is present (or
    recoverable from the message), string patterns must not cross-classify it,
    and a `-32603` with adapter-specific detail keeps that detail rather than
    being buried by the generic codex hint.

36. **The memory tree is acyclic by construction** — a `visited` set means a
    memory appears at its first reachable position and later references to it are
    dropped from the tree, so a cyclic engram graph cannot hang the renderer. A
    reference to a tombstoned memory correctly surfaces as *dangling*.

37. **Memory ownership is decided by encryption, not key custody.** A remote
    owner holds no local seckey but legitimately owns the agent and can read its
    engrams; `useIsManagedAgent` returning `undefined` is a *loading* state, not
    `false`.

38. **Error-with-cache must keep the cache.** Memory, and the card gallery, both
    encode this: a failed refetch shows a non-blocking banner over live data, and
    an errored gallery query must never render as "No cards yet" — telling
    someone their persisted cards do not exist is worse than saying the load
    failed.

39. **The card-mint promise lives in a module store, not in the dialog.** That is
    the entire reason the dialog can dispatch-and-close while a 2–3 minute mint
    runs, and why completion can land as a toast plus a persistent chip.
    `viewerSeq` (not card bytes) keys the viewer, because every card PNG shares a
    header prefix and dimensions.

40. **`shared` is a TAG, not a content field.** Content bytes are the event id
    and the persona-drift `source_version`; a content toggle would read as a
    definition edit. The tag shape is exact-two-elements-`"true"`, exactly once,
    and every reader fails closed on anything else.

41. **Catalog visibility is relay-confirmed, never optimistic.** A queued
    publication stays visibly queued; the catalog renders only relay-confirmed
    heads; the saved-notice copy distinguishes `published` from `queued`.

42. **Catalog paging must dedupe by event id and stop when a page adds nothing
    new** — the relay treats `until` as inclusive, so pages overlap on tied
    timestamps and a run of identical `created_at` would otherwise loop forever.

43. **A foreign `respond_to: "allowlist"` is downgraded to `owner-only` on
    import** — someone else's allowlist means nothing in your community.

44. **A copied catalog entry is identified by its `catalogSource` coordinate, not
    its id.** The copy has a fresh local id, so without the coordinate the
    catalog would offer "Add" again and mint duplicates.

45. **Agent-authored management requests reject unknown keys outright**
    (`hasOnlyKeys`), defer the trust decision until ownership *and* channel
    membership have loaded (`"buffer"`), require the agent and owner to share the
    claimed origin channel at both receive time and submit time, and target a
    definition by its **current display name**, never an internal id.

46. **Emoji avatars are percent-encoded inline SVG, not base64** — they must pass
    through avatar resolution unchanged (never `atob`'d or uploaded), and the
    catalog accepts them precisely because the trailing comma in
    `data:image/svg+xml,` rejects `;base64` payloads.

47. **Snapshot preview performs zero writes and discloses the full manifest and
    the full source allowlist pubkeys** (not just a count), and `keepAllowlist`
    defaults to **false**. A locked card that cannot be unlocked refuses before
    any preview exists.

48. **`reconcileInboundPersonaEvent` takes the arrival relay URL** so a workspace
    switch mid-flight cannot retain an event into the newly active community's
    scoped store.

49. **The Share-compute toggle keys off `mode`, never `state`.** Both roles
    occupy one slot and both report `running`; keying on state lights up the
    switch while consuming a peer's compute and tears down that session on click.
    Only a **serve** runtime's model may be mirrored into the model field.

50. **The relay is the only tether.** After deploy the desktop holds no substrate
    control channel: stopping a healthy remote agent is a `!shutdown` *message*,
    presence is a lease the agent renews (≤ ~90 s of staleness, never
    indefinite), and a remote agent bounds its own lifetime rather than waiting
    for a supervisor that does not exist.
