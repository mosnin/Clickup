# Agent teams — roadmap

What is missing for a *team* of agents to work in operate.to for a week without
a person babysitting it, and without the person losing the thread.

**Provenance note.** The three research reports were not delivered to this
session — the calling script's `${research}` placeholder arrived unsubstituted,
so there was nothing to synthesise. Rather than write from memory, this document
was built by reading the codebase directly: `convex/schema.ts` (86 tables),
`convex/agentApi.ts` (8,358 lines, ~190 MCP tools), the execution stack
(`executionPlans`/`executionPolicy`/`executionDispatch`/`executionLifecycle`/
`outcomeAssurance`), `contextPackets.ts`, `decisions.ts`, `plans.ts`,
`agentGrants.ts`, `maintenance.ts`, `crons.ts`, and `src/lib/mcp-tool-names.ts`.
Every claim below about what exists was checked against a file, and every
proposal names the file or table it extends. Note also that `CLAUDE.md` is
significantly behind the repository — it does not mention context packets,
execution plans, decisions, fleets, revisions, or outcome assurance — so it is
not a safe inventory on its own.

---

## 1. Executive summary

The platform is further along than any roadmap document here has admitted. The
hard, distinctive parts are built: versioned context with read receipts,
compiled execution plans with human review gates, wave dispatch with leases,
per-assignment lifecycle receipts, outcome evidence, fleet provisioning by
attenuated grant, idempotent agent operations, live run streaming. What is
missing is not another large subsystem. It is a set of small closures around
what already exists — and most of them are cheap.

The five highest-leverage missing features, ranked:

1. **Cost ceilings that actually bind.** `agentRuns.tokensUsed` / `costUsd` are
   self-reported, aggregated for display in `agents.fleetSpend`, and enforced
   nowhere. The only enforced budget counts *mutations* (`agentUsage`), so an
   agent can spend two hundred dollars of tokens while making three writes.
   Until spend is a ceiling rather than a chart, nobody sane turns on
   `bounded_autonomous` mode. **M.**

2. **Agent-readable run history.** Agents write runs (`start_run`,
   `finish_run`, `report_error`, `emit_run_event`) and can never read one back —
   not their own, not a teammate's, not "what was tried on this task last
   Tuesday". `agents.stats` and `agents.liveRunForTask` are Clerk-authenticated
   human queries. The single largest capability gap in the product is memory,
   and the cheapest large piece of it is already sitting in a table with the
   right indexes. **S.**

3. **One dispatcher instead of two.** `executionDispatch.ts` routes work by
   `agents.capabilities` and `maxConcurrentTasks`. `agentApi.nextTask`
   (line 3473) — the pull path every self-directed agent actually uses — ignores
   both, and will happily hand a research agent a TypeScript task while the
   TypeScript agent already holds three. Two selectors with different rules is
   precisely the drift this codebase names as a failure mode elsewhere. **S.**

4. **A stop signal.** The only way to halt work in flight is to pause the whole
   agent (`agents.status`, checked in `_agentAuth.ts:149`), which is
   all-or-nothing, retroactive, and invisible to the run that is mid-flight.
   `agentPingDeliveries` + `list_wake_inbox` + `acknowledge_wake` are already a
   working wake channel; a cancellation is one more `sourceKind`. **M.**

5. **One queue for the human's turn.** Work waiting on a person is currently
   scattered across four surfaces: approvals (`tasks.pendingApprovals`, in the
   Inbox), revision requests (`revisions.ts`, only on the task page and
   `revisions-panel.tsx`), human-reserved plan questions (`needsHuman` in
   `planNodes`, only on the plan canvas), and failed/pending outcome criteria
   (`outcomeChecks`, only in the plan view). The practical ceiling on fleet size
   is how fast one person can clear their obligations, and right now they cannot
   even see them in one place. **M.**

Separately, and regardless of ranking: **`add_dependency` has no cycle check**
(`agentApi.ts:2424` → `tasks.validateBlockers`, which refuses self-blocks and
cross-scope blockers only). Two agents can build A-blocks-B-blocks-A, and since
completion is refused while a blocker is open, both tasks are wedged forever
with no watchdog pass that notices. The plan compiler already detects cycles
(`agentApi.ts:6419`); lifting that check into `validateBlockers` is an
afternoon. Do it in the next PR that touches `tasks.ts`.

---

## 2. What we already have

An honest inventory, one line each. Nothing below should be re-proposed.

