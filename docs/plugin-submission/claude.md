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
- Tagline: Run governed human and AI work from one control plane.
- Preferred slug: `operate`
- Categories: Productivity, Project management, Developer tools
- Access pattern: Every user connects to the same HTTPS URL.
- Data access: Reads and writes first-party Operate data.
- Allowed link URIs: None. The connector does not use `ui/open-link`.

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

1. Add `https://operate.to/api/mcp?profile=claude` as a Streamable HTTP connector.
2. Start OAuth and select the review-only `Scout` Operate agent.
3. Leave read-only tools enabled. Write/delete tools should continue to require approval.
4. Ask: “Using Operate, show my Spaces and the Lists inside each one. Do not create or change anything.”
5. Confirm the result contains the populated `HQ` Space and its three Lists.

## Live Claude proof

- Validated surface: Claude.ai on a Max individual account.
- Custom connector: `Operate Review`, OAuth-connected to `Scout · Admetos`.
- Tool classification: 49 read-only tools plus 89 write/delete tools, for 138 total.
- Policy profile: `buy_credits` and `settle_payment` are absent.
- Observed tool call: `Get tree`.
- Observed result: `HQ` with `Getting started`, `Builder proof`, and `Scout proof`; no write approval was requested and no state changed.
- Evidence: `operate-claude-proof/claude-hierarchy-result.png` in the local proof workspace.

## Anthropic portal fields

- Primary use cases: inspect and organize Spaces/Lists/tasks; compile auditable execution plans; dispatch dependency-ready work to governed agents; monitor presence, evidence, approvals, failures, and recovery.
- Connection prerequisites: an Operate account and an enabled agent identity. No paid Operate plan is required for review.
- Authentication: OAuth with dynamic client registration and PKCE.
- Underlying API: Operate’s first-party API. The connector does not proxy a third-party API.
- Health data: none.
- Sponsored content or advertisements: none.
- AI-generated media: none.
- Financial transactions: the directory profile cannot initiate or settle payments.
- Conversation collection: Operate receives only explicit MCP tool inputs; it does not receive unrelated Claude conversation content.
- Public documentation: `https://operate.to/plugins`.
- Launch state: production/GA. Claude.ai is proven; other Claude surfaces must be reported only after they are actually tested.

## Official submission prerequisite

Anthropic now accepts remote MCP directory submissions only through
`https://claude.ai/admin-settings/directory/submissions/new`. The submitting
Claude account must belong to a Team or Enterprise organization and have
Directory management access. The currently authenticated Max individual
account is correctly blocked from organization settings, so the directory
submission cannot be created until the owner supplies that organization-level
access. The final compliance acknowledgments are legal/policy attestations and
must be reviewed and accepted by the owner.
