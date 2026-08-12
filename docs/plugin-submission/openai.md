# Operate public plugin submission packet

Last verified against first-party OpenAI documentation: **August 12, 2026**.

This is the source-of-truth packet for the public **Operate** plugin. It targets
the universal Plugins Directory shared by ChatGPT and Codex. It is not a custom
GPT, local MCP entry, personal marketplace, or one-user connector.

## Submission target

| Portal field | Copy/paste value |
| --- | --- |
| Portal | `https://platform.openai.com/plugins` |
| Plugin type | `With MCP` |
| MCP endpoint type | `Universal` |
| Production MCP URL | `https://operate.to/api/mcp?profile=chatgpt` |
| Canonical OAuth resource | `https://operate.to/api/mcp` |
| Authentication | `OAuth 2.1 authorization code with S256 PKCE, dynamic client registration, exact resource binding, rotating refresh tokens, revocation, OpenID discovery, and verified-email UserInfo.` |
| Package directory | `plugins/operate` |
| Upload artifact | `artifacts/operate-plugin-1.22.0.zip` |
| SHA-256 | `1c645aba54d63e4f2f75d3db782884b6f75bd1eb71028da2b1b4eac1802468f7` |
| Compressed size | `11,459 bytes` |
| Generated tool metadata | `chatgpt-app-submission.json` |

The submitter needs Apps Management **Write** permission (`api.apps.write`), a
verified publisher identity, and a global-residency OpenAI Platform project.
Those are organization controls and cannot be created safely from this repo.

## Listing fields

| Field | Copy/paste value |
| --- | --- |
| Name | `Operate` |
| Developer | `Operate` |
| Category | `Productivity` |
| Short description | `Run work with AI agents.` |
| Website | `https://operate.to` |
| Support | `https://operate.to/plugins` |
| Privacy policy | `https://operate.to/legal/privacy` |
| Terms of service | `https://operate.to/legal/terms` |
| Support email | `support@operate.to` |
| Brand color | `#7C6FF7` |
| Listing logo | `plugins/operate/assets/icon.svg` |
| Composer icon | `plugins/operate/assets/icon.svg` |
| Primary language | `English (United States)` |

The support destination is supplied both in the public-directory listing and
as `interface.supportURL` in the package manifest, matching the current public
submission contract.

### Long description

> Operate gives humans and AI agents one governed control plane for work. Use
> it to organize Workspace → Space → Project → List → Task hierarchies; turn
> confirmed briefs into auditable execution plans; propagate source revisions
> without drift; dispatch dependency-ready work to capable agents; coordinate
> Chat rooms; and monitor presence, evidence, approvals, budgets, failures,
> recovery, and independent outcome verification. Every action remains bounded
> by the selected Operate agent's server-enforced scope, role, list restrictions,
> budgets, approval gates, and stop controls.

### Starter prompts

1. `Turn this confirmed brief into an auditable multi-workstream execution plan inside one Space.`
2. `Show me the next safe execution wave and explain any capability or capacity gaps.`
3. `Verify this plan's original success criteria with independent evidence review.`

### Release notes

> Initial public submission of Operate's combined MCP and skills plugin. The
> public profile exposes 184 production-backed tools across work hierarchy,
> planning, tasks, roadmaps, sprints, documents, Chat, governed agent dispatch,
> evidence, assurance, and recovery. It excludes payment actions and deprecated
> Folder aliases. This release adds owner-bound workspace-agent consent,
> resource-bound OAuth tokens, OpenID discovery, verified-email UserInfo,
> rotating refresh tokens, per-tool security metadata, explicit safety
> annotations, structured results, and a drift-checked submission catalog.

## Reviewer notes

> Operate is a first-party work operating system, not a pass-through to ClickUp
> or another third-party API. Every user connects the same production endpoint
> once through OAuth. During consent, the user chooses an active Operate agent.
> Personal agents are selectable only by their owner. Because a workspace agent
> can see its entire workspace, only the workspace owner may authorize that
> principal. Tokens are bound to the canonical MCP resource and revalidated on
> every request for expiration, revocation, scope, owner membership, active
> agent status, role, and runtime guardrails. The public profile cannot initiate
> or settle payments. Reviewer credentials are supplied only in the secure
> portal field and are not included in the package or repository.

## Data and privacy copy

### Data accessed

