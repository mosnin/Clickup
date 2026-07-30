# CLAUDE.md

Guidance for Claude Code (and other AI assistants) working in this repository.

## What this is

**operate.to** — a productivity app (ClickUp-style): tasks, docs, goals, chat — for individuals and teams. Each account has one **personal space** (private to the user) and zero or more **team workspaces** (shared with members). The current commit is a working scaffold with the marketing site, auth flow, onboarding, and dashboard shell wired up; most domain features (tasks, docs, etc.) are not yet implemented.

## Stack

| Layer        | Choice                                                      |
| ------------ | ----------------------------------------------------------- |
| Framework    | Next.js 15 (App Router, `src/` dir, TypeScript)             |
| Styling      | Tailwind v4 (CSS-based config in `src/app/globals.css`)     |
| Auth         | Clerk (`@clerk/nextjs`) — middleware-protected routes       |
| Backend      | Convex (`convex/` dir) — schema, queries, mutations, HTTP   |
| Auth bridge  | `convex/react-clerk` (`ConvexProviderWithClerk`)            |
| Email        | Resend (`src/lib/resend.ts`) — no flows wired yet           |
| Hosting      | Vercel (Next.js) + Convex's managed deployment              |
| PWA          | `manifest.webmanifest` + Serwist-generated service worker   |
| Native       | Capacitor wrapper (iOS + Android, remote-web-app pattern)   |

## Directory layout

```
.
├── convex/                       # Convex backend — typechecked separately by Convex CLI
│   ├── _generated/               # checked in (CLI overwrites on `convex dev`/`deploy`)
│   ├── _authz.ts                 # shared auth helpers (require*Access, requireMessageParentAccess, requireDocLikeParentAccess)
│   ├── _agentAuth.ts             # agent-side authz: API-key auth (pure-JS SHA-256), Actor type, require*ForAgent helpers
│   ├── _adminAuth.ts             # platform-admin authz: env-allowlist root of trust, requirePlatformAdmin, logAdminAction (audit)
│   ├── admin.ts                  # SOC2 admin console API: overview/users/workspaces/agents/audit/security/roster (all audited)
│   ├── schema.ts                 # users, workspaces, memberships, spaces, folders, lists, listStatuses, customFields, taskFieldValues, tasks, messages, mentions, docs, whiteboards, agents, agentKeys, events, webhookSubscriptions, webhookDeliveries, sprints, scheduledTasks, skills, platformAdmins, adminAuditLog, platformSettings, agentWallets, payments
│   ├── auth.config.ts            # Clerk JWT integration
│   ├── http.ts                   # Clerk webhook -> internal mutations
│   ├── sidebar.ts                # single tree query that powers the sidebar
│   ├── users.ts                  # webhook upsert/delete, ensureCurrent, current
│   ├── workspaces.ts             # create + listForCurrentUser + listMembers
│   ├── spaces.ts                 # personal/workspace space CRUD
│   ├── folders.ts                # folder CRUD inside a space
│   ├── lists.ts                  # list CRUD; seeds 4 default statuses on create
│   ├── listStatuses.ts           # per-list workflow stages with cascade-reassign delete
│   ├── customFields.ts           # per-list custom field definitions
│   ├── taskFieldValues.ts        # sparse value rows keyed by (task, field)
│   ├── tasks.ts                  # task CRUD; statusId-based; toggleComplete helper
│   ├── messages.ts               # comments + chat (polymorphic parent: task | space | workspace)
│   ├── mentions.ts               # unread mention queries + markRead/markAllRead
│   ├── docs.ts                   # rich-text docs (Tiptap JSON in `content`)
│   ├── whiteboards.ts            # tldraw boards (snapshot in `snapshot`)
│   ├── timeEntries.ts            # time tracking (start/stop, runningForCurrent)
│   ├── goals.ts                  # OKRs/goals with number/money/boolean targets
│   ├── reports.ts                # workspaceSummary aggregation for the Reports tab
│   ├── listAutomations.ts        # per-list trigger/action rules + applyAutomations() called from tasks.create / tasks.update
│   ├── notifications.ts          # internalActions: sendMentionEmail, sendAssignmentEmail (Resend, Node runtime)
│   ├── clips.ts                  # screen recordings: generateUploadUrl + metadata rows pointing at Convex file storage
│   ├── ai.ts                     # OpenAI: embeddings on doc/task write + brainSearch (RAG), writerContinue, taskAutofill
│   ├── templates.ts              # hardcoded LIST_TEMPLATES + applyListTemplate (creates list + statuses + fields + sample tasks)
│   ├── integrations.ts           # per-workspace external services (currently: Slack incoming webhook)
│   ├── team.ts                   # Teams Hub: per-member workload + week stats + currently-running timer
│   ├── agents.ts                 # human-facing agent management: CRUD, key metadata, assignee-picker options
│   ├── agentKeys.ts              # Node action minting agent API keys (CSPRNG; only the SHA-256 hash is stored)
│   ├── agentApi.ts               # agent-facing API: ~100 key-authenticated functions the MCP server calls
│   ├── agentAi.ts                # key-authenticated semantic search (Node runtime, OpenAI embeddings)
│   ├── events.ts                 # append-only activity log: emitEvent() + human feed query
│   ├── webhooks.ts               # webhook subscription CRUD + delivery bookkeeping
│   ├── webhookDelivery.ts        # Node action: HMAC-SHA256-signed POSTs with retries/backoff/auto-disable
│   ├── sprints.ts                # workspace-level sprints + per-sprint task rollup
│   ├── scheduledTasks.ts         # time-based recurring task definitions + cron materializer
│   ├── crons.ts                  # 15-min crons (materialize schedules, watchdog) + daily retention prune
│   ├── maintenance.ts            # watchdog (expired claims, overdue tasks, stalled agents) + retention pruning
│   ├── channels.ts               # topic channels (messages with parentType "channel") for agent↔agent threads
│   ├── chat.ts                   # the messaging surface: channel rail w/ unread, thread, reference targets + resolution
│   ├── appearance.ts             # per-user UI preferences (forCurrentUser/save/reset)
│   ├── screens.ts                # per-user composed screens, keyed "project:<id>" (layoutFor/save/reset)
│   ├── _refs.ts                  # `#[Label](kind:id)` reference tokens (pure) + body→text/preview
│   ├── realtime.ts               # Ably: server publish + client subscribe-token (SSE) + typing signals
│   ├── onboarding.ts             # completeSetup: workspace + HQ + "Getting started" tasks + first agent in one transaction
│   ├── skills.ts                 # built-in skill playbooks (code) + custom skills (table) merged per scope
│   ├── _x402.ts                  # x402 protocol helpers (pure): config, 402 challenge builder, credit⇄atomic pricing, payment-shape validation
│   ├── x402.ts                   # agent-payment surface: wallet/topup queries, internal applySettlement (nonce-unique), human walletForScope, admin revenue + metering config
│   └── x402Actions.ts            # Node action: facilitator verify+settle (real via X402_FACILITATOR_URL, else mock) then credit the wallet
├── mcp/                          # npx-runnable stdio→HTTP proxy for stdio-only MCP clients
├── scripts/smoke-mcp.mjs         # post-deploy smoke test for the hosted MCP endpoint
├── tests/                        # vitest unit tests (sha256, schedule math, mention tokens) — `npm test`
├── public/
│   ├── manifest.webmanifest
│   ├── icon.svg / icon-maskable.svg
│   └── sw.js                     # minimal service worker (no caching strategy)
├── src/
│   ├── middleware.ts             # Clerk middleware; protects /dashboard, /onboarding
│   ├── app/
│   │   ├── api/[transport]/route.ts  # hosted MCP server (Streamable HTTP) at /api/mcp, bearer = agent API key
│   │   ├── layout.tsx            # root layout, metadata, viewport, SW registration
│   │   ├── globals.css           # Tailwind v4 import + theme tokens
│   │   ├── providers.tsx         # ClerkProvider + ConvexProviderWithClerk
│   │   ├── (marketing)/          # logged-out site v2 (Phase G azure/navy rebuild; fixed header — sections own their own top spacing)
│   │   │   ├── layout.tsx        # MarketingNav + MarketingFooter on the white canvas
│   │   │   ├── page.tsx          # / — scroll-animated home built from sections/ (home-content.tsx)
│   │   │   ├── sections/         # home page building blocks: hero, ops-stack, bento, showcase, social-proof, mini-features, faq, pricing-section, cta-panel
│   │   │   ├── features/         # anchored feature sections (#agents, #mcp, … match marketing-nav)
│   │   │   ├── use-cases/        # index + [slug] industry pages (content in lib/use-cases.ts)
│   │   │   ├── resources/        # index + [slug] guides/changelog (content in lib/resources.ts)
│   │   │   ├── legal/            # index + [slug] legal doc pages (content in lib/legal.ts)
│   │   │   ├── company/page.tsx  # about → /company (old /about permanently redirects)
│   │   │   ├── pricing/page.tsx  # tiers + animated FAQ
│   │   │   └── about/page.tsx    # permanentRedirect("/company")
│   │   ├── (auth)/               # Clerk-hosted sign-in / sign-up
│   │   │   ├── layout.tsx
│   │   │   ├── sign-in/[[...sign-in]]/page.tsx
│   │   │   └── sign-up/[[...sign-up]]/page.tsx
│   │   ├── onboarding/           # first-run cinematic setup: 2 questions → workspace+HQ+starter tasks+first agent+key (convex/onboarding.ts)
│   │   │   ├── page.tsx
│   │   │   └── onboarding-flow.tsx
│   │   └── dashboard/            # logged-in app shell
│   │       ├── layout.tsx        # sidebar + main; auth-guarded; renders <EnsureUser />
│   │       ├── page.tsx          # overview
│   │       ├── personal/page.tsx # user's personal space view
│   │       ├── agents/           # Agents HQ ("Mission Control") + per-agent detail page (runs, governance, usage)
│   │       ├── inbox/            # @mention inbox with unread counter
│   │       ├── w/[workspaceId]/  # team workspace view + Chat tab
│   │       ├── d/[docId]/        # full-page Tiptap doc editor
│   │       ├── wb/[whiteboardId]/# full-page tldraw whiteboard
│   │       ├── chat/             # full-bleed messaging: channel rail + transcript + composer
│   │       └── l/[listId]/       # list page with view tabs (List/Board/Calendar/Gantt)
│   │           ├── list-page.tsx # client wrapper that picks the active view
│   │           ├── view-tabs.tsx # tab nav driven by ?view= search param
│   │           ├── views/
│   │           │   ├── list-view.tsx     # default — task table
│   │           │   ├── board-view.tsx    # Kanban with @dnd-kit drag-drop
│   │           │   ├── calendar-view.tsx # month grid keyed off dueDate
│   │           │   └── gantt-view.tsx    # horizontal timeline of startDate→dueDate
│   │           ├── settings/     # manage list statuses and custom fields
│   │           └── t/[taskId]/   # full-page task editor
│   ├── components/
│   │   ├── ui/button.tsx         # shadcn-style primitive (cva + Tailwind)
│   │   ├── ui/picker.tsx         # searchable popover picker (replaces native <select> for people/tasks/sprints)
│   │   ├── toast.tsx             # ToastProvider + useToast (feedback + undo-able deletes)
│   │   ├── command-palette.tsx   # ⌘K quick-switcher + task quick-create (mounted in dashboard layout)
│   │   ├── motion.tsx            # brand motion primitives (EASE/SPRING/Reveal/Stagger/…)
│   │   ├── marketing/nav.tsx     # fixed nav: transparent-over-hero → solid navy glass, Products dropdown, full-screen mobile overlay
│   │   ├── marketing/footer.tsx  # navy footer; link columns read from marketing-nav.ts
│   │   ├── marketing/ui.tsx      # shared primitives: Container/Eyebrow/SectionHeading/CtaButton/ScreenshotFrame/IconDock/Placeholder
│   │   ├── marketing/gsap.tsx    # the one motion vocabulary: EASE_OUT/DUR, useGsap(), GsapReveal/GsapParallax/GsapCountUp (reduced-motion-safe)
│   │   ├── dashboard/sidebar.tsx # tree of personal+team workspaces; Inbox link with unread badge
│   │   ├── dashboard/ensure-user.tsx # idempotent client bootstrap of user row
│   │   ├── dashboard/status-pill.tsx # colored pill for a listStatuses row
│   │   ├── dashboard/custom-field-input.tsx # type-aware editor for custom field values
│   │   ├── dashboard/comments.tsx # threaded comments + chat composer with @-popover (agents mentionable too)
│   │   ├── dashboard/sprints-panel.tsx # workspace Sprints tab: create/start/complete, progress, task rollup
│   │   ├── dashboard/task-collab.tsx # task-page sections: banners, assignees, sprint, checklist, blocked-by (composable exports)
│   │   ├── dashboard/inline-create.tsx # in-place naming input (the replacement for window.prompt)
│   │   ├── dashboard/page-editor/ # the Pages rich editor (Tiptap over markdown)
│   │   │   ├── index.tsx         # PageBodyEditor — builds extensions once, emits markdown on every change
│   │   │   ├── extensions.ts     # the schema: StarterKit + tables + task lists + PageMention + PageLink
│   │   │   ├── markdown-tokens.ts# markdown-it rules for @[Name](id) and [[Page title]]
│   │   │   ├── slash-commands.ts # the grouped `/` block menu (SLASH_ITEMS)
│   │   │   ├── page-link.ts      # the [[…]] node + its `[[` picker + click-to-open/create
│   │   │   ├── image.ts          # image node (markdown ![](url)) + paste/drop upload
│   │   │   ├── blocks.ts         # toggle (<details>) + callout (> [!NOTE]) nodes
│   │   │   ├── drag-handle.ts    # block reordering (hand-rolled; no tippy)
│   │   │   ├── suggestion-menu.tsx # one popup + one keyboard contract for /, @ and [[
│   │   │   └── selection-toolbar.tsx # the formatting bar over a selection
│   │   ├── dashboard/agent-online-watcher.tsx # toasts an agent's first heartbeat, app-wide
│   │   └── register-service-worker.tsx
│   └── lib/
│       ├── utils.ts              # cn(): clsx + tailwind-merge
│       ├── resend.ts             # lazy Resend client (server-only)
│       ├── mentions.ts           # parse/format `@[Name](clerkId)` mention tokens
│       ├── time.ts               # timeAgo() — the one relative-time voice
│       ├── dates.ts              # local-time <input type=date> round-trips (no UTC off-by-one)
│       ├── event-labels.ts       # humanized event phrasing + eventHref deep links
│       ├── marketing-nav.ts      # logged-out IA: mega-menu/footer/sitemap link lists + SITE_* consts
│       ├── appearance.ts         # the per-user UI model: settings → CSS custom properties (pure)
│       ├── screen-layout.ts      # composed screens: widget order + spans, every op total (pure)
│       ├── anime.ts              # anime.js: token morphing + FLIP layout transitions + motion scale
│       ├── use-cases.ts          # content for /use-cases/[slug] (6 industries)
│       └── resources.ts          # content for /resources/[slug] (guides + changelog)
└── …config files (next, tsconfig, eslint, postcss, .env.example)
```

## Commands

```bash
npm install              # install JS deps
npx convex dev           # start Convex dev server (also generates convex/_generated)
npm run dev              # start Next.js dev server (separate terminal)

