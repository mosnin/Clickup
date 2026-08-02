# The Chat dashboard — phase plan

Fifteen phases, C0 through C14. Each is one commit-sized batch of work, each ends green
(`npm test`, `npm run build`, `npm run typecheck`), and each is independently
useful — you can stop after any of them and what exists works.

Sources: `01-core-comms.md` … `07-integration-map.md` in this directory, 12k
lines extracted from the Buzz repo. Decisions in `00-decisions.md`. Where a
phase says "spec §N", that is the section to build from — do not re-derive it
from the Buzz source, and do not invent an alternative.

## Ground rules for every phase

- **Namespaces.** `convex/buzz/*`, `src/app/chat/*`, `src/components/chat/*`,
  `src/lib/buzz/*`, `tests/buzz-*.test.ts`, `tests/ui/chat-*.test.tsx`. Anything
  outside those is an edit you can describe in one sentence and see in a
  three-line diff.
- **Off limits** (concurrent dynamic-UI build): everything listed in
  `07-integration-map.md` §9. Do not open those files, do not "fix" their tests.
- **Reuse, never fork.** `_authz.ts`, `_agentAuth.ts`, `events.ts`, `toast.tsx`,
  `motion.tsx`, `ui/*`, `lib/time.ts`, `lib/dates.ts` are stable dependencies of
  both builds. Import them; a small improvement to one is the most expensive
  merge conflict available.
- **One core per write path.** Buzz's own lesson and ours: a human posting a
  message and an agent posting a message go through the same function with a
  different `Actor`. A second code path for agents is how the two silently
  diverge.
- **Prove it.** Pure rules get a vitest file. Anything visual gets looked at.
  Anything gestural gets driven by a real pointer in Chromium
  (`scripts/verify-resize.mjs` is the pattern). "Tests pass" is not "it works".

---

## C0 — The event ✅

`convex/buzz/_nostr.ts` + `tests/nostr-protocol.test.ts`. Canonical
serialization, event id, BIP-340 signing inside a mutation, verification,
tag helpers, kind classification, replacement, filter matching. 31 tests.

## C1 — The switch and the shell ✅

`/chat` as a sibling shell with its own provider stack; the Work ⇄ Chat
switcher at the top of the Work sidebar; the attribute-scoped theme block and
the test that stops it overruling a reader's accessibility settings. 6 tests.

## C2 — The log and the identity layer

The substrate everything else sits on.

- `convex/buzz/_kinds.ts` — the kind registry from spec 06 §3: number, name,
  class, channel scope, tag conventions. Closed and enumerated; agents write
  into this log, so an unknown kind is refused, not stored.
- `convex/buzz/_tables.ts` — `buzzEvents`, `buzzEventTags` (the tag index —
  Convex cannot index an array of arrays, so tags are projected into rows) and
  `buzzKeys`. Composed into `convex/schema.ts` with a two-line change. Channels,
  memberships and read state arrive with the phases that need them: a schema
  written ahead of its first caller is a guess.
- `convex/buzz/keys.ts` — Node action minting a keypair per principal (human and
  agent), modelled on `agentKeys.createKey`. Private key server-side only.
- `convex/buzz/log.ts` — `publish` (validate → sign → replace-or-insert → index
  tags → fan out), `query` (filter → indexed read, never a scan), and the
  replacement transaction.
- Tenancy: community = workspace, enforced through `_authz.requireScopeAccess`.

**Proves:** replacement + tie-break under concurrency; the tenancy fence (an
event is unreachable from a workspace its author could not reach); every filter
shape resolves to an index; a malformed or unknown-kind event is refused.

## C3 — Channels, and the room's chrome

Spec 01 §1, spec 05 §1–§3.

The type × visibility × TTL matrix that encodes public / private / DM /
group-DM / ephemeral; create, join, leave, archive; the channel browser with its
eight-band fuzzy scorer and the pinned create-row; member lists and roles;
channel templates. Then the shell itself: the Buzz rail, the pane widths, the
top chrome, the route tree (`/chat/c/[id]`, `/chat/dm/[id]`), unread badges,
drag-reorder.

## C4 — Messages

Spec 01 §2–§3. The largest phase; likely two batches.

The edit-overlay projector; threading and the thread pane; drafts; optimistic
send with failure and retry; ordering with the id tie-break; cursor pagination
and virtualization; day and unread dividers; ten-minute grouping; system
messages. Then the composer (Tiptap, markdown, mentions, emoji picker, custom
emoji, attachment slot reservation) and the message actions — hover toolbar,
more-menu, optimistic reaction algebra, edit, delete, copy link.

