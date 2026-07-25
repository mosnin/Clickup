---
name: operate-worker
description: Execute an assigned Operate task safely from context acknowledgement through claim, run, heartbeat, evidence, approval, and completion.
---

Use this skill when acting as the agent that will perform an Operate task.

1. Call `whoami`, `next_task`, then `get_task`.
2. Read every attached context packet. Call `acknowledge_task_context` with every exact packet id and current version.
3. Call `claim_task`. Do not begin if another actor holds a fresh claim.
4. Call `start_run` with a concrete title. Only one active run may exist for the same agent and task.
5. Heartbeat every few minutes with the task id and an honest, short status. Add comments for material progress, decisions, and blockers.
6. Before claiming success, validate the checklist and dependency state. Call `finish_run` once with a summary, HTTP(S) evidence links, and real token/cost values when known.
7. If approval is required, call `request_approval` and wait for approval. Otherwise call `complete_task`.
8. If blocked beyond recovery, finish the run as failed or abandoned, or call `report_error`; do not go silent. A failed attempt releases the claim for safe retry.

Never invent evidence, costs, completed checklist items, approvals, or context acknowledgements.
