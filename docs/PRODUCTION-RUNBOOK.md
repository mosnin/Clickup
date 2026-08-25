# Production runbook

The ops checklist for `www.operate.to`. Code changes do not replace setting
these values. Counsel review and directory submissions are owner-only.

Work + Agents + MCP is the GA surface. Chat (`/chat`) is beta: rooms work
without Ably or an SFU; huddle audio and Pulse search stay off until they
are real.

## Scale thresholds

| Workspace size | Expectation |
| -------------- | ----------- |
| A few hundred tasks | Comfortable today |
| 10k tasks / 100 lists / 50 agents | Must work (pagination + rollups) |
| 100k tasks | Needs the maintained rollup tables, not just cursors |

## Convex env (`npx convex env set`)

Required for an honest production:

- `CLERK_WEBHOOK_SECRET` — Clerk → Convex user sync
- `PLATFORM_ADMIN_EMAILS` — comma-separated; the admin console has no root of trust without this
- `RESEND_API_KEY` + `RESEND_FROM_EMAIL` — mention / assignment / invite / approval / due-soon. Unset = silent no-op
- `OPENAI_API_KEY` — embeddings, Brain, autofill, panel intent. Unset = polite refusal
- `DEVICE_PROXY_SECRET` — **same value on Next and Convex**. Without it, unauthenticated device-code creation can flood storage
- `OPERATE_PUBLIC_URL=https://www.operate.to` if not already the default

Decide, do not default:

- **x402** — leave metering OFF until `X402_FACILITATOR_URL` and `X402_PAY_TO` (mainnet, not `base-sepolia`) are set. Never set `X402_ALLOW_MOCK` in production. Billing UI already shows setup-incomplete
- **Ably** — optional. Unset is supported; Chat header reads `convex`. Set `ABLY_API_KEY` for typing / presence
- **Huddle SFU** — do not configure until Chat leaves beta
- **Sentry** — set `SENTRY_DSN` on Convex Node actions and `NEXT_PUBLIC_SENTRY_DSN` / `SENTRY_DSN` on Vercel. Unset = console only

## Vercel env

Every `NEXT_PUBLIC_*` key from `.env.example`, plus:

- `CONVEX_DEPLOY_KEY`
- `CLERK_SECRET_KEY`
- `NEXT_PUBLIC_APP_URL=https://www.operate.to`
- `DEVICE_PROXY_SECRET` (same as Convex)
- `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` when tracking is on

## Owner-only (cannot be coded)

1. **Counsel review** of `src/lib/legal.ts` (Terms, Privacy, AUP, Cookies, Subprocessors, Security, DPA). Every legal page still shows `LEGAL_DISCLAIMER`. Remove that banner only after counsel signs off.
2. **ChatGPT / Claude directory submit** — bundles and live OAuth are certified; portal attestations and Anthropic org-tier access are blocked on the owner. See `docs/plugin-submission/`.
3. **Credential rotation** — revoke any keys exposed during the July 2026 certification loop.
4. **Vercel Firewall** — rate-limit `POST /api/mcp` at the edge (the app also has an in-process cap). Per-agent budgets do not stop unauthenticated key-guessing load.

## Bounded reads

- MCP `list_tasks` / `search_tasks` return `{ …, continueCursor, isDone }`.
- Inbox feed pages 100 mentions. Human list views take at most 2000 tasks.
- Reports/Home use `listRollups` (write-path + nightly reconcile).
- Workspace export is one space per page, 500 tasks per list.

## After every production deploy

1. `GET https://www.operate.to/api/health` — application + Convex `ok`, plus config-presence flags
2. Hosted MCP discovery (`scripts/smoke-mcp.mjs` against a one-use key)
3. Vercel runtime error logs empty
4. Sentry (if configured) quiet for the release

## Backup / disaster recovery

Convex owns the system of record. The exercise:

1. Export a **staging** deployment from the Convex dashboard (not production)
2. Restore into a throwaway staging deployment
3. Confirm `/api/health` is `ok`, MCP `whoami` works, and one task reads back
4. Record the date and the restore target in `docs/operate-completion-audit.md`

Do not mark DR proven from this document alone.

## x402 go-live

Only when a real facilitator and receiving wallet exist:

1. Set `X402_FACILITATOR_URL`, `X402_NETWORK` (mainnet), `X402_PAY_TO`
2. Confirm `X402_ALLOW_MOCK` is unset
3. Superadmin enables metering in the admin Billing tab
4. Certify pay → settle → credit → meter → deplete → top-up → resume
5. Log the run in `docs/operate-completion-audit.md`
