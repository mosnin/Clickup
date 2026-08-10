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

- [x] **Shipped fixes never reached the reader.** The service worker
      registered once and was never asked again, so a warm PWA served a
      precached build indefinitely — three UI defects were fixed, deployed
      and confirmed live in production's own stylesheet while the reporting
      device kept rendering the old shell. It now checks on mount and on
      every return to the tab, and reloads exactly once when a new worker
      takes over (never on first install). Guarded by
      `tests/ui/service-worker-update.test.tsx`, because an absent update
      check is invisible in review. — iteration 2

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
- [x] **P10 — cost ceilings that bind.** Two ceilings, because they answer two
      questions: per-agent (`agents.dailySpendUsdLimit`) and per-FLEET
      (`agentWallets.dailySpendUsdLimit`) — the second is the one an agency
      owner actually sets, since ten agents at $20 is a $200 day nobody
      agreed to. A circuit breaker, not a pre-authorization: cost is known
      when a run ends, so crossing stops the NEXT action. Recording is
      never gated on the ceiling (the money is already gone; refusing to
      write it down would only hide the overrun). The crossing announces
      itself once from `recordAgentSpend` — a refusal cannot, because a
      Convex mutation that throws rolls back everything it wrote. Both
      numbers are settable and visible. — iteration 3
- [x] **P3 — a stop signal.** A pause says "off until further notice"; a stop
      is about the work in flight. `agents.requestStop` refuses further
      writes, releases the claims the agent is holding (work stranded behind
      something told to do nothing is the deadlock a stop exists to prevent),
      and reaches the agent over the wake channel as `sourceKind: "stop"`
      rather than waiting to surface as a refusal. Reads and presence
      survive — a stopped agent must still be able to say where it got to.
      A reason is required and travels to the agent. **The notice is one
      channel, the enforcement deliberately is not**: a human stop persists
      until a human lifts it, a budget stop self-clears at the UTC day, and
      unifying those would mean every morning starts with somebody manually
      un-sticking a fleet that was never in trouble. — iteration 4
- [ ] **CF-1 — deferred approval (the Gatekeeper import).** A gated action is
      recorded as *pending* with a simulated result, the agent continues, and
      the human approves or rejects in bulk from one queue. The flagship.
- [x] **P5 — one "your turn" queue.** Four sources (task approvals, answered
      revisions, plan questions a person reserved, outcome criteria awaiting
      sign-off) gathered into one queue at the top of the Inbox, and folded
      into the badge — a count that showed only mentions taught people a
      quiet Inbox meant nothing was waiting. **Oldest first**, which is the
      ordering every source it replaces got backwards: a feed is for things
      you might read, this is for things that do not move until you touch
      them, and the one at risk of never being touched is the one that has
      waited longest. Age is shown in the buckets a person reacts to, and
      staleness marks a row without ever hiding it. Every source is
      access-checked on its own terms — a queue that gathered four kinds of
      pointer without re-checking each one would be a tidy way to enumerate
      a workspace you cannot open. — iteration 5
- [ ] **P11 — thrash detection.** Every watchdog pass detects absence; none
      detects repetition. An agent redoing the same work is invisible.

- [ ] **P13 — the task graph.** Proposed by the founder, and the codebase is
      already most of the way there: `tasks.blockedByTaskIds` is a DAG, and
      cycle enforcement (P2) is what makes traversing it safe rather than
      infinite. What is missing is that nothing asks graph-shaped questions
      of it. Four answers counting cannot give: **critical path** ("which
      open task, if finished, releases the largest downstream subtree" —
      this turns `next_task` from fair into effective, and it is the single
      highest-value thing an agent could know); **progress as flow** (17/23
      is a count that lies — two projects at 70% are not equally close, and
      the graph knows which remaining work is on the path); **structural
      stalls** (a chain whose only unblocked head sits in a list its agent
      is fenced out of — every watchdog detects absence, none detects
      unreachability); and **context locality** (the neighbourhood of a
      task is a bounded traversal, and a far better answer for an arriving
      agent than "here is everything").
      Shape: NOT a graph database — Convex tables plus indexes already are
      the graph, and porting would be a rewrite no customer sees. One pure
      module (`src/lib/task-graph.ts`: topological order, critical path,
      reachability, blast radius) testable without a browser like `pack.ts`
      and `situation.ts`; one scope-assembling query; one MCP tool.
      **Agent-readable first, human-visible second** — a node diagram
      nobody acts on is decoration. Degrades to today's behaviour when the
      graph is sparse, because the traversal is only as good as the
      dependencies people actually record.

