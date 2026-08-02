# Buzz Parity Spec 03 — Workflows, Projects/Forge, Pulse, Reminders, Forum, Moderation, Home

Rebuild specification derived from `github.com/block/buzz`. Everything here is
sourced from the repo; file references are given as `path:symbol`. Buzz is a
Nostr-native team platform: every durable object is a signed Nostr event with a
`kind` integer, stored by a relay (`crates/buzz-relay`) in Postgres
(`crates/buzz-db`), and read by a Tauri desktop client (`desktop/`) whose React
layer talks to Rust commands (`desktop/src-tauri/src/commands/*`) which in turn
speak WebSocket/HTTP to the relay.

Two cross-cutting invariants that shape every feature below:

1. **Tenancy is server-resolved.** A `CommunityId` is bound from the request
   host (`crates/buzz-relay/src/tenant.rs:bind_community`), never from a
   client-supplied tag. The same UUID (channel, workflow, run) may exist in two
   communities; every lookup is `(community_id, id)`.
2. **Writes are signed events; reads are either NIP-01 filters over the event
   store or NIP-98-authed HTTP GETs.** There is no REST write path.

---

## 1. Workflows — the YAML automation engine

### 1.1 Where it lives

| Layer | Path |
|---|---|
| Engine (parse/validate/schedule/execute) | `crates/buzz-workflow/src/{lib,schema,executor,action_sink,error}.rs` |
| Persistence | `crates/buzz-db/src/workflow.rs` |
| Event ingest / command handlers | `crates/buzz-relay/src/handlers/command_executor.rs` |
| Webhook door | `crates/buzz-relay/src/api/bridge.rs:workflow_webhook` (route `POST /hooks/{id}`, registered in `crates/buzz-relay/src/router.rs:121`) |
| Webhook secret | `crates/buzz-relay/src/webhook_secret.rs` |
| Side-effect sink | `crates/buzz-relay/src/workflow_sink.rs` (implements `ActionSink`) |
| Desktop Rust commands | `desktop/src-tauri/src/commands/workflows.rs` |
| Desktop event builders | `desktop/src-tauri/src/events.rs:build_workflow_definition` / `build_workflow_delete` / `build_workflow_trigger` / `build_approval_grant` / `build_approval_deny` |
| SDK builders (CLI/agents) | `crates/buzz-sdk/src/builders.rs:build_workflow_definition` / `build_workflow_delete` / `build_workflow_trigger` / `build_workflow_approval` |
| Desktop TS API | `desktop/src/shared/api/tauriWorkflows.ts`, types in `desktop/src/shared/api/workflowTypes.ts` |
| Desktop React | `desktop/src/features/workflows/**`, routes `desktop/src/app/routes/workflows.tsx`, `workflows.$workflowId.tsx`, screen `desktop/src/app/routes/WorkflowsRouteScreen.tsx` |
| CLI | `crates/buzz-cli/src/lib.rs:WorkflowsCmd` |

### 1.2 Storage model

A workflow **is** a kind `30620` (`KIND_WORKFLOW_DEF`, parameterized-replaceable,
`crates/buzz-core/src/kind.rs:429`) event:

```jsonc
{
  "kind": 30620,
  "content": "<raw YAML document>",
  "tags": [
    ["d", "<workflow-uuid>"],   // canonical workflow id (NIP-33 identifier)
    ["h", "<channel-uuid>"]     // the channel the workflow is scoped to
  ]
}
```

The relay parses the YAML at ingest, stores canonical JSON in the `workflows`
table, and computes `definition_hash = SHA-256(canonical_json)` **after**
webhook-secret injection. Postgres tables:

| Table | Notes |
|---|---|
| `workflows` | `(community_id, id)` PK; `name`, `owner_pubkey`, `channel_id`, `definition` (jsonb), `definition_hash`, `status` (`active`\|`disabled`\|`archived`), `enabled` bool, timestamps — `crates/buzz-db/src/workflow.rs:WorkflowRecord` |
| `workflow_runs` | `(community_id, id)` PK; `workflow_id`, `status`, `trigger_event_id`, `current_step` i32, `execution_trace` jsonb, `trigger_context` jsonb, `started_at`, `completed_at`, `error_message` — `WorkflowRunRecord` |
| `workflow_approvals` | `(community_id, token)` PK where `token` is **SHA-256 of the raw token** (`hash_approval_token`); `workflow_id`, `run_id`, `step_id`, `step_index`, `approver_spec`, `status`, `approver_pubkey`, `note`, `expires_at` — `ApprovalRecord` |
| scheduled-fire claims | `(community_id, workflow_id, scheduled_for)` at-most-once claim rows — `claim_scheduled_workflow_fire`, `attach_scheduled_workflow_run`, `latest_scheduled_workflow_fire`, `prune_scheduled_workflow_fires_before` |

Status enums (`crates/buzz-db/src/workflow.rs`):
`WorkflowStatus = Active | Disabled | Archived`;
`RunStatus = Pending | Running | WaitingApproval | Completed | Failed | Cancelled`;
`ApprovalStatus = Pending | Granted | Denied | Expired`.

List queries are LIMIT-capped: `LIST_DEFAULT_LIMIT = 100`, `LIST_MAX_LIMIT = 1000`.

### 1.3 The YAML schema (complete)

Defined by `crates/buzz-workflow/src/schema.rs`. Both `TriggerDef` and
`ActionDef` are **serde internally-tagged enums with flattened fields** —
`trigger.on` is the tag, `step.action` is the tag, and each variant's fields sit
at the same level as the tag, never nested.

```yaml
name: string            # REQUIRED, must be non-empty after trim
description: string     # optional
enabled: bool           # optional, default true
trigger:                # REQUIRED
  on: <trigger-type>
  # …variant fields…
steps:                  # REQUIRED, at least one
  - id: string          # REQUIRED, unique, [A-Za-z0-9_]{1,64}
    name: string        # optional, human label
    if: string          # optional evalexpr boolean; false ⇒ step "skipped"
    timeout_secs: int   # optional; default = engine default_timeout_secs (300)
    action: <action-type>
    # …variant fields…
```

#### Trigger types (5)

| `on:` | Fields | Fires on |
|---|---|---|
| `message_posted` | `filter` (optional evalexpr string) | stored event of kind `9` (`KIND_STREAM_MESSAGE`) in the workflow's channel |
| `reaction_added` | `emoji` (optional string; omit = any emoji) | kind `7` (`KIND_REACTION`) |
| `diff_posted` | `filter` (optional evalexpr) | kind `40008` (`KIND_STREAM_MESSAGE_DIFF`, a unified-diff message) |
| `schedule` | exactly one of `cron` (string) or `interval` (duration string) | the 60 s cron loop |
| `webhook` | none | `POST /hooks/{workflow-id}` with the secret |

`trigger_matches_event` (`crates/buzz-workflow/src/lib.rs`) maps kinds strictly:
`message_posted` matches **only** kind 9 (not 40002 v2 messages, not 45001 forum
posts). `schedule` and `webhook` never match an ingested event.

Emoji and filter conditions are evaluated *after* kind matching, in
`should_fire_workflow`; a filter that errors **skips the workflow** (fail closed,
logged at warn).

#### Action types (7)

| `action:` | Fields | Behaviour |
|---|---|---|
| `send_message` | `text` (required, templated), `channel` (optional UUID override) | posts into the channel via `ActionSink::send_message`; output `{"sent": true, "event_id": "<hex>"}` |
| `send_dm` | `to` (pubkey hex or `{{trigger.author}}`), `text` | **`NotImplemented`** — a run reaching this step fails |
| `set_channel_topic` | `topic` | **`NotImplemented`** — run fails |
| `add_reaction` | `emoji` | `POST {BUZZ_RELAY_BASE_URL}/api/messages/{trigger.message_id}/reactions` with `{"emoji": …}`; requires the `reqwest` feature, else returns `{"added": false, "skipped": true}`; errors if `trigger.message_id` is empty |
| `call_webhook` | `url` (required), `method` (default `POST`), `headers` (map, values templated), `body` (templated) | SSRF-guarded outbound HTTP; output `{"status": <u16>, "body": "<text>"}` |
| `request_approval` | `from` (approver spec), `message`, `timeout` (duration, default `"24h"`) | returns `StepResult::Suspended { approval_token }`; execution stops here |
| `delay` | `duration` | `tokio::sleep`; **capped at 270 s** (`MAX_DELAY_SECS`, deliberately < the 300 s default step timeout); output `{"slept_secs": n}` |

`send_message` channel resolution (`executor.rs:resolve_send_message_channel`):
if the workflow row has a `channel_id`, that wins and an explicit `channel:`
override **must equal it** or the step errors; if the workflow has no channel,
the override is used; otherwise `trigger.channel_id`; if that is empty the step
errors ("no channel_id available"). Consequence surfaced in the UI: webhook-
triggered and manually-triggered runs have no trigger channel, so the builder
warns that a `channel` override is needed
(`desktop/src/features/workflows/ui/WorkflowStepCard.tsx`).

#### `call_webhook` hardening (`executor.rs:call_webhook_impl`, `check_ssrf`)

- Hostname resolved via `to_socket_addrs` on a blocking thread; **every**
  resolved IP is checked with `buzz_core::network::is_private_ip`; any
  private/reserved address ⇒ refuse. Zero addresses or DNS failure ⇒ refuse.
- The first validated IP is **pinned** into a per-request `reqwest::Client`
  (`.resolve(host, addr)`) to defeat DNS-rebinding TOCTOU. Connection pooling is
  sacrificed on purpose.
- `.no_proxy()` (a system proxy would re-resolve the hostname) and
  `redirect::Policy::none()` (a redirect to an internal host would bypass the
  check).
- 10 s timeout; response read chunk-by-chunk and aborted past
  `WEBHOOK_MAX_RESPONSE_BYTES = 1 MiB`.

#### Duration grammar

`executor.rs:parse_duration_secs`: `<n>h`, `<n>m`, `<n>s`, or a bare integer
(seconds). Overflow on multiply is an error. Used for `delay.duration`,
`request_approval.timeout`, and `schedule.interval`.

#### Cron grammar

`schema.rs:normalize_cron` — the `cron` crate needs 7 fields
(`sec min hour dom month dow year`). A 5-field expression gets `0` prepended and
`*` appended; 6 fields get `*` appended; 7 pass through. So `0 9 * * 1-5`
becomes `0 0 9 * * 1-5 *`. All cron times are UTC.

### 1.4 Validation rules (`WorkflowDef::validate`)

Every rule below is a hard reject at ingest, surfaced to the client as
`invalid: workflow YAML parse error: …`:

1. `name` non-empty after trim.
2. `steps` non-empty.
3. Each `step.id` non-empty, ≤ 64 chars, `[A-Za-z0-9_]` only. **Dashes are
   rejected** because ids become evalexpr variable names
   (`steps_my-step_output_x` would parse as subtraction). Semicolons/spaces
   likewise.
4. Step ids unique.
5. `schedule` requires exactly one of `cron` / `interval` (neither ⇒ error, both
   ⇒ error).
6. `cron` must parse after normalization.
7. `interval` must parse **and be ≥ 60 s** — the scheduler ticks every 60 s, so
   sub-minute intervals could never fire correctly.

Unknown trigger `on:` values and unknown `action:` values fail serde
deserialization (`WorkflowError::InvalidYaml`).

Error enum (`crates/buzz-workflow/src/error.rs:WorkflowError`):
`InvalidYaml`, `InvalidDefinition`, `ConditionError`, `TemplateError`,
`StepTimeout{step_id,timeout_secs}`, `WebhookError`, `CapacityExceeded`,
`Database`, `Unauthorized`, `NotImplemented`.

### 1.5 Template variables

`executor.rs:resolve_template`. Single pass, **not recursive**. Syntax
`{{ path }}` or `{{ path | filter }}`.

Resolvable paths:

- `trigger.text` — event content (message body; empty for schedule runs)
- `trigger.author` — pubkey hex; taken from an `actor` tag if present, else
  `event.pubkey` (`lib.rs:build_trigger_context`)
- `trigger.channel_id`
- `trigger.timestamp` — unix seconds as string
- `trigger.emoji` — reaction content for kind 7, else empty
- `trigger.message_id` — for reactions, the **target** message id read from the
  last `e` tag that is 64 hex chars (NIP-25 last-`e`-is-target rule), falling
  back to the reaction's own id; for everything else, the event's own id
- `trigger.<anything else>` — webhook body fields (see below)
- `steps.<STEP_ID>.output.<FIELD>` — one level deep only; the step output must
  be a JSON object

