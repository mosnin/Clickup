# Loop progress — "until we blow ClickUp out of the water"

Live log for the `/loop` skill. Each iteration:
1. Reads this file
2. Picks the top unshipped item from the queue
3. Ships it on its own branch
4. Opens a PR to `main`
5. Moves the item from "queue" to "shipped" and appends notes
6. Schedules the next wakeup

## Shipped

### Iteration 1 — Task dependencies (`claude/loop-1-task-dependencies`)

ClickUp parity gap closed. New `tasks.blockedByTaskIds: v.optional(v.array(v.id("tasks")))` on the schema. Three new server functions in `convex/tasks.ts`:
- `addBlocker(taskId, blockerTaskId)` — same-list constraint, 20-blocker cap, cycle detection via `wouldCreateCycle` DFS.
- `removeBlocker(taskId, blockerTaskId)` — idempotent.
- `blockerStatusFor(taskId)` — returns `{ blockers, blocking, isBlocked }`. `isBlocked` is true when any blocker's status category is not `complete`/`closed`. Reverse direction (`blocking`) computed by scanning siblings on the same list.

UI:
- New `<BlockerSection>` on task detail (`src/app/dashboard/l/[listId]/t/[taskId]/task-detail.tsx`) — chip list + picker + reverse "This blocks" panel + Blocked badge.
- Lock icon in list view next to blocked task titles.
- `purgeTaskTree` cascade now strips dangling blocker refs from siblings before the task vanishes.

## Queue (ordered by impact × ship-ability)

1. **AI rate-limits + cost tracking** — production-blocker. Per-user daily quota in a new `aiUsage` table, gated by a helper before every OpenAI call in `convex/ai.ts`. Free tier: 30 quickTask, 50 brainSearch, 50 writerContinue, 30 taskAutofill per day. Pro tier: unlimited. Surface a friendly error and a small "AI usage" pill on the dashboard.

2. **Pagination on the long-tail queries** — `convex/trash.ts` daily purge and `convex/reports.ts` workspace summary both `.collect()` whole tables. Move to cursor-based pagination (`paginate({numItems: 200})`) and process in batches.

3. **Public API v1** — Convex HTTP routes exposing `POST /api/v1/tasks`, `GET /api/v1/tasks`, `PATCH /api/v1/tasks/:id` with a per-workspace API key (new `apiKeys` table). Authenticated via `Authorization: Bearer <key>`.

4. **Outbound webhooks scaffold** — new `webhookEndpoints` table per workspace + `webhookDeliveries` log. Internal action `fanOutTaskEvent` called from `tasks.create / update` with `task.created`, `task.updated`, `task.completed` payloads. HMAC signed.

5. **Mention inbox deep-links to soft-deleted tasks** — currently breaks because `tasks.resolveLocation` returns null. Fall back to trash deep-link.

6. **Saved view configs** — filter/sort/group state stored per-(user, list) in a new `savedViews` table. URL stays the source of truth for the active view; saved views are presets.

7. **Two-way Slack** — Slack slash command via signed webhook. `/pace add <sentence>` invokes `ai.quickTask` and DMs the user a confirmation with the new task.

8. **Reports CSV export + custom date range** — `reports.workspaceSummary` already aggregates; add a `from/to` arg and a "Download CSV" client-side blob.

9. **Yjs compaction chunking** — `convex/yjs.ts` loads all pending updates into memory. Chunk by sequence range and merge incrementally.

10. **Automation cascade re-entry** — automation actions that change status should re-fire status-change triggers in the same transaction.

11. **Time-entry stop racy** — wrap in OCC retry (read-modify-write with version check).

12. **Vector search scope filter** — currently `scopeId` alone; chain `scopeType` when Convex supports compound filters or add a hash prefix to scopeId to make collision impossible.

13. **SSO / enterprise auth** — Clerk supports it; expose org-level SSO config in workspace settings (Enterprise tier later).

14. **Saved dashboards (Reports builder)** — let users add/remove/rearrange widgets.

## Notes

- Each iteration branches off `main` (not stacked anymore — main is the trunk).
- Each PR opens directly against `main` as draft.
- Loop wakes on a 25-minute heartbeat (`delaySeconds: 1500`).
- If an iteration finds the queue empty, it scans the codebase for new gaps and appends to queue.
- This file is the only state shared between iterations.