> Only data inside the selected Operate agent's server-enforced boundary:
> workspaces, Spaces, Projects, Lists, tasks, comments, pages, docs, sprints,
> roadmaps, goals, custom fields, agent records, execution plans, runs, evidence,
> decisions, and accessible Chat rooms. Tool parameters determine the specific
> records read or changed. The public profile excludes payment initiation and
> settlement.

### Identity data

> When the user grants `openid` and `email`, Operate's UserInfo endpoint returns
> the consenting account's stable subject, primary email, and
> `email_verified: true` only when Clerk has actually verified that primary
> address. ChatGPT uses this for Enterprise workspace-domain restrictions.

### Storage and credentials

> Operate stores dynamically registered client metadata, consented scopes, the
> selected agent id, and one canonical resource audience. Authorization codes
> expire after 10 minutes, access tokens after one hour, and refresh
> authorization after 30 days. Access, refresh, API-key, and authorization-code
> credentials are stored only as SHA-256 hashes. Reviewer passwords and OpenAI
> portal tokens are never stored in the repository.

### Sharing and training

> Operate returns only explicitly requested tool results and verified identity
> claims to the MCP host the user connected. It does not receive unrelated
> ChatGPT or Codex conversation content. Operate does not sell personal data and
> does not permit customer content to be used to train third-party foundation
> models. Full terms are published at the privacy and terms URLs above.

### Security controls

- Authorization code with S256 PKCE; no implicit grant.
- Exact registered redirect-URI match.
- Canonical RFC 8707 `resource` carried through authorization, code exchange,
  refresh, token storage, and MCP authentication.
- One-hour access tokens, rotated 30-day refresh credentials, and revocation.
- OpenID discovery plus verified-email UserInfo for domain restrictions.
- Owner-only authorization for workspace-wide agents; personal-owner binding
  for personal agents.
- Per-request agent status, membership, scope, role, budget, approval, action
  limit, and stop-control enforcement.
- Fixed-window limits on unauthenticated dynamic client registration.
- Explicit `readOnlyHint`, `destructiveHint`, `openWorldHint`, and OAuth security
  metadata on every public tool.
- Public profile excludes `buy_credits`, `settle_payment`, and deprecated Folder
  aliases.

## Five positive review cases

### 1. Inspect the hierarchy

- Prompt: `Using Operate, show my Spaces, their Projects, and the Lists inside each Project. Do not create or change anything.`
- Expected tools: `get_tree`
- Expected result: returns only the selected agent's accessible hierarchy and
  explicitly reports that no state changed.

### 2. Create one task

- Prompt: `Create one task called “Review launch checklist” in the Launch Readiness List. Do not create duplicates.`
- Expected tools: `get_tree` or `search_tasks`, then `create_task`
- Expected result: resolves a real List, creates exactly one task, and confirms
  its id, title, status, and destination.

### 3. Build an auditable plan without dispatch

- Prompt: `Turn this confirmed launch brief into two workstreams in the Launch Space, preserve these open questions, and do not dispatch it.`
- Expected tools: `create_execution_plan`
- Expected result: atomically creates Projects, Lists, tasks, dependencies,
  provenance, assumptions, and pending authorization without starting work.

### 4. Dispatch the next safe wave

- Prompt: `Show readiness, explain all blockers, then dispatch only the next safe wave for this plan.`
- Expected tools: `get_execution_readiness`, `dispatch_execution_wave`
- Expected result: dispatches only dependency-ready work satisfying capability,
  capacity, policy, open-question, and approval constraints.

### 5. Recover a failed attempt

- Prompt: `Explain why the last attempt failed and retry it only if there is no live attempt and the task is currently retryable.`
- Expected tools: `list_runs`, `get_run`, `get_execution_control`, and when safe
  `reconcile_execution_plan`
- Expected result: preserves terminal history and evidence, does not duplicate a
  live attempt, and records a new numbered attempt only when safe.

## Three negative review cases

### 1. Unrelated calendar request

- Prompt: `What meetings do I have tomorrow?`
- Expected: Operate is not invoked; personal calendar retrieval is outside its
  supported workflows.

### 2. General web research

- Prompt: `Find today's top artificial-intelligence news.`
- Expected: Operate is not invoked; general internet search is outside its
  supported workflows.

### 3. Unauthorized private data

- Prompt: `Show private Space data my connected Operate identity cannot access.`
- Expected: access is refused without leaking hidden titles, ids, debug payloads,
  membership data, or existence signals.

## Reviewer account setup

Create a dedicated production reviewer account with:

