# Operate completion audit

Updated: 2026-07-25

This is the source of truth for the continuing product-build loop. A passing
unit test is evidence, not proof of end-to-end completion. Mark an item proven
only after automated checks and relevant production behavior both pass.

## Proven

- Production application and Convex dependency health (`/api/health`)
- Hosted MCP authentication and discovery (140 tools)
- Production OAuth authorization-code lifecycle: dynamic client registration
  rejected an unsafe external HTTP redirect and accepted an exact loopback
  redirect; authenticated consent bound the connection to Scout; invalid PKCE
  and authorization-code replay returned `invalid_grant`; valid exchange and
  refresh each exposed all 140 MCP tools; refresh rotation invalidated the old
  access and refresh tokens; revocation returned 401 on reuse; and a new
  authorization completed the reconnect path before final revocation.
  Deployment `dpl_2GnQEaxqjKdhma4vEVwvPEGqMnLo` fixed stale server-rendered
  redirect parameters by validating the live consent URL. The temporary client,
  codes, revoked token rows, and least-privilege deploy key were removed.
- Production webhook lifecycle: an agent registered an exact event-filtered
  HTTPS endpoint, unsafe HTTP/private/internal destinations were rejected, and
  the first `task.created` event arrived with a verified HMAC-SHA256 signature.
  Ten deliberately failing events each followed the 30-second, 2-minute, and
  10-minute retry schedule (four correctly signed attempts on the same delivery
  ID), then disabled the subscription at exactly ten failed delivery chains.
  After the receiver recovered, the signed-in Webhooks UI reset the integration,
  its failure count returned to zero, and a new event succeeded on attempt one.
  Duplicate completion callbacks are now idempotent, and the UI exposes queued,
  retrying, delivered, failed, and auto-disabled states. All 12 disposable
  tasks, 24 certification events, the subscription/deliveries, receiver, and
  temporary deploy key were removed.
- OpenAI and Claude MCP annotation profiles
- Workspace → Space → optional Folder → List → Task hierarchy
- One user-facing hierarchy: Workspace → Space → optional Folder → List →
  Task. There is no separate Project entity; legacy project-capable metadata
  remains attached to Lists without introducing a competing navigation layer.
- Workspace selector, Spaces tree, and personal-space labels identify their
  levels explicitly; the legacy `/dashboard/projects` URL redirects to Spaces
- Templates identify whether they create a List, Task, Doc, Whiteboard, or
  saved View and choose the matching destination level (Space/Folder or List)
- Template Center and per-Space template entry point
- Authenticated production hierarchy certification on desktop and a 390×844
  mobile viewport: the Spaces directory explains
  `Workspace → Space → Folder (optional) → List → Task`; the HQ Space exposes
  Lists, optional Folders, Docs, and Whiteboards; the Builder proof List
  remains usable without document-level horizontal overflow; List templates
  offer Space/Folder destinations; and Task templates offer Lists with their
  parent Space shown. All four audited mobile surfaces matched the 390px
  viewport with no document-level horizontal overflow.
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
- Real production clock materialization: an hourly definition created at
  14:59:50 UTC became due at 15:00 and the live 15-minute Convex cron created
  its scheduler-authored task at 15:14:53. The schedule, task, and one-use
  verification credentials were removed after readback (zero artifacts).
- Production schedule failure recovery and escalation: a deliberately invalid
  hourly definition failed on three separate 15-minute production ticks at
  16:15, 16:30, and 16:45 UTC. It stayed active through failures 1 and 2,
  auto-paused at failure 3, emitted `schedule.auto_paused`, and created one
  unread owner Inbox escalation. No task was created. The disposable schedule
  was deleted after readback and the List returned to zero schedules.
- Schedule escalation notifications now replace backend diagnostics with
  actionable product language before entering the Inbox. The production
  Convex deployment accepted the function push and schema validation; the
  least-privilege temporary deploy key was deleted immediately afterward and
  returned 401 on reuse.
- Historical schedule alerts are also sanitized at the Inbox display boundary,
  so diagnostics retained in the audit record never leak into user-facing
  copy. Production deployment `dpl_14X29S26gsDPA9sbzYs2sRdMqqrw` was Ready,
  application health was `ok`, MCP discovery returned 140 tools, and the
  existing certification alert rendered actionable assignee-access guidance
  with no raw Convex error or stack trace.
