# Operate completion audit

Updated: 2026-07-25

This is the source of truth for the continuing product-build loop. A passing
unit test is evidence, not proof of end-to-end completion. Mark an item proven
only after automated checks and relevant production behavior both pass.

## Proven

- Production application and Convex dependency health (`/api/health`)
- Hosted MCP authentication and discovery (140 tools)
- OpenAI and Claude MCP annotation profiles
- Workspace → Space → optional Folder → List → Task hierarchy
- User-facing Projects → Spaces/Lists terminology correction
- Template Center and per-Space template entry point
- Truthful agent connection, heartbeat, recent, offline, and paused presence
- Durable signed assignment, mention, and execution wake delivery
- Polling wake inbox and authenticated consumption receipts
- Atomic execution-plan compilation with context provenance
- Context revision propagation, acknowledgement invalidation, and drift signals
- Supervised and bounded-autonomous execution policies
- Capability/capacity-aware dispatch and stale-attempt reconciliation
- Outcome evidence and independent assurance workflow
- Production multi-agent execution: the supervised `CERT Multi-agent
  2026-07-25T14-45-14-121Z` plan was human-authorized, dispatched to Scout and
  Cert Builder in one wave, consumed through durable wakes, executed as two
  separately claimed and heartbeating tasks, completed with outcome evidence,
  and independently verified in assurance. The verified roadmap and paused
  Cert Builder principal remain as audit evidence; all temporary certification
  credentials were revoked and returned 401 on reuse.
- Hourly through monthly recurring operations
- Reusable agent-authored SOP blueprints
- Isolated schedule failures, threshold auto-pause, and owner/admin escalation
- Seven curl-installable skills with retries and SHA-256 verification
- Completed agent work clears its matching current-task and activity text,
  preventing stale “Now” presence after success
- Local production build, typecheck, lint, plugin validation, and 320 tests
- Disposable production MCP mutation certification: List create/rename/metadata,
  two-task parent/dependency batch, task update/checklist, comment
  create/update/delete, schedule create/pause/resume/delete, readback/event
  verification, task deletion, and List deletion (21 operations; zero
  certification artifacts remained)

## Built but not yet proven end to end

- Production ChatGPT app submission bundle
- Production Claude connector/plugin bundle
- OAuth registration, authorization, refresh, revoke, and reconnect lifecycle
- Webhook delivery, signature verification, retry, disable, and recovery lifecycle
- x402 metering and billing lifecycle
- Recurring schedule materialization through a real production cron tick

## Still required

1. Prove production cron materialization and schedule failure recovery on the
   clock rather than only through tests.
2. Complete OAuth, webhook, and billing production certification.
3. Run a systematic browser pass over onboarding, home, inbox, Spaces, Lists,
   task detail, views, sprints, roadmaps, operations, agents, templates, search,
   settings, responsive layouts, keyboard navigation, and failure states.
4. Add external uptime/error alerting; the health endpoint and Vercel log scan
   exist, but no independent monitor currently pages an operator.
5. Run security review: exposed-key rotation, authorization matrix, rate limits,
   SSRF/webhook boundaries, OAuth redirect validation, secret handling, and
   dependency scan.
6. Run load/performance, backup/restore, data-retention, and disaster-recovery
   exercises.
7. Upload the ChatGPT and Claude bundles for official review and address reviewer
   feedback. Platform approval itself is external and cannot be proven locally.

## Deployment policy

- Batch validated changes into one intentional production build.
- Never deploy a dirty tree or failing checks.
- After deployment, verify `/api/health`, hosted MCP discovery, relevant Chrome
  flows, and Vercel error logs.
- Do not mark the product goal complete while any required item above remains.