**Principals and governance**
- `agents` — first-class agent principals in a personal space or workspace, with `role`, `allowedListIds`, `capabilities`, `maxConcurrentTasks`, `dailyActionLimit`, `notifyUrl`.
- `agentKeys` — SHA-256-hashed API keys, minted in a Node action, plaintext shown once.
- `agentGrants` + `_envelope.ts` — fleet provisioning by attenuated envelope: an orchestrator agent provisions workers it can never make more powerful than itself.
- `agentUsage` — per-agent daily mutation budget plus a 60/minute burst cap, enforced in `_agentAuth.requireAgentByKey`.
- `agentWallets` / `payments` + `x402*.ts` — prepaid credit wallet per scope, x402 top-up, metering off by default, replay-proof settlement.
- `platformAdmins` / `adminAuditLog` — env-rooted admin tiers, account holds, append-only audit.

**Coordination**
- `executionPlans` (+ `Revisions`, `Reviews`) — a brief compiled into roadmap/projects/tasks/dependencies/context, immutable, idempotent, human-reviewed before dispatch.
- `executionPolicy` — workspace-level `supervised` / `bounded_autonomous`, wave and daily caps, versioned so policy authorization expires with the version.
- `executionWaves` / `executionAssignments` — auditable release of ready work with leases, and a mutable lifecycle receipt per assignment (dispatched → claimed → running → succeeded/failed/abandoned).
- `executionDispatch.ts` — readiness and control-plane queries; capability matching, concurrency, context-fingerprint checks.
- `agentPingDeliveries` — durable, retried, HMAC-signed wake delivery with a second receipt proving the agent consumed it over MCP.
- Claims (`claimedByActorId`, 60-min TTL), `blockedByTaskIds`, `handoff_task`, `next_task`, `channels`, `revisions.ts` (a correction with a lifecycle, not a comment).
- `plans.ts` / `planNodes` — question/option/evidence/decision deliberation with derived status and `needsHuman`.
- `presence` — one table for humans and agents on any surface; `set_focus` for reads.

**Context and memory**
- `contextPackets` + `taskContextPackets` + `agentContextReceipts` — versioned project briefs, attached to many tasks, with per-agent per-version read receipts that go stale on update and gate claim/complete.
- `decisions` + `decisionImpacts` — immutable, keyed, versioned operating policy with supersede chains and per-task impact assessment.
- `embeddings` + `ai.ts` / `agentAi.ts` — semantic search over docs, tasks and pages, scope-filtered.
- `skills` + `BUILTIN_SKILLS` — markdown playbooks, custom rows override built-ins by slug.
- `brief` (`agentApi.ts:1183`) — an arriving agent gets accepted decisions, open questions, governance limits.
- `pages` + `pageRevisions` — markdown documents with history, restore-as-edit, optimistic-concurrency saves.
- `agentOperations` — idempotency receipts so a timed-out write is safe to retry.

**Staying on task**
- `maintenance.watchdog` (15 min) — releases expired claims, nags overdue tasks once per period, flags agents holding a task with no heartbeat for 30+ minutes, abandons the matching execution assignment.
- `maintenance.prune` (daily) — events 90d, deliveries 30d, usage 14d.
- `agentRuns` — structured runs with live steps, `liveState`, one-line narration, artifacts and self-reported cost; `run-theater.tsx` renders it live.
- `outcomeChecks` + `outcomeAssurance.ts` — plan success criteria evaluated against submitted evidence, review recorded, evidence invalidated when context revises.
- `requiresApproval` gates, `tasks.pendingApprovals`, `request_approval`.
- `calibration.ts` — a decision can carry a claim about a measurable number and get graded by cron.
- `situations` / `panelSituations` — a named condition over the work, with hysteresis, that can make a panel announce itself.

---

## 3. The gaps

### Coordination

- **Two dispatchers with different rules.** Capability and concurrency routing
  exists only on the push path (`executionDispatch`). The pull path (`nextTask`)
  sorts by claim freshness, assignment, blockers, active sprint and priority —
  and knows nothing about what an agent can do or how much it is already
  holding.
- **No stop.** Pause-the-agent is the only halt, and it is a permission change
  rather than a message: a run in flight is never told, and there is no way to
  cancel one task, one wave, or one plan.
- **Claims are advisory by design, with nothing that can make them binding.**
  That is the right default for a mixed human/agent list. It is the wrong
  default for a list where four workers are pulling from the same queue, and
  there is currently no way to say so.
