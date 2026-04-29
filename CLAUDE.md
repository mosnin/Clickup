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
│   ├── schema.ts                 # users, workspaces, memberships, spaces
│   ├── auth.config.ts            # Clerk JWT integration
│   ├── http.ts                   # Clerk webhook -> internal mutations
│   ├── users.ts                  # internal upsert/delete + `current` query
│   ├── workspaces.ts             # create + listForCurrentUser
│   └── spaces.ts                 # personal/workspace space CRUD
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
│   │       ├── layout.tsx        # sidebar + main; auth-guarded
│   │       ├── page.tsx          # overview
│   │       ├── personal/page.tsx
│   │       └── w/[workspaceId]/page.tsx
│   ├── components/
│   │   ├── ui/button.tsx         # shadcn-style primitive (cva + Tailwind)
│   │   ├── marketing/pill-header.tsx
│   │   ├── marketing/pill-footer.tsx
│   │   ├── dashboard/sidebar.tsx # responsive: drawer on mobile, fixed on md+
│   │   └── register-service-worker.tsx
│   └── lib/
│       ├── utils.ts              # cn(): clsx + tailwind-merge
│       ├── resend.ts             # lazy Resend client (server-only)
│       └── mock-data.ts          # placeholder personal/team data — REMOVE once Convex queries are wired
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

- `users` — mirrored from Clerk via the webhook in `convex/http.ts`. Indexed by `clerkId`.
- `workspaces` — team workspaces. `ownerClerkId` is the creator.
- `memberships` — many-to-many between users and workspaces. Roles: `owner`, `admin`, `member`. Always check membership before returning workspace data.
- `spaces` — top-level containers. `parentType: "user" | "workspace"`. A user's personal space is auto-created on first webhook sync with `parentType: "user"`, `parentId: <clerkId>`.

**Authorization rules** (enforce in every Convex function):

- Any query/mutation that touches a workspace must verify the caller has a matching `memberships` row.
- Personal-space mutations may only be performed when `parentId === identity.subject`.
- The Clerk webhook is the only legitimate caller of `users.upsertFromClerk` / `users.deleteFromClerk` — keep these as `internalMutation`.

## Conventions

- **TypeScript everywhere.** No `any` unless you can explain why in a comment.
- **Server vs. client components.** Default to server. Add `"use client"` only when you need state, effects, browser APIs, or Clerk hooks (`useUser`, etc.).
- **Routing.** Marketing routes live in `(marketing)`, auth routes in `(auth)`, app routes under `/dashboard`. Add new auth-guarded routes either inside `/dashboard` or extend `isProtectedRoute` in `src/middleware.ts`.
- **Styling.** Tailwind utilities only. Use `cn()` from `@/lib/utils` for conditional classes. Theme tokens live in `globals.css` under `@theme` — extend there, not via inline arbitrary values.
- **Pill aesthetic.** Buttons use `rounded-full`. Header/footer cards use `rounded-3xl` or `rounded-[2rem]`. Keep the rhythm consistent.
- **Responsive.** Mobile-first; use `md:`/`lg:` for desktop. Test at 360px, 768px, and 1280px before merging UI changes. Sidebar uses a drawer pattern below `md`.
- **Apostrophes in JSX.** Escape as `&apos;` — `react/no-unescaped-entities` is enforced by `next lint`.
- **Convex imports.** From the Next.js tree, use `convex/react` and `convex/react-clerk` (runtime). Generated types under `convex/_generated/` are gitignored; they appear after `npx convex dev` runs and can then be imported (e.g. `import { api } from "../../../convex/_generated/api"`).

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

- **Don't commit anything to `convex/_generated/`** — it's regenerated by the Convex CLI.
- **Don't add an `api/webhooks/clerk` route in Next.js.** The webhook lives in Convex's HTTP router (`convex/http.ts`) so secrets stay server-side and we avoid a hop.
- **Don't make `users.upsertFromClerk` a public mutation.** Anyone could spoof identities.
- **Don't gitignore `.env.example`** — it's the template.
- **Don't introduce a new state library** (Redux, Zustand, etc.) for data that should live in Convex. Local UI state via `useState` is fine; persistent state should round-trip through Convex.
- **Don't replace mock data without wiring Convex queries.** `src/lib/mock-data.ts` is intentionally a stand-in; when removing it, swap the call sites for real `useQuery(api.*)` hooks in the same change.

## Open work (not yet done)

- Wire `useQuery(api.workspaces.listForCurrentUser)` into `DashboardSidebar`; remove `mockTeamWorkspaces`.
- Wire `useMutation(api.workspaces.create)` into `OnboardingForm`; navigate to `/dashboard/w/<id>` on success.
- Add a Resend email template + flow (e.g. workspace invite) — currently only the client wrapper exists.
- Replace SVG icons with PNG variants (192, 512, maskable) for full PWA-installability across browsers.
- Add task/list/doc models to `convex/schema.ts` and the corresponding UI in the dashboard.
