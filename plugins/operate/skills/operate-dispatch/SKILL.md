---
name: operate-dispatch
description: Release and monitor safe parallel execution waves in Operate using dependencies, agent capabilities, concurrency ceilings, delivery configuration, and the execution ledger.
---

Use this skill when a committed execution plan should begin, continue, or recover.

1. Call `get_execution_policy`, `get_execution_plan`, and `get_execution_readiness`.
2. Check `dispatchAuthorized`, authorization source/reason, policy version, `policyCapacityRemaining`, and the plan's `reviewStatus` first. Pending and rejected plans require a workspace owner/admin; policy-authorized plans require the exact active policy version. An agent cannot approve its own plan or change policy.
3. Explain blockers before mutating anything: authorization, stale policy version, rolling daily limit, per-wave limit, open-question gates, dependency blocks, capability gaps, capacity exhaustion, active claims, or live assignments.
4. If open questions exist, obtain or write an explicit disposition that says what was resolved, deferred, or intentionally bounded. Never imply uncertainty disappeared.
5. Call `dispatch_execution_wave` with a unique idempotency key, a deliberate `maxTasks`, and an optional agent subset when the user constrained the fleet.
6. Dispatch reconciles stale attempts before routing. If you are recovering work manually, call `reconcile_execution_plan` first and preserve its timeout evidence.
7. Read `get_execution_control` after dispatch. Report each task, assigned agent, delivery mode, attempt number, and whether the runtime was notified or must poll.
7. On later checks, distinguish dispatched, claimed, running, succeeded, failed, and abandoned attempts. Failed or abandoned work is retryable; do not duplicate a fresh active attempt.
8. When execution appears complete, load `operate-assurance`. Submit evidence against every original success criterion and route it to a different agent or human for review. Never equate a green execution ledger with a verified outcome.

Never bypass dependencies, capability requirements, concurrency ceilings, approval gates, or a fresh claim merely to make a wave look busy.
