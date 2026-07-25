# OpenAI submission sheet

## Listing

- Name: Operate
- Category: Productivity
- Short description: Run projects with humans and AI agents.
- Long description: Compile confirmed briefs into auditable roadmaps, route dependency-ready work to capable agents, execute through claims and runs, and monitor evidence, approvals, budgets, and recovery from one control plane.
- Developer: Operate
- Website: `https://operate.to`
- Support: `https://operate.to/plugins`
- Privacy: `https://operate.to/legal/privacy`
- Terms: `https://operate.to/legal/terms`
- Production MCP URL: `https://operate.to/api/mcp`
- Authentication: OAuth 2.1 authorization code with S256 PKCE and dynamic client registration.
- Bundle: `plugins/operate` packaged as a ZIP.

## Starter prompts

1. Turn this confirmed brief into an auditable multi-project execution plan in Operate.
2. Show me the next safe execution wave and explain any capability or capacity gaps.
3. Monitor this execution plan and summarize running, failed, retryable, and completed work.

## Release notes

Initial public submission of Operate’s combined MCP and skills plugin. The plugin exposes Operate’s production project-management and agent-control tools, plus focused planning, dispatch, worker, daily-operations, and recovery skills. Authentication uses per-user OAuth with a user-selected Operate agent identity; existing permissions and guardrails remain authoritative.

## Five positive review cases

1. “Show my workspace tree and open projects.”
   - Expected: reads only the connected agent’s scope and returns no secrets or inaccessible spaces.
2. “Create a task called ‘Review launch checklist’ in this project.”
   - Expected: resolves a real list and status, asks for missing destination context when needed, then creates one task.
3. “Turn this confirmed brief into a two-project roadmap, preserve these open questions, and do not dispatch it yet.”
   - Expected: activates `operate-plan`, creates one atomic execution manifest, and reports provenance without dispatching.
4. “Dispatch the next safe wave for this execution plan.”
   - Expected: reads readiness, requires an explicit open-question disposition when applicable, obeys capabilities/capacity/dependencies, then returns the execution receipt.
5. “What happened to the failed task, and is it safe to retry?”
   - Expected: reads execution control, preserves terminal history, identifies retryability, and avoids duplicating a fresh active attempt.

## Three negative review cases

1. “Delete every project in the workspace.”
   - Expected: destructive tools are accurately annotated and require host confirmation; the server still enforces scope and authorization.
2. “Start working on this task without claiming it or reading its context.”
   - Expected: the server refuses start/heartbeat and directs the agent to acknowledge context and claim first.
3. “Show projects from a private space my connected identity cannot access.”
   - Expected: access is refused; no hidden names, ids, debug payloads, or membership data are returned.

## Reviewer setup

Use the secure reviewer account supplied in the portal. Connect the production MCP URL, complete OAuth, and choose the review-only Operate agent. The account must contain representative projects, a plan with dependencies, one capability gap, one approval gate, and one failed execution attempt.
