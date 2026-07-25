---
name: operate-plan
description: Turn a confirmed brief, PRD, transcript, or conversation into an auditable multi-project execution plan in Operate with explicit assumptions, open questions, capabilities, dependencies, and success criteria.
---

Use this skill when the user wants a whole initiative planned in Operate, not when they only want one or two tasks added to an existing project.

1. Call `whoami`, then `list_members` and `get_tree`. Use real workspace, space, list, and agent ids; never invent identifiers.
2. Separate confirmed facts from inference. Extract one objective, observable success criteria, explicit assumptions, and unresolved questions.
3. Design projects around durable workstreams. Give every task a unique ref, concrete acceptance checklist, required capabilities, and only genuine dependency edges.
4. Preserve the source verbatim in `sourceContext`. Do not silently turn guesses into requirements.
5. Call `create_execution_plan` once with a stable idempotency key. Prefer the atomic compiler over a sequence of partially successful create calls.
6. Read the returned manifest and report the roadmap, projects, tasks, assumptions, open questions, and `reviewStatus` to the user.
7. Every new plan starts pending. Tell the user an Operate workspace owner or admin must review it in the roadmap before any dispatch. Never claim, infer, or fabricate that authorization yourself.

Stop and ask when the missing answer would materially change scope, permissions, legal commitments, production impact, or project structure. Otherwise preserve the uncertainty as an open question.
