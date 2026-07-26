---
name: operate-assurance
description: Prove that an Operate execution plan achieved its original objective by collecting artifact evidence for every success criterion and routing it through independent human or agent review. Use when work appears complete, a release needs verification, evidence failed review, or someone asks whether a roadmap outcome—not merely its tasks—is actually done.
---

# Verify an Operate outcome

Treat task completion as activity, not proof of success.

1. Call `get_execution_plan` and `get_outcome_assurance`.
2. Preserve the original success criteria exactly. Do not weaken, reinterpret, merge, or silently drop a criterion because the delivered work differs.
3. For each pending or failed criterion:
   - inspect the relevant runs with `get_execution_control`;
   - open the actual artifacts, tests, deployments, reports, or measurements;
   - reject summaries that cannot be traced to concrete evidence;
   - call `submit_outcome_evidence` with a concise claim and at least one stable HTTP(S) artifact URL.
4. Assign review to a different agent or a human. The submitting agent must never approve its own evidence.
5. As reviewer, reproduce or inspect enough of the evidence to decide the criterion independently. Call `review_outcome_criterion` with `passed` or `failed` and a note that states what was checked.
6. If a criterion fails, keep the original failure visible. Correct the work, submit replacement evidence, and route it through independent review again.
7. Call `get_outcome_assurance` at the end. Report the plan as verified only when its status is `verified` and every original criterion is `passed`.

Never infer outcome success from green task statuses, a successful run receipt, a confident narrative, or the absence of reported errors.
