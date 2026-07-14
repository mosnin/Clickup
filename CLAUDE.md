# CLAUDE.md

Guidance for Claude Code (and other AI assistants) working in this repository.

## What this is

A ClickUp-style productivity app: tasks, docs, goals, chat — for individuals and teams. Each account has one **personal space** (private to the user) and zero or more **team workspaces** (shared with members). The current commit is a working scaffold with the marketing site, auth flow, onboarding, and dashboard shell wired up; most domain features (tasks, docs, etc.) are not yet implemented.

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
│   ├── schema.ts                 # users, workspaces, memberships, spaces, folders, lists, listStatuses, customFields, taskFieldValues, tasks, messages, mentions, docs, whiteboards, agents, agentKeys, events, webhookSubscriptions, webhookDeliveries, sprints, scheduledTasks, skills
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
│   ├── agentApi.ts               # agent-facing API: ~40 key-authenticated functions the MCP server calls
│   ├── agentAi.ts                # key-authenticated semantic search (Node runtime, OpenAI embeddings)
│   ├── events.ts                 # append-only activity log: emitEvent() + human feed query
│   ├── webhooks.ts               # webhook subscription CRUD + delivery bookkeeping
│   ├── webhookDelivery.ts        # Node action: HMAC-SHA256-signed POSTs with retries/backoff/auto-disable
│   ├── sprints.ts                # workspace-level sprints + per-sprint task rollup
│   ├── scheduledTasks.ts         # time-based recurring task definitions + cron materializer
│   ├── crons.ts                  # 15-min crons (materialize schedules, watchdog) + daily retention prune
│   ├── maintenance.ts            # watchdog (expired claims, overdue tasks, stalled agents) + retention pruning
│   ├── channels.ts               # topic channels (messages with parentType "channel") for agent↔agent threads
│   ├── onboarding.ts             # completeSetup: workspace + HQ + "Getting started" tasks + first agent in one transaction
│   └── skills.ts                 # built-in skill playbooks (code) + custom skills (table) merged per scope
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
│   │   ├── (marketing)/          # logged-out site
│   │   │   ├── layout.tsx        # PillHeader + PillFooter
│   │   │   ├── page.tsx          # /
│   │   │   ├── features/page.tsx
│   │   │   ├── pricing/page.tsx
│   │   │   └── about/page.tsx
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
│   │   ├── marketing/pill-header.tsx
│   │   ├── marketing/pill-footer.tsx
│   │   ├── dashboard/sidebar.tsx # tree of personal+team workspaces; Inbox link with unread badge
│   │   ├── dashboard/ensure-user.tsx # idempotent client bootstrap of user row
│   │   ├── dashboard/status-pill.tsx # colored pill for a listStatuses row
│   │   ├── dashboard/custom-field-input.tsx # type-aware editor for custom field values
│   │   ├── dashboard/comments.tsx # threaded comments + chat composer with @-popover (agents mentionable too)
│   │   ├── dashboard/sprints-panel.tsx # workspace Sprints tab: create/start/complete, progress, task rollup
│   │   ├── dashboard/task-collab.tsx # task-page sections: banners, assignees, sprint, checklist, blocked-by (composable exports)
│   │   ├── dashboard/inline-create.tsx # in-place naming input (the replacement for window.prompt)
│   │   ├── dashboard/agent-online-watcher.tsx # toasts an agent's first heartbeat, app-wide
│   │   └── register-service-worker.tsx
│   └── lib/
│       ├── utils.ts              # cn(): clsx + tailwind-merge
│       ├── resend.ts             # lazy Resend client (server-only)
│       ├── mentions.ts           # parse/format `@[Name](clerkId)` mention tokens
│       ├── time.ts               # timeAgo() — the one relative-time voice
│       ├── dates.ts              # local-time <input type=date> round-trips (no UTC off-by-one)
│       └── event-labels.ts       # humanized event phrasing + eventHref deep links
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
- `customFields` — per-list field definitions. `type` is one of `text | number | dropdown | date | checkbox`. Dropdown rows carry an `options` array.
- `taskFieldValues` — sparse value rows keyed by `(taskId, fieldId)`. The four optional `*Value` columns hold the typed primitive; dropdown stores its option id in `textValue`.
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
- **Brand system (Phase 15 rebrand).** Monochrome editorial + pastel accents: the dashboard renders as a white sheet on the gray `bg-page` canvas (see `dashboard/layout.tsx`); ink is near-black with hairline `border-border` dividers; the primary CTA is a solid black pill (`Button` primary); active segments in pill navs are black with white text; meaning is carried by pastel chips (`--color-pastel-*` tokens; status/priority hexes are pastel with dark ink on top); page titles are bold with a `title-rule` hairline underneath; micro-labels are tiny uppercase tracking-wider gray. Buttons/chips stay `rounded-full`, cards are `rounded-2xl`, sidebar rows `rounded-lg`. Don't reintroduce saturated fills — green is reserved for positive deltas.
- **Motion system (`src/components/motion.tsx`, built on `motion/react`).** One easing (`EASE`, a long-tail ease-out) and one spring (`SPRING`) everywhere. Primitives: `Reveal` (fade + rise + un-blur), `Stagger`/`StaggerItem` (50ms cascades for grids/lists), `AnimatedNumber` (springy count-up for stat tiles), `AnimatedBar` (progress fills), `PresenceDot` (radiating ping). Route transitions live in `dashboard/template.tsx`; tab switches re-mount a keyed `motion.div`; the sidebar's active pill morphs between links via `layoutId="sidebar-active"`; lists animate entrances (and exits via `AnimatePresence` where rows can disappear — approvals, checklist). Buttons press-scale via CSS; interactive cards use the `.lift` utility. Everything must respect reduced motion (`MotionConfig reducedMotion="user"` + the `.lift` media query) — keep new animations inside these primitives rather than inventing new timings.
- **Feedback system (Phase 18).** Never use `window.prompt`/`window.confirm`/`window.alert`. Naming something new = `InlineCreate` in place; destructive actions = hide the row locally and `toast(msg, { action: {label: "Undo", …}, onExpire: commit })` from `useToast()` — the mutation only runs when the undo window closes; quiet saves (blur-persisted fields) confirm with a success toast; refused mutations surface a `kind: "error"` toast with the server's reason. `ToastProvider` is mounted once in the dashboard layout (as are the ⌘K `CommandPalette` and `AgentOnlineWatcher`). Use the `Picker` component instead of native `<select>` whenever options are people, agents, tasks, or sprints. Use `timeAgo` from `@/lib/time` and the date-input helpers from `@/lib/dates` (never `toISOString().slice(0, 10)` — it's off by a day across timezones). Small icon buttons get the `.tap-target` class for a ~44px touch area.
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
- **Phase 18 (current):** UX polish pass. Feedback system: app-wide toasts (`src/components/toast.tsx`) with undo-able deferred deletes replacing every `window.confirm`, and inline in-place creation (`inline-create.tsx`) replacing every `window.prompt`; blur-saving governance fields confirm with a "Saved" toast. ⌘K command palette (quick-switch to any list/doc/board/workspace/agent, plain-text task search via `tasks.quickSearch`, two-step task quick-create). Searchable `Picker` popover replacing native selects for assignees/blockers/sprints. Task page rebuilt two-column (content left, state rail right) with a springy completion moment (optimistic `toggleComplete` in the list view). Local-time date handling (`lib/dates.ts`), one `timeAgo` (`lib/time.ts`), shared humanized event labels (`lib/event-labels.ts`). `agent.connected` event on first heartbeat + app-wide first-connection toast + self-retiring connect hint + Home waiting-card resolve animation. Mobile: `.tap-target` hit-area utility, horizontally scrollable pill tab rows. Content-shaped skeletons on list/task/agents/inbox/agent-detail.

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
