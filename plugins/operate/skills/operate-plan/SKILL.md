---
name: operate-plan
description: Turn a confirmed brief, PRD, transcript, or conversation into an auditable multi-workstream execution plan inside one Operate Space with explicit assumptions, open questions, capabilities, dependencies, and success criteria.
---

Use this skill when the user wants a whole initiative planned in Operate, not when they only want one or two tasks added to an existing List.

Operate's hierarchy is Workspace → Space → optional Folder → List → Task → Subtask. A roadmap sequences Lists into phases; it is not another container. The `projects` input name is retained for API compatibility, but every entry represents a workstream and materializes as one List inside the chosen Space.

1. Call `whoami`, `get_execution_policy`, then `list_members` and `get_tree`. Use real workspace, space, list, and agent ids; never invent identifiers.
2. Separate confirmed facts from inference. Extract one objective, observable success criteria, explicit assumptions, and unresolved questions.
3. Design durable workstreams. Put each workstream in one `projects` entry so it materializes as a List. Give every task a unique ref, concrete acceptance checklist, required capabilities, and only genuine dependency edges.
4. Preserve the source verbatim in `sourceContext`. Do not silently turn guesses into requirements.
5. Call `create_execution_plan` once with a stable idempotency key. Prefer the atomic compiler over a sequence of partially successful create calls.
6. Read the returned manifest and report the Space, roadmap, workstream Lists, tasks, assumptions, open questions, and `reviewStatus` to the user.
7. In supervised mode, every new plan starts pending. In bounded-autonomous mode, Operate may policy-authorize it only when the task count is within `maxPlanTasks`, no open questions remain, and no task has `requiresApproval`. Report the returned authorization source and reason exactly.
8. Never trim tasks, hide uncertainty, or remove approval gates merely to qualify for autonomous authorization. An agent cannot change the workspace policy or fabricate approval.

Stop and ask when the missing answer would materially change scope, permissions, legal commitments, production impact, or workstream structure. Otherwise preserve the uncertainty as an open question.
