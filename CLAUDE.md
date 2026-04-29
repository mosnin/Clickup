# CLAUDE.md

Guidance for Claude Code (and other AI assistants) working in this repository.

## What this is

**Pace** — a productivity app whose one job is to not slow you down. Tasks, docs, chat, goals, all the usual surfaces, but the product position is **speed**: ⌘K everywhere, AI that takes action, mobile-first interactions, instant-feeling realtime.

The codebase is still a ClickUp-style hierarchy under the hood: each account has one **personal space** (private to the user) and zero or more **team workspaces** (shared with members). The brand is Pace; the architecture is what we built across phases 0–11.

**Identity guardrails for future agents:**
- The product name is **Pace** — never "ClickUp Clone" in user-facing copy.
- Tagline: *"Find your pace."* / *"The work app that gets out of your way."*
- The differentiator is **speed**, not feature parity. New features either make the user faster or stay out of the way. If a change can't justify itself on those terms, push back.
- Palette: emerald (`--color-brand-*` resolves to emerald) primary, amber (`--color-accent-*`) for AI / urgency / the leading dot in the mark.
- Voice: terse, confident. Empty states *teach* (mention `⌘K`, point at a template). Buttons say what they do. Errors are honest.

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
│   ├── schema.ts                 # users, workspaces, memberships, spaces, folders, lists, listStatuses, customFields, taskFieldValues, tasks, messages, mentions, docs, whiteboards
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
│   └── team.ts                   # Teams Hub: per-member workload + week stats + currently-running timer
├── public/
│   ├── manifest.webmanifest
│   ├── icon.svg / icon-maskable.svg
│   └── sw.js                     # minimal service worker (no caching strategy)
├── src/
│   ├── middleware.ts             # Clerk middleware; protects /dashboard, /onboarding
│   ├── app/
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
│   │   ├── onboarding/           # first-run team workspace setup
│   │   │   ├── page.tsx
│   │   │   └── onboarding-form.tsx
│   │   └── dashboard/            # logged-in app shell
│   │       ├── layout.tsx        # sidebar + main; auth-guarded; renders <EnsureUser />
│   │       ├── page.tsx          # overview
│   │       ├── personal/page.tsx # user's personal space view
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
│   │   ├── marketing/pill-header.tsx
│   │   ├── marketing/pill-footer.tsx
│   │   ├── dashboard/sidebar.tsx # tree of personal+team workspaces; Inbox link with unread badge
│   │   ├── dashboard/ensure-user.tsx # idempotent client bootstrap of user row
│   │   ├── dashboard/status-pill.tsx # colored pill for a listStatuses row
│   │   ├── dashboard/custom-field-input.tsx # type-aware editor for custom field values
│   │   ├── dashboard/comments.tsx # threaded comments + chat composer with @-popover
│   │   └── register-service-worker.tsx
│   └── lib/
│       ├── utils.ts              # cn(): clsx + tailwind-merge
│       ├── resend.ts             # lazy Resend client (server-only)
│       └── mentions.ts           # parse/format `@[Name](clerkId)` mention tokens
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

**Authorization** is centralized in `convex/_authz.ts`. Every read/write resolves up the hierarchy (task → list → folder?/space → workspace?/user) and calls `canAccessSpace` to confirm either personal ownership or workspace membership. Use `requireListAccess`/`requireSpaceAccess`/`requireFolderAccess` rather than re-rolling checks in each function.

- Public mutations: anything end-user invokable (`workspaces.create`, `tasks.update`, etc.).
- Internal mutations: `users.upsertFromClerk`, `users.deleteFromClerk` — only callable from `convex/http.ts`. Never expose them.

## Conventions