- **Human obligations are scattered across four surfaces** (approvals,
  revisions, `needsHuman` questions, outcome criteria), so "what is waiting on
  me" cannot be answered, counted, or aged.
- **Dependency cycles are only refused in the plan compiler**, so the two agent
  tools that write edges can wedge a pair of tasks permanently.
- **Abandoned work is never re-offered.** The watchdog marks an assignment
  abandoned; nothing re-dispatches it. `executionAssignments.attempt` exists and
  is only ever written as part of a manual wave.

### Context and memory

- **Runs are write-only from the agent side.** No `list_runs`, no `get_run`, no
  "what happened on this task before". An agent that failed a task on Monday
  arrives Tuesday with no evidence it ever tried.
- **Context assembly is the agent's problem.** `get_task` returns the task,
  `list_context_packets` returns packets, `list_decisions_for_task` returns
  decisions, `list_open_revisions` returns corrections — four round trips, no
  ordering by relevance, no token budget, and the readiness receipt is a fifth
  call. Meanwhile the wave dispatcher already computes
  `estimatedContextTokens` and a `contextVersionFingerprint`, so half the work
  is done in the wrong place.
- **Deliberation is not searchable.** `embeddings` covers docs, tasks and pages.
  Comments and channel messages — which is where agent-to-agent reasoning
  actually happens — are not indexed, so the record of *why* is unreachable by
  the tool agents use to find things.
- **Failure produces nothing durable.** A failed run writes an `agent.error`
  event that is pruned after 90 days. Skills are hand-written and there is no
  `update_skill` tool. Nothing carries a lesson from one run to the next.

### Staying on task

- **Spend is observed, not bounded.** See summary item 1.
- **Nothing detects thrash.** The watchdog catches stalls (nothing happening);
  it catches nothing about the same thing happening repeatedly — five failed
  runs on one task, a status flipping back and forth, two agents overwriting
  each other's edits to one page. A loop looks like health to every existing
  check.
- **Verification exists at plan level only.** `outcomeChecks` are keyed
  `by_plan`. An ordinary task has a checklist nobody verifies and an approval
  gate that only a human can clear, with no way to say "done means these three
  things, show evidence".

---

## 4. Proposals

Twelve, deduplicated, none duplicating a shipped feature. Sizes: **S** = one
focused PR, no schema change or one optional column. **M** = one PR with a
schema addition and a UI surface. **L** = multi-PR.

### Coordination

#### P1 — One dispatcher

**What.** Extract the candidate-selection logic into a shared module
(`convex/_dispatch.ts`) that both `agentApi.nextTask` and
`executionDispatch.ts` call: same capability match (`capabilities.ts
hasCapabilities`), same concurrency ceiling (`agents.maxConcurrentTasks`
counted over active `executionAssignments` plus fresh claims), same blocker and
claim rules. `next_task` gains an optional `capabilities` filter argument and
returns *why* a task was skipped.

**Why.** A fleet that pulls its own work is the cheap and common configuration;
today it routes worse than the expensive one. And a second selector with
divergent rules will keep diverging — the plan compiler already learned this
lesson about cycle checks.

**Builds on.** `convex/agentApi.ts` (`nextTask`, line 3473),
`convex/executionDispatch.ts`, `convex/capabilities.ts`, `agents.capabilities`,
`agents.maxConcurrentTasks`, `executionAssignments.by_agent`.

**Size.** S. No schema change.

**Cut line.** Ship capability matching only; leave concurrency to the push path.

---

#### P2 — Cycles refused everywhere

**What.** Move the plan compiler's cycle detection (`agentApi.ts:6419`) into
`tasks.validateBlockers`, so every write path — human, agent, board drag,
automation — refuses an edge that closes a loop. Add a watchdog pass that flags
pre-existing cycles as `task.deadlocked` rather than leaving them silent.

**Why.** Completion is refused while a blocker is open, so a cycle is permanent
data corruption expressed as two tasks nobody can finish. Two agents editing
dependencies concurrently is the ordinary way to produce one.

**Builds on.** `convex/tasks.ts` (`validateBlockers`, line 236),
`convex/agentApi.ts` (`addDependency`), `convex/maintenance.ts`,
`convex/network.ts` (which already walks the same edges for the graph view).

**Size.** S.

**Cut line.** Write-time refusal only; skip the watchdog sweep for existing
data.

---

#### P3 — Cancellation as a wake

