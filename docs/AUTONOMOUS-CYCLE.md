# The autonomous cycle

The working queue for the self-driving development loop. One iteration = pick
the top unfinished item, build it with tests, verify it in a real browser,
ship it, update this file.

Two sources feed the queue: `docs/AGENT-TEAMS-ROADMAP.md` (what a fleet needs
to run a week unattended, verified against the codebase) and the patterns
worth stealing from Cloudflare OS (`/workspace/cloudflare/cloudflare-os`).

## What Cloudflare OS is for, and what we take from it

Cloudflare OS is an AI productivity OS: per-user **Gadgets** (a private
instance of an app per person, sandboxed), **Gatekeepers** (capability-scoped
drivers for external services, with logging and human-in-the-loop), and
**Blueprints** (templates that specify a whole application).

Three of its ideas are directly load-bearing for an agency running agent
fleets, and one of them is the single biggest differentiator available to us:

1. **Deferred, simulated approval.** Their key insight, stated in their own
   README: synchronous human-in-the-loop is why people end up running with
   approvals disabled. You give an agent a task, walk away, and come back to
   find it stopped on step one. So a Gatekeeper *simulates* the side effect,
   tells the agent it succeeded, serves simulated reads back, and lets the
   human approve or reject **in bulk, later**. We have the opposite: a gated
   task blocks the agent until a person clicks. This is ours to take.
2. **Capability-scoped external access with an action log.** Every external
   reach is narrowed to the specific resource the user intended and every
   action is recorded for review. We have SSRF guards and webhooks; we do not
   have "this agent may touch this one resource, and here is everything it
   did".
3. **Per-person instances instead of one shared app.** Their Gadget model is
   the extreme version of a rule this codebase already believes (panels are
   definitions, screens are data, an agent may author but never apply). The
   useful import is not sandboxed Workers — it is that a *definition an agent
   wrote* should be as ordinary as a document.

What we deliberately do NOT take: the Workers/Durable Objects substrate. Our
backend is Convex and the per-workspace reactive model is doing the same job.
Porting the runtime would be a rewrite that buys us nothing a customer sees.

## Queue

Ordered by leverage. `[ ]` open, `[x]` shipped this cycle, with the commit.

### Blockers
_(none)_

### Majors

- [x] **P2 — cycles refused everywhere.** `validateBlockers` walks proposed
      blockers' chains and refuses anything closing a loop; covers the human
      mutation and `add_dependency` alike. — `c27188a`
- [x] **P1 — one dispatcher.** `next_task` honours the concurrency ceiling the
      push path already honoured, and answers `{ tasks, dispatch }` so an
      empty list is never mistaken for an empty backlog. — iteration 1
- [x] **P6 — agent-readable run history.** `list_runs` / `get_run` MCP tools
      plus `recentOutcomes` inline on `get_task`; a teammate's run is
      readable in scope, fenced per task on the way out. — iteration 1
- [ ] **P10 — cost ceilings that bind.** Spend is charted, never enforced; the
      only enforced budget counts mutations. Nobody should switch on
      `bounded_autonomous` until money has a ceiling.
- [ ] **P3 — a stop signal.** Pausing the whole agent is the only halt, and it
      is invisible to a run in flight. `agentPingDeliveries` is already a
      working wake channel; cancellation is one more `sourceKind`.
- [ ] **CF-1 — deferred approval (the Gatekeeper import).** A gated action is
      recorded as *pending* with a simulated result, the agent continues, and
      the human approves or rejects in bulk from one queue. The flagship.
- [ ] **P5 — one "your turn" queue.** Human obligations are scattered across
      approvals, revisions, plan questions and outcome checks, with no count
      and no aging. CF-1's approvals land here.
- [ ] **P11 — thrash detection.** Every watchdog pass detects absence; none
      detects repetition. An agent redoing the same work is invisible.

### Polish
- [ ] **P7 — one-call task context with a budget.**
- [ ] **P12 — assignment recovery sweep.** Abandoned assignments are never
      re-dispatched; `attempt` exists, no cron reads it.
- [ ] **CF-2 — capability-scoped external access + action log.**

## Iteration log

**1.** Wrote this file. Shipped P1 (dispatcher parity + legible refusal) and
P6 (the memory layer: agents can finally read runs back). 2940 tests green,
all four gates green. Next: P10 — cost ceilings that bind, because it is what
stands between `bounded_autonomous` being a checkbox and being a decision
somebody can responsibly make.
