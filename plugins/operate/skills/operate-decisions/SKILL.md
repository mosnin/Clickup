---
name: operate-decisions
description: Preserve and safely propagate operating-policy changes in Operate with immutable decision versions, rationale, linked context invalidation, and task-by-task impact review. Use when a requirement, strategy, constraint, architecture choice, launch plan, or other instruction changes after work has already been planned or started.
---

# Control decision changes in Operate

A changed instruction is a control-plane event, not a comment.

1. Identify the stable policy key. Reuse the same concise key across its lifetime, such as `launch.region`, `architecture.database`, or `pricing.billing-unit`.
2. Before changing anything, call `list_decisions_for_task` on affected work. Read the active wording, rationale, superseded versions, and current impact states.
3. For a genuinely new policy, call `create_decision` with:
   - the list and stable key;
   - an unambiguous statement of what is now true;
   - the real rationale and tradeoff;
   - every currently known affected task;
   - the governing context packet when one exists.
4. For a changed policy, call `supersede_decision`. Never edit history or create a second key to hide a reversal. Operate carries every task impacted by the prior version forward and marks it pending again.
5. Re-read linked context after the decision write. Linking a packet attaches it to affected tasks and increments its version, making old acknowledgements stale by design.
6. Assess each task independently with `assess_decision_impact`:
   - `no_change` only when the task already conforms;
   - `rework_required` with a concrete note naming what must change;
   - `resolved` only after that rework is actually reflected in the task or artifact.
7. Do not claim, start, heartbeat on, finish, or complete blocked work. Operate enforces this, but the correct behavior is to absorb the change before the refusal.
8. During handoff, report the active decision keys and versions used. If a decision changes mid-run, stop at a safe point, reassess, and update the run summary.

Never overwrite old rationale, mark `no_change` to bypass a gate, or bury a policy reversal in chat.