**What.** A `work.cancel` wake: `agentPingDeliveries.sourceKind` gains
`"cancellation"`, `executionAssignments.status` gains `"cancelled"`, and a
human (or an orchestrator holding the grant) can stop one task, one wave, or one
plan. The agent sees it in `list_wake_inbox`, acknowledges it, and
`finish_run` records the run as cancelled rather than failed. A Stop control on
`run-theater.tsx` and on the plan's control panel.

**Why.** Pausing an agent is a permission change, not a message: it is
all-or-nothing, it does not reach the runtime, and it leaves an assignment
looking alive. The first thing a person wants when watching a fleet do the wrong
thing is a stop button, and the wake channel that would carry it is already
built and already proven with a two-stage receipt.

**Builds on.** `convex/agentPingDeliveries.ts`, `convex/executionLifecycle.ts`,
`convex/agentApi.ts` (`list_wake_inbox`, `acknowledge_wake`, `finish_run`),
`src/components/dashboard/run-theater.tsx`.

**Size.** M.

**Cut line.** Task-level cancel only; wave and plan cancel later. Skip the run
status distinction and let a cancelled run finish as failed with a reason.

---

#### P4 — Claim-required lists

**What.** One optional column on `lists` — `claimPolicy: "advisory" |
"required"` — that makes writes to a task on that list refuse unless the actor
holds a fresh claim. Enforced in `updateTaskCore`, so humans and agents get the
same rule.

**Why.** Advisory claims are correct for a list where people and agents share
work, and wrong for a queue four workers pull from concurrently; the platform
currently cannot express the difference. This is the smallest possible answer —
no locking subsystem, just the existing claim with teeth on the lists that ask
for them.

**Builds on.** `convex/tasks.ts` (`updateTaskCore`, `CLAIM_TTL_MS`),
`convex/lists.ts`, list settings UI.

**Size.** S.

**Cut line.** Enforce for agent actors only; leave humans advisory (a person
being told they may not edit a task is a worse failure than a duplicate edit).

---

#### P5 — One "your turn" queue

**What.** A single query — `obligations.forCurrentUser` — merging pending
approvals, open revision requests addressed to you, `needsHuman` plan questions,
and pending/failed outcome criteria on plans you own, each with an age and a
deep link. Rendered as the first section of `/dashboard/inbox`, with a count in
the sidebar badge.

**Why.** The number of agents one person can supervise is bounded by how fast
they clear their obligations, and today those obligations live on four different
screens with no aging and no count. This is not a new concept; it is four
existing queues given one address.

**Builds on.** `convex/tasks.ts` (`pendingApprovals`), `convex/revisions.ts`
(`by_status` index, already built for exactly this shape),
`convex/plans.ts` (`planNodes.needsHuman`), `convex/outcomeAssurance.ts`,
`src/app/dashboard/inbox/inbox-view.tsx`.

**Size.** M.

**Cut line.** Approvals + revisions only. Those two cover most volume; questions
and criteria can follow.

---

### Context and memory

#### P6 — Agent-readable run history

**What.** Three read tools: `list_runs` (by agent, by task, by list, with
status filter), `get_run` (steps, narration, artifacts, error), and a
`recentOutcomes` block added to `get_task` — the last few runs against this
task, who, how it ended, what it produced. Access-checked exactly like the task,
and a teammate's run is readable within scope (a run someone else cannot see is
a lesson nobody learns).

**Why.** This is the largest capability gap with the smallest implementation.
Everything is already stored with the right indexes (`agentRuns.by_agent`,
`by_task`); the only thing missing is permission to read it back. Without it,
"we tried that and it failed for this reason" is unavailable to the only party
who could act on it.

**Builds on.** `agentRuns` (schema line 1835), `convex/agents.ts` (`stats`,
`liveRunForTask` — the human-side shapes to mirror), `convex/agentApi.ts`,
`src/lib/mcp-tool-names.ts`.

**Size.** S. No schema change.

**Cut line.** `list_runs` scoped to the calling agent only. Half the value, a
quarter of the authz surface.

---

#### P7 — One-call task context, with a budget

**What.** `get_task_context(taskId, tokenBudget?)` returns, in one call and in
relevance order: attached context packets at their current versions, decisions
in force for the list, open revisions, recent run outcomes (P6), and the
readiness verdict — trimmed to a token budget, with what was trimmed named
rather than silently dropped. Acknowledging the packets it returned is one
follow-up call, not four.

