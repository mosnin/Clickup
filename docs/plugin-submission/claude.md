# Anthropic Connectors Directory submission sheet

## Connector

- Name: Operate
- Type: Remote MCP server
- Status: General availability
- Endpoint: `https://operate.to/api/mcp?profile=claude`
- Transport: Streamable HTTP
- Authentication: OAuth 2.1 authorization code with S256 PKCE, compatible with OAuth 2.0 clients.
- Documentation: `https://operate.to/plugins`
- Privacy policy: `https://operate.to/legal/privacy`
- Support: `https://operate.to/plugins` and `support@operate.to`

## Description

Operate is an autonomous-company control plane for humans and AI agents. Claude can work across Spaces, Lists, tasks, roadmaps, sprints, docs, goals, and custom fields; compile confirmed briefs into immutable execution plans; propagate confirmed context revisions across every workstream; dispatch dependency-ready work to capability-matched agents; and monitor live presence, claims, runs, evidence, failures, approvals, budgets, and recovery.

## Core capabilities

1. Space operations: inspect the Workspace → Space → optional Folder → List → Task hierarchy, search work, create and update tasks, and manage dependencies, sprints, milestones, docs, and roadmaps.
2. Agent coordination: claims, context acknowledgements, presence, handoffs, channels, approvals, budgets, and event-driven notifications.
3. Auditable orchestration: atomic execution plans, capability-aware waves, immutable attempt history, run evidence, and safe recovery.

## Required examples

### Compile an initiative

Prompt: “Turn this confirmed launch brief into an auditable roadmap inside the Launch Space. Keep unknown production-region details as open questions.”

Expected: Claude creates one atomic execution plan, preserves source and uncertainty, and returns the List/task graph without dispatching.

### Start safe parallel work

Prompt: “Dispatch the next safe wave for this plan, limited to the backend and QA agents.”

Expected: Claude checks dependencies, capabilities, concurrency, active assignments, and open-question disposition before releasing work.

### Recover a failure

Prompt: “The last implementation attempt failed. Explain why and retry only if no active attempt exists.”

Expected: Claude reads the execution ledger, preserves failure evidence, and creates a new numbered attempt only when the task is ready and retryable.

## Security annotations

Every advertised tool declares a human-readable title plus explicit `readOnlyHint`, `destructiveHint`, and `openWorldHint`. The Claude endpoint marks every state-changing tool destructive, as required by Anthropic’s directory policy. It deliberately omits `buy_credits` and `settle_payment` because the Software Directory Policy excludes connectors that initiate or execute cryptocurrency or financial transactions; `get_wallet` remains available for read-only billing visibility. External webhook registration is marked open-world. Server-side authorization, validation, budgets, approvals, and idempotency remain enforced independently of host hints.

## Reviewer setup

Use the secure review account supplied in the submission form. It must remain active throughout review, require no MFA/email/SMS challenge, and have representative sample data plus access to every submitted workflow. Credentials must never be committed to this repository.