npm run build            # production build (next build) — runs lint + typecheck
npm run lint             # next lint
npm run typecheck        # tsc --noEmit (Next.js tree only; convex/ checked by Convex CLI)
npm test                 # vitest unit tests (tests/)
```

You need **two terminals** in dev: one for `npx convex dev`, one for `npm run dev`. Convex's dev server regenerates `convex/_generated/` on every schema/function change.

## Data model (Convex)

```
Workspace (team) ─┐
                  ├─ Space ─ Folder? ─ List ─ Task ─ Subtask
User (personal) ──┘
```

- `users` — mirrored from Clerk via the webhook in `convex/http.ts`, with a fallback `users.ensureCurrent` mutation for environments where webhooks aren't reachable. Indexed by `clerkId`.
- `workspaces` — team workspaces. `ownerClerkId` is the creator.
- `memberships` — many-to-many between users and workspaces. Roles: `owner`, `admin`, `member`.
- `spaces` — top-level containers. `parentType: "user" | "workspace"`. A user's personal space is auto-created on first webhook sync (or first `ensureCurrent`) with `parentType: "user"`, `parentId: <clerkId>`.
- `folders` — optional grouping inside a space.
- `lists` — `parentType: "space" | "folder"` discriminated parent.
- `tasks` — belong to a list. `statusId` references a `listStatuses` row in the same list. `parentTaskId` makes a task a subtask of another. `startDate` (optional) and `dueDate` (optional) drive the Gantt and Calendar views.
- `listStatuses` — per-list workflow stages. Every list seeds 4 defaults on creation (To Do / In Progress / Complete / Closed). Each row has a `category` (`open | in_progress | complete | closed`) so the UI can answer "is this complete?" without hardcoding names.
- `customFields` — per-list field definitions. The full ClickUp-parity type set: `text | long_text | dropdown | labels | date | checkbox | files` (basic), `number | money | rating | progress | voting` (numeric), `email | phone | url | location` (contact), `people | relationship` (relational), `rollup | formula` (computed). `options` holds the choices for dropdown/labels; everything else type-specific lives in `config` (`currency`, `precision`, `min`/`max`, `ratingMax`, `multiple`, `relationListId`, `formula`, `rollup`). **All definition + value validation lives in `convex/_customFields.ts`** and is shared by the human mutations and `agentApi` — never re-roll it. Formulas are parsed by a hand-rolled recursive-descent parser (never `eval`) and their references are checked at definition time; `rollup`/`formula` are derived on read (`computeDerivedValues`) and refuse direct writes.
- `taskFieldValues` — sparse value rows keyed by `(taskId, fieldId)`. Each optional column holds the shape its type needs: `textValue`/`numberValue`/`booleanValue`/`dateValue` for the primitives (dropdown stores its option id in `textValue`), plus `currency` (money), `optionIds` (labels), `actorIds` (people, and one entry per voter for voting), `taskIds` (relationship), `location`, and `files` (Convex storage ids). Computed types never have a row.
- `messages` — comments and chat in a single table. Polymorphic parent (`parentType: "task" | "space" | "workspace"`, `parentId: string`). `parentMessageId` makes a message a reply. `assigneeClerkId` + `resolvedAt` model "assigned comments". Mention tokens live inline in `body` as `@[Name](clerkId)`.
- `mentions` — one row per mention. `parentType`/`parentId` are denormalized from the message so the inbox query is O(unread) without resolving each message's parent.
- `docs` — rich-text documents. Polymorphic parent (`user | workspace | space`). `content` holds Tiptap/ProseMirror JSON.
- `whiteboards` — tldraw-backed boards with the same parent shape. `snapshot` holds the tldraw store snapshot.
- `timeEntries` — one row per time-tracked interval. `endedAt` undefined means the timer is currently running. Convex doesn't index `undefined` cleanly, so the running-entry lookup walks recent entries by user; the working set per user is tiny (typically 0 or 1).
- `goals` — `targetType` is `number | money | boolean`. All three share the same `targetValue` / `currentValue` columns; boolean goals always target 1 and the UI renders a checkbox.
- `listAutomations` — per-list rules with one `trigger` (`task_created` | `status_changed_to_complete`) and one `action` (assign user / set priority / set status / set due in N days). Evaluated inline in `tasks.create` and `tasks.update` so all patches stay inside one transaction.
- `tasks.recurrence` — optional `daily | weekly | monthly`. When a task transitions into a complete-category status, `tasks.update` spawns a fresh task on the same list with its dates advanced.
- `clips` — screen-recording metadata. `storageId` references Convex file storage (`Id<"_storage">`); the bytes live there, not in the table. Author owns delete.
- `embeddings` — one row per indexed task or doc, carrying the OpenAI `text-embedding-3-small` vector (1536 dims). `scopeType` / `scopeId` mirror the visibility boundary (personal user or workspace) so vector search filters can't leak across boundaries. Indexed via Convex's `vectorIndex("by_embedding", { vectorField, dimensions, filterFields })`.
- `integrations` — per-workspace external services. One row per (workspaceId, kind). Currently the only kind is `slack` and `config.webhookUrl` is validated to start with `https://hooks.slack.com/` at write time. Owner/admin gated.

