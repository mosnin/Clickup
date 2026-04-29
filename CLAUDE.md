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
| PWA          | Plain `manifest.webmanifest` + `public/sw.js` (no library)  |

## Directory layout

```
.
├── convex/                       # Convex backend — typechecked separately by Convex CLI
│   ├── _generated/               # checked in (CLI overwrites on `convex dev`/`deploy`)
│   ├── _authz.ts                 # shared auth helpers (require*Access, requireMessageParentAccess)
│   ├── schema.ts                 # users, workspaces, memberships, spaces, folders, lists, listStatuses, customFields, taskFieldValues, tasks, messages, mentions
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
│   └── mentions.ts               # unread mention queries + markRead/markAllRead
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
- **Phase 4 (current):** Threaded task comments + workspace chat, @mentions with inline picker, assigned comments, /dashboard/inbox with unread badge in the sidebar. Realtime is automatic via Convex `useQuery` subscriptions.
- **Phase 5:** Docs (Tiptap/Lexical) + Whiteboards (tldraw).
- **Phase 6:** Time tracking + Goals + Dashboards/widgets.
- **Phase 7:** Automations + recurring tasks.
- **Phase 8:** Email integration + Clips (screen recording).
- **Phase 9:** AI (Brain) — knowledge search, task auto-fill, summaries, writer.
- **Phase 10:** Templates + 3rd-party integrations + Teams Hub.
- **Phase 11:** Offline-first PWA polish + native app wrappers.

## Known limitations (not bugs)

- The committed `convex/_generated/` is a hand-rolled stub. Until you run `npx convex dev`, `useQuery`/`useMutation` calls return without strict argument checking on individual functions. Once the CLI overwrites it, full type safety kicks in.
- Resend has no email flows wired — the wrapper exists but no template/sender code is built.
- PWA icons are SVG-only; some Android variants prefer PNGs.
- Status column reorder is wired in Convex (`listStatuses.reorder`) but no drag-and-drop UI yet for status columns themselves; tasks within columns ARE draggable via Board view.
- No saved-view configs yet (filter/sort/group selections don't persist). View choice is in the URL via `?view=`, but other settings reset on reload.
- Calendar and Gantt are read-only — no drag-to-reschedule. Edit a task's date from the task detail page or List view.
- Inbox doesn't yet deep-link from a task mention back to its list page (would require a task → list resolver query). Workspace chat mentions deep-link correctly.
- Mentions don't trigger email yet — Resend is wired but no notification flow has been built.