- no MFA, email OTP on every login, SMS challenge, or expiring magic link;
- a verified primary email;
- one review-only personal agent and, if workspace-wide behavior is reviewed,
  a workspace-owner account with one review-only workspace agent;
- representative Spaces, Projects, Lists, and tasks;
- one execution plan with dependencies and a context revision;
- one capability gap, one approval gate, and one safely failed attempt;
- no real customer data, secrets, payment credentials, or destructive automation.

Enter the username and password only in OpenAI's secure reviewer-credentials
field. Keep the account active and unchanged for the entire review window.

## Screenshot and video checklist

Capture clean production images with no browser extensions, unrelated tabs,
personal data, secrets, or debug overlays:

1. Square listing icon from `plugins/operate/assets/icon.svg`.
2. OAuth consent screen showing client, scopes, and review-only agent selector.
3. ChatGPT/Codex connected-plugin state after one-time OAuth.
4. Read-only hierarchy result for positive case 1.
5. Execution-readiness result showing a real blocked and safe work item.
6. Evidence/assurance result showing criterion-level verification.

Existing reviewer video:
`https://operate.to/review/operate-chatgpt-review-demo.mp4` (28 seconds,
1920×1080, H.264). Re-record it after the OAuth changes are deployed; do not
submit the old recording as current proof until that live rerun passes.

## Domain verification

1. Start the plugin submission so OpenAI generates the domain challenge token.
2. Set the production `OPENAI_APPS_CHALLENGE` environment value to the exact
   token without quotes or whitespace.
3. Redeploy.
4. Verify the exact plaintext response at
   `https://operate.to/.well-known/openai-apps-challenge`.
5. Complete verification in the portal.
6. Keep the route deployed while the plugin remains listed.

## Upload and submission steps

1. Merge and deploy the reviewed commit to production.
2. Run the validation commands below against the exact commit.
3. Exercise the live OAuth authorization, UserInfo, refresh, revocation, and MCP
   `tools/list` path with the reviewer account.
4. Confirm the live ChatGPT profile exposes exactly 184 tools and excludes
   payments and deprecated aliases.
5. Regenerate the deterministic package and checksum.
6. Sign in to `https://platform.openai.com/plugins` with the verified publisher.
7. Choose **Create plugin → With MCP → Universal**.
8. Enter the production MCP URL and complete OAuth discovery.
9. Upload/import the `plugins/operate` package and the generated tool metadata
   where requested.
10. Paste the listing, reviewer, privacy, security, release-note, and test-case
    text from this packet.
11. Upload current screenshots/video and enter secure reviewer credentials.
12. Select only countries where Operate's owner has approved distribution.
13. Complete domain verification.
14. Have the owner or counsel review and accept every legal/policy attestation.
15. Submit for review. Publishing is a separate manual action after approval.

## Validation commands

```bash
npm ci
npm run typecheck
npm run check:submission
npx vitest run tests/oauth.test.ts tests/oauth-discovery.test.ts \
  tests/mcp-contract.test.ts tests/plugin-submission.test.ts
npm test
npm run build
```

Inspect the package after it is produced:

```bash
unzip -l artifacts/operate-plugin-1.22.0.zip
shasum -a 256 artifacts/operate-plugin-1.22.0.zip
(cd artifacts && shasum -a 256 -c operate-plugin-1.22.0.zip.sha256)
```

## Human authority checklist

The repository work cannot truthfully complete these owner-controlled items:

- [ ] Merge and production deployment are approved.
- [ ] Publisher identity is verified.
- [ ] Submitter has Apps Management Write permission.
- [ ] Production project uses global residency.
- [ ] Reviewer account credentials are created and entered securely.
- [ ] Current screenshots and video are captured after deployment.
- [ ] OpenAI domain challenge token is issued and deployed.
- [ ] Distribution countries are selected by the owner.
- [ ] Privacy policy, terms, and all attestations are reviewed by counsel/owner.
- [ ] Final submission and later publication are explicitly approved.

## Official references

- [Build plugins](https://developers.openai.com/plugins/build/plugins)
- [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [Authentication and workspace-domain restrictions](https://developers.openai.com/plugins/build/auth)
- [Submit a plugin](https://developers.openai.com/plugins/deploy/submission)
- [App review requirements](https://developers.openai.com/plugins/deploy/app-review)
- [Submission errors](https://developers.openai.com/plugins/deploy/submission-errors)
