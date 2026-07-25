---
name: operate-dispatch
description: Release and monitor safe parallel execution waves in Operate using dependencies, agent capabilities, concurrency ceilings, delivery configuration, and the execution ledger.
---

Use this skill when a committed execution plan should begin, continue, or recover.

1. Call `get_execution_plan` and `get_execution_readiness`.
2. Explain blockers before mutating anything: open-question gates, dependency blocks, capability gaps, capacity exhaustion, active claims, or live assignments.
3. If open questions exist, obtain or write an explicit disposition that says what was resolved, deferred, or intentionally bounded. Never imply uncertainty disappeared.
4. Call `dispatch_execution_wave` with a unique idempotency key, a deliberate `maxTasks`, and an optional agent subset when the user constrained the fleet.
5. Read `get_execution_control` after dispatch. Report each task, assigned agent, delivery mode, attempt number, and whether the runtime was notified or must poll.
6. On later checks, distinguish dispatched, claimed, running, succeeded, failed, and abandoned attempts. Failed or abandoned work is retryable; do not duplicate a fresh active attempt.
7. When execution appears complete, load `operate-assurance`. Submit evidence against every original success criterion and route it to a different agent or human for review. Never equate a green execution ledger with a verified outcome.

Never bypass dependencies, capability requirements, concurrency ceilings, approval gates, or a fresh claim merely to make a wave look busy.