**Why.** Context assembly is currently four round trips whose ordering and
budget are each agent's private guess, which is exactly the thing that varies
between a good and a bad runtime. The wave dispatcher already computes
`estimatedContextTokens` and `contextVersionFingerprint` per assignment — that
logic belongs to the task, where the pull path can use it too.

**Builds on.** `convex/contextPackets.ts` (`listPacketsForTask`,
`AgentContextReadiness`), `convex/decisions.ts`, `convex/revisions.ts`,
`convex/executionDispatch.ts` (token estimation and fingerprint, to be lifted),
`agentContextReceipts`.

**Size.** M.

**Cut line.** Skip the token budget; return everything with counts and let the
runtime trim. The single call is most of the win.

---

#### P8 — Deliberation becomes searchable

**What.** Extend `embeddings` to cover `messages` — task comments and channel
messages — with the same `scopeType`/`scopeId` filter, throttled to bodies over
a length floor and skipping pure mention/reference noise. `semantic_search`
gains a `kinds` filter so an agent can ask only the record of reasoning.

**Why.** `embeddings` already covers docs, tasks and pages. The place agents
actually argue — channels and comments — is unindexed, so the answer to "has
anyone discussed this" is unreachable by the one tool built to answer it. The
codebase notes this as deferred on embedding-traffic grounds; the length floor
and the fact that channels are low-volume compared to tasks make it affordable
now.

**Builds on.** `convex/ai.ts` (write-side indexing, parent types
`doc | task | page`), `convex/agentAi.ts`, `embeddings` (schema line 1155),
`convex/messages.ts` (`createMessageCore`).

**Size.** M.

**Cut line.** Channel messages only, not task comments — the volume ratio is
strongly favourable and channels are where the reasoning is.

---

#### P9 — Lessons: failures distilled, humans consenting

**What.** After a run fails, an agent may file a `lesson` — a short claim about
what went wrong and what to do instead, scoped to a list — which appears as a
proposal to a human, and on acceptance becomes a `skills` row and joins `brief`.
Same consent shape as `screenProposals` / `panelProposals`, for the same reason.

**Why.** Failure currently produces an event that is pruned in 90 days. This is
the only proposal here that changes what the team *knows* over time rather than
what it can see. It is last in the group because it is the least certain: a
lessons file that nobody prunes becomes noise, and the acceptance gate is what
keeps it honest.

**Builds on.** `skills` table + `convex/skills.ts` (merge-by-slug already
handles overrides), `screenProposals` / `panelProposals` as the consent
precedent, `agentRuns` (failed runs as the trigger), `brief`.

**Size.** L.

**Cut line.** This is the cut. If scope pressure hits anywhere in this document,
P9 goes first — P6 delivers most of the practical memory benefit at a fraction
of the cost, and a lesson nobody accepts is worse than no lesson at all.

---

### Staying on task

#### P10 — Cost ceilings that bind

**What.** `agents.dailyCostLimitUsd` and a scope-level ceiling in
`platformSettings`, enforced in `_agentAuth.requireAgentByKey` alongside the
existing daily and burst counters — before them, in the same fail-closed
position the wallet check already occupies. Spend is rolled up from
`agentRuns.costUsd` into an `agentUsage`-shaped daily counter. Exceeding it
refuses writes with a payment/limit reason and emits `agent.budget_exhausted`;
reads and `finish_run` stay allowed so an agent can always report what it spent.

**Why.** The enforced budget counts mutations, which is a poor proxy for cost —
the expensive thing about an agent is the tokens between the writes. `fleetSpend`
and `agents.stats` already compute the numbers for display. Turning a chart into
a ceiling is what makes `bounded_autonomous` a mode a founder will actually
enable.

**Builds on.** `convex/_agentAuth.ts` (`requireAgentByKey` — the one gate every
agent write passes), `agentUsage`, `agentRuns.costUsd` / `tokensUsed`,
`convex/agents.ts` (`fleetSpend`), `convex/x402.ts` (metering config as the
precedent for an off-by-default enforcement toggle), `platformSettings`.

**Size.** M.

**Cut line.** Per-agent ceiling only, no scope-level pool. And accept the honesty
limit out loud: cost is self-reported, so this bounds cooperative agents and
detects uncooperative ones — it does not stop a runtime that lies. Say that in
the UI rather than implying a guarantee.

---

#### P11 — Thrash detection

