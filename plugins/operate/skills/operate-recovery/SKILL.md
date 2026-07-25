---
name: operate-recovery
description: Diagnose and recover stalled, failed, abandoned, or repeatedly dispatched Operate work without duplicating active execution or hiding the original evidence.
---

Use this skill when an execution plan is stuck, an agent disappeared, a run failed, or work needs reassignment.

1. Call `get_execution_control`, `get_execution_readiness`, `get_task`, and relevant recent events.
2. Identify the latest attempt and its exact state. A fresh dispatched, claimed, or running attempt is active; do not create a duplicate. The control ledger surfaces an active receipt as `stale` after 30 minutes without an execution heartbeat while retaining its `recordedStatus`.
3. Check `contextDrifted`, the dispatch and current context fingerprints, estimated token load, claim freshness, agent status, required capabilities, concurrency, dependencies, approval gates, and evidence/error fields. Context drift requires re-reading and acknowledgement; it does not by itself justify duplicating an active attempt.
4. Preserve the failed or abandoned receipt. Never rewrite a terminal outcome.
5. When the ledger reports stale work, call `reconcile_execution_plan`. Confirm its recovered-attempt and released-claim counts. Reconciliation is idempotent and keeps the timed-out attempt as an abandoned receipt with its timeout reason.
6. If the prior attempt is now retryable and the task is ready, dispatch a new wave with a new idempotency key. `dispatch_execution_wave` also reconciles stale receipts transactionally before routing. The new receipt must increment the attempt number.
7. If recovery needs a different agent, constrain the wave to a compatible fleet subset or hand off with a complete context note.
8. Report the cause, the preserved evidence, the recovery action, and any remaining risk.

Do not delete audit history, falsify a success outcome, or force work past a dependency or approval gate.
