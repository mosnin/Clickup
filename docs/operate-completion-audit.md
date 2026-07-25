# Operate completion audit

Updated: 2026-07-25

This is the source of truth for the continuing product-build loop. A passing
unit test is evidence, not proof of end-to-end completion. Mark an item proven
only after automated checks and relevant production behavior both pass.

## Proven

- Production application and Convex dependency health (`/api/health`)
- Independent production uptime monitoring is active on GitHub's restored
  `main` default branch. A live run passed application and Convex health;
  isolated certification run `30173632944` opened exactly one incident
  (issue #46), repeat run `30173647295` commented on the same issue, and
  recovery run `30173659698` closed it. No production outage was induced and
  no production uptime incident remains open. Automation/documentation-only
  commits now skip the Vercel build rather than consuming a production build.
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
- Offline and paused agents label retained activity as `Last status`, never
  `Now`, on both Agents HQ and the agent detail page.
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
- The API key exposed during development was matched to Jimmy by its stored
  prefix in the authenticated Agents HQ, revoked without deleting the agent or
  its separate unused key, and rejected on the next live MCP discovery request
  with `401 invalid_token` plus OAuth protected-resource metadata.
- Completed agent work clears its matching current-task and activity text,
  preventing stale “Now” presence after success
- Local production build, typecheck, lint, plugin validation, and 354 tests
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
3. Finish the security review: rotate any remaining credentials exposed during
   development, complete the human/agent authorization matrix and
   abuse-oriented rate-limit tests, review remaining secret-handling paths,
   and disposition the seven upstream/unpatched production dependency
   advisories. The shared agent API key, OAuth redirects, MCP
   authentication/CORS, webhook egress, the agent write-rate limit, and the
   fixable dependency set are certified below.
4. Run load/performance, backup/restore, data-retention, and disaster-recovery
   exercises.
5. Upload the ChatGPT and Claude bundles for official review and address reviewer
   feedback. Platform approval itself is external and cannot be proven locally.

## Active production certifications

- Independent uptime monitor (production-proven 2026-07-25): repository default
  branch was restored from a stale Claude documentation branch to production
  `main`, allowing the scheduled workflow to register. Live run `30173623901`
  passed against `https://www.operate.to/api/health`. Safe failure certification
  opened one deduplicated issue, a repeat added one continued-failure comment,
  and recovery added its proof comment and closed the same issue. The production
  incident query returned zero open issues. Commit `c9ef672` passed 331 tests,
  typecheck, application lint, Actionlint, and the production CI build; Vercel
  correctly canceled the non-runtime deployment after the ignore-build check.
- Security boundary batch (production-validated 2026-07-25): outbound webhook
  delivery now re-resolves every destination immediately before each attempt,
  rejects any private/reserved DNS answer, rejects credentials and non-HTTPS
  URLs, and refuses redirects so registration-time validation cannot be
  bypassed through DNS rebinding or a public redirector. Twenty-three focused
  network-boundary cases pass alongside the existing webhook lifecycle tests.
  Production deployment `dpl_DuY7p6YuJKmX59MfQiii3uSTp9oY` is Ready at commit
  `80fd5e9`; application and Convex health are `ok`, GitHub CI passed the full
  build, and Vercel has no runtime error logs. Live boundary probes returned
  401 plus OAuth resource metadata for unauthenticated MCP access, rejected a
  metadata-service OAuth redirect as `invalid_redirect_uri`, allowed CORS for
  ChatGPT, and emitted no CORS grant for an arbitrary origin. Safe dependency
  overrides and correct build-tool classification reduced the production audit
  from 15 findings (8 high, 1 critical) to 7 (3 high, 0 critical), with 354
  tests, typecheck, lint, and the production build passing. The remaining
  advisories are upstream/unpatched Next image/CSS chains and an MCP SDK
  Windows-only static-file adapter path not used by the Linux Vercel handler;
  they remain tracked rather than force-upgraded across incompatible majors.
- Credential rotation (production-validated 2026-07-25): the agent API key
  shared during development was still active and resolved to Jimmy. The
  authenticated Agents HQ exposed two distinct keys for that principal, so the
  matching key alone was revoked after its undo window while the agent and its
  separate unused key were preserved. The row changed to `revoked`, and an
  immediate live `tools/list` replay returned `401 invalid_token` with the
  correct OAuth protected-resource challenge. Production application and
  Convex health remained `ok`, and the one-hour production error-log scan was
  empty.
- Agent status recency (production-validated 2026-07-25): after Jimmy's
  revoked connection passed the five-minute online window, the live fleet
  count moved to `0 online`, Jimmy moved to `Seen 19m ago`, and both Agents HQ
  and Jimmy's detail page rendered the retained QA activity as `Last status`
  instead of the misleading `Now`. Paused and offline peers followed the same
  wording. Deployment `dpl_H1BSRhFJrNMZnpTCahCmjZiToRs1` is Ready at commit
  `e39ad6a`; application and Convex health are `ok`, the production error-log
  scan is empty, GitHub CI run `30174947566` passed, and 354 tests, typecheck,
  lint, and the production build pass.
- Public connector submission compliance (production-validated 2026-07-25):
  deployment `dpl_w3dL5pw14yVUGJiJeTEy8qSngXeq` is Ready and healthy. The
  authenticated base profile exposes all 140 tools; Anthropic's directory
  profile exposes 138. Both passed live initialization, discovery, annotation,
  structured-output, identity, hierarchy, and seven-resource smoke checks. The
  public Plugins page rendered the production connection and curl install paths
  cleanly in Chrome with no console errors; Vercel had no runtime errors.
- Anthropic directory intake (production-validated 2026-07-25): the official
  submission portal now requires a Team or Enterprise Claude organization plus
  Directory management access; the authenticated Max individual account is
  correctly blocked from organization settings. Product readiness was proven
  independently in Claude.ai: `Operate Review` was added as a custom
  Streamable HTTP connector through the `profile=claude` endpoint,
  OAuth-connected to `Scout · Admetos`, and classified exactly 138 tools as 49
  read-only plus 89 write/delete. `buy_credits` and `settle_payment` were
  absent. Claude invoked `Get tree` and returned the live `HQ` Space with
  `Getting started`, `Builder proof`, and `Scout proof` without requesting a
  write approval or changing state. The current 11-step Anthropic portal
  dossier is complete in `docs/plugin-submission/claude.md`; official directory
  submission remains externally blocked on organization-level access and the
  owner's final policy attestations. Production health still reports the
  application and Convex healthy, the current deployment has no error logs,
  and typecheck, lint, and all 331 tests pass after the certification.
- OpenAI official submission intake (active 2026-07-25): the production MCP
  endpoint was accepted in ChatGPT, OAuth-connected to Scout, and all 140 base
  actions were discovered. The official Platform review portal created the
  combined MCP-plus-skills Operate draft and accepted the generated app-info,
  5 positive tests, and 3 negative tests. The intake also established that
  OpenAI currently permits commerce tools only for physical goods, so the
  dedicated `profile=chatgpt` endpoint now exposes 138 tools, omitting
  `buy_credits` and `settle_payment` while preserving them for custom MCP
  runtimes. Production deployment `dpl_8JXQNzUZeCZhDg6Tuz6n7umCCF8x` is Ready;
  the base 140-tool, ChatGPT 138-tool, and Anthropic 138-tool profiles each
  passed authenticated initialization, discovery, annotation,
  structured-output, identity, hierarchy, and seven-resource smoke checks,
  with no Vercel errors. The review draft has a verified individual developer
  identity plus public website, support, privacy, and terms URLs. Typecheck,
  lint, plugin validation, and all 331 tests pass. A separate reviewer-facing
  ChatGPT developer app (`asdk_app_6a650f4bca2c81919ed6b0f0723594bd`) is
  OAuth-connected to Scout through the safe 138-tool profile. Its live
  read-only hierarchy prompt returned the production `HQ` Space with
  `Getting started`, `Builder proof`, and `Scout proof`, explicitly confirmed
  that no changes were made, and completed in 34 seconds. A truthful 28-second
  1920×1080 H.264 reviewer demo was generated as
  `operate-chatgpt-review-demo.mp4`. Production deployment
  `dpl_HvCCMK6mk3RW9ZgWVMAKjSXEaHhE` is Ready at commit `ee055aa`; the stable
  reviewer URL returns `200 video/mp4`, supports byte ranges, has the expected
  222,839-byte length and SHA-256
  `747f5f0484ecce5c037a7676ca361ef40e15002c91e4771a0fc01257313dc9c7`,
  and production health reports both the application and Convex healthy at
  that commit. The official OpenAI portal is now configured with the safe
  production URL and OAuth reviewer identity, scanned exactly 138 tools
  (`whoami` present; `buy_credits` and `settle_payment` absent), and accepted
  all 414 required safety-annotation explanations. Production redeployment
  `dpl_GQHRjBWA2EZ5tgoazxgFw6di6tLR` is Ready with the OpenAI challenge token;
  the well-known endpoint returns the exact token as `200 text/plain`, and the
  portal reports `Domain verified`. The public demo URL, three starter prompts,
  five positive tests, three negative tests, global availability, and release
  notes are saved. Uploading the seven skill bundles and prepared
  directory/composer PNGs is blocked until Chrome allows extension access to
  local file URLs. The owner must then review and accept OpenAI's legal/policy
  attestations before `Submit for Review`.
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
- Dependency security remediation (validated in production 2026-07-25): upgraded
  Next within v15 to 15.5.21, Convex within v1 to 1.42.3, and Clerk within v6
  to 6.39.6, then patched safe transitive dependencies and moved the Capacitor
  CLI and Serwist build integration out of the production runtime set. The
  production-only audit dropped from 17 findings (11 high, 1 critical) to 7
  (3 high, 0 critical), eliminating the vulnerable Convex/WebSocket,
  Clerk/js-cookie, archive, URI parser, multipart, Markdown/link parser, and
  brace-expansion runtime chains. Typecheck, lint, 354 tests, GitHub CI, the
  local production build, and deployment `dpl_DuY7p6YuJKmX59MfQiii3uSTp9oY`
  pass. Remaining findings require upstream releases or incompatible-major
  review; do not mark the full security gate proven from dependency counts
  alone.

## Deployment policy

- Batch validated changes into one intentional production build.
- Never deploy a dirty tree or failing checks.
- After deployment, verify `/api/health`, hosted MCP discovery, relevant Chrome
  flows, and Vercel error logs.
- Do not mark the product goal complete while any required item above remains.