**What.** A fourth watchdog pass: N failed runs against one task within a
window, a task whose status has flipped between the same two values repeatedly,
and two actors alternating writes to one page or task inside a short interval.
Each emits a `task.thrashing` / `agent.thrashing` event, releases the claim, and
files a human obligation (P5).

**Why.** Every existing safety net detects *absence* — an expired claim, a
missing heartbeat, an overdue date. Nothing detects *repetition*, and a loop is
what unattended agents actually do when they are wrong: it looks like health to
every check we have while burning budget (which is why this pairs with P10).

**Builds on.** `convex/maintenance.ts` (`watchdog`, same 15-minute cron),
`agentRuns.by_task`, `events` (`task.*`, `agent.error`),
`convex/notificationCenter.ts`.

**Size.** S/M.

**Cut line.** Repeated-failure detection only. It is the most common shape and
the cheapest to compute from `agentRuns.by_task`.

---

#### P12 — Automatic recovery waves

**What.** A cron pass that re-offers abandoned `executionAssignments` — bounded
by `attempt`, respecting the plan's authorization and current policy version,
skipping tasks whose context fingerprint has changed (those need re-reading, not
retrying), and escalating to a human obligation after the attempt cap.

**Why.** The lifecycle already models this: the schema comment says "expired,
unclaimed work becomes eligible for a later recovery wave", the `attempt` column
exists, and the watchdog already abandons assignments when a claim expires. But
nothing is on the other side — recovery requires a human or an orchestrator to
notice and dispatch again, which defeats the point of unattended operation. This
is finishing a mechanism, not adding one.

**Builds on.** `executionAssignments` (`attempt`, `by_plan`, `by_wave`),
`convex/executionLifecycle.ts` (`abandonExecutionAssignmentForTask`),
`convex/executionDispatch.ts`, `convex/executionPolicy.ts`,
`convex/crons.ts`, `convex/maintenance.ts`.

**Size.** M.

**Cut line.** Re-offer only into the pull path — mark the task unclaimed and let
`next_task` find it — rather than minting a recovery wave. Less auditable, a
fifth of the code.

---

## 5. Suggested build order

**Round 1 — the afternoon fixes (P2, P1, P6).**
Start where the ratio is absurd. P2 closes a data-corruption hole with a
function move. P1 makes the pull path route as well as the push path, with no
schema change. P6 turns an existing table into the memory layer by granting read
access. None of the three needs a migration, all three are testable in the
existing vitest suite, and together they change what a fleet does on day one.
P6 also comes first among the memory work because P7 wants to include run
outcomes and P11 wants to count run failures — both are cheaper once run history
is a readable thing.

**Round 2 — make autonomy safe to switch on (P10, P3).**
These two are what stand between `supervised` and `bounded_autonomous` being a
real choice. P10 bounds the money; P3 provides the stop. Do P10 first: it is the
one whose absence would be discovered expensively, and it lands in
`requireAgentByKey`, which is the most sensitive file in the agent stack — it
deserves a round of its own rather than sharing one. P3 second because a stop
button is most valuable once agents are permitted to run long enough to need
one.

**Round 3 — keep the human in the loop at fleet scale (P5, P11).**
P5 gives the person one place to stand; P11 gives that place something important
to say. They ship together because P11's escalation path is P5's queue — built
in the other order, thrash detection emits events into a fifth surface nobody
watches, which is the problem P5 exists to solve.

**Round 4 — quality of work (P7, P4).**
With routing, memory, budget, stop and supervision in place, the remaining
lever is how well each task is done. P7 makes good context the default rather
than each runtime's private discipline; P4 removes the last common way two
agents ruin each other's work. Both are small; they are late because they
improve work that the earlier rounds make possible in the first place.

**Round 5 — compounding (P12, P8).**
P12 finishes unattended recovery, which only pays off once runs are long enough
and frequent enough to fail unattended. P8 makes the record of reasoning
searchable, which pays off in proportion to how much reasoning has accumulated —
so it is deliberately late, when there is something worth searching.

**P9 — only if the earlier rounds land and the appetite is there.** It is the
one proposal whose value is speculative rather than structural, and the one
whose failure mode (an accumulating file of unreviewed advice) makes the product
worse rather than merely no better.

One note on sequencing discipline: rounds 1 and 2 are seven files and no new
concepts. If only those ship, the product is meaningfully better at running an
agent team than it is today. Everything after round 2 is refinement, and should
be treated as cuttable.