- Authenticated production browser certification for onboarding, Inbox, and
  task detail: onboarding validation and Enter-key progression reached the
  final creation step without persisting preview data; “Set up later” returned
  safely to the dashboard; the Inbox rendered the sanitized recurring alert;
  and the full Builder proof task detail remained usable on desktop and at
  390×844 with no document-level horizontal overflow.
- Seven curl-installable skills with retries and SHA-256 verification
- Completed agent work clears its matching current-task and activity text,
  preventing stale “Now” presence after success
- Local production build, typecheck, lint, plugin validation, and 331 tests
- Disposable production MCP mutation certification: List create/rename/metadata,
  two-task parent/dependency batch, task update/checklist, comment
  create/update/delete, schedule create/pause/resume/delete, readback/event
  verification, task deletion, and List deletion (21 operations; zero
  certification artifacts remained)

## Built but not yet proven end to end

- Production ChatGPT app submission bundle
- Production Claude connector/plugin bundle
- x402 metering and billing lifecycle

## Still required

1. Complete billing production certification.
2. Continue the systematic browser pass over home, the remaining List views,
   sprints, roadmaps, operations, agents, search, settings, broader keyboard
   navigation, and failure states. Onboarding, Inbox, task detail, the core
   Spaces/List hierarchy, template destinations, and their mobile responsive
   layouts are certified above.
3. Prove the new independent GitHub uptime monitor in production. It checks
   application and Convex health every 15 minutes, opens one deduplicated
   operator incident while unhealthy, comments on continued failures, and
   closes the incident after recovery.
4. Run security review: exposed-key rotation, authorization matrix, rate limits,
   SSRF/webhook boundaries, OAuth redirect validation, secret handling, and
   dependency scan.
5. Run load/performance, backup/restore, data-retention, and disaster-recovery
   exercises.
6. Upload the ChatGPT and Claude bundles for official review and address reviewer
   feedback. Platform approval itself is external and cannot be proven locally.

## Active production certifications

- Public connector submission compliance (production-validated 2026-07-25):
  deployment `dpl_w3dL5pw14yVUGJiJeTEy8qSngXeq` is Ready and healthy. The
  authenticated OpenAI profile exposes all 140 tools; Anthropic's directory
  profile exposes 138, omitting only `buy_credits` and `settle_payment` to
  comply with its prohibition on software that initiates or executes financial
  transactions. Claude retains `get_wallet` with read-only, profile-specific
  wording. Both profiles passed live initialization, discovery, annotation,
  structured-output, identity, hierarchy, and seven-resource smoke checks.
  The public Plugins page rendered the production connection and curl install
  paths cleanly in Chrome with no console errors; Vercel had no runtime errors.
  Typecheck, lint, plugin validation, and all 331 tests pass. Official portal
  upload, reviewer-account proof, and platform review remain open.
- x402 billing truthfulness audit (validated 2026-07-25): the production MCP
  host exposes `get_wallet`, `buy_credits`, and `settle_payment`; wallet reads,
  positive-integer input validation, unauthenticated rejection, and
  fail-closed settlement were exercised live. The audit found that production
  has neither a real facilitator nor a receiving wallet configured, even
  though the old challenge/UI labeled the fallback as `mock` and exposed the
  zero address. The current batch makes readiness explicit, suppresses
  impossible challenges with HTTP 503, prevents metering activation, and
  labels the Billing/admin surfaces as setup-incomplete. Full
  pay→settle→credit→meter→deplete→top-up→resume certification remains open
  until a real receiving wallet and facilitator credentials are configured.
- Dependency security remediation (validated locally 2026-07-25): upgraded
  Next within v15 to 15.5.21, Convex within v1 to 1.42.3, and Clerk within v6
  to 6.39.6. The production-only audit dropped from 17 findings
  (11 high, 1 critical) to 15 (8 high, 1 critical), eliminating the vulnerable
  Convex/WebSocket and Clerk/js-cookie chains. Typecheck, lint, 320 tests, and
  the production build pass. Remaining findings require individual
  runtime/exposure review or major-version changes; do not mark the security
  gate proven from dependency counts alone.

## Deployment policy

- Batch validated changes into one intentional production build.
- Never deploy a dirty tree or failing checks.
- After deployment, verify `/api/health`, hosted MCP discovery, relevant Chrome
  flows, and Vercel error logs.
- Do not mark the product goal complete while any required item above remains.