- **TypeScript everywhere.** No `any` unless you can explain why in a comment.
- **Server vs. client components.** Default to server. Add `"use client"` only when you need state, effects, browser APIs, or Clerk hooks (`useUser`, etc.).
- **Routing.** Marketing routes live in `(marketing)`, auth routes in `(auth)`, app routes under `/dashboard`. Add new auth-guarded routes either inside `/dashboard` or extend `isProtectedRoute` in `src/middleware.ts`.
- **Styling.** Tailwind utilities only. Use `cn()` from `@/lib/utils` for conditional classes. Theme tokens live in `globals.css` under `@theme` — extend there, not via inline arbitrary values.
- **Pill aesthetic.** Buttons use `rounded-full`. Header/footer cards use `rounded-3xl` or `rounded-[2rem]`. Keep the rhythm consistent.
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
- **Polish (post-phase-11):** Task → list resolver, comment indexing in Brain, member picker for `assign_user`, calendar drag-to-reschedule, last-used view persisted per list, sharp-generated PNG icons.
- **Pace Step 0 (current):** Rebrand — name, emerald palette, voice, marketing rebuild, onboarding copy. Shared `<PaceMark />` / `<PaceWordmark />` brand component used at every entry point (pill header, pill footer, sidebar, auth, onboarding).
- **Pace Step 1 (current):** Command palette + keyboard shortcuts. `convex/search.ts` palette query (cross-table substring search across tasks/lists/docs/whiteboards/people, scoped to the user's personal + workspace memberships). `<CommandPaletteProvider />` + `<KeyboardShortcuts />` mounted in the dashboard layout. ⌘K opens the palette anywhere, `/` opens it from outside text inputs, `?` toggles a cheat sheet. Sidebar gains a Search button with the ⌘K affordance.

## Known limitations (not bugs)

- The committed `convex/_generated/` is a hand-rolled stub. Until you run `npx convex dev`, `useQuery`/`useMutation` calls return without strict argument checking on individual functions. Once the CLI overwrites it, full type safety kicks in.
- Resend has no email flows wired — the wrapper exists but no template/sender code is built.
- PNG icon variants (192/512/maskable) are generated via `scripts/generate-icons.mjs` (sharp) as a `prebuild` step. They're gitignored — `next build` always emits fresh ones from the SVG source.
- Serwist's runtime caching uses the default policy (network-first navigation, stale-while-revalidate for static). Convex's WebSocket bypasses fetch entirely so live queries resume the moment the network returns; queued mutations are replayed by the Convex client on reconnect.
- Status column reorder is wired in Convex (`listStatuses.reorder`) but no drag-and-drop UI yet for status columns themselves; tasks within columns ARE draggable via Board view.
- No saved-view configs yet (filter/sort/group selections don't persist). View choice is in the URL via `?view=`, but other settings reset on reload.
- Gantt is read-only — no drag-to-reschedule there yet. Calendar supports drag-to-reschedule (and drag-to-undated to clear).
- Saved view configs persist on the client only (per-list, in localStorage). Move to a server-side `lists.defaultView` field if cross-device persistence is needed.
- Mentions don't trigger email yet — Resend is wired but no notification flow has been built.
- Docs and whiteboards save with last-write-wins (debounced). No CRDT collab yet; concurrent editors can clobber each other's changes.
- tldraw is loaded with `next/dynamic` (`ssr: false`) so it only ships on the whiteboard route. Its license requires keeping the watermark unless you have a commercial license — we currently keep the default watermark.
- The Reports query (`reports.workspaceSummary`) walks the workspace tree (spaces → folders → lists → tasks) and joins time entries per task. It's O(tasks + entries) and fine at the sizes we target; needs cursors/pagination once any workspace grows beyond a few thousand tasks.
- Goals don't auto-update from tasks yet — progress is logged manually. Auto-rollup ("complete X tasks in list Y") is a follow-up.
- Reports widget layout is fixed; users can't add/remove/rearrange widgets yet.
- Automations are evaluated event-driven only — no scheduled (time-based) triggers like "every Monday at 9am" yet. Use Convex crons for that when needed.
- Automation actions are primitives that call `db.patch` directly. They don't re-enter `tasks.update`, so a `set_status` action that points at a complete-category status won't re-fire `status_changed_to_complete` automations or recurrence in the same call.
- The `assign_user` automation list-settings UI now uses a member picker driven by `lists.membersForList`.
- Email send actions (`notifications.ts`) read `RESEND_API_KEY` and `RESEND_FROM_EMAIL` at invocation time. Without those env vars set on the Convex deployment, the action logs and no-ops — no mutation rollback. Inbound email (turning replies into comments) is not built yet.
- Clips use the browser's `getDisplayMedia` + `MediaRecorder`. Browser support varies: Safari handles screen capture but not always with mic; Firefox/Chrome/Edge are fine. The recorder picks the first supported `mimeType` from a small candidate list (vp9 → vp8 → webm → mp4).
- AI requires `OPENAI_API_KEY` set on the Convex deployment (`npx convex env set OPENAI_API_KEY sk-...`). Without it, every AI action returns a polite "AI is not configured" message rather than crashing.
- Convex vectorSearch's filter API only takes a single `.eq()` per call; we filter on `scopeId` alone (Clerk subjects and Convex workspace IDs never collide) rather than chaining `scopeType + scopeId`.
- Brain indexes docs, tasks, and messages (comments + chat). Embedding traffic scales with message volume; throttle if it becomes expensive.
- List templates live as code in `convex/templates.ts`. To add a new template, append to the `LIST_TEMPLATES` array and redeploy — there's no admin UI for creating templates from existing lists yet.
- Slack is currently the only integration. Adding more (Google Drive, GitHub, etc.) means a new `kind` literal on the integrations table plus a `notifications.post*` action.