Filters:

- `| truncate(N)` — first N **characters** (`chars().take(n)`, not bytes)
- `| npub` (alias `| truncate_pubkey`) — bech32-encode a hex pubkey in **full**;
  a truncated prefix would be grindable. Non-pubkey values pass through.
- Any other filter ⇒ `TemplateError: unknown filter: …`

**Unknown variables are emitted literally** (`{{unknown.var}}` stays in the
output). An unclosed `{{` is emitted literally and parsing stops.

JSON→string coercion (`json_to_string`): strings unwrapped, bool/number
stringified, `null` → empty string, arrays/objects → their JSON text.

### 1.6 Condition expressions (`if:` and trigger `filter:`)

`executor.rs:build_eval_context` / `evaluate_condition`, using the `evalexpr`
crate with a `HashMapContext`. **evalexpr has no dotted identifiers**, so the
dotted YAML paths map to underscore variables:

| YAML reference | evalexpr variable |
|---|---|
| `trigger.text` | `trigger_text` |
| `trigger.author` | `trigger_author` |
| `trigger.channel_id` | `trigger_channel_id` |
| `trigger.timestamp` | `trigger_timestamp` |
| `trigger.emoji` | `trigger_emoji` |
| `trigger.message_id` | `trigger_message_id` |
| `steps.ID.output.FIELD` | `steps_ID_output_FIELD` |
| webhook body key `k` | `trigger_k` |

Registered helper functions (evalexpr v11 ships none of these):
`str_contains(haystack, needle) -> bool`, `str_starts_with(s, prefix) -> bool`,
`str_ends_with(s, suffix) -> bool`, `str_len(s) -> int`. Operators are
evalexpr's own (`==`, `!=`, `&&`, `||`, `!`, comparisons, arithmetic).

Safety:

- Webhook fields are registered **first** so the six canonical `trigger_*`
  variables always overwrite them; body keys starting with `trigger_` or
  `steps_` are dropped outright — a webhook caller can never spoof
  `trigger_author`.
- Expression length is capped at `MAX_EXPR_LEN = 4096` bytes.
- Evaluation runs on `spawn_blocking` under a `tokio::time::timeout` of
  `EVAL_TIMEOUT = 100 ms`. (Note the honest caveat in the source: the blocking
  thread cannot actually be cancelled, which is why the length cap exists.)
- Any evaluation error inside a step ⇒ the run **fails** with
  `ConditionError`; the same error in a *trigger filter* ⇒ the workflow is
  silently skipped.

A false `if:` produces a trace entry `{"step_id": …, "status": "skipped"}` and
execution continues. It is not a failure.

### 1.7 Secrets

There is no general secret store. The only secret in the model is the **webhook
secret** (`crates/buzz-relay/src/webhook_secret.rs`):

- Generated as a UUID v4 string (122 bits) on the first save of a
  webhook-triggered workflow (`generate_webhook_secret`).
- Stored **inside the definition JSON** under the key `_webhook_secret`
  (`inject_secret`), which is why the `definition_hash` must be computed *after*
  injection — documented as a load-bearing ordering contract.
- Preserved across updates: an update re-reads the existing secret; a new secret
  is returned **only** the first time the workflow gains a webhook trigger. The
  ingest response carries `{"workflow_id": …, "webhook_secret": …}` exactly once.
- `strip_secret` removes it before any API response.
- Verified with a constant-time XOR fold (`verify_secret`); length mismatch is
  allowed to short-circuit (the length is always 36).

Anything else secret (auth tokens for `call_webhook`) is written literally into
`headers:` in the YAML and is visible to anyone who can read the workflow
definition — hence the elevated-authority rule below.

### 1.8 Authority model (SEC-006)

`WorkflowDef::requires_elevated_authority()` is true iff any step is
`call_webhook` — the only action that can exfiltrate channel content to an
arbitrary destination.

- **Save** (`command_executor.rs:handle_workflow_def`): caller must be a member
  of the `h`-tag channel; if the definition requires elevated authority the
  caller must currently hold role `owner` or `admin`. Ownership is pinned: an
  existing row with a different `owner_pubkey` or a different `channel_id` is
  rejected.
- **Every run-creation door re-checks the owner's *current* authority**
  immediately before creating a run (`WorkflowEngine::check_owner_authority`,
  pure decision in `owner_authority_allows`): not a member ⇒ deny; member ⇒ ok
  for ordinary definitions; elevated definitions ⇒ `owner`/`admin` only. Any
  lookup error denies (fail-closed). The four doors are: event trigger
  (`on_event`), cron tick (before the durable claim, so a revoked owner cannot
  burn the at-most-once slot), manual trigger (kind 46020), and the webhook
  endpoint.
- Manual trigger (46020) additionally requires `event.pubkey == workflow.owner_pubkey`
  and `workflow.enabled && status == Active`.
- The webhook endpoint fails **closed with the same generic 404** for: unmapped
  host, workflow not in this community, disabled/inactive workflow, no channel
  scope, failed owner-authority check — so a caller cannot probe which hosts or
  workflow ids exist.

### 1.9 Execution

`executor.rs:execute_run` → `execute_steps`; resume path
`execute_from_step(start_index, initial_outputs)`.

1. `try_acquire()` a permit from `run_semaphore` (`WorkflowConfig.max_concurrent
   = 100`). **No queuing** — exhaustion returns `CapacityExceeded` immediately.
2. Set run status `Running`, step 0, empty trace.
3. For each step from `start_index`:
   a. Evaluate `if:` (skip ⇒ trace `skipped`, continue; error ⇒ fail).
   b. Resolve templates in every action field (`resolve_step_templates`;
      `method` and `delay.duration` are *not* templated).
   c. Dispatch under `tokio::time::timeout(step.timeout_secs ?? 300)`; a timeout
      is `StepTimeout`.
   d. `Completed(output)` ⇒ trace `{step_id, status:"completed", output}` and
      `step_outputs[step_id] = output`.
      `Suspended{token}` ⇒ return immediately with `approval_token`,
      `step_index = i`, the partial trace and outputs.
4. Completion returns `step_index = steps.len()`.

Failures return `(WorkflowError, PartialProgress { step_index, trace })` so the
partial trace survives.

`WorkflowEngine::finalize_run` is the **single** place a result becomes a DB
status: `Ok` with no token ⇒ `Completed`; `Ok` with a token ⇒ (in the engine's
own code path) logged as "approval gates not yet implemented — WF-08" and marked
`Failed`; `Err` ⇒ `Failed` with the error string. `existing_trace` is prepended
so a resumed run keeps its pre-approval entries.

`ActionSink` (`crates/buzz-workflow/src/action_sink.rs`) is the seam for side
effects — a trait with one method `send_message(community_id, channel_id, text,
author_pubkey) -> event_id`, implemented by the relay
(`crates/buzz-relay/src/workflow_sink.rs`) with direct DB access. It replaced an
HTTP loopback that failed auth. Errors:
`InvalidInput | ChannelNotFound | ChannelArchived | EventBuild | Database | EmptyContent`.
The relay keypair signs; the workflow owner's pubkey rides as an attribution
tag. Messages published by a workflow carry a `buzz:workflow` tag and are
excluded from re-triggering.

### 1.10 Trigger paths in detail

**Event path** — `WorkflowEngine::on_event(community_id, stored_event)`, called
from the relay's post-store hook (step 12 of the ingest pipeline, spawned
fire-and-forget):

- Skip events with no `channel_id`.
- Skip workflow execution kinds `46001..=46012` (`is_workflow_execution_kind`)
  — loop prevention. Relay-signed messages tagged `buzz:workflow` and
  `KIND_GIT_WRAP` are also excluded upstream.
- Look up enabled workflows for `(community, channel)` through a **moka cache,
  TTL 10 s, capacity 10 000**. Invalidated on the same pod by
  `invalidate_channel_workflows` at the two mutation sites (30620 upsert, NIP-09
  deletion). Deliberately no cross-pod invalidation — triggering is not an
  access-control fence, and the per-fire authority recheck is.
- For each workflow: parse definition, check `enabled`, `trigger_matches_event`,
  `should_fire_workflow` (emoji/filter), `check_owner_authority`, then
  `create_workflow_run` and `tokio::spawn` the execution.

**Schedule path** — `WorkflowEngine::run()`, a loop sleeping 60 s:

- Load all enabled workflows across communities; skip those with no
  `channel_id`.
- **cron**: `cron_fire_instant(expr, now, 60)` finds the next scheduled instant
  after `now - 60s` and keeps it only if `<= now` (window matching tolerates
  tick drift). The returned instant is the cron's *own scheduled time*, not
  `now`, so every pod computes the same claim key.
- **interval**: an in-memory `last_fired: DashMap<(CommunityId, Uuid), DateTime>`
  pre-filter, seeded on restart from `latest_scheduled_workflow_fire`. The claim
  anchor is the epoch-aligned bucket `floor(now/interval)*interval`
  (`interval_fire_instant`), identical on every pod inside a bucket.
  Cold-start liveness rule (`interval_prefilter_should_fire`): on the first
  suppressed tick where `last` is `None`, seed `now` — otherwise every tick
  re-reads `None`, suppresses, and the workflow never fires. Never advance an
  existing `Some` anchor on suppress (it would never elapse), and never seed on
  a firing tick (the post-claim path owns that write).
- Authority check, then the durable claim
  `claim_scheduled_workflow_fire(community, workflow, scheduled_for)` — the
  cross-pod at-most-once boundary. Loser skips before any side effect. If the
  claim wins but the run insert fails, the claim row **stays** (at-most-once
  beats exactly-once).
- `attach_scheduled_workflow_run` links claim→run for audit (best effort).
- Prune `last_fired` entries for workflows no longer enabled at the end of each
  tick.

**Manual trigger** — kind `46020` (`KIND_WORKFLOW_TRIGGER`) with a `d` (or `e`)
tag = workflow uuid. Content, if a JSON object, becomes `webhook_fields` in the
trigger context (this is how `buzz workflows trigger --inputs '{"k":"v"}'`
works). Only the owner may trigger. Response `{"run_id": "<uuid>"}`.

**Webhook** — `POST /hooks/{workflow-id}` with header `X-Webhook-Secret`
(preferred; not logged by proxies) or `?secret=` query fallback. Body, if a JSON
object, is flattened into `webhook_fields` (non-string values stringified via
`Value::to_string`). Requires the workflow's trigger to actually be `webhook`.
Returns `202 Accepted` with `{"run_id", "workflow_id", "status": "pending"}`.

### 1.11 Approval gates

The full loop exists in the relay/DB even though `finalize_run`'s in-engine path
is still marked WF-08:

- `request_approval` yields `StepResult::Suspended { approval_token }` where the
  token is a fresh `Uuid::new_v4()` (OS CSPRNG; run id and step id are
  deliberately *not* mixed in — time-derived entropy would be predictable).
- The record is stored with the token **hashed** (SHA-256) and an `expires_at`
  derived from `timeout` (default 24 h). `approver_spec` is the YAML `from:`.
- A human approves by publishing kind `46030` (`KIND_APPROVAL_GRANT`) or `46031`
  (`KIND_APPROVAL_DENY`), referencing the approval by `d` (or `e`) tag holding
  the **hex token hash**; event content is the optional note.
- `check_approver_spec` (`command_executor.rs`) accepts: `""` or `"any"` (anyone
  authenticated), or a 64-char hex pubkey matching the caller case-insensitively.
  **Anything else — including role strings like `@release-manager` — is rejected
  fail-closed** ("approver spec … is not yet supported").
