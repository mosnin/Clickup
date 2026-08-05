# Agent-driven onboarding: the plan

The device flow shipped. It removed the pasted key and made consent informed.
It did **not** make onboarding agentic: the agent still gets a document and
follows five steps, and the human still transcribes an eight-character code.

That is a person doing setup on a machine's behalf, which is backwards. The
target is the reverse.

## Target experience

```
human:  <pastes one line into their agent>
agent:  runs one command
agent:  "Open this to connect me: https://operate.to/link?code=WXYA-3479"
human:  <clicks, signs in or signs up, sees exactly what it may do, approves>
agent:  "Connected as Scout in Acme. 7 skills installed. Reading your brief…"
```

One paste, one click, one approval. Everything else is the agent's job.

Three things stand between here and there, and only the first is the feature.

1. **The agent needs one command, not five steps.** A document an agent
   interprets is a document an agent interprets *differently each time*.
2. **The human needs a link, not a code.** Transcription is the single most
   failure-prone step in the flow and it exists only because RFC 8628 has to
   work on televisions.
3. **A brand-new user has no workspace.** `/link` never mounts `EnsureUser`,
   so somebody arriving from sign-up approves an agent into a personal space
   that does not exist.

## Architecture

Nothing new is invented. `/connect` is a generated shell script the way
`/install/skills` already is, and it drives the endpoints that already exist.

```
GET  /connect            → sh script: device request → link → skills → poll → config
POST /oauth/device       → device_code + user_code + verification_uri_complete
GET  /link?code=…        → consent (Clerk; signs up if needed; bootstraps user)
POST /oauth/token        → device grant → api_key, once
GET  /api/agent/manifest → what changed since last boot
```

The script is generated rather than static for the same reason `/start` is:
the skill digests it verifies come from the same function the manifest
publishes, so an installer and a "you are current" answer can never disagree
about what bytes are correct.

---

## Phase 1 — one command

**`GET /connect`** returns a POSIX `sh` script. No `jq`, no `bash`-isms, no
dependency beyond `curl` and a SHA-256 binary — the same bar `/install/skills`
already meets, because the machines running this are as often a slim container
as a laptop.

Order matters and is not the obvious one:

1. Request the device code **first**, so the link is on screen within a second.
2. Print the link, prominently, with the code as the fallback.
3. Install the skills **while the human is signing in.** That dead time is
   otherwise wasted, and it is exactly long enough.
4. Poll at the advertised interval, honouring `slow_down`.
5. Write credentials to `.operate/credentials.json`, mode 600, and **print**
   the MCP config rather than writing it.

Point 5 is a deliberate refusal. The script cannot know where an arbitrary
runtime keeps its config, and a wrong guess silently clobbers a file somebody
depends on. It writes the credential where it says it will and prints the
block; the agent — which knows its own runtime — wires it up. `OPERATE_MCP_CONFIG`
opts into writing a specific path for people who want that.

**`/link` becomes clickable.** `verification_uri_complete` (RFC 8628 §3.3.1,
the field QR-code flows use) is already returned. `/link?code=` pre-fills and
goes straight to consent — but **still requires an explicit Approve**, because
the consent screen is the security control and a link that self-approves is
just a pasted key with extra steps.

### The tradeoff this makes, stated plainly

The shipped `/start` says the human typing the address is what makes the flow
phishing-resistant. Handing them a link gives that up. It is worth it, and the
honest accounting is:

- The agent is already executing on the human's machine with their trust. An
  agent that wanted to phish them does not need this feature.
- What actually protects them is unchanged: the consent screen names the
  scope, the role, and the ceiling, and nothing happens without a click.
- The typed-code path stays, and is what the script offers as the alternative.

So: link first, code beside it, wording corrected rather than quietly dropped.

### New-user bootstrap

`/link` mounts the equivalent of `<EnsureUser />`. This is the
`EnsureChatIdentity` failure exactly — a correct backend that is simply never
called — and it is invisible until a real new user tries it, because every
developer testing it already has a personal space.

---

## Phase 2 — hardening (required before this is exposed, not after)

Making onboarding one click widens who reaches it. Two limits are missing.

### The finding: user-code enumeration is a confused-deputy hijack

`agentAuth.requestForUserCode` is authenticated but **unthrottled**. An
attacker with any account can enumerate user codes. On a hit they see a live
pending request and can call `approveDeviceRequest` binding **their own**
agent, in **their own** workspace, to **somebody else's** device code.

The victim's agent runtime then connects — successfully, with a valid key — to
the attacker's workspace, and starts taking instructions from it. The victim
sees a working connection. Nothing looks wrong.

The keyspace (24⁸ ≈ 1.1×10¹¹ over a 10-minute window) makes this impractical
today at low concurrency. It gets cheaper as the product grows, which is the
wrong direction for a limit to move, and "expensive" is not a control.

