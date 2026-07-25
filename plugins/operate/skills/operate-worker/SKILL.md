---
name: operate-worker
description: Execute an assigned Operate task safely from context acknowledgement through claim, run, heartbeat, evidence, approval, and completion.
---

Use this skill when acting as the agent that will perform an Operate task.

1. Call `whoami`, `next_task`, then `get_task`.
2. Read every attached context packet. Call `acknowledge_task_context` with every exact packet id and current version.
3. Read every operating decision returned by `get_task` or `list_decisions_for_task`, including its rationale and superseded versions. Clear each pending impact with `assess_decision_impact`: use `no_change` only when the task already conforms; otherwise record `rework_required`, make the change, and mark it `resolved`.
4. Call `claim_task`. Do not begin if another actor holds a fresh claim.
5. Call `start_run` with a concrete title. Only one active run may exist for the same agent and task.
6. Heartbeat every few minutes with the task id and an honest, short status. Add comments for material progress and blockers. Use `create_decision` or `supersede_decision` for operating-policy changes so affected tasks are revalidated.
7. Before claiming success, validate the checklist, dependency state, current context versions, and decision impacts. Call `finish_run` once with a summary, HTTP(S) evidence links, and real token/cost values when known.
8. If approval is required, call `request_approval` and wait for approval. Otherwise call `complete_task`.
9. If blocked beyond recovery, finish the run as failed or abandoned, or call `report_error`; do not go silent. A failed attempt releases the claim for safe retry.

Never invent evidence, costs, completed checklist items, approvals, or context acknowledgements.