- Grant: must be `Pending` and not past `expires_at`; the command event is
  persisted, the approval updated to `Granted` (a lost race yields "already acted
  on"), the transaction committed, and only then is
  `resume_workflow_after_approval` spawned. Resume guards `run.status ==
  WaitingApproval`, rebuilds `step_outputs` from the stored trace entries
  (`step_id` + `output`), restores `trigger_context` from the run row, and calls
  `execute_from_step(resume_index = step_index + 1, Some(initial_outputs))`,
  finalizing with the existing trace prepended.
- Deny: same validation, status → `Denied`, then the run is moved to
  `Cancelled` with `error_message = "workflow cancelled: approval denied by
  <pubkey-hex>"`.
- Push notifications: kind `46010` is in `PUSH_KINDS` and in `urgent_kinds`
  (`crates/buzz-relay/src/handlers/push_lease.rs:15`), so approval requests
  wake phones.

What blocks: the run sits at `WaitingApproval` and no later step executes.
Nothing auto-expires the run; an `Expired` approval status exists in the enum
and a grant/deny past `expires_at` is refused.

### 1.12 Event kinds 46001–46012 (and 46020/46030/46031)

From `crates/buzz-core/src/kind.rs:543-569`:

| Kind | Constant | Meaning |
|---|---|---|
| 46001 | `KIND_WORKFLOW_TRIGGERED` | a workflow was triggered by a matching event |
| 46002 | `KIND_WORKFLOW_STEP_STARTED` | a step began |
| 46003 | `KIND_WORKFLOW_STEP_COMPLETED` | a step completed |
| 46004 | `KIND_WORKFLOW_STEP_FAILED` | a step failed |
| 46005 | `KIND_WORKFLOW_COMPLETED` | run completed |
| 46006 | `KIND_WORKFLOW_FAILED` | run failed |
| 46007 | `KIND_WORKFLOW_CANCELLED` | run cancelled before completion |
| 46010 | `KIND_WORKFLOW_APPROVAL_REQUESTED` | a step waits for human approval |
| 46011 | `KIND_WORKFLOW_APPROVAL_GRANTED` | approval granted |
| 46012 | `KIND_WORKFLOW_APPROVAL_DENIED` | approval denied |
| 46020 | `KIND_WORKFLOW_TRIGGER` | **command**: run this workflow now |
| 46030 | `KIND_APPROVAL_GRANT` | **command**: grant a pending approval |
| 46031 | `KIND_APPROVAL_DENY` | **command**: deny a pending approval |

`is_workflow_execution_kind(k) == (46001..=46012).contains(k)` — that whole
band is excluded from workflow triggering (loop prevention) and from the Home
activity feed (`crates/buzz-db/src/feed.rs:279`, "intentionally excluded to
avoid noise").

**Payload shapes.** The 46001–46012 lifecycle band is a *reserved, designed*
namespace: in the current tree the relay has no producer for it (execution state
lives in `workflow_runs`), and `desktop/src-tauri/src/commands/workflows.rs`
documents this explicitly — `get_workflow_runs` and `get_run_approvals` return
`[]` with a `TODO(workflow-runs)` rather than fabricate rows from lifecycle
events. Kind 46010 *is* produced (it is push-routed and rendered by the inbox,
`desktop/src/features/home/lib/inbox.ts:190`). When rebuilding, emit the band
with this shape, which is what every consumer already assumes:

```jsonc
// 46001 triggered / 46005 completed / 46006 failed / 46007 cancelled
{ "kind": 46001, "content": "{}",
  "tags": [["h","<channel-uuid>"], ["d","<run-uuid>"], ["workflow","<workflow-uuid>"],
           ["e","<trigger-event-id>"], ["p","<owner-pubkey>"]] }

// 46002/46003/46004 step events — content carries the step's trace entry
{ "kind": 46003, "content": "{\"step_id\":\"notify\",\"status\":\"completed\",\"output\":{…}}",
  "tags": [["h",…], ["d","<run-uuid>"], ["step","notify"], ["index","0"]] }

// 46010 approval requested — the only one with a live producer + push lease
{ "kind": 46010, "content": "<the request_approval `message:` text>",
  "tags": [["h",…], ["d","<hex-sha256-of-token>"], ["workflow",…], ["e","<run-id>"],
           ["p","<approver-pubkey>"], ["expiration","<unix-secs>"]] }

// 46011 granted / 46012 denied — relay-signed mirror of the 46030/46031 command
{ "kind": 46011, "content": "<approver note>",
  "tags": [["d","<hex-token-hash>"], ["p","<approver-pubkey>"], ["e","<run-id>"]] }
```

The `p`-tag on 46010 is what puts it in the target's Needs-Action feed
(`crates/buzz-db/src/feed.rs` joins `event_mentions`); the `expiration` tag
mirrors `workflow_approvals.expires_at`.

The client-side wire contract that *is* fully specified is
`desktop/src/shared/api/workflowTypes.ts`:

```ts
Workflow      = { id, name, ownerPubkey, channelId, definition: Record<string,unknown>,
                  status: "active"|"disabled"|"archived", createdAt, updatedAt }
WorkflowSaveResult = { workflow, webhookSecret: string|null }
WorkflowRun   = { id, workflowId, status: "pending"|"running"|"completed"|"failed"|
                  "cancelled"|"waiting_approval", currentStep: number|null,
                  executionTrace: TraceEntry[], startedAt, completedAt,
                  errorMessage: string|null, createdAt }
TraceEntry    = { stepId, status, output: Record<string,unknown>,
                  startedAt: number|null, completedAt: number|null, error: string|null }
WorkflowApproval = { token, workflowId, runId, stepId, stepIndex, approverSpec,
                  status: "pending"|"granted"|"denied"|"expired", approverPubkey,
                  note, expiresAt: string /*ISO*/, createdAt }
```

### 1.13 Desktop client surface

`desktop/src-tauri/src/commands/workflows.rs` exposes:
`get_channel_workflows(channelId)`, `get_channels_workflows(channelIds)` (one
relay query with a multi-value `#h` filter — replaced an N-channel fanout),
`get_workflow(workflowId)` (`#d` filter, limit 1), `get_workflow_runs` (→ `[]`),
`create_workflow`, `update_workflow` (re-reads the prior event to recover the
`h` tag and `created_at`, since 30620 is replaceable by `(pubkey, d)`),
`delete_workflow` (kind 5 with `a` = `30620:<owner>:<id>`), `trigger_workflow`,
`get_run_approvals` (→ `[]`), `grant_approval`, `deny_approval`.

`workflow_from_event` derives everything from the event: `id` = `d` tag,
`channel_id` = `h` tag, `definition` = the YAML parsed to free-form JSON, `name`
= `definition.name` (falling back to the id when blank), `status` hard-coded
`"active"` (the relay's disable/archive lifecycle is not reflected back into the
30620 event). **A malformed workflow must not break the list** — `parse_definition`
falls back to `{}` on any parse failure or non-object document.

React query layer `desktop/src/features/workflows/hooks.ts`:
`useChannelWorkflowsQuery` (staleTime 30 s, refetch on focus),
`useWorkflowQuery`, `useWorkflowRunsQuery` (staleTime 10 s;
**`refetchInterval` becomes 1 s while any run is `pending`/`running`/
`waiting_approval`**, else off), `useRunApprovalsQuery` (10 s poll),
`useCreateWorkflowMutation`, `useUpdateWorkflowMutation`,
`useDeleteWorkflowMutation`, `useTriggerWorkflowMutation`,
`useApprovalMutation({token, action: "grant"|"deny", note})`. Query keys:
`["workflows-all", <sorted-channel-id-csv>]`, `["workflows", channelId]`,
`["workflow", id]`, `["workflow-runs", id]`, `["run-approvals", id, runId]`.

#### Screens

Routes: `/workflows` and `/workflows/$workflowId` both lazily render
`WorkflowsRouteScreen`, both gated by `usePreviewFeatureWarning("workflows")`.
`WorkflowsScreen` → `WorkflowsView`.

**List (`ui/WorkflowsView.tsx`)** — a two-pane layout. Left: header "Workflows"
with a refresh icon-button (spins while fetching) and a "Create Workflow"
primary button; then either a 4-card skeleton (`WorkflowsListSkeleton`), a
"Failed to load workflows" + Retry state, an empty state (Zap icon, "No
workflows yet", "Create your first workflow"), or the list of `WorkflowCard`s.
Right: a 400 px `WorkflowDetailPanel` when a workflow is selected.
Local state is a discriminated `DialogState` (`closed | create | edit |
duplicate`) plus a `deleteTarget`.

**`WorkflowCard`** — Zap glyph, name, status badge, then a meta row of channel
name · trigger summary · last-updated date, then the description. A `…` dropdown
offers Trigger / Edit / Duplicate / Delete (destructive styling). The whole card
is a click target via an absolutely-positioned invisible button.

Derived display helpers (`ui/workflowDefinition.ts`):
`getWorkflowEnabled(def) = def.enabled !== false`;
`getWorkflowDisplayStatus(wf)` returns the row status unless it is `active` and
`definition.enabled === false`, in which case `"disabled"` — this is how
enable/disable is expressed, because the 30620 event never carries a status;
`getWorkflowTriggerSummary` builds `"<Trigger Label> · <detail>"` where the
detail is the filter (message/diff), the emoji (reaction), or the cron/interval
(schedule).

**Detail panel (`ui/WorkflowDetailPanel.tsx`)** — header with name + status
badge, description, trigger summary, and buttons Edit / Trigger / Close.
Triggering selects the returned `runId`. Body: a `Definition` section showing
`JSON.stringify(workflow.definition, null, 2)` in a scrollable `<pre>`, then
`Run History`. Each run row is a collapsible button showing the first 8 chars of
the run id (monospace), a status badge, then created-at, step count, duration,
and `Current step N+1`; `errorMessage` renders in destructive red. Expanding
shows "Execution Trace" (+ "Refreshing approvals…" while the approvals query is
in flight) and `WorkflowRunTrace`.

`formatRunDuration(startedAt, completedAt)` → `"NNNms"` under a second, else
`"N.Ns"`. Status labels replace `_` with a space.

Status→badge variant map (both run and workflow):
`active|completed → success`, `failed → destructive`, `running → info`,
`pending|cancelled|disabled → secondary`, `archived|waiting_approval → warning`.

**`WorkflowRunTrace`** — empty trace renders "No steps recorded yet." in a
dashed box. Each entry is a card with a status icon (`completed` = green check,
`failed`/`error` = red X, `skipped` = grey skip-forward, `waiting_approval` =
amber clock, default = blue clock), the step id in monospace, a status badge, a
duration; then an `Output` block (`<pre>` of the JSON, only when the output
object is non-empty) and an `Error` block (red `<pre>`); then, when an approval
with the same `stepId` and status `pending` exists, a "Pending approval" section
holding `WorkflowApprovalCard`.

**`WorkflowApprovalCard`** — renders nothing unless the approval is `pending`
and `expiresAt` is in the future. Shows `Approver: <approverSpec>` and
`Expires: <locale string>`, an optional note textarea, and green **Approve** /
destructive **Deny** buttons wired to `useApprovalMutation`.

#### Editing / validation UX

`WorkflowDialog` (create | edit | duplicate) hosts a channel combobox (hidden in
edit mode; a plain sentence when there is only one channel), the
`WorkflowFormBuilder`, an error paragraph rendering `mutation.error.message`
verbatim (this is where relay rejections such as
`invalid: workflow YAML parse error: duplicate step id: step1` surface), and
Cancel/Submit. Duplicate mode pre-fills the YAML with `name: "<name> (copy)"`.
On a successful save that returns a `webhookSecret`, the dialog closes and
`WorkflowWebhookSecretDialog` opens showing the URL
`${relayHttpUrl}/hooks/${workflowId}` and the `X-Webhook-Secret` value, each
with a copy button, and the warning "This secret is only shown now. If it is
lost, re-save the workflow to generate a new one."

`WorkflowFormBuilder` is a **two-way form ⇄ YAML editor**. It parses the YAML
once on mount; if parsing fails it starts in raw-YAML mode. The toggle button
reads "Edit as YAML" / "Back to form"; switching back re-parses and, on failure,
shows `Cannot switch to form view: <error>` and stays in YAML mode.
`yamlToFormState` refuses unknown trigger or action types with
`Unsupported trigger type "x" — use the YAML editor`.

Form fields: name, description, an "Workflow is enabled" checkbox, a trigger
select (Message Posted / Reaction Added / Diff Posted / Webhook / Schedule) with
trigger-specific inputs, and a Steps list with Add step (defaults to a `delay`
step with id `step_N`, `nextStepId` picking the next free `step_<n>`).

`WorkflowStepCard` renders, per step: Step ID + Step name, Action select +
Timeout seconds, Run condition, then action-specific fields. It also renders
honest **backend-support hints** in amber for `send_dm`, `set_channel_topic`
("not executed yet, so runs fail at this step") and `request_approval`
("approval gates still stop runs with WF-08"), a `URL must start with https://`
warning on `call_webhook`, and the webhook-trigger channel-override warning on
`send_message`.

`formStateToYaml` emits keys in the order `name, trigger, steps` then
`description`/`enabled` (only when non-default: `enabled` is written only when
false). `timeout_secs` is emitted only for a positive integer string.

`WorkflowDeleteDialog` is an AlertDialog: "Delete workflow?" /
"Delete \"<name>\". This will stop all future triggers and remove the workflow
permanently."

### 1.14 Three real workflow examples from the repo

**(a) Incident triage — message trigger + conditional approval**
(`ARCHITECTURE.md:513`)

```yaml
name: "Incident Triage"
trigger:
  on: message_posted
  filter: "str_contains(trigger_text, 'P1')"
steps:
  - id: notify
    action: send_message
    text: "P1 incident detected: {{trigger.text}}"
  - id: page
    if: "str_contains(trigger_text, 'production')"
    action: request_approval
    from: "{{trigger.author}}"
    message: "Page on-call?"
```

**(b) Approval-gated deploy — branching on a step's output**
(`crates/buzz-workflow/src/schema.rs:parse_approval_gate_example`)

```yaml
name: Deploy Approval
trigger:
  on: webhook
steps:
  - id: request
    action: request_approval
    from: '@engineering-lead'
    message: Approve deploy?
    timeout: 4h
  - id: notify_approved
    if: 'steps_request_output_approved == true'
    action: send_message
    text: Deploy approved
  - id: notify_denied
    if: 'steps_request_output_approved == false'
    action: send_message
    text: Deploy denied
```

**(c) CI on a branch channel — diff trigger + webhooks + merge gate**
(`VISION_PROJECTS.md:160`)

```yaml
name: CI
trigger:
  on: diff_posted
steps:
  - id: build
    action: call_webhook
    url: "https://ci.internal/build"
    body: '{"commit": "{{trigger.commit}}"}'
  - id: test
    action: call_webhook
    url: "https://ci.internal/test"
    if: "steps.build.output.status == 'success'"
  - id: gate
    action: request_approval
    message: "CI passed. Approve merge?"
    if: "steps.test.output.status == 'success'"
```

(Note the vision doc writes dotted names in `if:`; the engine requires the
underscore form `steps_build_output_status`, and `trigger.commit` is not a
context field — a rebuild should either add those or fix the example.)

Two more that exercise the remaining triggers, verbatim from the test suites:

```yaml
# schema.rs:parse_schedule_trigger
name: Daily Standup
trigger:
  on: schedule
  cron: '0 9 * * 1-5'      # weekdays 09:00 UTC
steps:
  - id: prompt
    action: send_message
    text: Standup time
```

```yaml
# crates/buzz-cli/TESTING.md:374 — the smallest valid webhook workflow
name: test-wf
trigger:
  on: webhook
steps:
  - id: step1
    action: send_message
    text: "Hello from workflow"
```

---

## 2. Projects / branch-as-room (the Nostr-native forge)

Design doc: `VISION_PROJECTS.md`. Implementation: `desktop/src/features/projects/**`,
`crates/buzz-relay/src/api/git/**`, `crates/buzz-core/src/git_perms.rs`.

### 2.1 What a project is

A project is a **NIP-34 repository announcement**, kind `30617`
(`KIND_GIT_REPO_ANNOUNCEMENT`), parameterized-replaceable keyed by
`(author_pubkey, d-tag)`. Its NIP-34 address (`repoAddress`) is
`30617:<owner-hex>:<d-tag>` and that address is the join key for every other
forge event (`a` tags everywhere).

Tags read by `desktop/src/features/projects/hooks.ts:eventToProject`:

| Tag | Meaning |
|---|---|
| `d` | repo id / slug (falls back to the event id) |
| `name` | display name (falls back to `d`) |
| `description` | falls back to `event.content` |
| `clone` | multi-value: `["clone", url1, url2, …]`; when absent, a canonical URL is synthesized from the relay origin + owner + d (`lib/projectCloneUrl.ts:effectiveCloneUrls`) |
| `web` | browser URL |
| `p`, `auth` | contributors (union, deduped) |
| `h` / `project-channel` | bound channel (read-side tolerance only — no current writer) |
| `status`, `default-branch` | read-side tolerance; the canonical default branch is the `HEAD` ref on the 30618 state event |
| `buzz-channel` | **the git ACL** (see 2.3) |
| `buzz-visibility` | `listed` \| unlisted |
| `buzz-protect` | branch protection rules (see 2.4) |
| `maintainers` | NIP-34 maintainer list |
| `relays` | where to find the repo's events |

`Project` shape (`hooks.ts:Project`): `{ id: "<owner>:<dtag>", dtag, name,
description, cloneUrls, webUrl, owner, contributors, createdAt,
projectChannelId, status, defaultBranch, repoAddress }`.

`RepoState` comes from kind `30618` (`KIND_GIT_REPO_STATE`), whose tags are ref
names: `["refs/heads/<branch>", "<oid>"]`, `["refs/tags/<tag>", "<oid>"]`,
`["HEAD", "ref: refs/heads/<branch>"]`. `eventToRepoState` strips the prefixes.

Multi-repo grouping is the one custom kind: `30621` (`KIND_PROJECT`, NIP-MP,
`docs/nips/NIP-MP.md`) — `d` = project slug, `a` tags naming member
`30617:<owner>:<repo>` coordinates, plus `buzz-channel` / `buzz-visibility`.
Rationale (VISION_PROJECTS §"One Project, Many Repos"): membership cannot live
in each 30617 because Alice cannot sign for Bob's repo. **The 30621 signer gains
no authority over any member** — push policy always reads the repository's own
announcement.

### 2.2 The forge event vocabulary

| Kind | Constant | Use |
|---|---|---|
| 30617 | `KIND_GIT_REPO_ANNOUNCEMENT` | repo announcement (project) |
| 30618 | `KIND_GIT_REPO_STATE` | ref state after a push (relay-signed) |
| 1617 | `KIND_GIT_PATCH` | NIP-34 patch (git format-patch output) |
| 1618 | `KIND_GIT_PULL_REQUEST` | pull request |
| 1619 | `KIND_GIT_PR_UPDATE` | PR tip-commit update |
| 1621 | `KIND_GIT_ISSUE` | issue |
| 1630/1631/1632/1633 | `KIND_GIT_STATUS_OPEN` / `_MERGED` / `_CLOSED` / `_DRAFT` | status events (CI "passed" is a 1630; a merge is a 1631) |
| 1 | `KIND_TEXT_NOTE` | issue/PR comments **and** reviews — see below |
| 30621 | `KIND_PROJECT` | multi-repo project (NIP-MP) |

**Comments are kind 1, not NIP-22 kind 1111**, because the relay does not
register 1111. They carry `["e", <root-id>, "", "root"]` and
`["a", <repoAddress>]` plus `p` tags for the repo owner, the item author, its
recipients, and any mentions. This is why Pulse has to filter them out
(`desktop/src/features/pulse/lib/projectComments.ts:isProjectComment` — any note
with an `a` tag starting `30617:`), otherwise they surface as orphan replies
whose parent is a git event a note feed cannot resolve.

**Reviews are labelled kind-1 comments** (`t` tags):
`PR_REVIEW_REQUEST_LABEL`, `PR_APPROVAL_LABEL`, `PR_CHANGES_REQUESTED_LABEL`,
`PR_INLINE_COMMENT_LABEL` (`projectPullRequests.mjs`). An inline review comment
additionally carries `["c", <commit>]`, `["file", <path>]`,
`["side", "old"|"new"]`, `["line", <n>]`.

Pull-request tags (`pullRequestMutations.ts:projectPullRequestTags`):
`a`=repoAddress, `p`=owner+reviewers, `subject`=title, `c`=head commit,
`clone`=clone urls (multi-value), `branch-name`, `target-branch`, optional
`merge-base`. An update (1619) uses `E`/`P` (uppercase root refs) plus `c` and
`clone`. A merged status (1631) carries `merge-commit` and `r` tags.

### 2.3 Branch-as-room: how a channel binds to a repo

The `buzz-channel` tag on the 30617 announcement **is** the git ACL
(`crates/buzz-relay/src/api/git/binding.rs`):

```rust
enum RepoBinding { NotBound, Bound(Uuid), Broken }
```

- Only the **first** `buzz-channel` tag counts, and it must be a valid UUID.
  A malformed first tag resolves to `Broken` **even if a later duplicate parses**
  — "find the first *parseable* tag" would let an author who can append a second
  tag choose the channel.
- `NotBound` (no tag at all): only the announcement author (the sole identity
  that can rebind, since 30617 is keyed by `(author, d)`) is offered
  remediation; everyone else gets the generic denial — never leak that the repo
  exists.
- The resolver does **no DB access**: a well-formed UUID naming a deleted
  channel still resolves `Bound`, and each gate's own membership lookup denies
  (a dead channel is indistinguishable from non-membership — info-leak-safe).
- Deliberate asymmetry preserved: **push denies on an archived channel, read
  does not.** The shared resolver must not unify that.

Both the read gate (`api/git/transport.rs:authorize_git_read`) and the push
policy (`api/git/policy.rs:hook_callback`) authorize against membership in the
bound channel — before this module they each parsed the tag with code that
"agreed only by coincidence."

The product intent (VISION_PROJECTS §"Branches as Channels") is that creating a
branch creates a channel; the branch's patches, review comments, CI results and
merge decision live in it; on merge the channel archives, becoming the permanent
record of why the code exists. In the shipped tree, the binding tag and the git
ACL exist; automatic per-branch channel creation is still design-stage
(`VISION_PROJECTS.md:245` status table: project binding and the merge
coordinator are "📋 Designed", git hosting and workflows are "✅ Ships today").

### 2.4 Branch protection and push policy

Protections are `buzz-protect` tags on the 30617:
`["buzz-protect", "<ref-pattern>", "<rule>", …]`
(`crates/buzz-core/src/git_perms.rs`).

- `RefPattern`: `segment ("/" segment)*`, each segment a literal
  `[a-zA-Z0-9._-]+` or `*` (exactly one path segment). Must start with `refs/`.
  No `**`, `?`, `[...]`, or partial globs. Limits: `MAX_PROTECTION_RULES = 50`,
  `MAX_PATTERN_LENGTH = 256`, `MAX_WILDCARDS_PER_PATTERN = 3`.
- `ProtectionRule { pattern, push_role: Option<MemberRole>, no_force_push,
  no_delete, require_patch }`. `require_patch` blocks **all** update kinds
  (create, fast-forward, non-fast-forward, delete) — the ref becomes governed
  entirely by the NIP-34 patch workflow.
- `RuleParseError`: `TooFewValues | TooManyRules | InvalidPattern | UnknownRule |
  InvalidRole`.
- Rules apply to **everyone including the owner**; `channel role = repo role`.

Push flow (`api/git/policy.rs`): git's pre-receive hook POSTs an HMAC-SHA256
signed payload (`repo_id`, `repo_owner`, `community_id`, `pusher_pubkey`,
`ref_updates[{old_oid,new_oid,ref_name,is_ancestor}]`, `timestamp`, `signature`)
to `POST /internal/git/policy`, which is bound to `127.0.0.1` only. Steps:
validate HMAC + 30 s TTL (`MAX_CALLBACK_AGE_SECS`) fail-closed → resolve 30617
→ grant owner authority to the repo key or its verified managed-agent owner
(NIP-OA) → otherwise resolve the pusher's channel role via the `buzz-channel`
binding → **promote Bot → Member** (a bot is a designation, not a permission
tier) → `evaluate_push()` → 200 allow / 403 deny with reasons. Any error is 403.

After an accepted push the relay CAS-publishes the new manifest and only then
derives the kind:30618 event (`api/git/manifest_event.rs:build_ref_state_event`,
signed with the **relay** keys, carrying a Buzz-extension `p` tag with the
pusher's pubkey). A denied push emits nothing — a relay-signed 30618 would
falsely attribute state to the denied pusher. Only `refs/heads/*` and
`refs/tags/*` are emitted; invalid OIDs (not 40- or 64-hex) are skipped rather
than failing the whole event; the HEAD tag gets the `"ref: "` prefix even though
the manifest stores it bare. Git transport is standard Smart HTTP:
`GET /git/{owner}/{repo}/info/refs`, `POST …/git-upload-pack`,
`POST …/git-receive-pack`.

### 2.5 Project list screen (`/projects`)

`app/routes/projects.tsx` → `ui/ProjectsScreen` → `ui/ProjectsView.tsx`
(preview-gated by `usePreviewFeatureWarning("projects")`).

Top-level filter tabs (`ui/ProjectsToolbar.tsx`, underline-on-active):
**Overview · Repositories · Pull Requests · Issues**. A separate grid/list
`ProjectsViewModeToggle`. The full `ProjectsFilter` union also carries
`mine | local | agents | users` (used by scope dropdowns and legacy stored
values). Persistence is localStorage, one key per control
(`lib/projectsViewHelpers.ts`): `buzz.projects.viewMode`, `.filter`,
`.repositoryScope`, `.pullRequestScope`, `.issueScope`, `.sort`; hidden cards
live under `buzz.projects.hidden-cards.v1` (`hooks.ts:HIDDEN_PROJECT_CARDS_KEY`).

Scope dropdowns (`ProjectsListScopeDropdown`): repositories → All / My
Repositories / Local; PRs → All / My Pull Requests; Issues → All / My Issues.
Sorts: `updated | created | name`. `MANY_PROJECTS_THRESHOLD = 12` switches
presentation density.

Panels on the Overview tab: `ProjectsOverviewPanel` (stat pills),
`ProjectsOverviewRail` (people + activity-by-day), `ProjectsActivityFeed`, and
the project cards themselves (`ProjectCards.tsx`: `ProjectGridCard`,
`ProjectListRow`, `ProjectStatsRow`, `ProjectActivityBar`, `ProjectPeopleStack`,
`StatusPill`, `ProjectActionsMenu`, `EmptyState`, `EmptyFilteredState`).
`ProjectsCreateMenu` opens `CreateProjectDialog` /
`CreateProjectIssueDialog` / `CreatePullRequestDialog`.

Data loading (`hooks.ts`):
`fetchProjects` queries kinds `[30617]` limit 200 **and** kind 5 deletions limit
500 in parallel, dedups replaceables by `(pubkey, kind, d)` keeping the newest
`created_at`, then filters out locally hidden cards and NIP-09-deleted ones.
`isDeletedByA` only honours a deletion **signed by the project owner** —
otherwise anyone could hide someone else's project. Sort: newest first.

`fetchProject(projectId)` parses the route id: canonical form is
`<64-hex-owner>:<dtag>`; a bare dtag from a legacy link resolves ambiguously to
whichever owner the relay returns first (forks make dtags non-unique). It then
resolves the default branch from the 30618 HEAD
(`lib/projectBranches.ts:resolveProjectDefaultBranch`).

`fetchRepoState` restricts authors to `[project.owner, relaySelf]` — only the
owner or the relay may assert ref state.

Activity summaries (`fetchProjectActivitySummaries` + `projectActivity.mjs:
summarizeProjectActivityEvents`) fetch one batched query over
`[1621, 1630, 1631, 1632, 1633, 1617, 1618, 1619]` filtered by the repo `a`
addresses, limit 1000, and produce per-repo `{issueCount, prCount, commitCount,
activityCount, updatedAt, participantPubkeys, latestCommit, activityByDay}`
(day keys are local-time `YYYY-MM-DD`).

`ProjectsActivityFeed` builds a unified, timestamp-sorted item list
(`buildActivityItems`, capped by `ACTIVITY_LIMIT`) of kinds:
`repository` ("created the repository"), `commit` ("pushed a commit to",
"updated a pull request in"), `pull-request` ("opened a pull request in"),
`approval` ("approved a pull request in"), `changes-requested`,
`review-request`, `comment`, `issue`. Bodies are markdown flattened to plain
text and truncated to 280 chars.

Creation (`useCreateProject.ts`): the dtag is slugified from the name
(`lowercase`, non-alphanumerics → `-`, trimmed); duplicate `(owner, dtag)` is
refused client-side; tags emitted are `d`, `name`, optional `description`,
`clone`, `web`; content = description. Deletion publishes a kind 5 with
`["a", repoAddress]` and is refused unless the caller is the owner.

### 2.6 Project detail screen (`/projects/$projectId`)

`app/routes/projects.$projectId.tsx` validates three search params —
`commitHash`, `pullRequestId`, `issueId` — so any sub-object is deep-linkable.
`ui/ProjectDetailScreen.tsx` (≈1000 lines) owns: selection state for PR/issue/
commit, a `tabsResetKey` used to remount the tab container, a breadcrumb that
mirrors the active tab (`PROJECT_TAB_CRUMB_LABELS`), remote/local repo source
toggle, branch selection (`useProjectRepositoryRefSelection`,
`useOptimisticProjectBranches`), git identity (`useGitIdentityQuery` →
`ViewerGitIdentity` for matching commit authors to pubkeys), an
`openProjectMergeRecoveryTerminal` hook, and a right-hand `UserProfilePanel`
driven by `profile`/`profileTab`/`profileView` search params.

Tabs (`ui/ProjectWorkspaceTabList.tsx:ProjectTabsList`, rendered by
`ui/ProjectWorkspaceTabs.tsx`):

| Tab | Panel |
|---|---|
| **Overview** (BookOpen icon, title "README") | `ProjectOverviewPanel` — README render (`ProjectReadmePanel`, `ProjectRichContent`), `LanguageChips` (top languages by file extension), `PeopleAvatars`, latest-commit line, `OverviewRailSection`, clone/source controls |
| **Files** | `RepositoryFilesPanel` (`ProjectRepositoryPanel.tsx`) — breadcrumbed tree, per-entry icon by extension, size, last-changed, `FileContentPanel` with syntax highlighting; shows "No local checkout found." when the local source has none |
| **Commits** (`value="activity"`) | `ActivityPanel` (`ProjectDetailFeedPanels.tsx`) or, when `commitHash` is selected, `ProjectCommitDetailPanel` with the diff from `useProjectCommitDiff` |
| **Issues** | `WorkItemListHeader` + `ProjectIssuesPanel` + `CreateIssueDialog` |
| **Pull Request** | `WorkItemListHeader` + `ProjectPullRequestsPanel` + `CreatePullRequestDialog` |
| **Contributors** | `ContributorsPanel` |

Selecting a PR replaces the body with a PR workspace: a two-column grid
(content + an 18 rem meta rail) holding `PullRequestDetailHeader`, a
`PullRequestTabsList` of **Conversation (n) · Commits (n) · Checks (0) · Files
changed (n)**, and `PullRequestMetaRail`. Note `Checks` is hard-coded to 0 —
there is no CI check aggregation yet. The Files-changed tab
(`ProjectPullRequestFilesChangedPanel`) supports inline comments anchored to
`{path, side, line}` (`ProjectPullRequestInlineComments`), and opening an inline
comment switches to `pr-files` and focuses the anchor.

Tab-change side effects (`handleTabChange`): leaving `pr-*` clears the selected
PR; leaving `issues` clears the selected issue; leaving `activity` clears the
selected commit. Conversely, setting a `selectedIssueId` forces the `issues`
tab and `selectedCommitHash` forces `activity`.

Other buttons in the tab bar: an "Open terminal" icon
(`useOpenProjectTerminal`) and an "Update PR" button that publishes a 1619 for
a newly pushed commit.

### 2.7 Review and merge decisions

`desktop/src/features/projects/pullRequestReviews.ts`:

- `ProjectPullRequestLifecycleStatus = "open" | "draft" | "closed"` mapping to
  kinds 1630/1633/1632. **1631 (merged) is deliberately excluded** — merges
  happen through git, not this UI.
- `canReviewProjectPullRequest(project, pr, viewer)`: requires a viewer, a head
  `commit`, status `Open` or `Draft`, viewer ≠ PR author, and viewer is either
  the repo owner or a listed reviewer.
- Review decisions publish a kind-1 note tagged
  `["t", PR_APPROVAL_LABEL | PR_CHANGES_REQUESTED_LABEL]` + `["c", commit]`,
  with `created_at` forced forward by
  `nextProjectPullRequestReviewCreatedAt` so a new decision always supersedes
  the previous one (nostr ordering is by `created_at`).
- Review requests publish a note tagged `PR_REVIEW_REQUEST_LABEL` with the
  requested reviewers as `p` tags. Parsing **only trusts** review requests and
  status changes signed by the PR author or the repo owner
  (`isTrustedReviewRequest`, `isTrustedReviewDecision`, `allowedActorsForRoot`).
- Managed-agent owners can sign on an agent's behalf
  (`signProjectPullRequestStatus`, `signProjectPullRequestReviewRequest`).
- `ProjectPullRequest` carries derived `approvals[]` and `changeRequests[]` —
  "latest current-commit decision per reviewer" — plus
  `projectPullRequestReviewSummary()` producing `{approvalCount,
  changeRequestCount, detail, showState, state}`. An inline comment's
  `inlineCommentStatus` is `"current"` or `"outdated"` relative to the head
  commit; a decision's `reviewDecisionStatus` is `"current"` or `"historical"`.

Merging (`MergePullRequestButton.tsx`, `pullRequestMutations.ts`): calls
`mergeProjectPullRequest` (a Rust-side git merge), then publishes the 1631. Two
failure modes are handled explicitly:
`ProjectPullRequestMergeError { code: "merge_conflict", recovery }` opens a
conflict-recovery flow that can prepare a recovery ref and print
`projectPullRequestConflictCommands({recoveryRef, targetBranch, targetRef})` for
copy-paste, optionally opening a terminal; and a
`statusPublicationError` (merge succeeded, 1631 failed to publish) surfaces the
unpublished signed event so it can be retried rather than silently losing the
merge record.

### 2.8 CI results

Per the design, workflows orchestrate and agents compute; the relay is the
message bus, not a build server. A push produces a 30618; a `diff_posted`
workflow calls out to CI over `call_webhook`; the agent posts results back into
the branch channel and publishes a NIP-34 status event (1630 = CI passed) tagged
with the repo `a` address; the merge is a 1631 that references the approval.
Workflows may live in the repo under `.buzz/workflows/` or be defined at project
level and inherited by every branch channel.

---

## 3. Pulse — the activity/social dashboard

Route `desktop/src/app/routes/pulse.tsx` (preview-gated), screen
`features/pulse/ui/PulseScreen.tsx`, body `ui/PulseView.tsx`.

### 3.1 What it shows

Pulse is a note (kind 1) timeline with a persistent composer, plus an
agent-activity mode. Tabs (`ui/PulseTabBar.tsx`, `PulseTab` union):

| Tab | Source | Query |
|---|---|---|
| 🔍 **search** (icon-only, first) | — | a centred "What are you looking for?" hero with a pill search input; **not wired to a backend yet** (local `searchQuery` state only) |
| **Everyone** | global notes | `useGlobalNotesQuery` → `getGlobalNotes({limit: 50})` |
| **Following** (`people`) | contacts' notes | `useTimelineQuery(contactPubkeys, …)` → `getNotesTimeline(pubkeys, 10)` |
| **Liked** | own reactions | `useLikedNotesQuery(pubkey, …)` → `getLikedNotes(pubkey, 50)` |
| **Agents** (badge = agent count) | agent pubkeys' notes | `useTimelineQuery(agentPubkeys, …)` |
| **Mine** | own notes | `useMyNotesQuery(pubkey)` → `getUserNotes(pubkey, {limit: 50})` |

Contacts come from `useContactListQuery` (NIP-02). Agents are the union of
`useRelayAgentsQuery` and `useManagedAgentsQuery`, deduped by pubkey, with
managed agents synthesised into the relay-agent shape and their status mapped
(`running`/`deployed` → `online`, else `offline`).

### 3.2 Derivation and grouping

- **Every feed is stripped of project comments** —
  `withoutProjectComments(response)` drops any note carrying an `a` tag starting
  `30617:` (`lib/projectComments.ts`). Without it, PR/issue comments (which are
  kind 1) appear as replies whose parent is a 1618/1621 and can never resolve.
- **The Following tab additionally hides agent notes** unless the viewer
  actually follows that agent (`!agentPubkeySet.has(pk) || contactPubkeySet.has(pk)`).
- **The Agents tab groups**: `lib/groupAgentNotes.ts:groupAgentNotes(notes,
  windowSeconds = 300)` collapses *consecutive* notes from the same agent into
  one `AgentNoteGroup {pubkey, notes, latestAt, earliestAt}` as long as the gap
  to the **previous note already in the group** (not the group's earliest) is
  ≤ 300 s — comparing against the earliest would let the window grow unbounded.
  Input must be newest-first. Groups render as `AgentActivityCard`, keyed
  `${pubkey}-${latestAt}`.
- Reply-parent resolution (`lib/replies.ts:getReplyParent`) walks `e` tags from
  the end, preferring a marker `"reply"`, then an unmarked tag, then `"root"`
  (NIP-10 both-styles tolerance). `noteSnippet` collapses whitespace and cuts at
  120 chars.
- Reactions: `usePulseReactionsQuery(noteIds, currentPubkey)` calls
  `getNoteReactions` and keeps **only `emoji === "+"`**, producing
  `Map<noteId, {count, reactedByCurrentUser}>`.
  `lib/noteActions.ts` holds the optimistic helpers: `applyReactionState`
  (clamped at 0), `toggleNoteIdInSet`, `buildNoteShareUri` (nip19
  `neventEncode({id, author})` → `nostr:nevent1…`), and
  `isDuplicateReactionError` (matches the relay's "duplicate: reaction already
  exists"). Actions surfaced per note: reply, share, start DM, toggle upvote
  (`lib/useNoteActions.ts:usePulseNoteActions`).

### 3.3 Time windows and refresh

There is no explicit date-range filter. Freshness is polling, and polling is
**visibility-gated**: `useDocumentVisible()` + `useVisibleRefetchInterval(ms)`
return `false` (no polling) when the document is hidden. Intervals: note feeds
30 s, reactions 60 s; `staleTime` 15 s and `gcTime` 5 min for feeds, single
notes 5 min/10 min. Query keys (`pulseQueryKeys`) use a **sorted, joined string**
of pubkeys/noteIds so reference-equality churn cannot cause refetch storms.

### 3.4 Layout

`PulseTabBar` (a `role="tablist"` of pill buttons, horizontally scrollable,
scrollbar hidden) sits above a scroll container capped at `max-w-2xl`. Below the
tab bar, every tab except `search` and `agents` shows a **sticky composer** —
the shared `ForumComposer` in `compact` mode with the user's avatar and display
name as its header, placeholder "What's on your mind?", mention autocompletes
built from `[self, contacts, agents]`. Publish errors render in a destructive
strip above it. Timelines render through `VirtualizedList`
(`estimateSize` 140 for notes, 160 for agent groups). Empty states are
per-tab strings; the Agents tab distinguishes "No agents registered yet." from
"No agent notes yet. Agents post here when they publish." Loading shows a
4-row avatar/skeleton timeline. Clicking any avatar opens `UserProfilePanel` via
the `profile` search param (`ProfilePanelProvider`).

Design rationale for the agent side lives in `VISION_ACTIVITY.md`: every item is
"verb, object, outcome"; twelve render classes (message, relay op, file-edit,
shell command, tool status/turn lifecycle; thought, plan/todo, permission,
error; generic tool, raw rail, suppressed noise); principles — semantics over
transport, outcome-first, mutate in place (one action = one row, not a trail),
never go dark (silence/idle/timeout are *rendered* states), failures rise and
reads recede, resolve references to names, coalesce chunked streams into one
item, honesty over guessing, polished by default with a raw rail on demand.

---

## 4. Reminders

Wire format: **NIP-ER**, kind `40007` (`KIND_EVENT_REMINDER` /
`KIND_STREAM_REMINDER`), parameterized-replaceable by `d`, content
**NIP-44-encrypted to self**.

### 4.1 Event shape (`features/reminders/lib/reminderService.ts`)

```jsonc
{
  "kind": 40007,
  "content": "<nip44(JSON.stringify(ReminderContent))>",
  "tags": [
    ["d", "<32 hex chars = 16 random bytes>"],
    ["not_before", "<unix seconds>"],       // pending only
    ["expiration", "<unix seconds>"]        // done/cancelled only
  ]
}
```

- The `d` tag uses **`crypto.getRandomValues(16 bytes)`, not `randomUUID()`** —
  NIP-ER mandates 128 bits and a UUIDv4 only has 122.
- `parseNotBefore` mirrors the relay's strict validator: `^(0|[1-9][0-9]*)$` and
  `<= Number.MAX_SAFE_INTEGER`. Anything else is ignored, so the client never
  shows a reminder the relay considers malformed.
- Completing or cancelling replaces the event **without** `not_before` and with
  a jittered `expiration` of **30–90 days** (`jitteredExpiration`) so the relay
  garbage-collects it, and jitter avoids a synchronized purge.
- Every rewrite sets `created_at = max(now, previous.createdAt + 1)` so the
  replacement always wins nostr's newest-wins rule even under clock skew.

Decrypted content (`lib/reminderTypes.ts`):

```ts
ReminderContent = { target?: ReminderTarget; note?: string;
                    status: "pending" | "done" | "cancelled" }
ReminderTarget  = { eventId; channelId; preview; authorPubkey }
Reminder        = { id /* d-tag */, notBefore?, content, createdAt, eventId }
```

`parseReminderContent` fails closed: not a JSON object ⇒ null; unknown `status`
⇒ null; non-string `note` ⇒ null; malformed target ⇒ null; and **a reminder must
have either a target or a non-empty note**. Decryption failure logs a warning
and drops the row rather than throwing.

### 4.2 Creating a reminder from a message

`ui/RemindMeLaterDialog.tsx` (opened through `RemindMeLaterProvider`, wired into
the message action bar). Title "Remind me later", description "Choose when you
want to be reminded about this message." It offers the shared presets as
full-width buttons, then a "Custom date & time" section (a `type="date"` input
with `min = todayDateString()` and a `type="time"` input), then an optional note
textarea. Submitting toasts "Reminder set" / "Failed to create reminder".

Shared presets — the single source of truth for both create and snooze
(`lib/timePresets.ts:TIME_PRESETS`): **In 30 minutes · In 1 hour · In 3 hours ·
Tomorrow at 9am · Next Monday at 9am**. `nextDayAt9am(offset)` rolls forward a
day if the computed instant is already past. `parseCustomDateTime(date, time)`
returns null unless both are present, parse, and are **strictly in the future** —
the native time input has no `min`, so without this guard a past time would fire
immediately.

### 4.3 Snooze

`ui/SnoozeMenu.tsx` — a clock icon dropdown of the same presets plus a
"Custom…" item that opens a popover with the same date/time pair and guard.
Snoozing republishes the event with a new `not_before` and `status: "pending"`.

### 4.4 Delivery

`useReminderNotifications(pubkey, settings, channels)` — mounted **once** at app
level (`features/reminders/useReminderNotifications.ts`):

- A per-pubkey watermark in localStorage,
  `buzz:lastReminderCheck:<lowercased-pubkey>`.
- **Seeded to `now` on first-ever launch, never 0** — a 0 seed would replay the
  user's entire reminder history as toasts. A reminder already due at first
  launch therefore never toasts; it only shows in the panel and badge.
- Every `POLL_INTERVAL_MS = 30_000` (and once on mount) it computes
  `dueSince(reminders, watermark, now)` = pending reminders with
  `watermark < notBefore <= now` — the strict lower bound is what prevents
  replay — fires **one coalesced toast**, then advances the watermark
  **unconditionally**, even when the toast was suppressed by settings, so
  re-enabling notifications later does not backlog-replay.
- A guard (`queryResolvedRef`) prevents advancing the watermark before the
  reminders query has resolved once; otherwise an empty array on mount would
  skip everything that came due while the app was closed.
- The toast respects `settings.desktopEnabled` and the `needs_action` alert
  slot; a single due reminder resolves its channel label and uses the target
  preview (or the note) as the body, multiple become "N reminders are due".
  On a successful send it plays the slot sound and requests a dock bounce.
- After each check it invalidates the reminders query — a liveness tick so
  `countDue` consumers (nav badge, inbox filter, panel) re-render as reminders
  cross their due time while the app sits idle.

### 4.5 Filters, grouping, and the screen

`lib/reminderFilters.ts`: `isDue(r, now)` = pending ∧ `notBefore <= now`;
`countDue` is the one shared definition used by both the badge and the fire
detector so they can never disagree; `groupReminders(reminders, includeDone)`
buckets into **Overdue / Today / Upcoming** (+ **Completed**, newest first, only
when `includeDone`), dropping cancelled reminders entirely and skipping pending
rows with no `notBefore`.

`/reminders` **no longer exists as a screen**: `app/routes/reminders.tsx` is a
`beforeLoad` redirect to `/`. Reminders are now an **inbox filter**
(`InboxFilterMenu` option `reminders`, below a separator, with a count badge).
`ui/RemindersPanel.tsx` renders the grouped rows in either `card` or
`inbox-list` presentation and exports `ReminderDetailPane` for the inbox's
detail column. Each row shows the author avatar and label, the source location
(`#channel` or `DM with <name>`), the preview/note, and a relative time
(`formatRelativeTime`: "just now", "Nm overdue", "Nh overdue", "Nd overdue", "in
less than a minute", "in Nm/Nh/Nd"). Row actions: **Complete** (check),
**Snooze** (`SnoozeMenu`), **Cancel** (X).

Navigation (`lib/reminderNavigation.ts`): `hasNavigableTarget` requires
non-empty `channelId`, `eventId` and `authorPubkey` — a *present* target can
still hold empty strings because the creation site writes `channelId ?? ""`.
`resolveReminderDestination` fetches the target event to derive its thread root
(`getThreadReference(tags).rootId`), degrading to a null root on fetch failure,
and returns `{channelId, messageId, threadRootId}`.

Query layer (`features/reminders/hooks.ts`): one query
`["reminders", pubkey]` (staleTime 30 s) is the single source of truth for the
badge, the channel overlay, the panel, and the fire detector; every mutation
(`create`/`complete`/`snooze`/`cancel`) invalidates it on success.
`useDueReminderBadgeCount(pubkey, enabled)` returns 0 when the home-badge toggle
is off, mirroring the feed badge contract.

---

## 5. Forum

### 5.1 Posts vs chat messages

A **channel has a type** (`Stream | Forum | Dm | Workflow`). Inside a forum
channel, top-level items are kind `45001` (`KIND_FORUM_POST`) and replies are
kind `45003` (`KIND_FORUM_COMMENT`); kind `45002` (`KIND_FORUM_VOTE`) is
reserved for votes but has no client surface in this tree. Ordinary chat
messages are kind `9` / `40002`. Both post kinds go through the *same*
`sendChannelMessage` transport, differing only in the kind argument
(`features/forum/hooks.ts:useCreateForumPostMutation` passes `KIND_FORUM_POST`,
`useCreateForumReplyMutation` passes `KIND_FORUM_COMMENT` plus a
`parentEventId`).

The practical difference from chat: a forum post is a **card in a list**
carrying a thread summary, not a line in a transcript; the reader opens one post
at a time into a dedicated thread panel; and forum posts participate in the Home
feed's mention and activity queries (`crates/buzz-db/src/feed.rs` lists
`KIND_FORUM_POST` in both the mentions kind filter and the activity kind
filter, and `KIND_FORUM_COMMENT` in mentions).

### 5.2 The post route

`desktop/src/app/routes/channels.$channelId.posts.$postId.tsx` — params
`channelId`, `postId`; a validated `?replyId=` search param scrolls to a
specific reply. It renders the shared `ChannelRouteScreen` with
`selectedPostId=postId` and `targetReplyId=replyId`, i.e. **the post is a
sub-route of its channel, not a separate screen**. Preview-gated by
`usePreviewFeatureWarning("forum")`.

### 5.3 Data shapes

```ts
ForumPost          = { eventId, pubkey, content, kind, createdAt, channelId,
                       tags, threadSummary: ThreadSummary | null }
ThreadSummary      = { replyCount, descendantCount, lastReplyAt, participants }
ForumPostsResponse = { posts: ForumPost[]; nextCursor: number | null }
ThreadReply        = ForumPost-ish + { parentEventId, rootEventId, depth }
ForumThreadResponse= { post, replies, totalReplies, nextCursor }
```

`ThreadSummary` is a relay-synthesized overlay (kind `39005`
`KIND_THREAD_SUMMARY`, never stored — see `docs/bridge-channel-window.md`);
`KIND_WINDOW_BOUNDS` (39006) is the only authority on `has_more` — clients must
not infer exhaustion from row counts.

`desktop/src/shared/api/forum.ts` converts snake_case wire rows and resolves the
display author through `resolveEventAuthorPubkey({event, relaySelfPubkey})` so
relay-signed/delegated messages attribute correctly.

Queries (`features/forum/hooks.ts`): `useForumPostsQuery(channel)` — enabled
only when `channel.channelType === "forum"`, `getForumPosts(channelId, 50)`,
staleTime 15 s, **poll 15 s**; `useForumThreadQuery(channelId, eventId)` —
staleTime 10 s, poll 10 s. Both keys include the relay-self pubkey so the
author-resolution input is part of the cache identity. Mutations invalidate the
posts key (and the thread key for replies/reply-deletes).

### 5.4 Composer

`features/forum/ui/ForumComposer.tsx` (~580 lines) is shared with Pulse. It
supports: markdown body, `@`-mention autocomplete over channel members
(`ForumComposerAutocompletes`, `autocompleteBelow` flag to flip the popover),
media upload with progress/error surface (`ForumComposerMediaStatus`, producing
`imeta` tags), a compact single-line layout that expands
(`ForumComposerCompactLayout` + `useCompactComposerInteractions`), an
`isSending` state, and `onSubmit(content, mentionPubkeys, mediaTags)`.

In `ForumView` the composer is collapsed behind a dashed placeholder button
reading "Start a new post…", which becomes "Join this forum to create posts."
when `!channel.isMember` and "This forum is archived." when
`channel.archivedAt !== null` (both disable it). Switching channels closes an
open composer.

### 5.5 List and thread rendering

`ui/ForumView.tsx` — when no post is selected: the composer block, then either a
3-card skeleton, an empty state (MessageSquareText, "No posts yet", "Start a
discussion by creating the first post."), or a `VirtualizedList` of
`ForumPostCard`s (`estimateSize` 120, keyed by `eventId`).

`ui/ForumPostCard.tsx` — avatar + author label (via `UserProfilePopover`) +
relative time, an optional delete menu, a markdown preview **truncated to 200
chars with an ellipsis**, and, when `threadSummary.replyCount > 0`, a footer
"N replies · last <relative time>". The `imetaByUrl` map is memoized on
`post.tags` for a load-bearing reason documented in the file: `parseImetaTags`
returns a fresh object each render, `Markdown` compares it by reference, so
without the memo the DOM node is swapped mid-click and the browser never fires
`click` on file downloads.

Profile resolution gathers pubkeys from post authors, **mention tags**, and
thread-summary participants — a mentioned user who never authored a post would
otherwise render as a dead chip.

Selecting a post renders `ui/ForumThreadPanel.tsx` in place (root post, nested
replies with depth, reply composer, back button, scroll-to `targetEventId`).

Deletion: `canDelete(postPubkey, currentPubkey)` is **author-only** today
(explicitly noted as pending channel-role data). `DeleteActionMenu` +
`DeleteConfirmDialog` guard it; deleting the open post closes the thread panel.

`lib/time.ts:formatRelativeTime` is the forum's own relative-time formatter.

---

## 6. Moderation

Design doc `VISION_MODERATION.md`. Two layers: **community moderation**
(subjective, per-community, owners+admins, ends at the community boundary) and
**platform safety** (illegal content, network abuse — never delegated; reachable
only via *escalation*, which today writes a durable record but has no consuming
inbox).

The governing stance: **a report is a signal, never a trigger.** No user report
auto-removes anything.

### 6.1 What a member can do — report

`features/moderation/ui/ReportMessageDialog.tsx` + `shared/api/moderation.ts:submitReport`.

A NIP-56 report is kind `1984` (`KIND_REPORT`):

```jsonc
{ "kind": 1984,
  "content": "<optional moderator-visible note>",
  "tags": [["p", "<author-pubkey>"], ["e", "<event-id>", "<report-type>"]] }
```

The report **type rides the third element of the `e` tag** (relay
`report.rs:parse_report`). Categories (`REPORT_TYPES`), shown in this order with
`other` last so it reads as the fallback: **spam, profanity (or hate speech),
nudity (or sexual content), impersonation, malware (or scam), illegal, other**.

Dialog copy: "Reports go to this community's moderators for review. The author
is not notified of who reported them." The form resets every time it opens so a
prior selection cannot leak into the next report. Success toast: "Report
submitted to community moderators".

**Reports are private structural state** — validated and filed into
`moderation_reports`, never stored in the event log, never fanned out. Reporter
identity cannot leak through a future query bug because it was never in the
public store.

### 6.2 What a moderator can do — commands

All moderation writes are signed command events published over the normal WS
path. They carry **no `h` tag** — the relay binds the tenant from the connection
host, and a stray `h` is rejected as channel-scoping a global-only command.

| Kind | Constant | Tags | Effect |
|---|---|---|---|
| 9040 | `KIND_MODERATION_BAN` | `p`, optional `expiration` (unix secs ⇒ temporary; omit ⇒ permanent), optional `reason` | ban |
| 9041 | `KIND_MODERATION_UNBAN` | `p` | lift ban |
| 9042 | `KIND_MODERATION_TIMEOUT` | `p`, `expiration` (**required**), optional `reason` | write-block until expiry |
| 9043 | `KIND_MODERATION_UNTIMEOUT` | `p` | lift timeout |
| 9044 | `KIND_MODERATION_RESOLVE_REPORT` | `report` (report event id), `status`, `action`, optional `reason` | resolve/dismiss a queued report |

`ResolutionStatus = "resolved" | "dismissed"`;
`ResolutionAction = "delete" | "kick" | "ban" | "timeout" | "dismiss" |
"escalate"`. The relay **enforces the pairing** `(action == "dismiss") ==
(status == "dismissed")` (`moderation_commands.rs`), and the client encodes it
in `statusForAction` so an invalid combination cannot be submitted.

Authority: owners and admins only, from the community's own roster. Guard rails:
an admin cannot ban or time out an owner or another admin. There is deliberately
**no volunteer-moderator tier**; authority is structured as capabilities so
adding one later is a policy change, not a rewrite.

Per-message moderator actions (`ui/MessageModerationMenuItems.tsx`) render only
when the viewer's relay role is `owner`/`admin`, the message has a real signer,
and that signer is not the viewer. **They target `message.signerPubkey`, never a
relay-delegated display author.** The menu offers Timeout (a submenu of
`TIMEOUT_PRESETS`: **1 hour / 24 hours / 7 days**, shared with the queue via
`lib/timeout.ts` so the two surfaces cannot drift), Ban/Unban, Untimeout, and
Kick from the current channel; every action toasts success or the server's error
message.

### 6.3 Enforcement and the restricted user's experience

- **A ban bites at the identity seam** — rejected at authentication,
  disconnected everywhere, immediately. Enforcement is not scattered as filters.
- **A timeout is a write-block with a stated expiry.** There is no proactive
  self-restriction read (v1 "Option A, reactive"): the composer learns it is
  timed out only from a send rejection whose message has the exact form
  `restricted: you are timed out until <unix_seconds>` — a **load-bearing parse
  contract** implemented by `lib/timeout.ts:parseTimeoutRejection`. The prefix
  identifies a timeout; the timestamp is best-effort, and an unparseable one
  yields `expiresAtMs: null`, which `isTimeoutActive` treats as **still active**
  (fail closed). `formatTimeoutRemaining` renders `"2h 5m"` / `"3m 20s"` /
  `"12s"`. `ui/ComposerTimeoutBanner.tsx` docks to the composer's top edge with
  a live countdown: "You're timed out by community moderators — 2h 5m left."
  No silent write-drops, no shadow bans.
- **A removed message leaves an honest tombstone** — "removed by a community
  moderator" plus a *sanitized* reason. The room learns the rules are real
  without republishing the offense.
- **The restricted user is told directly** via a DM from the relay's own
  identity. `lib/moderationDm.ts:isModerationDm` identifies it as a DM whose only
  other participant is the NIP-11 `self` pubkey, and disables the composer on
  that channel alone so the member cannot reply into it. It **fails open**: an
  unknown `relaySelf` leaves the composer enabled — it is an affordance, not
  enforcement.
- **The reporter hears the outcome**, closing the loop.
- Notices are **best effort and never block enforcement**: a ban lands even if
  the DM fails.

### 6.4 The moderation queue

`features/settings/ui/ModerationQueueCard.tsx` (in Settings, not a top-level
route) over `features/settings/lib/moderationQueue.ts` (pure triage math) and
`features/moderation/hooks.ts` (queries). Reads are NIP-98-authed HTTP GETs to
`/moderation/reports`, `/moderation/audit`, `/moderation/restrictions` — the
only reads with no WebSocket equivalent. The relay 403s non-moderators; the
client mirrors that gate with `useMyRelayMembershipQuery` so members never fire
a doomed fetch.

NIP-98 detail (`shared/api/moderation.ts:nip98GetHeader`): the signed `u` tag
must equal the **full request URL including the query string**, so the URL is
finalized before signing and never mutated afterwards; the header is
`Nostr <base64(signed 27235 event)>`.

Row shapes:

```ts
ModerationReport = { id, reportEventId, reporterPubkey,
                     targetKind: "event"|"pubkey"|"blob", target, channelId,
                     reportType, note, status, resolvedBy, resolvedAt,
                     actionId, createdAt }
ModerationAction = { id, actorPubkey, action, targetPubkey, targetEventId,
                     channelId, reasonCode, publicReason, privateReason,
                     matchedPrincipal, createdAt }
CommunityRestriction = { pubkey, banned, banExpiresAt, banReason,
                         mutedUntil, muteReason, actorPubkey, updatedAt }
```

`ReportStatus = "open" | "resolved" | "dismissed" | "escalated"` — `open` is the
default and the only actionable state; `escalated` routes out of community
discretion into the platform-safety lane.

**Triage** (`moderationQueue.ts`): reports are grouped by
`targetKey = "<targetKind>:<target>"` (kind-qualified so an event id and an
identical pubkey hex cannot collide). Each `ModerationQueueGroup` carries
`channelId` (from the first report; event targets live in exactly one channel,
pubkey/blob targets are not channel-scoped), reports newest-first, `maxSeverity`,
`latestCreatedAt`, and `priorActions` correlated from the audit log
(`actionMatchesTarget`; blob groups surface no prior actions **by design, not
omission**). Groups sort by severity desc, then most-recent-report desc.

Severity ranking (`SEVERITY_RANK`): `illegal 6 > malware 5 > impersonation 4 >
nudity 3 > spam 2 > profanity 1 > other 0`. `illegal` tops the queue because it
routes to the platform-safety lane, not community discretion.

**Ordering invariant when resolving**: `enforceResolution` runs **before** the
9044. A 9044 records the decision *and* DMs the reporter "reviewed and acted on",
so it must not fire until the action actually happened; a failed enforcement
throws and the report stays open (no false DM, no orphan decision row).
`escalate` and `dismiss` carry no enforcement. `delete` and `kick` are gated to
event targets that have a channel. `ban` resolves the target author first:
for a pubkey target that is the target; for an event target the row carries only
the event id (the reporter's `p` tag is dropped at ingest), so the reported event
is fetched and its **stored `pubkey` (signer truth, never a `p`/`actor`
override)** is used; failure aborts before touching the 9044. `timeout` is
deliberately **not offered from the queue** until the flow collects a duration.

**Privacy invariant, stated as locked in the source**: `reporterPubkey` is
visible in the admin queue and **must never reach any surface the reported
author can see**. Accountability runs both ways to moderators, never to the
reported party.

**Audit trail**: bans, timeouts, dismissals, escalations, and resolutions write
durable append-only audit rows (who / what / whom / why / when), with the
decision recorded separately from its enforcement so the trail never claims
something happened that didn't. Message removals additionally leave a visible
tombstone. The full report record (reporter identity, notes) stays
moderator-only; the public sees only the sanitized reason. Kind `48001`
(`KIND_AUDIT_ENTRY`) is the hash-chained audit event kind.

Honest edges called out in the vision doc: escalation is a hook, not a pipeline;
two roles, not three; notices are best-effort; **no automod** — nothing scans
content before it posts.

---

## 7. Home — the default landing screen

Route `/` (`desktop/src/app/routes/index.tsx`, search params `item`, `profile`,
`profileTab`, `profileView`) → `features/home/ui/HomeScreen.tsx` →
`ui/HomeView.tsx` (~940 lines). It also owns first-run behaviour: it consumes a
pending welcome channel (`features/onboarding/welcome.ts:consumePendingWelcomeChannel`,
plus a `WELCOME_CHANNEL_READY_EVENT` window listener) and redirects into it.

### 7.1 The feed

`useHomeFeedQuery` returns `HomeFeedResponse { feed: { mentions, needs_action,
activity } }`, computed server-side by `crates/buzz-db/src/feed.rs`:

| Category | Query | Kinds |
|---|---|---|
| **Mentions** | `query_mentions` — INNER JOIN `event_mentions` on `(community_id, pubkey_hex)` | 9, 40002, 1, 45001, 45003, 1618, 1619, 1621, 1630–1633 |
| **Needs action** | `query_needs_action` — same join, kind-filtered | 46010 (approval requested), 40007 (reminder) |
| **Activity** | `query_activity` — straight scan of `events` | 9, 40002, 45001, 43001, 43003, 43004 |

Hard cap `FEED_MAX_LIMIT = 100` per query, enforced before the SQL LIMIT.
Channel visibility: an empty accessible-channel list means **global-only**
(`channel_id IS NULL`), never "all channels" (`push_visible_channel_filter`).
Workflow execution kinds 46001–46012 are excluded from activity "to avoid noise".
`event_mentions` carries community-leading composite indexes
`(community_id, pubkey_hex, event_created_at DESC)` and
`(…, event_kind, …)`, replacing a full-table tags-JSON scan.

`HomeScreen` augments the server feed with live in-session thread activity
(`useAppShell().threadActivityFeedItems`) before handing it to `HomeView`.

### 7.2 The inbox

The landing surface is a **two-pane inbox**: `InboxListPane` (resizable via
`useResizableInboxListWidth`, layout math in `lib/homePaneLayout.ts`) and
`InboxDetailPane`, with `ProjectInboxDetailPane` / `HomePersonalInboxDetail`
variants for git work items and personal items. Selection is URL-persisted
through the `item` search param, with `useInboxSelectionAnchor`,
`useHomeInboxAutoSelection` and `useHomeInboxReadState` handling anchoring,
auto-select and read marking. `RecentNotesSection` and `FeedSection` render the
non-inbox strips; `HomeLoadingState` is the skeleton.

`InboxFilter = all | project | mention | thread | needs_action | agent_activity
| reminders | drafts` (`lib/inbox.ts`), surfaced by `ui/InboxFilterMenu.tsx` as a
radio dropdown labelled **All · Projects · Mentions · Threads · Needs action ·
Agents · Reminders · Drafts**, with a separator before Reminders and count
badges on Reminders and Drafts. The trigger's aria-label announces the active
filter plus "N due reminders" or "N active drafts".

`InboxItem` (`lib/inbox.ts`) is the row model:
`{ conversationId, id, item, categories, categoryLabel, channelLabel, preview,
senderLabel, subject, groupItems, isActionRequired, latestActivityAt,
mentionNames, timestampLabel, fullTimestampLabel, unreadCount, avatarUrl }`.
`conversationId` is the **stable** conversation identity — the NIP-10 root, or a
repository-scoped root for git work — and deliberately does *not* change when a
new reply advances the representative latest event, because scroll gating, draft
keys, local-reply storage and selection all key off it.

Headline derivation (`feedHeadline`): project items take the `subject` tag (or
the first content line) of the group's 1618/1621 root; otherwise by kind —
40007 "Reminder", 43001–43006 "Job requested/accepted/Progress update/Job
result/Job cancelled/Job failed", 45001 "Forum post", 45003 "Forum reply",
**46010 "Approval requested"**, else "Mention"/"Agent update"/"Channel update"
by category. `feedPreview` falls back to "A workflow is waiting for approval."
(46010) and "A reminder is waiting for you." (40007).

Type labels (`getInboxTypeLabel`): project items → "Pull request"/"Issue"; DMs →
"DM from <sender>"; mentions → "Mentioned in <channel>"; needs-action → "Needs
action in <channel>"; thread replies → thread phrasing.
`isThreadActivityItem` = category `activity` ∧ has a NIP-10 parent ∧ not a
broadcast reply.

Unread math: an item is unread when `item.createdAt > max(channelReadAt,
perMessageReadAt)`.

Reminders are folded in as a filter, and the nav badge sums the feed badge with
`useDueReminderBadgeCount` at the AppShell wiring point (reminders are a
separate stream from the feed badge machinery).

---

## Non-obvious rules worth preserving

1. **Step ids are evalexpr variable fragments.** `[A-Za-z0-9_]` only, ≤ 64
   chars. A dash makes `steps_my-step_output_x` parse as subtraction; a
   semicolon or space is an injection surface. Validate at definition time, not
   at execution time.
2. **evalexpr has no dotted identifiers.** `trigger.text` in a template is
   `trigger_text` in a condition. The two syntaxes are *not* interchangeable —
   this is the single most common authoring mistake, and the repo's own
   VISION_PROJECTS CI example gets it wrong.
3. **Unknown template variables are emitted literally, never blanked.** An
   author who typos `{{trigger.txt}}` sees the token in the output rather than a
   silent empty string.
4. **`| npub` encodes the full bech32 pubkey** — a truncated prefix is
   grindable. `truncate_pubkey` survives only as an alias for compatibility.
5. **Webhook body fields register as `trigger_<key>` *before* the canonical
   trigger fields, and any key starting `trigger_`/`steps_` is dropped**, so an
   external caller can never spoof `trigger_author`.
6. **Sub-minute intervals are rejected at definition time**, because the
   scheduler ticks every 60 s and such a workflow could never fire correctly.
   Better to refuse than to silently under-deliver.
7. **`delay` is capped at 270 s — deliberately below the 300 s default step
   timeout** — so a long delay fails deterministically at validation instead of
   non-deterministically at `StepTimeout`.
8. **The cron claim anchor is the cron's own scheduled instant, and the interval
   anchor is the epoch-aligned bucket** — never `now`. Only a value every pod
   computes identically can serve as a cross-pod at-most-once key.
9. **Interval cold-start must seed the anchor on the first suppressed tick**
   (and must never advance an existing anchor on suppress, nor seed on a firing
   tick). Get this wrong in either direction and the workflow either never fires
   or fires forever.
10. **If the durable claim wins but the run insert fails, keep the claim.**
    At-most-once beats exactly-once for side-effecting automations.
11. **Authority is rechecked at every run-creation door, immediately before the
    run is created, and always fails closed** — including on lookup errors. The
    10 s workflow cache is a performance device, explicitly *not* an
    access-control fence. Place the check *before* the durable claim so a
    revoked owner cannot consume the fire slot.
12. **`call_webhook` is the exfiltration boundary.** Its mere presence upgrades
    the required role to owner/admin for both saving *and* running.
13. **SSRF defence is pin-then-request**: resolve, reject private IPs, pin the
    validated IP into a fresh client, disable proxies and redirects. Resolving
    twice is the vulnerability.
14. **The webhook secret lives inside the definition JSON, so the definition
    hash must be computed after injection** — reversing those two steps was a
    real bug and every later comparison fails silently.
15. **Approver specs are fail-closed.** Only `""`/`"any"` or an exact 64-hex
    pubkey are honoured; role strings like `@release-manager` are *rejected*, not
    approximated.
16. **Approval tokens are stored hashed (SHA-256) and referenced by hash on the
    wire.** Note the live inconsistency to fix on rebuild: the relay reads the
    reference from a `d`/`e` tag (`command_executor.rs`) and the SDK writes `d`
    (`buzz-sdk/src/builders.rs:build_workflow_approval`), but the desktop builder
    writes a `t` tag (`desktop/src-tauri/src/events.rs:build_approval_grant`) —
    pick one and make both sides agree.
17. **Kinds 46001–46012 must never re-trigger a workflow**, and must be excluded
    from the activity feed. Same for relay-signed messages tagged
    `buzz:workflow`. Without this the engine loops on its own output.
18. **A malformed workflow must not break the list.** `parse_definition` falls
    back to `{}` and the name falls back to the id.
19. **Return an empty array, never a wrapper object, from a stubbed list
    endpoint.** `get_workflow_runs` returns `[]` because the frontend does
    `raw.map(...)` and a `{runs: []}` shape would crash the detail panel.
20. **Enable/disable is expressed in the YAML (`enabled: false`), not in the
    30620 event's status** — the client derives a "disabled" display status from
    the definition (`getWorkflowDisplayStatus`).
21. **Poll fast only while something is live.** The runs query drops from "off"
    to a 1 s interval exactly while a run is pending/running/waiting-approval.
22. **Tell the truth about unimplemented actions in the editor.** The step card
    renders amber "Backend note:" hints for `send_dm`, `set_channel_topic` and
    `request_approval` rather than letting a user author a workflow that will
    fail at runtime.
23. **Only the *first* `buzz-channel` tag counts, and a malformed first tag fails
    closed even when a later duplicate parses.** "First parseable tag" hands
    channel selection to anyone who can append a tag.
24. **A repo binding that names a deleted channel still resolves `Bound`** — the
    membership lookup then denies, making a dead channel indistinguishable from
    non-membership. Do not "helpfully" distinguish them.
25. **Push denies on an archived channel; read does not.** Do not unify that
    asymmetry when sharing the resolver.
26. **Emit kind:30618 only after the CAS publish commits, and never on a denied
    push** — a relay-signed ref-state event would otherwise falsely attribute
    state to the denied pusher.
27. **Branch protections apply to everyone, including the repo owner.** Bots are
    promoted to Member for push (a designation, not a permission tier).
28. **A NIP-09 deletion of a project is honoured only when signed by the project
    owner** — otherwise anyone could hide someone else's repo.
29. **Ref state is trusted only from `[owner, relaySelf]`.**
30. **Project identity is `30617:<owner>:<dtag>`, not the dtag.** Forks make
    dtags ambiguous; a bare-dtag link resolves to whichever owner the relay
    returns first, which is a legacy compatibility path, not the model.
31. **Issue/PR comments are kind 1 and must be filtered out of note feeds** by
    their `a` tag prefix — otherwise Pulse shows orphan replies whose parent is a
    git event.
32. **Review decisions carry a forced-forward `created_at`** so a newer decision
    always supersedes the previous one under nostr's newest-wins ordering, and
    parsing trusts review requests/status changes only from the PR author or repo
    owner.
33. **A merge whose 1631 failed to publish must surface the unpublished signed
    event**, not swallow it — the merge happened and the record must be
    retryable.
34. **The multi-repo project signer gains no authority over member repos.** Push
    policy always reads the repository's own announcement.
35. **Agent-note grouping compares against the previous note in the group, not
    the group's earliest**, or the coalescing window grows without bound.
36. **Polling is visibility-gated and query keys are sorted joined strings**, so
    a hidden window costs nothing and array-identity churn cannot cause refetch
    storms.
37. **The reminder `d` tag needs 16 random bytes, not a UUIDv4** (122 bits < the
    required 128).
38. **A completed/cancelled reminder is republished with a jittered 30–90 day
    `expiration` and no `not_before`**, and with `created_at = max(now, prev+1)`
    so the replacement always wins.
39. **Seed the reminder watermark to `now`, never 0**, and advance it even when
    the toast was suppressed — otherwise enabling notifications later replays
    history.
40. **Do not advance the watermark before the reminders query resolves once**, or
    everything that came due while the app was closed is silently skipped.
41. **A present reminder target can still hold empty strings**; navigability
    requires non-empty `channelId`, `eventId` *and* `authorPubkey`.
42. **`countDue` is one shared function** used by the badge and the fire detector
    so the two surfaces can never disagree about "due".
43. **A custom reminder/snooze time must be strictly in the future** — the native
    time input has no `min`, so an unguarded past time fires immediately.
44. **Forum profile lookups must include mention-tag pubkeys**, or a mentioned
    user who never posted renders as a dead chip.
45. **Memoize `imetaByUrl` on `post.tags`.** A fresh object each render swaps the
    live DOM node mid-gesture and the browser never fires `click` — file
    downloads silently vanish.
46. **`has_more` comes from the window-bounds overlay (kind 39006), never from
    counting rows.**
47. **Moderate the raw signer (`signerPubkey`), never a relay-delegated display
    author.**
48. **Reports are never stored as events and never fanned out.** Reporter
    identity must never reach any surface the reported author can see.
49. **Enforce before recording the resolution.** The 9044 both records the
    decision and DMs the reporter; firing it first produces false notices and
    orphan decision rows.
50. **`(action == "dismiss") == (status == "dismissed")`** is a relay-enforced
    pairing; encode it client-side so an invalid combination is unconstructible.
51. **Ban targets are resolved from the reported event's stored `pubkey`**, never
    from a `p`/`actor` tag, and a failed resolution aborts before any command is
    sent.
52. **Timeout detection is a string-prefix contract**
    (`restricted: you are timed out until <unix>`); an unparseable timestamp
    still means "timed out" (fail closed), while an unknown relay identity leaves
    the moderation-DM composer enabled (fail open). The direction of failure is
    chosen per surface, on purpose.
53. **Moderation command events carry no `h` tag**; the tenant is bound from the
    connection host, and a stray `h` is rejected.
54. **NIP-98 read auth signs the full URL including the query string**, so the
    URL must be finalized before signing.
55. **An empty accessible-channel list in a feed query means "global only", not
    "everything".**
56. **`conversationId` must stay stable as new replies arrive** — draft keys,
    scroll gating and selection all hang off it.