## C5 — Read state, presence, typing, notifications, search

Spec 01 §4–§7. The read-state blob and its hierarchical frontier; the
forced-unread overlay; the sidebar unread algorithm; presence at 60s/180s;
typing at 8s TTL and 3s throttle; the notify predicate's nine-step ordering and
its eleven-item suppression list; the search operator grammar and hit→destination
routing.

## C6 — Agents in the room

Spec 02. Reuses our `agents` table, governance, budgets and runs rather than
forking them — the agent gains a keypair and a channel membership, not a second
identity. Attach and reuse; mentionability; the turn (trigger → run → streamed
output → cancel → error); the working signal; the activity transcript with tool
classification and burst collapsing; agent memory. MCP tools so an agent can
read and post in channels with the key it already has.

The turn runs on the agent's own runtime (D9): a mention pings `notifyUrl`, the
agent answers over MCP. Nothing is executed server-side. A new agent is
therefore silent until somebody runs a harness for it — the connect flow has to
say that plainly, or the room reads as broken.

## C7 — Forum, canvases, reminders, moderation, pulse

Spec 03 §3–§6, spec 04 §3. Forum posts; the canvas (one markdown doc per
channel — our Pages editor already is this); reminders with presets and snooze;
the moderation queue with reports and commands; the Pulse activity dashboard's
six tabs.

## C8 — Workflows

Spec 03 §1. The YAML schema — five triggers, seven actions, template variables
and filters, the expression evaluator (hand-rolled, never `eval`, same rule as
our formula parser), approval gates, the runs list and run detail, the
form⇄YAML builder. Two inconsistencies in Buzz's own source are flagged in the
spec; we pick one and say which.

## C9 — Projects, branch-as-room

Spec 03 §2. Repo announcements, patches, status events, CI results posting,
review and merge decisions, the project screens.

## C10 — Media

Spec 04 §2. Upload through Convex file storage; the `imeta` tag shape;
thumbnails and blurhash; progressive images; the FLIP lightbox and gallery; the
video player; and frame-anchored video comments — a thread reply whose body is
prefixed `[MM:SS.d] `, which is the whole trick.

## C11 — Huddles

Spec 04 §1. Audio rides a managed SFU (D6); everything above it is ours and
matches Buzz — a huddle is a room announced by signed events, membership is the
channel's membership, and an agent joins the way a person does. Lifecycle events
and kinds, the roster, the bar and every control, speaking indicators,
push-to-talk, reactions, transcript, add-an-agent. The SFU is a pipe for frames
behind one adapter, never the source of truth for who is in the room.

## C12 — The bridge

The reason both dashboards are one product.

- **Tasks ↔ channels.** One literal added to `_refs.REF_KINDS`; a channel bound
  to a project posts its task events; a message becomes a task without leaving
  the room.
- **One inbox.** One literal added to `mentions.parentType`; approvals,
  reminders, mentions and unreads are one queue, and the switcher badges the
  other side.
- **One search, one activity log.** ⌘K and search span messages, tasks, pages
  and events; Chat writes to the same `events` table Work reads.
- **One fleet.** Already true after C6 — this phase is where it becomes visible:
  an agent working a task shows as working in the channel.

## C13 — The desktop app

Tauri wrapping the deployed URL, same remote-web-app pattern `capacitor.config.ts`
already uses for iOS and Android (D10). Window chrome, the tray menu, desktop
notifications, deep links, and a release pipeline for macOS/Windows/Linux.

## C14 — Mobile, motion, and a verification pass

390px through 1280px on every surface; the motion primitives applied; the
gallery run and the PNGs actually looked at; a Playwright pass over the
gestures (drag-reorder, the composer, the huddle bar).

---

## What is deliberately not in scope

Called out so it is a decision rather than an omission:

- **The local archive (SQLite) and identity archive.** Both are desktop-native
  features solving a problem — offline sovereignty over your own copy — that our
  hosted model answers differently.
- **Mesh compute** and the on-device STT/TTS voice models (~250–400 MB of
  pinned model weights, client-side). Out until someone asks.
- **The Nostr wire protocol itself.** We store real Nostr events; we do not
  serve a relay over WebSocket. If interop matters later, the log is already the
  right shape and it becomes an export endpoint rather than a rewrite.