### Polish
- [ ] **P7 — one-call task context with a budget.**
- [ ] **P12 — assignment recovery sweep.** Abandoned assignments are never
      re-dispatched; `attempt` exists, no cron reads it.
- ~~CF-2 — capability-scoped external access + action log.~~ **CUT** by the
      Jobs panel: the only proposal in either document with no verified gap
      behind it. Every other item names the file or table it extends; CF-2
      names an architecture. The product already answers "what can an agent
      reach" with SSRF guards, HMAC-signed webhooks, `allowedListIds`,
      readonly roles and attenuated grants. Revisit the day one concrete
      integration demands "this agent may touch this one channel" — then
      scope the grant to that one thing and stop.
- ~~P9 — failures distilled into reviewed skills.~~ **CUT**: its failure mode
      makes the product worse rather than merely no better (an accumulating
      file of unreviewed advice polluting `brief` and skills), and shipped P6
      already delivers the practical memory benefit at a fraction of the
      cost.

## The order, judged

A Steve Jobs panel (three lenses — customer, risk, coherence — then a
synthesis) ranked the queue on 2026-08-07. Its critical path, in one
sentence a founder can repeat:

> **Cap the money for real, give the fleet one stop button, and put everything
> waiting on a human into one aging queue — only then is it safe to let agents
> work through approvals instead of freezing on them.**

So: **P10 → P3 → P5 → CF-1**, with P11, P12, P7 behind them and CF-2 + P9 cut
outright. Two of its rulings are worth keeping visible. P5 was moved ABOVE the
flagship because CF-1's entire output is obligations, and building the producer
before the consumer ships approvals into no surface — "a deferred approval
nobody sees is exactly the week-away disaster CF-1 exists to prevent". And the
panel refused to call CF-1 first: "ship it first and you have built the
accelerator before the brakes".

## Iteration log

**5.** Shipped P5, the receiving dock the panel insisted come before the
flagship. The judgement that shaped it: sorting. Every surface it replaces
ordered newest-first out of habit, which systematically buries the obligation
most likely to have been forgotten — so the queue inverts it and shows the
wait rather than the timestamp, because "has this been ignored" is the
question somebody acts on.

**4.** Shipped P3, the stop signal, routing P10's budget stop down the same
notice channel per the panel's instruction — one thing for a runtime to
implement — while keeping the two enforcement lifetimes separate on purpose.
The judgement worth recording: making the budget stop durable like a human
stop would have made the code symmetrical and the product worse.

**3.** Convened the Jobs panel to set the order (above), then shipped P10 to
its spec. The panel's sharpest catch was in the working tree rather than the
plan: the ceiling was written and the wire was cut — `finishRun` validated
`costUsd`, wrote it onto the run, and never counted it, so the enforcement read
as if money were capped while nothing could ever trip it. That is worse than no
ceiling, because it is the one thing that would let a founder switch on
`bounded_autonomous` believing a lie.

**2.** Verified the three production UI reports against the live site rather
than assuming: production's CSS carried every fix already (`.notch-panel` with
no border, `.ui-chip` as a pill). The defect was distribution, not design — see
the blocker above. This is the highest-leverage bug found so far: it made every
other fix conditional on a cache expiring.

**1.** Wrote this file. Shipped P1 (dispatcher parity + legible refusal) and
P6 (the memory layer: agents can finally read runs back). 2940 tests green,
all four gates green. Next: P10 — cost ceilings that bind, because it is what
stands between `bounded_autonomous` being a checkbox and being a decision
somebody can responsibly make.
