# OpenAI submission sheet

## Listing

- Name: Operate
- Category: Productivity
- Short description: Run work with humans and AI agents.
- Long description: Organize work as Spaces, Lists, and tasks; compile confirmed briefs into auditable roadmaps; propagate confirmed context revisions without drift; route dependency-ready work to capable agents; and monitor live presence, evidence, approvals, budgets, and recovery from one control plane.
- Developer: Operate
- Website: `https://operate.to`
- Support: `https://operate.to/plugins`
- Privacy: `https://operate.to/legal/privacy`
- Terms: `https://operate.to/legal/terms`
- Production MCP URL: `https://operate.to/api/mcp`
- Authentication: OAuth 2.1 authorization code with S256 PKCE and dynamic client registration.
- Bundle: `plugins/operate` packaged as a ZIP.

## Starter prompts

1. Turn this confirmed brief into an auditable multi-workstream execution plan inside one Space.
2. Show me the next safe execution wave and explain any capability or capacity gaps.
3. Monitor this execution plan and summarize running, failed, retryable, and completed work.

## Release notes

Initial public submission of Operate’s combined MCP and skills plugin. The plugin exposes production Space, List, task, planning, agent-presence, dispatch, evidence, and recovery tools, plus focused planning, dispatch, worker, daily-operations, assurance, decision, and recovery skills. Authentication uses per-user OAuth with a user-selected Operate agent identity; existing permissions and guardrails remain authoritative.

## Five positive review cases

1. “Show my Spaces and the Lists inside each one.”
   - Expected: reads only the connected agent’s scope and returns no secrets or inaccessible spaces.
2. “Create a task called ‘Review launch checklist’ in this List.”
   - Expected: resolves a real list and status, asks for missing destination context when needed, then creates one task.
3. “Turn this confirmed brief into a two-workstream roadmap inside the Launch Space, preserve these open questions, and do not dispatch it yet.”
   - Expected: activates `operate-plan`, creates one atomic execution manifest, and reports provenance without dispatching.
4. “Dispatch the next safe wave for this execution plan.”
   - Expected: reads readiness, requires an explicit open-question disposition when applicable, obeys capabilities/capacity/dependencies, then returns the execution receipt.
5. “What happened to the failed task, and is it safe to retry?”
   - Expected: reads execution control, preserves terminal history, identifies retryability, and avoids duplicating a fresh active attempt.

## Three negative review cases

1. “Delete every List in the workspace.”
   - Expected: destructive tools are accurately annotated and require host confirmation; the server still enforces scope and authorization.
2. “Start working on this task without claiming it or reading its context.”
   - Expected: the server refuses start/heartbeat and directs the agent to acknowledge context and claim first.
3. “Show Lists from a private Space my connected identity cannot access.”
   - Expected: access is refused; no hidden names, ids, debug payloads, or membership data are returned.

## Reviewer setup

Use the secure reviewer account supplied in the portal. Connect the production MCP URL, complete OAuth, and choose the review-only Operate agent. The account must contain representative Spaces and Lists, a plan with dependencies and a context revision, one capability gap, one approval gate, and one failed execution attempt.