**Fix:** per-user attempt limiting on lookup and approval. Per-*request*
counting is useless here — the attacker tries different codes, not the same
one — so the counter is keyed on the **caller**.

### Device-request flooding

`POST /oauth/device` is necessarily unauthenticated and currently unbounded:
anyone can mint rows forever. Retention prunes them a day later, which is not
a rate limit.

**Fix:** per-IP limiting in the mutation, with the IP read from headers by the
route (Convex cannot see it).

### A generic limiter, because there are already three callers

`convex/_rateLimit.ts` — fixed-window counters keyed by an opaque string,
following the `agentUsage` precedent rather than inventing a second shape.
Fixed windows over sliding: a sliding window needs per-hit rows, and a table
that grows per request is the thing being defended against.

---

## Phase 3 — enterprise visibility

A minted credential must never be invisible.

- **Audit.** Approval and claim emit events into the activity log — who
  approved, which client, what scope, what governance. `agent.connected`
  already exists for first heartbeat; this covers the grant itself.
- **Connections UI.** The Agents page lists keys; it should list
  *authorisations* — which client, approved by whom, when, last seen, and a
  Revoke that kills the key. Device flow makes this natural because each
  authorisation is a row rather than an anonymous key.
- **Policy.** Per-workspace: whether members may connect agents at all,
  whether new agents may be auto-created, a default ceiling. The bar today is
  owner/admin, which is right but not configurable.

## Phase 4 — scale

- **Polling cost.** Every poll is a mutation today (it writes `lastPolledAt`).
  At N agents × 12 polls/minute this is the hottest write path in the flow.
  Fine at target scale; the fix if it isn't is to skip the write when the
  interval has not moved.
- **Indexes.** `by_user_code`, `by_device_hash`, `by_expires` all exist and
  every lookup is an index range. No scans.
- **Retention.** Expired requests prune daily with a day's grace, so a claimed
  row outlives its own code and a replay still gets `invalid_grant`.

---

## Shipping in this pass

Phase 1 in full, plus every Phase 2 item — because a one-click path that is
easier to reach is not something to ship ahead of its limits — plus Phase 3's
audit events. The connections UI and per-workspace policy are specified above
and deliberately not started.

---

## Phase 5 — the plural: fleets

Everything above onboards *an* agent. It does not survive twenty of them:
each needs its own device flow and its own human click, and a person
clicking Approve twenty times is not consenting, they are dismissing a
dialog. Individually-approved agents also leave twenty separate off
switches, and nobody finds all of them under pressure.

So the unit of consent moves from the agent to the **fleet**. A human says
once — "this orchestrator may run up to N workers here, none stronger than
this" — and the orchestrator provisions them itself with no further clicks.

### The rule everything rests on

`convex/_envelope.ts`, pure and dependency-free because it is the security
boundary of the whole feature:

> A provisioned agent's governance is the INTERSECTION of what was requested
> and what the grant permits. Never the union, never the request, never the
> grant alone.

Attenuation is monotonic — provisioning can only narrow — which is what
makes chaining safe: whatever an orchestrator does, and whatever an agent it
provisioned goes on to do, nothing downstream holds a power the human at the
top did not hand over. `tests/agent-fleet.test.ts` asserts that directly,
including that attenuating an already-attenuated result never recovers
authority.

Two details worth keeping if this is rebuilt:

- **An empty fence is a real fence.** `allowedListIds: []` means "fenced to
  nothing"; `undefined` means "not fenced". Conflating them silently grants
  the whole scope.
- **A negative budget clamps to zero, it does not fall back.** The first
  version treated `-5` as unreadable and handed back the *full* envelope —
  a narrowing function that widened on hostile input. Only values it cannot
  read at all (absent, NaN, Infinity) inherit the ceiling.

### Why this is safer than N approvals, not just faster

One grant is one off switch. `revokeFleet` pauses every member **and deletes
their keys** — pausing alone is not revocation, because a paused agent still
holds a valid credential. The grant row survives revocation rather than
being deleted, so the fleet that existed stays in the audit record.

### Shipped

Schema (`agentGrants`, `agents.provisionedByGrantId`, `by_grant` index),
`convex/agentGrants.ts` (grant / provision / revoke / fleet views), the
`my_fleet` and `provision_agent` MCP tools, `fleet.*` events, and 19 tests.

### Not started

- **Fleet UI.** `agentGrants.listForScope` returns everything the Agents
  page needs to group agents by fleet and offer one Revoke; the page does
  not render it yet. Until it does, a fleet is manageable over MCP and
  through the activity feed but not in the dashboard.
- **Granting a fleet from the consent screen.** Today a grant is a separate
  call after an agent exists; `/link` should offer it inline.
- **Sub-fleets.** `withinEnvelope` is written and tested for it — an
  orchestrator delegating to a sub-orchestrator — but nothing calls it yet.