- `agents` — first-class AI agent principals scoped to a user's personal space or one workspace. Everywhere a clerkId-shaped string is stored (assignees, message authors, mentions, `*ActorId` columns) an agent's document id can appear instead. Live presence: `lastSeenAt`, `currentTaskId`, `statusText` (self-reported over MCP heartbeat).
- `agentKeys` — SHA-256 hashes of agent API keys (plaintext shown once at mint time; keys look like `cua_…`). Minted in a Node action (`agentKeys.createKey`), verified in the default runtime with the pure-JS SHA-256 in `_agentAuth.ts`.
- `events` — append-only activity log written inside the same transaction as the change (via `emitEvent`). Powers the human activity feed, agent cursor polling, and webhook fan-out. Types: `task.*`, `comment.created`, `mention.created`, `sprint.*`, `agent.*` (including `agent.connected` on an agent's first heartbeat).
- `webhookSubscriptions` / `webhookDeliveries` — outbound webhooks (user-configured in the UI or agent-registered over MCP). Deliveries are HMAC-SHA256 signed (`X-Webhook-Signature: sha256=<hex>`), retried 3× with backoff, and the subscription auto-disables after 10 consecutive failures.
- `sprints` — workspace-level timeboxes; tasks join via `tasks.sprintId`. Status planned → active → complete, each transition emitting an event.
- `scheduledTasks` — time-based recurring task definitions ("every Monday 09:00 UTC"); an hourly cron (`crons.ts`) materializes due rows into real tasks via `createTaskCore` with a system actor.
- `skills` — custom markdown playbooks per scope; built-ins live in code (`skills.ts BUILTIN_SKILLS`) and are merged into reads, with custom rows overriding built-ins by slug.
- `platformAdmins` / `adminAuditLog` / `platformSettings` — the SOC2 admin layer. Root of trust is the `PLATFORM_ADMIN_EMAILS` deployment env var (env-allowlisted users are superadmins; there is no in-app self-escalation path). Superadmins grant scoped `platformAdmins` rows (`superadmin` | `support`); support is read + account-holds-on-ordinary-users only — support can neither pause agents (`setAgentStatus` requires `minRole: superadmin`) nor suspend any platform admin. A granted superadmin can't suspend a peer superadmin; only the env-root may hold a granted superadmin. Every admin mutation and every break-glass content read writes one append-only `adminAuditLog` row (never updated/pruned). `users.suspendedAt` / `workspaces.suspendedAt` are admin holds — enforced in `_authz.requireIdentity` (and `assertNotSuspended` for the few raw-identity write entry points), AND in `_adminAuth` (a suspended admin loses admin powers too, so a hold actually contains a rogue admin), so a suspended principal is blocked from every write. Emails are stored lowercased (`users.upsertFromClerk`) so the `by_email` admin-grant lookup is reliable. All admin functions gate on `_adminAuth.requirePlatformAdmin`; the `/dashboard/admin` client guard is UX-only, the Convex functions are the real boundary. Security posture panel computes a live SOC2 checklist. See `tests/admin-security.test.ts`.
- `agentWallets` / `payments` — the x402 agent-payment layer. `agentWallets` is a prepaid **credit** balance per billing scope (a user's personal space or a workspace); every agent in that scope shares it. Metered write actions consume credits, enforced in `_agentAuth.requireAgentByKey` (mode "write", BEFORE the daily/burst counters, so a payment-required refusal doesn't burn budget); metering is OFF until a superadmin enables it (`x402.setMeteringConfig` → `platformSettings`). Agents top up over the **x402 protocol**: an HTTP 402 challenge (`buildPaymentRequired`) → the agent signs an `X-PAYMENT` authorization → `x402Actions.settleTopup` verifies + settles it through a facilitator (real via `X402_FACILITATOR_URL`, else a built-in **mock** that mints a deterministic settlement — dev/test only, and refused unless `X402_ALLOW_MOCK=1`) → the internal `applySettlement` mutation credits the wallet. **Fail-closed:** `settleTopup` refuses to settle and `setMeteringConfig` refuses to enable metering unless a real facilitator or explicit mock opt-in is configured, so production can't silently hand out free credits. `payments.nonce` is unique (`by_nonce`) so a settlement can never be replayed to double-credit; the private keys agents sign with are never stored. Amounts are atomic asset-unit strings; credits are integers. Surfaced by MCP tools (`get_wallet`/`buy_credits`/`settle_payment`), the `/api/x402` HTTP 402 endpoint, the agents Billing tab, and the admin Billing tab. See `tests/x402.test.ts`.
- `tasks` Phase 12 columns — `sprintId`, `blockedByTaskIds` (completion is refused while a blocker is open), `claimedByActorId`/`claimedAt` (soft work-lock, 60-min TTL), `checklist` (embedded acceptance criteria), `requiresApproval`/`approvedByClerkId`/`approvedAt` (human-in-the-loop gate: agents can raise the gate but never lower it, and can't complete a gated task until a human approves — a human completing it counts as approval), `overdueNotifiedAt` (watchdog dedupe).
- `agents` governance — `role` ("member" | "readonly": readonly agents can call every read tool but no mutations), `allowedListIds` (restricts a member agent to specific lists; structure-level ops are refused entirely), `dailyActionLimit` (mutations/UTC-day budget enforced in `requireAgentByKey`, tracked in `agentUsage`; default 2000) plus a hard 60 actions/minute burst cap, `notifyUrl`/`notifySecret` (assignment/mention pings pushed to the agent's runtime; HMAC-signed via `X-Ping-Signature` when the secret is set). All outbound URLs (webhooks + pings) pass an SSRF guard that refuses private/loopback addresses.
- `agentRuns` — structured work sessions agents report over MCP (start_run/finish_run/report_error), including artifacts (`links`) and cost (`tokensUsed`/`costUsd`). Failed runs emit `agent.error` events. The watchdog marks runs of stalled agents "abandoned". `agents.stats` aggregates 7-day per-agent analytics for the detail page.
- `channels` — named topic threads (messages/mentions carry `parentType: "channel"`), so agent↔agent deliberation stays out of the main workspace chat. Idempotent create-by-name = join.
- Watchdog (`maintenance.watchdog`, every 15 min) — releases expired claims (`task.claim_expired`), nags on overdue open tasks once per overdue period (`task.overdue`), and flags agents holding a current task with no heartbeat for 30+ min (`agent.stalled`). Both task passes are index ranges (`by_claimed`, `by_due`), not table scans. Retention (`maintenance.prune`, daily) — events kept 90 days, webhook deliveries 30, usage counters 14.
- Approval queue — `tasks.pendingApprovals` ranges the `by_approval` index and access-checks each gated task; the Inbox renders it with one-click Approve. Agents call `request_approval` (MCP) to raise the gate, emit `task.approval_requested`, and email a responsible human.
- Webhook + ping payloads carry `apiVersion: 1`; bump on breaking shape changes.

**Actor pattern (Phase 12).** Task/message/sprint write paths are factored into `*Core` functions (`createTaskCore`, `updateTaskCore`, `createMessageCore`, …) that take an explicit `Actor` (`{ type: "user" | "agent" | "system", id, name }`). The Clerk-authenticated mutations and the API-key-authenticated functions in `agentApi.ts` both call the same cores, so automations, notifications, recurrence, and events behave identically for humans and agents. Never write a second code path for agents — extend the core and both sides get it.

**Authorization** is centralized in `convex/_authz.ts`. Every read/write resolves up the hierarchy (task → list → folder?/space → workspace?/user) and calls `canAccessSpace` to confirm either personal ownership or workspace membership. Use `requireListAccess`/`requireSpaceAccess`/`requireFolderAccess` rather than re-rolling checks in each function.

- Public mutations: anything end-user invokable (`workspaces.create`, `tasks.update`, etc.).
- Internal mutations: `users.upsertFromClerk`, `users.deleteFromClerk` — only callable from `convex/http.ts`. Never expose them.

## Conventions

- **TypeScript everywhere.** No `any` unless you can explain why in a comment.
- **Server vs. client components.** Default to server. Add `"use client"` only when you need state, effects, browser APIs, or Clerk hooks (`useUser`, etc.).
- **Routing.** Marketing routes live in `(marketing)`, auth routes in `(auth)`, app routes under `/dashboard`. Add new auth-guarded routes either inside `/dashboard` or extend `isProtectedRoute` in `src/middleware.ts`.
- **Styling.** Tailwind utilities only. Use `cn()` from `@/lib/utils` for conditional classes. Theme tokens live in `globals.css` under `@theme` — extend there, not via inline arbitrary values.
- **Brand system (Phase 15 rebrand + Phase 21 bento).** Monochrome editorial + pastel accents on the soft "bento" surface language: the dashboard renders as a white sheet on the gray `bg-page` canvas (see `dashboard/layout.tsx`); ink is near-black; the primary CTA is a solid black pill (`Button` primary); meaning is carried by pastel chips (`--color-pastel-*` tokens; status/priority hexes are pastel with dark ink on top); page titles are bold with a `title-rule` hairline underneath; micro-labels are tiny uppercase tracking-wider gray. **Surfaces use the bento primitives in `globals.css`, not hairline borders:** discrete cards/panels/tables get `.bento` (soft floating shadow) paired with a `rounded-*` utility — do NOT reintroduce `border border-border` on cards; nested wells use `.bento-tile`; a functional glyph on its own surface uses `.icon-tile` (the only place an icon rides a tile); inputs use `.soft-field` (neutral fill + focus ring). **Segmented controls** (view/tab/mode toggles) use `.segmented` track + `.segmented-on` raised-white active pill (NOT black) — black stays for primary action buttons only. Buttons/chips stay `rounded-full`, cards `rounded-2xl`, sidebar rows `rounded-lg`. **No decorative icons** — an icon must be a button/link affordance, a form control, a semantic status/type indicator, or an `.icon-tile`; never ornament beside a heading or centered in an empty state. Don't reintroduce saturated fills — green is reserved for positive deltas. Popovers/menus keep `shadow-lg` (stronger than bento). The sidebar collapses to an icon rail (persisted); nav icons press/hover-scale and the active pill morphs via `layoutId="sidebar-active"`.
- **Motion system (`src/components/motion.tsx`, built on `motion/react`).** One easing (`EASE`, a long-tail ease-out) and one spring (`SPRING`) everywhere. Primitives: `Reveal` (fade + rise + un-blur), `Stagger`/`StaggerItem` (50ms cascades for grids/lists), `AnimatedNumber` (springy count-up for stat tiles), `AnimatedBar` (progress fills), `PresenceDot` (radiating ping). Route transitions live in `dashboard/template.tsx`; tab switches re-mount a keyed `motion.div`; the sidebar's active pill morphs between links via `layoutId="sidebar-active"`; lists animate entrances (and exits via `AnimatePresence` where rows can disappear — approvals, checklist). Buttons press-scale via CSS; interactive cards use the `.lift` utility. Everything must respect reduced motion (`MotionConfig reducedMotion="user"` + the `.lift` media query) — keep new animations inside these primitives rather than inventing new timings.
- **Pages editor.** `src/components/dashboard/page-editor/` is a rich editing surface over a **markdown document** — Tiptap is the editing surface, never the storage model. Every change is serialized back with `editor.storage.markdown.getMarkdown()` and that is what `pages.update` stores, so an agent writing `## Heading` and a person pressing the H2 button are editing the same bytes. **Nothing in the editor may express something markdown can't round-trip**: tables are GFM pipe tables, checkboxes are GFM task items, mentions are `@[Name](actorId)` (the same token `src/lib/mentions.ts` uses), page links are `[[Page title]]`. Both app-specific tokens need a rule in `markdown-tokens.ts` **and** a node that owns its serialization — prosemirror-markdown escapes `[`, so a `[[link]]` left as plain text comes back as `\[\[link\]\]` and stops resolving. Every `Suggestion` plugin needs its own `PluginKey`; they all default to `PluginKey("suggestion")` and ProseMirror throws on construction when two share one. Adding a block = one entry in `SLASH_ITEMS`, with `keywords` so the filter finds it by more than its title. Positioning goes through the shared `createSuggestionRenderer`/`SelectionToolbar` (editor coordinates), not tippy — and neither is the drag handle (`drag-handle.ts` is hand-rolled because `@tiptap/extension-drag-handle` depends on tippy.js and peer-depends on the y-prosemirror collaboration chain). **Toggles and callouts are restored from the parsed DOM, not by teaching markdown-it new syntax**: the parser runs `html: false` as its security posture, so `<details>` arrives escaped, and `markdown-tokens.ts restorePageBlocks` rebuilds exactly those two constructs by creating elements and setting `textContent` — one un-escaped construct, no path from author text to markup. Their stored forms are portable on purpose: a toggle is a GFM `<details><summary>` block, a callout is a GitHub alert blockquote (`> [!NOTE]`), so both degrade to something meaningful in any markdown reader. **A block that can't round-trip is a block that deletes data** — the Image item wrote `![](url)` for months against a schema with no image node, so every image silently vanished on the next parse; if you add a block, add its node AND a test that the markdown survives a save. Page links resolve through `PageLinkOptions.resolve` and open through `onOpen` (null page id = "create it"); an unresolved link renders `.page-wikilink-missing` so a name written ahead of its page reads as unfinished rather than broken. Saves are optimistic-concurrency-checked: the client sends `expectedUpdatedAt` and the server refuses a save built on a version someone else replaced, so the editor shows a Take theirs / Keep mine banner instead of clobbering.

- **Appearance (per-user UI).** The design system already runs on CSS custom properties, so personalisation changes the *tokens*, not the components — `src/lib/appearance.ts` is a pure `settings → Record<cssVar, string>` function and nothing in the app knows it exists. Three rules: **the defaults must reproduce the shipped design exactly** (asserted in `tests/appearance.test.ts` — personalisation that changes the look for someone who never opened the settings is a bug); **every value is clamped on the way in** via `normalizeAppearance`, which is total and ignores keys it doesn't know, so a row written by a newer build can never lock someone out; and **every token has a fallback in `globals.css`**, so the logged-out site and the pre-hydration paint render the shipped design. Preferences live in Convex (`uiPreferences`, one row per user) rather than localStorage, which is what makes them real-time across tabs and devices — there is no save button. `AppearanceProvider` holds three distinct states: **stored** (Convex, live), **preview** (a slider mid-drag — applied instantly, never written), and **effective** = preview ?? stored ?? defaults. Writes are debounced ~450ms so a four-slider drag is one write. Structural choices (sidebar left/right/floating, density, surface) ride on `data-*` attributes on `:root` because "where is the nav" is answered by CSS, not interpolated. **Density is opt-in per surface** (`.ui-dense-pad`, `.ui-dense-gap`, sidebar rows) — a rule broad enough to re-pad `.panel` outranks the `p-4`/`p-5` utilities already on those cards and would silently change layouts nobody asked to change.

- **Layered appearance (`src/lib/appearance.ts` + `convex/appearance.ts`).** Three writers decide what the app looks like, and the precedence rule is not "last writer wins" — **a setting belongs to whoever it is about.** `PLACE_KEYS` (accent, radius, surface) describe the *room* and a space sets them for everyone in it; `PERSONAL_KEYS` (type size, motion, density, sidebar position/width, heading weight) describe the *person* and a space cannot set them at all — `appearanceLayers()` drops them via an allow-list, so there is no write path that smuggles one through (asserted end-to-end in `tests/space-appearance.test.ts`, not only in the resolver). The partition is total and disjoint, with a test that fails if a new setting is left unclassified. Resolution runs general → specific: defaults → your preferences → the space's theme → your override of that space; `resolveAppearance` also returns a **`sources` map** naming the layer each value came from, which is what lets a control say "this is the space's value, not yours" — without it the customiser is sliders whose numbers arrive from nowhere. **Everything stored is a sparse patch**, because absence is what means "ask the layer beneath me": a row holding all eleven keys is indistinguishable from someone having pinned all eleven, so a space theme could never reach anyone who had once opened the settings panel. Legacy rows (pre-layering, full snapshots) are discriminated by `uiPreferences.patchVersion` and read through `prunePatch`, which drops keys equal to the shipped default — no migration. Clearing an override **deletes the key** rather than copying down the parent's value: copying looks identical today and silently stops tracking tomorrow. **Which room you are in is read from the URL** (`src/lib/space-route.ts`, pure and tested; `useActiveSpace` resolves a list/project/task up to its space server-side and *holds* the previous answer across the load gap, because a frame of default in between reads as breakage rather than transition). The space customiser lives at `/dashboard/s/<id>/appearance` — a route inside the space rather than a `?space=` parameter, so the whole shell previews that room while you tune it and there is one way to say which space you mean. `mayGovernSpace` in `_authz.ts` is the single bar for shared changes (same one privacy uses).

- **Live retheming.** The *committed* theme needs no Ably: it is a Convex row, so a saved change morphs for everyone standing in the space over the same subscription that renders it. Ably carries only the **in-flight drag**, which no query can — a write per frame is exactly what the debounce prevents. `realtime.spaceLookSignal` is gated on `mayTheme` rather than membership (a signal that repaints everyone's UI is a shared act), throttled ~90ms with a *trailing* send so spectators end on the last frame, tagged with a per-tab `ORIGIN` so a publisher ignores its own echo, and expired after 3s of silence so a closed tab can't strand the room on an uncommitted look. On the receiving side the live patch **stands in for the space layer**, not on top of everything — so a teammate's drag still loses to your own override and still can't touch your type size.

- **Composed screens (`src/lib/screen-layout.ts` + `project-screen/widgets.tsx`).** A screen is data: `{ widgets: [{ id, span }] }`, per user per screen, keyed `"project:<id>"` so it generalises to any surface without a migration. Adding a panel is **one entry in `PROJECT_WIDGETS`** — the layout engine knows only ids and spans, and only the registry knows what a widget means. The property that shapes it: **an empty layout is legitimate** — someone who removes every panel wants a blank screen, so `normalizeLayout` drops unknown ids and clamps illegal spans but never helpfully re-adds anything. A `null` row means "never customised" (→ defaults); an empty `widgets` array means "cleared it on purpose". Widgets declare `minSpan`/`maxSpan` and the width control skips what they can't render at — a grid of cards below two columns is a single file of cards. Two explicit modes: reading has *no* edit chrome at all, customising adds handles, width and remove; hover-to-reveal was rejected because the common case is reading your work. Reorder is @dnd-kit (already present, brings keyboard support); resize/add/remove reflow the grid through anime.js FLIP.

- **Editable screens (`screen/editable-grid.tsx`).** Screens are arranged the way a phone's home screen is: hold a panel until the grid wobbles (or use the Arrange/Customize toggle — the accessible path), then move it. There is deliberately NO settings page for layout — the surface being read is the editor. The physics live in `src/lib/anime.ts` (`jiggle` desynchronised per tile, `createMagneticField` neighbour-lean, `velocityDeform`/`settleDeform`, `wake` after a drop, `tearOut` on remove) and the reorder rule is pure and hysteresis-banded (`slotForPointer` — without the band a boundary pointer flips slots per frame). Tiles declare `rows` (1|2) and the grid fixes row height at lg, which is what makes a screen look composed; content scrolls inside its size. The tray is a shelf: `TrayTile` is dragged out and dropped into a slot (`insertWidget`), clicking appends, releasing elsewhere springs back. `EditableGrid` has a controlled mode (`editing`/`onEditingChange`) so a surface with its own toggle (Home) keeps one switch. Home and the project screen both ride this; new surfaces should too, never a bespoke editor.

- **Presence (`convex/presence.ts` + `presence-rail.tsx`).** One table for every surface (page/task/list/project/space) and BOTH kinds of principal — `actorType` is the point: an agent appears in the same rail as a person, on the surface it is actually touching, not just on a dashboard about agents. Convex TTL rows (45s, swept opportunistically + retention), no realtime service. Agent writes announce themselves (`markPresence` from claim/update/writePage; release clears), and `set_focus` (MCP) exists because a query cannot write — it is how an agent says it is *reading* something. Access-checked both directions (`requireSurface` on read/write; agent side through the agent's own fences — presence somewhere an agent is fenced out of is a governance leak). UI: `PresenceRail` (chips, agents first, pulse while writing), `PresenceNote` (the sentence), `AgentEdge` (a stroke travelling a panel's perimeter while a machine writes in it), `LiveNumber` (digits resolve when a value changes under you). See `tests/presence.test.ts`.

- **Live runs (AG-UI-shaped; `agentApi.emitRunEvent`, `agents.liveRunForTask`, `run-theater.tsx`).** A run used to be two bookends (start_run/finish_run) with silence between; now the run *document is the stream*. Steps (`step_started/step_finished/step_failed`, stable keys, idempotent restart, hard 50-cap), one replaced narration line (never a transcript), and a small `liveState` object (`state_snapshot` replaces, `state_delta` shallow-merges with null-deletes, ~4KB cap — a dashboard's worth of numbers, not a data channel). No second transport: Convex pushes every patch, so emitting is publishing. Presence-classified (telling people what you're doing never consumes the budget for doing it). Another agent's run id answers "not found" (existence is information); events after finish are refused; the watcher query is access-checked like the task. `RunTheater` renders it on the task page — materializing checklist, current sentence, `LiveNumber` tiles — and is *absent* when nothing is live. MCP tool: `emit_run_event`. See `tests/live-runs.test.ts`.

- **Screen proposals (`screenProposals` + `screens.proposalsFor`/`resolveProposal`, agent tool `propose_screen`).** An agent may AUTHOR a screen, never apply one: the naive adaptive UI silently rearranges your screen and breaks learnability, so the agent files a proposal with a mandatory reason, and the banner shows a computed diff (`describeLayoutChange`) with Preview (morphs the real grid — the preview IS the result; edits while previewing are refused so the agent's layout can't be silently saved as yours), Accept, Dismiss. Accepting writes the ACCEPTOR's layout only — consent is per-person because layouts are. One pending proposal per agent per screen (newer replaces older). Structure-level: list-restricted agents are refused via `requireUnrestricted`. See `tests/screen-proposals.test.ts`.

- **anime.js (`src/lib/anime.ts`).** The third motion library, and it does not overlap the other two: `motion/react` animates dashboard components, GSAP owns marketing, anime.js owns the two things neither can. (1) **Token interpolation** — anime.js animates plain JS objects, so `morphTokens` drives one `{t: 0→1}` animation and writes every interpolated custom property per frame. One animation, not one per token: nine concurrent animations on the same element is nine style recalcs a frame, and the radius and padding would land at different times, which reads as a glitch. Colours interpolate as RGB (hex only — `resolveTokens` never emits `hsl()`, and there's a test); anything non-interpolable (shadows, borders) swaps at the midpoint. (2) **FLIP layout transitions** via `createLayout` — `morphLayout(root, change)` records the boxes, runs the change, then animates the difference on the next frame, which is the only way moving the sidebar reads as one object moving rather than a cut. Everything reads `--ui-motion-scale` through `scaled()`; **`prefers-reduced-motion` always wins over the stored preference**, and a motion scale of 0 means instant, never broken.

- **Messaging (Chat).** `/dashboard/chat` is full-bleed on purpose — it cancels the dashboard shell's padding with `-mx-4 -my-6` and owns the viewport, because a conversation is a place you sit in, not a panel you glance at. **Convex is the source of truth for every message; Ably carries only what a query can't answer** (typing, presence, and a nudge to clients that aren't holding a Convex subscription). The browser never bundles the Ably SDK: `realtime.chatSubscribeToken` does the access check and mints a *subscribe-only, single-channel* token, and `useAblyChannel` opens an `EventSource` against Ably's SSE endpoint (`src/lib/use-ably-channel.ts`). The API key stays server-side; a leaked token is worth one channel for 30 minutes. Typing is an action (`realtime.chatSignal`), never a DB write — a table every keystroke touches is a table that dominates the write log. Ably being unconfigured is a supported state: the room still works and the header says `convex` instead of `live`.

- **Three inline tokens, one grammar.** `@[Name](actorId)` (mention), `#[Label](kind:id)` (reference — project/list/task/page/sprint/goal, see `convex/_refs.ts`), `[[Page title]]` (page link). References are **parsed from the body at write time** in `createMessageCore` and denormalized onto `messages.refs`, never accepted from the caller — a client that forgets to send them can't produce a message whose stored refs disagree with its own text. `chat.resolveRefs` turns them into hrefs server-side (a task's URL needs its list). Message bodies render through `src/components/dashboard/message-body.tsx`, which builds **React nodes, not an HTML string** — there is no `dangerouslySetInnerHTML` and therefore no sanitizer to keep correct, which matters because bodies are written by agents that may have read a malicious document.

- **Page history (`pageRevisions`).** Every content-changing save snapshots what the page said *before* the edit — the pre-edit state, because a revision holding the post-edit state is identical to the live page and restoring it does nothing. Two policies keep the list readable: **coalescing** (a page saves every ~700ms, so one author's edits extend a single open revision for 5 minutes; a *different* author always opens a new one, since "who changed this" is the question history exists to answer), and a hard **50-per-page cap** pruned at write time, so no cron is involved. A title-only rename is a revision; a save that changes nothing is not. **Restoring is an ordinary edit, not a rewind** — `restoreRevision` routes through `updatePageCore`, so the version it replaces is recorded first, links/mentions/embeddings re-sync, and restore is undoable by restoring again. That is why the UI has no confirmation dialog: nothing in the panel is destructive. `history` returns excerpts and sizes rather than full markdown (fifty revisions of a long page is megabytes); `readRevision` fetches one, access-checked against the *page* rather than the row — an old version is page content and leaks the same text.

- **Page comments.** `messages.parentType` includes `"page"`, so the discussion about a document lives beside it rather than inside it — an agent reading the page gets the decision, not the argument that produced it. Note the deliberate overlap: page-*body* mentions and page-*comment* mentions both land on `parentType: "page"` with the same `parentId`, so `pages.syncMentions` dedupes **only against rows with no `messageId`**. Without that, commenting "@Ada" would silently suppress a later mention written into the page itself.

- **Page mentions.** `@[Name](actorId)` in a page's markdown is parsed **server-side** in `pages.syncMentions` (agents write over MCP and never touch the composer), and produces a real `mentions` row — `parentType: "page"`, `messageId` absent, `snippet`/`byName` carried on the row because there is no message to read them from. It is idempotent by construction (a page saves every ~700ms while someone types, so it only inserts for a principal not already mentioned on that page) and gated by the same `canBeMentioned` check comments use. Removing the token does not retract the notification.

- **Feedback system (Phase 18).** Never use `window.prompt`/`window.confirm`/`window.alert`. Naming something new = `InlineCreate` in place; destructive actions = hide the row locally and `toast(msg, { action: {label: "Undo", …}, onExpire: commit })` from `useToast()` — the mutation only runs when the undo window closes; quiet saves (blur-persisted fields) confirm with a success toast; refused mutations surface a `kind: "error"` toast with the server's reason. `ToastProvider` is mounted once in the dashboard layout (as are the ⌘K `CommandPalette` and `AgentOnlineWatcher`). Use the `Picker` component instead of native `<select>` whenever options are people, agents, tasks, or sprints. Use `timeAgo` from `@/lib/time` and the date-input helpers from `@/lib/dates` (never `toISOString().slice(0, 10)` — it's off by a day across timezones). Small icon buttons get the `.tap-target` class for a ~44px touch area.
- **Marketing site v2 (Phase G).** Electric azure-over-navy palette on a white canvas, ToDesktop-inspired layout — no more cream/ember/cocoa (`--color-cream`, `--color-ember-*`, `--color-cocoa-*` are retired; use `--color-azure-*` for the accent ramp and `--color-navy-800/900/950` for dark bands/footer/nav). Typeface is still Instrument Sans (`src/app/fonts/`, next/font/local + `--font-sans`; never load fonts from a CDN). All motion goes through GSAP, not Framer/`motion.tsx` — `src/components/marketing/gsap.tsx` is the one vocabulary: `EASE_OUT`/`EASE_IN_OUT` + the `DUR` durations are the only timing values, `useGsap()` scopes a `gsap.context` to a ref and reverts on unmount, `GsapReveal`/`GsapParallax`/`GsapCountUp` are the reusable scroll-triggered primitives, and everything is reduced-motion-safe (`prefersReducedMotion()` short-circuits to the final state, no ScrollTrigger registered; `[data-gs-hidden]` keeps targets invisible pre-hydration so there's no flash). Shared page primitives live in `src/components/marketing/ui.tsx` (`Container`, `Eyebrow`, `SectionHeading`, `CtaButton`, `ScreenshotFrame`, `IconDock`, and `Placeholder` — see below), not in per-page files. All marketing copy is centralized in `src/lib/marketing-content.ts` (hero, social proof, ops stack, nav products menu, etc.) — edit copy there, not inside section components. **Every raster/screenshot/illustration slot that doesn't have a real asset yet renders as a red `Placeholder` block** (from `marketing/ui.tsx`) labeled with what belongs there — never a fake screenshot, gradient stand-in, or silently empty div; swap to the real asset in a follow-up pass. No decorative icons beyond the established treatments. All logged-out IA (nav mega menu, footer columns, sitemap) reads from `src/lib/marketing-nav.ts` — add pages there, not in components; the nav's Products dropdown additionally reads `PRODUCTS_MENU` from `marketing-content.ts`. Every marketing page exports metadata with a canonical path; dynamic pages use `generateStaticParams` + `generateMetadata`; `src/app/sitemap.ts`/`robots.ts` pick new pages up from the shared lists (`USE_CASES`, `RESOURCES`, `LEGAL_DOCS`), never a hardcoded slug array.
- **Responsive.** Mobile-first; use `md:`/`lg:` for desktop. Test at 360px, 768px, and 1280px before merging UI changes. Sidebar uses a drawer pattern below `md`.
- **Apostrophes in JSX.** Escape as `&apos;` — `react/no-unescaped-entities` is enforced by `next lint`.
- **Convex imports.** From the Next.js tree, use `convex/react` and `convex/react-clerk` (runtime). Typed `api`/`Doc`/`Id` come from `convex/_generated/`, imported via the `@convex/*` path alias (e.g. `import { api } from "@convex/_generated/api"`). The `_generated/` files are checked in as hand-rolled stubs so a fresh checkout typechecks; `npx convex dev` and `npx convex deploy` overwrite them with the real generated content.

## Environment variables

See `.env.example` for the canonical list. Two grouping rules:

- Anything starting with `NEXT_PUBLIC_` is bundled into the client; never put secrets there.
- `CLERK_WEBHOOK_SECRET` is consumed by **Convex**, not Next.js — set it via `npx convex env set CLERK_WEBHOOK_SECRET …`. The Clerk webhook URL points to `https://<deployment>.convex.site/clerk`.

## Initial setup steps

When bringing up a fresh checkout:

1. `npm install`
2. `npx convex dev` — creates a Convex deployment and writes `NEXT_PUBLIC_CONVEX_URL` into `.env.local`.
3. Create a Clerk app, copy publishable + secret keys into `.env.local`.
4. In Clerk → JWT Templates, create a "Convex" template; copy the Frontend API URL into `NEXT_PUBLIC_CLERK_FRONTEND_API_URL`.
5. In Clerk → Webhooks, add an endpoint at `https://<deployment>.convex.site/clerk` subscribed to `user.created`, `user.updated`, `user.deleted`. Copy the signing secret with `npx convex env set CLERK_WEBHOOK_SECRET …`.
6. Get a Resend API key and set `RESEND_API_KEY` + `RESEND_FROM_EMAIL`.
7. `npm run dev` (Convex dev keeps running in another terminal).

## Vercel deployment

- Build command: `npm run build`
- Required env vars: every entry in `.env.example`. `CONVEX_DEPLOY_KEY` only needs to exist on Vercel (not local).
- For preview deployments to share a Convex backend with prod, add `npx convex deploy` to a Vercel build hook or use `npx convex env` to manage per-environment values.

## Native apps (Capacitor)

`capacitor.config.ts` wraps the live web app — Capacitor renders the production URL inside a thin native shell, so Convex realtime + Clerk session work the same as on web and you can ship updates without an app-store review for every change.

Bootstrap once per platform:

```bash
npx cap add ios       # requires Xcode on macOS
npx cap add android   # requires Android Studio
```

After every code change you want in the native app:

```bash
npx cap sync          # copies web assets + plugin metadata
npx cap open ios      # or `open android`
```

Set `CAP_SERVER_URL` (or edit `capacitor.config.ts`) to your real production URL before publishing to the stores. The generated `ios/` and `android/` directories are gitignored by default — commit them once the team has converged on a config.

## Things AI assistants should not do

- **Don't manually edit `convex/_generated/`** — the Convex CLI overwrites these files. The committed versions are stubs that survive between dev runs; further hand-edits will be lost on the next `convex dev`/`deploy`.
- **Don't add an `api/webhooks/clerk` route in Next.js.** The webhook lives in Convex's HTTP router (`convex/http.ts`) so secrets stay server-side and we avoid a hop.
- **Don't make `users.upsertFromClerk` a public mutation.** Anyone could spoof identities.
- **Don't gitignore `.env.example`** — it's the template.
- **Don't introduce a new state library** (Redux, Zustand, etc.) for data that should live in Convex. Local UI state via `useState` is fine; persistent state should round-trip through Convex.
- **Don't bypass `_authz.ts` helpers.** Every query/mutation that reads or writes a folder/list/task must resolve up the hierarchy with `requireListAccess`/`requireSpaceAccess`/`requireFolderAccess`.

## Phased roadmap

We are building this out in numbered phases, one PR each. See PR descriptions for what shipped in each.

- **Phase 0 (PR #1):** Scaffold + marketing/auth/onboarding/dashboard shell + PWA.
- **Phase 1:** Hierarchy + tasks v1 — Spaces/Folders/Lists/Tasks, sidebar tree, list view with task CRUD, real Convex queries replacing mock data, onboarding wired.
- **Phase 2:** Custom fields + per-list custom statuses, list settings page.
- **Phase 3:** Views — List/Board/Calendar/Gantt selectable via tabs (`?view=` query param). Board uses @dnd-kit; Calendar and Gantt are hand-rolled with date-fns.
- **Phase 4:** Threaded task comments + workspace chat, @mentions with inline picker, assigned comments, /dashboard/inbox with unread badge in the sidebar. Realtime is automatic via Convex `useQuery` subscriptions.
- **Phase 5:** Rich-text docs (Tiptap, debounced save) and tldraw whiteboards (dynamic-imported, debounced save). Both attach to user/workspace/space and appear in the sidebar tree alongside lists.
- **Phase 6:** Time tracking with a live timer (sidebar chip + per-task tracker, only one running per user), Goals (number/money/boolean) on workspaces, and a Reports tab per workspace with fixed widgets (open tasks, completed-this-week, time-tracked-this-week, goal progress, workload by assignee).
- **Phase 7:** Recurring tasks (daily/weekly/monthly, regenerated on completion) and a minimal list-automation engine (trigger + action rules evaluated inside `tasks.create` / `tasks.update`).
- **Phase 8:** Outbound email notifications via Resend (mentions and task assignments, scheduled via `ctx.scheduler.runAfter` so they don't block the originating mutation) and Clips (browser screen+mic recording uploaded to Convex file storage, played back in the task detail).
- **Phase 9:** AI Brain on the OpenAI API — semantic search over docs + tasks (`text-embedding-3-small` vectors, RAG via `gpt-4o-mini`), AI writer (continue/summarize) inside docs, and one-click task description draft.
- **Phase 10:** List templates (Software sprint / Marketing campaign / Personal to-do / Sales pipeline — each seeds list + statuses + custom fields + sample tasks in one transaction), Slack integration (incoming-webhook posts on task assignment), Teams Hub (per-member workload, week stats, currently-running timer) + new workspace Settings tab.
- **Phase 11:** Offline-first PWA polish via `@serwist/next` (Workbox-style precache + runtime caching, navigation preload, network-first navigation with offline fallback) and a `capacitor.config.ts` for iOS/Android wrapping using the remote-web-app pattern. Live offline indicator surfaces queued mutations.
- **Phase 12:** AI agent collaboration. First-class agent principals with API keys; a hosted MCP server (`/api/mcp`, ~40 tools: projects/lists/tasks/comments/sprints/recurring tasks/docs/search/events/skills) plus an npx-runnable stdio proxy (`mcp/`); an append-only events log with signed outbound webhooks (agents register their own over MCP); collaboration primitives (claims, blocked-by dependencies, checklists, agent mentions = agent inbox); sprints; time-based recurring tasks via cron; a skills library (built-in + user/agent-authored playbooks); and the Agents HQ page (live presence + "now working on", key management, activity feed, webhooks, skills) with agents assignable from the task page like any teammate. See `docs/AGENTS.md`.
- **Phase 13:** Hardening + agentic-company scaffolding from the Phase 12 audit. Correctness: Board drag-drop and recurrence route through the shared cores (events/automations/blockers/claims apply everywhere); read-authz sweep so no query leaks titles by ID. Governance: agent roles (readonly / list-restricted), per-agent daily action budgets, human approval gates on tasks. Operations: watchdog + retention crons, structured agent runs + report_error, assignment/mention push to agent notifyUrls, `next_task` dispatch + `handoff_task`, topic channels. Surface: ~25 new MCP tools (time, goals, automations, templates, custom fields, comment management, runs, channels) + skills as MCP resources; UI for recurring schedules, per-agent detail (governance + runs + usage), sprint task picker, channel chat, claim/blocked/approval badges in List/Board, real deep links everywhere (task→list resolver). Infra: vitest unit tests, MCP smoke script.
- **Phase 14:** Closing the loop from the Phase 13 re-audit. Approvals inbox ("Waiting on your approval" queue + `request_approval` MCP tool + approval emails); per-agent 7-day analytics (`agents.stats` tiles) and run artifacts/cost (`finish_run` links/tokensUsed/costUsd); reports resolve agent names; watchdog moved to index ranges (`by_claimed`/`by_due`); 60/min burst cap on top of the daily budget; SSRF guard on outbound URLs + HMAC-signed notify pings + `apiVersion` on payloads; complete delete cascades (task artifacts, list schedules, agent references); Board drag rejection banner; sprint-aware `next_task`; local-time hints on schedules; convex-test integration suite (authz/claims/blockers/gates/roles/budgets) + GitHub Actions CI.
- **Phase 15:** Full UI rebrand — the monochrome editorial system with pastel accents (see Brand system above).
- **Phase 16:** Motion design pass — the single-easing animation language in `src/components/motion.tsx` applied to every surface (see Motion system above).
- **Phase 17:** First-run experience — cinematic 2-question onboarding that builds workspace + HQ + teaching tasks + first agent + key in one transaction, and a living Home (greeting, welcome reveal, "waiting to connect" nudge).
- **Phase 18:** UX polish pass. Feedback system: app-wide toasts (`src/components/toast.tsx`) with undo-able deferred deletes replacing every `window.confirm`, and inline in-place creation (`inline-create.tsx`) replacing every `window.prompt`; blur-saving governance fields confirm with a "Saved" toast. ⌘K command palette (quick-switch to any list/doc/board/workspace/agent, plain-text task search via `tasks.quickSearch`, two-step task quick-create). Searchable `Picker` popover replacing native selects for assignees/blockers/sprints. Task page rebuilt two-column (content left, state rail right) with a springy completion moment (optimistic `toggleComplete` in the list view). Local-time date handling (`lib/dates.ts`), one `timeAgo` (`lib/time.ts`), shared humanized event labels (`lib/event-labels.ts`). `agent.connected` event on first heartbeat + app-wide first-connection toast + self-retiring connect hint + Home waiting-card resolve animation. Mobile: `.tap-target` hit-area utility, horizontally scrollable pill tab rows. Content-shaped skeletons on list/task/agents/inbox/agent-detail.
- **Phase 22 (current):** Legal + x402 agent payments + onboarding + bento rebrand. **Legal** (`src/lib/legal.ts` → `/legal` + `/legal/[slug]`): counsel-reviewable Terms/Privacy/AUP/Cookies/Subprocessors/Security/DPA templates, sober prose, wired into footer + sitemap, no decorative icons. **x402 agent payments** (`convex/_x402.ts` + `x402.ts` + `x402Actions.ts`, `src/app/api/x402/route.ts`, `components/dashboard/billing-panel.tsx`): agents pay for the platform themselves over the x402 protocol — a prepaid credit wallet per scope (`agentWallets`), a nonce-replay-protected settlement ledger (`payments`), env-driven pricing, a facilitator client (real via `X402_FACILITATOR_URL`, else a built-in mock that runs the full flow without a chain), metering enforced in `requireAgentByKey` (OFF by default; superadmin toggles it in the admin Billing tab), MCP tools `get_wallet`/`buy_credits`/`settle_payment`, and a protocol-faithful HTTP 402 endpoint. Agents Billing tab + admin revenue/metering, both icon-free. Proven by `tests/x402.test.ts`. **Onboarding**: cinematic Apple-inspired rebuild (welcome ceremony, aurora backdrop, live assembling preview, agent-online reveal) on the same `completeSetup` backend, strictly icon-free. **Bento rebrand** (Phase 21, folded in): the soft-shadow `.bento` surface system + collapsible icon-rail sidebar + raised-white segmented controls (see Brand system).
- **Phase 20:** Platform admin + ICP features + polish. SOC2 admin console (`/dashboard/admin`, `convex/admin.ts` + `_adminAuth.ts`): env-allowlist root of trust, superadmin/support tiers, append-only `adminAuditLog`, user/workspace account holds enforced in `_authz`, security-posture checklist, admin roster — proven by `tests/admin-security.test.ts`. ICP features: one-click agent template gallery (`agentTemplates.ts` — pre-governed presets), workspace data export (`dataExport.ts`, owner/admin JSON download), URL-persisted task filters across all four views (Active/Mine/Unassigned/Blocked/Needs-approval + priority, shareable), and fleet cost visibility (`agents.fleetSpend` — 7/30-day spend + top spenders). Consistency polish: `title-rule` headers and `.lift`/`Stagger` card motion brought to parity on the personal page.
- **Phase 19:** Marketing site rebrand. Multi-page sales site on the cream/sage "blurred meadow" aesthetic: scroll-expanding blurred pill header with Features/Use-cases/Resources mega menus and a full-screen staggered mobile menu; home page as a scroll-animated narrative (depth-of-field floating-mock hero with parallax + idle float, runtime marquee, label-top stat wall, a pinned scrollytelling "first handoff" story driven by useScroll, tinted-row "coordination layer" showcase, dark governance panel, featured-story + StatTile social proof, ChatBubble accents); anchored /features; six industry /use-cases pages + four built-out /resources guides (incl. changelog) rendered from content libs; /company (about redirects); pricing rebuild with animated FAQ; animated CSS/SVG product illustrations (no external assets); SEO: per-page metadata + canonicals, JSON-LD, sitemap.ts, robots.ts, metadataBase.

## Known limitations (not bugs)

- The committed `convex/_generated/` is a hand-rolled stub. Until you run `npx convex dev`, `useQuery`/`useMutation` calls return without strict argument checking on individual functions. Once the CLI overwrites it, full type safety kicks in.
- Resend has no email flows wired — the wrapper exists but no template/sender code is built.
- PWA icons are SVG-only; some Android variants prefer PNGs. Convert and add `/public/icon-192.png`, `/public/icon-512.png` for full coverage.
- Serwist's runtime caching uses the default policy (network-first navigation, stale-while-revalidate for static). Convex's WebSocket bypasses fetch entirely so live queries resume the moment the network returns; queued mutations are replayed by the Convex client on reconnect.
- Status column reorder is wired in Convex (`listStatuses.reorder`) but no drag-and-drop UI yet for status columns themselves; tasks within columns ARE draggable via Board view.
- No saved-view configs yet (filter/sort/group selections don't persist). View choice is in the URL via `?view=`, but other settings reset on reload.
- Calendar and Gantt are read-only — no drag-to-reschedule. Edit a task's date from the task detail page or List view.
- Inbox doesn't yet deep-link from a task mention back to its list page (would require a task → list resolver query). Workspace chat mentions deep-link correctly.
- Mentions don't trigger email yet — Resend is wired but no notification flow has been built.
- Docs and whiteboards save with last-write-wins (debounced). No CRDT collab yet; concurrent editors can clobber each other's changes.
- tldraw is loaded with `next/dynamic` (`ssr: false`) so it only ships on the whiteboard route. Its license requires keeping the watermark unless you have a commercial license — we currently keep the default watermark.
- The Reports query (`reports.workspaceSummary`) walks the workspace tree (spaces → folders → lists → tasks) and joins time entries per task. It's O(tasks + entries) and fine at the sizes we target; needs cursors/pagination once any workspace grows beyond a few thousand tasks.
- Goals don't auto-update from tasks yet — progress is logged manually. Auto-rollup ("complete X tasks in list Y") is a follow-up.
- Reports widget layout is fixed; users can't add/remove/rearrange widgets yet.
- Automations are evaluated event-driven only — no scheduled (time-based) triggers like "every Monday at 9am" yet. Use Convex crons for that when needed.
- Automation actions are primitives that call `db.patch` directly. They don't re-enter `tasks.update`, so a `set_status` action that points at a complete-category status won't re-fire `status_changed_to_complete` automations or recurrence in the same call.
- The `assign_user` automation accepts a Clerk user ID; the list-settings UI uses a free-text input rather than a member picker. Add member-aware UI alongside Phase 10 (Teams Hub).
- Email send actions (`notifications.ts`) read `RESEND_API_KEY` and `RESEND_FROM_EMAIL` at invocation time. Without those env vars set on the Convex deployment, the action logs and no-ops — no mutation rollback. Inbound email (turning replies into comments) is not built yet.
- Clips use the browser's `getDisplayMedia` + `MediaRecorder`. Browser support varies: Safari handles screen capture but not always with mic; Firefox/Chrome/Edge are fine. The recorder picks the first supported `mimeType` from a small candidate list (vp9 → vp8 → webm → mp4).
- AI requires `OPENAI_API_KEY` set on the Convex deployment (`npx convex env set OPENAI_API_KEY sk-...`). Without it, every AI action returns a polite "AI is not configured" message rather than crashing.
- Convex vectorSearch's filter API only takes a single `.eq()` per call; we filter on `scopeId` alone (Clerk subjects and Convex workspace IDs never collide) rather than chaining `scopeType + scopeId`.
- Comments aren't indexed yet — search is doc + task only. Adding messages would multiply embedding traffic; defer until needed.
- Brain "source" links navigate to docs but not tasks (a task → list resolver query is still missing). Same gap as the inbox.
- The Teams Hub task link in the "Now" pill uses a placeholder listId (`_`) because the `task → listId` resolver isn't built yet — clicking it doesn't navigate cleanly. Replace once the resolver lands.
- List templates live as code in `convex/templates.ts`. To add a new template, append to the `LIST_TEMPLATES` array and redeploy — there's no admin UI for creating templates from existing lists yet.
- Slack is currently the only integration. Adding more (Google Drive, GitHub, etc.) means a new `kind` literal on the integrations table plus a `notifications.post*` action.
- Agent API keys travel as function arguments (`apiKey`) rather than headers, so they can appear in Convex function logs. Keys are hashed at rest and revocable; treat deployment log access as sensitive.
- `webhookSubscriptions.secret` defaults to a `Math.random`-derived value when the caller doesn't supply one (Convex mutations have no CSPRNG). Callers that care should pass their own high-entropy `secret` — the UI and MCP tool both support it.
- Task claims are advisory (soft locks with a 60-minute TTL), not enforced on writes: a claim signals "someone is working on this", it doesn't block edits. The watchdog auto-releases expired claims.
- `agentApi.listTasks`/`searchTasks` without a `listId` walk every list in the agent's scope — fine at target scale, needs pagination beyond a few thousand tasks (same story as `reports.workspaceSummary`).
- The human activity feed merges at most the newest 100 rows per scope.
- MCP auth verifies the bearer key once per request via `agentApi.whoami`, then each tool call re-validates — two key lookups per tool call. Cheap (single indexed read) but worth a cache if traffic grows.
- Sprints require workspace-scoped agents; personal-space agents can't create them (there's no workspace to attach them to).
