---
name: operate-daily-ops
description: Produce a concise daily operating brief from Operate covering completed work, active runs, overdue or blocked tasks, approvals, agent capacity, failures, and next actions.
---

Use this skill for a standup, operating review, morning brief, or executive workspace pulse.

1. Call `whoami`, `list_events` for the last 24 hours, `list_tasks`, and `list_members`.
2. For relevant active plans, call `get_execution_control`; use `get_execution_readiness` only when the user wants the next wave.
3. Summarize outcomes first: completed tasks and produced evidence.
4. Separate currently running work from merely dispatched or claimed work.
5. Call out overdue tasks, dependency blocks, approval waits, failed or abandoned attempts, capacity exhaustion, and capability gaps.
6. End with a short action register: owner or agent, next action, and due date only when the source provides one.

Keep the brief factual and compact. Do not treat activity volume as progress or infer completion from a heartbeat.

For a recurring autonomous operating loop, choose a controlled SOP from `list_blueprints`, then use `create_scheduled_task` with its `blueprintId`, an hourly, daily, weekly, or monthly cadence, and the responsible agent. Each materialized task inherits the blueprint's checklist, estimate, and approval gate and enters that agent's durable wake inbox; do not use a schedule as evidence that the work itself ran.
