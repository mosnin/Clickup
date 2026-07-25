---
name: operate-recovery
description: Diagnose and recover stalled, failed, abandoned, or repeatedly dispatched Operate work without duplicating active execution or hiding the original evidence.
---

Use this skill when an execution plan is stuck, an agent disappeared, a run failed, or work needs reassignment.

1. Call `get_execution_control`, `get_execution_readiness`, `get_task`, and relevant recent events.
2. Identify the latest attempt and its exact state. A fresh dispatched, claimed, or running attempt is active; do not create a duplicate.
3. Check context versions, claim freshness, agent status, required capabilities, concurrency, dependencies, approval gates, and evidence/error fields.
4. Preserve the failed or abandoned receipt. Never rewrite a terminal outcome.
5. If the prior attempt is retryable and the task is ready, dispatch a new wave with a new idempotency key. The new receipt must increment the attempt number.
6. If recovery needs a different agent, constrain the wave to a compatible fleet subset or hand off with a complete context note.
7. Report the cause, the preserved evidence, the recovery action, and any remaining risk.

Do not delete audit history, falsify a success outcome, or force work past a dependency or approval gate.
