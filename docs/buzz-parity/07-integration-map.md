# Integration map — what the Chat dashboard plugs into

A survey of the existing codebase, written for the phases that build the Chat
(Buzz-modelled) dashboard beside the Work dashboard. Nothing here was changed;
every claim carries a `file:line`.

Read `docs/buzz-parity/00-decisions.md` first — this file answers "what is
already there and how do I attach to it", not "what are we building".

---

## 1. Shell & routing

### 1.1 What exists today

**`src/middleware.ts` (39 lines)** is the only auth gate.

- `isProtectedRoute` = `createRouteMatcher(["/dashboard(.*)", "/onboarding(.*)", "/invite(.*)"])` — `src/middleware.ts:5-9`.
- `isSelfAuthenticated` = `["/api/mcp", "/api/x402"]` — routes that carry their own bearer credential and must never see Clerk — `src/middleware.ts:19`.
- The default export short-circuits self-authenticated routes and otherwise runs `clerkMiddleware`, which calls `auth.protect()` for protected matches — `src/middleware.ts:21-31`.
- `config.matcher` already covers every non-static path (`"/((?!_next|.*\\..*|favicon.ico).*)"`) — `src/middleware.ts:33-38`, so a new top-level route group is *matched* already; it just isn't *protected*.

**`src/app/layout.tsx`** is the root: fonts (`next/font/local`, `--font-instrument` + `--font-darker-grotesque`) at `:83`, the pre-paint theme script that stamps `document.documentElement.dataset.theme` from `localStorage.theme` at `:88-93`, `<Providers>` at `:96`, plus `OfflineIndicator` and `RegisterServiceWorker`.

**`src/app/providers.tsx`** mounts `ClerkProvider` → `ConvexProviderWithClerk` and is *already global* (root layout), so a sibling route group inherits Convex + Clerk with zero work — `src/app/providers.tsx:14-26`. Note the deliberate null-client path when `NEXT_PUBLIC_CONVEX_URL` is unset (`:10`).

**`src/app/dashboard/layout.tsx` (93 lines)** — a server component. In order:

| Concern | Line | Notes |
| --- | --- | --- |
| `const { userId } = await auth(); if (!userId) redirect("/sign-in")` | `:25-26` | belt-and-braces on top of middleware |
| reads `sidebar_state` cookie → `defaultOpen` | `:32-35` | must match `SIDEBAR_COOKIE_NAME` in `src/components/ui/sidebar.tsx:28` |
| `<RequireBackend>` | `:43` | turns a missing `NEXT_PUBLIC_CONVEX_URL` into a message instead of a crash (`src/components/require-backend.tsx:15`) |
| `<ToastProvider>` | `:50` | outermost app provider, on purpose (comment at `:47-49`) |
| `<AppearanceProvider>` | `:51` | writes per-user CSS custom properties on `:root` |
| `<CustomizeProvider>` | `:52` | the in-place customise mode flag |
| `<SidebarProvider defaultOpen … className="h-svh overflow-hidden">` | `:53` | **exactly one** for the whole shell |
| `<EnsureUser />` | `:54` | idempotent `users.ensureCurrent` bootstrap (`src/components/dashboard/ensure-user.tsx:9`) |
| `<NoSupportWidget />` `<CommandPalette />` `<AgentOnlineWatcher />` | `:55-57` | app-wide singletons |
| `<DashboardSidebar />` | `:58` | renders only `<Sidebar>`, never a second provider |
| `<SidebarInset …overflow-y-auto>` + `<div className="w-full px-4 py-6 sm:px-6">{children}</div>` | `:62-64` | **SidebarInset is the app's real scroll container**, not `document` |
| `.gradient-strip` fixed bottom | `:68-71` | |
| `<FloatingNavToggle /> <SidebarDock /> <DockSlot />` | `:78-84` | the nav-position gesture system |
| `<StyleStudio />` | `:86` | the inspector |

**`src/app/dashboard/template.tsx` (26 lines)** — a client component re-mounted on every dashboard navigation. It wraps children in `MotionConfig reducedMotion="user"` and a `motion.div` that fades/rises/un-blurs with `EASE` — `src/app/dashboard/template.tsx:13-23`. Because it is a `template.tsx` (not `layout.tsx`) it remounts per route, which is what makes it a page transition.

### 1.2 What it takes to add `src/app/chat/`

Concretely, four edits and one new tree:

1. **`src/middleware.ts:5-9`** — append `"/chat(.*)"` to the `isProtectedRoute` array. One line, append-only, low conflict risk. Nothing else in middleware needs to change; the matcher already covers it.
2. **`src/app/chat/layout.tsx`** (new) — a server component mirroring `dashboard/layout.tsx`'s *provider stack*, not its markup. Minimum viable set that a second shell genuinely needs:
   - `await auth()` + `redirect("/sign-in")` — cheap, matches the existing belt-and-braces.
   - `<RequireBackend>` — otherwise a missing Convex URL is a white screen.
   - `<ToastProvider>` — `useToast()` is used by nearly every write path we will reuse (composer, channel create, deletes). **Mount it; do not import the dashboard's instance.** It is a React context provider mounted per-tree.
   - `<AppearanceProvider>` — required if Chat is to honour the user's personal accessibility keys (type size, motion, contrast, body typeface). D5 says it must. Note it is a *client* component writing to `document.documentElement`, so mounting a second instance in a sibling tree is safe (only one is ever mounted at a time — the trees do not coexist), but see §8 for the theme-scoping consequence.
   - `<EnsureUser />` — the user row/personal space bootstrap. Someone whose first-ever landing is `/chat` has no `users` row without it.
   - Optional but recommended: `<AgentOnlineWatcher />` (agent-first-heartbeat toast — Chat is *more* agent-centric than Work), `<CommandPalette />` (⌘K; its item list is `src/lib/command-palette-items.ts` and is Work-shaped, so either reuse as-is or gate it).
   - Probably *not* needed: `CustomizeProvider`, `SidebarDock`, `DockSlot`, `FloatingNavToggle`, `StyleStudio` — those are the Work canvas's own customisation gesture system and belong to that dashboard's model.
   - `SidebarProvider`/`SidebarInset`: the vendored primitive (`src/components/ui/sidebar.tsx`) is generic and reusable, **but it persists collapse state to a single global cookie `sidebar_state`** (`:28`, written at `:86`). Two shells sharing that cookie means collapsing the Chat rail collapses the Work sidebar. Either (a) build the Chat rail without `SidebarProvider` (Buzz's rail is a different shape anyway — fixed-width channel list, not a collapsible tree), or (b) fork a `chat_sidebar_state` cookie name. Prefer (a).
3. **`src/app/chat/template.tsx`** (new, optional) — copy the 26-line dashboard template if Chat wants the same route transition. It has no dependencies beyond `EASE` from `src/components/motion.tsx`.
4. **`src/app/chat/page.tsx`** (new) — the landing surface.

Things that come free and need no work: Clerk session, Convex client + subscriptions, fonts, the pre-paint theme script, the service worker, `OfflineIndicator`, `metadataBase`/OG defaults from the root layout.

One thing to watch: the dashboard shell pins the viewport (`h-svh overflow-hidden` at `:53`) and makes `SidebarInset` the scroll container so `sticky top-0` page headers work (comment at `:36-42`). A chat app wants the same discipline for a different reason — the transcript scrolls, the composer does not. Reproduce the pattern; do not let the document scroll.

---

## 2. Sidebar

`src/components/dashboard/sidebar.tsx` (1368 lines) is built on the vendored
shadcn/Square sidebar primitives in `src/components/ui/sidebar.tsx`.

### 2.1 Structure

```
DashboardSidebar                      :111   <Sidebar collapsible="icon">
├── SidebarHeaderSwitcher             :179   workspace dropdown (Orb + name + chevron)
│   └── [data-nav-grab] handle        :198   the drag affordance the dock listens for
├── SidebarContentBody                :275   <TreeHighlight> wrapper, then:
│   ├── SearchMenuItem                :360
│   ├── NavMenuItem Home              :283
│   ├── InboxMenuItem                 :403   badge = mentions.unreadCountForCurrent + notificationCenter.unreadCount
│   ├── ChatMenuItem                  :426   badge = sum of chat.channels[].unread for scopes[0]
│   ├── NavMenuItem My work / Spaces / Projects / Pages / Agents …
│   ├── FavoritesGroup                :457
│   ├── PersonalTreeGroup             :545
│   └── WorkspaceTreeGroup            :572 → SpaceTree :692 → ProjectTree :949 → ListSubItem :1100 …
├── SidebarFooterBody                 :1281  RunningTimerChip, AdminMenuItem, AppearanceMenuItem, ThemeToggle, UserButton, SidebarTrigger
└── SidebarRail
```

Data comes from **one** query: `useTreeQuery()` → `api.sidebar.tree` (`:88`).
`useCurrentContext` (`:148`) reverse-maps any `/dashboard/(wb|w|s|l|d)/:id` URL
back to its owning workspace via `CONTENT_ID_RE` (`:146`) so the header switcher
stays pinned. There is **no client-side "selected workspace" state** — context is
derived from the pathname (comment at `:132-138`).

### 2.2 Where a Work/Chat mode switcher goes

Top of `SidebarHeader`, **above** the workspace switcher dropdown — i.e. inserted
at `src/components/dashboard/sidebar.tsx:194` (immediately after
`<SidebarHeader>` opens, before the `[data-nav-grab]` span at `:198`).

Rationale from the existing code: the header already answers "which workspace am
I in"; mode is a coarser question and must sit above it. Two constraints the
insertion must respect:

- **Collapsed rail.** Every header child already carries
  `group-data-[collapsible=icon]:hidden` (e.g. `:206`) or centres itself
  (`group-data-[collapsible=icon]:justify-center` at `:203`). A mode switcher must
  do one or the other, or the icon rail breaks. Two icons side by side won't fit a
  48px rail — collapse it to a single glyph that toggles.
- **The drag handle.** `[data-nav-grab]` (`:198`) is what `sidebar-dock.tsx`
  listens for. Do not put an interactive control between it and the header edge in
  a way that swallows pointerdown.

Navigation, not state: the switcher should be two `<Link>`s (`/dashboard` and
`/chat`), matching how the workspace switcher works (`:229`, `:243`) — "picking a
different entry just navigates" (`:137`).

### 2.3 Collapse / icon rail / persistence

- `<Sidebar collapsible="icon">` at `:118`. The primitive renders an offcanvas
  Sheet below `md` and an icon rail on desktop.
- State lives in `SidebarProvider` (`src/components/ui/sidebar.tsx:47` `useSidebar`), and is
  persisted to the cookie `sidebar_state` (`:28`, max-age 7 days at `:29`, written
  at `:86`). The server layout reads it back at `src/app/dashboard/layout.tsx:33-35`
  so there is no open-then-collapse flash.
- Collapsed styling is expressed entirely through the
  `group-data-[collapsible=icon]:*` Tailwind variants on children, plus
  `data-slot` selectors in `globals.css` (`:670-671` etc.).
- Mobile: `DashboardSidebar` closes the drawer on every pathname change via
  `setOpenMobile(false)` in an effect (`:113-119`).

### 2.4 `layoutId="sidebar-active"` — **it no longer exists**

CLAUDE.md still documents a `motion` `layoutId="sidebar-active"` pill. Grep shows
no such usage anywhere in `src/` (the only `layoutId`s are
`style-studio.tsx:115`, `cult/expandable-screen.tsx`, and
`sprint-template-gallery.tsx:105`). The travelling highlight was replaced by
`TreeHighlight` / `useTreeHover` / `Branch` / `Disclosure` in
`src/components/dashboard/sidebar-tree-motion.tsx:53,103,127,163`, wrapped around
the content at `sidebar.tsx:279`. Active state itself is plain: `isActive` on
`SidebarMenuButton`, computed from `usePathname()` (`NavMenuItem` at `:376-400`).

**Consequence for Chat:** copy `TreeHighlight`/`Branch` if you want the same
motion; do not go looking for a shared layout-animation id that isn't there.

### 2.5 Other persisted sidebar state

- `sidebar_state` cookie (above) — the only cookie.
- `src/lib/project-collapse.ts` (`useProjectExpanded`, imported at `sidebar.tsx:80`) — per-project expand/collapse.
- Sidebar **position** (left/right/floating/dock) is *not* sidebar state: it is a PERSONAL appearance key in Convex (`sidebarPosition`, `src/lib/appearance.ts:32`), applied as `root.dataset.sidebar` by the appearance provider (`appearance-provider.tsx:251`) and styled in `globals.css:597-671`.

---

## 3. Existing chat-adjacent code

### `convex/chat.ts` (408 lines) — the messaging *surface*

| Export | Line | Does |
| --- | --- | --- |
| `scopesForCurrentUser` | `:24` | personal + every non-suspended workspace, as `{scopeType, scopeId, name}` |
| `channels` (query) | `:92` | the rail: channels for a scope with per-channel `unread`, sorted by `lastMessageAt` then name |
| `thread` (query) | `:160` | tail window of one channel's messages (default 200, cap 500) with authors resolved (agents via `db.normalizeId("agents", …)` at `:181`), returns `truncated` |
| `markRead` | `:233` | delegates to `markChannelReadCore` |
| `setTopic` | `:241` | |
| `referenceTargets` | `:259` | what `#[…](kind:id)` can point at |
| `resolveRefs` | `:372` | server-side ref → href (a task's URL needs its list) |
| `messageText` | `:406` | body → plain text |

Private helpers `scopeAccess` (`:52`) and `channelAccess` (`:75`) are the local
authz — note they do **not** call `_authz.requireMessageParentAccess`; they
re-implement the membership lookup. Reads that fail access return `[]`/`null`
rather than throwing (`:99-103`, `:164-168`), which is what keeps the rail from
erroring during a scope switch.

- **Reuse as-is:** `scopesForCurrentUser`, `messageText`, `resolveRefs`, `referenceTargets`.
- **Would need to change:** `channels` counts unread by `.collect()`-ing a channel's whole message history when `lastMessageAt > lastRead` (`:117-124`). That is fine at Work-chat volume and *not* fine at Buzz volume. A Chat-scale rail needs a counter column or an index range with a cursor.
- **Leave alone:** the whole file, if Chat gets its own `convex/buzz/*` modules. It is what `/dashboard/chat` renders and what `ChatMenuItem` badges.

### `convex/channels.ts` (162 lines)

`createChannelCore` (`:35`) is the shared write path — idempotent create-by-name
(create == join). Public: `get` (`:75`, for deep links), `listForScope` (`:94`),
`create` (`:115`), `remove` (`:139`). Table at `convex/schema.ts:1861` — scope,
name, topic, `createdByActorId`, plus denormalized `lastMessageAt` /
`lastMessagePreview` / `lastMessageByName`; `channelReads` at `:1882` is one row
per `(channel, actor)` with `lastReadAt`.

**This is the closest existing thing to a Buzz channel and the denormalization
pattern is exactly right** (comment at `schema.ts:1871-1873`, and the read-cursor
rationale at `:1879-1881`). Copy the shape; do not extend this table with
Buzz-only columns (membership, roles, e2e metadata, huddle state) — that is how
one concept becomes two half-concepts.

### `convex/messages.ts` (622 lines) — the core write path

- `parentTypeValidator` (`:43`): `task | space | workspace | channel | page`.
- `scopeForMessageParent` (`:53`) — parent → `{scopeType, scopeId}` for events.
- `listForParent` (`:83`), `listMentionableUsers` (`:109` — returns agents user-shaped with `isAgent`), `canBeMentioned` (`:182`).
- **`createMessageCore(ctx, args, actor, workspaceId)` (`:226`)** — the one path both humans and agents write through. It: rejects empty bodies, validates reply parents match context, **parses `refs` from the body rather than accepting them** (`:245-247`, and the reasoning at `:244`), inserts, then emits `comment.created` via `emitEvent`, writes `mentions` rows, updates channel denormalization, and schedules notification actions.
- `markChannelReadCore` (`:444`), public `create`/`update`/`remove`/`resolve` (`:480/:520/:570/:603`).

**Reuse the *pattern* (a `*Core` taking an explicit `Actor`), not necessarily the
function.** Buzz messages are signed Nostr events (D2) whose canonical form is
the event, not a `messages` row — so a `createEventCore` in `convex/buzz/` that
signs-then-writes-then-`emitEvent`s is the right analogue. Do not add a sixth
`parentType` to `messages` for Buzz channels; the two write paths have genuinely
different invariants (a Buzz message must be signed before it is observable).

### `convex/mentions.ts` (160 lines)

`listForCurrent` (`:6`), `feedForCurrent` (`:26` — fully resolved inbox rows with
preview + working href, `href: null` when the target no longer resolves),
`unreadCountForCurrent` (`:122`), `markRead` (`:135`), `markAllRead` (`:147`).
Table at `schema.ts:1038`; `parentType`/`parentId` are denormalized off the
message so the inbox is O(unread).

**Reuse as-is and extend by one `parentType` literal** if Chat mentions should
land in the same Inbox (D7 calls for a unified inbox). That is the single
cheapest bridge in the whole plan: one literal in the schema union, one branch in
`feedForCurrent`'s href resolver.

### `convex/realtime.ts` (328 lines) — see §6.

### `convex/presence.ts` (344 lines)

`PRESENCE_TTL_MS = 45_000` (`:32`), `SURFACE_TYPE` = `page|task|list|project|space`
(`:37`), private `requireSurface` (`:53` — routes every surface through the
normal `_authz` helpers, with the leak rationale at `:44-51`), `markPresence`
(`:98` — shared by human heartbeat and every agent path, never throws), public
`heartbeat` (`:151`) / `leave` (`:172`) / `viewers` (`:207`) / `forActor`
(`:266`), plus `clearActorPresence` (`:308`), `clearPresence` (`:327`),
`presenceIsStale` (`:342`). Table at `schema.ts:1274`.

**This is the single most reusable thing in the survey.** It already models both
principal kinds (`actorType: "user" | "agent"`), already sweeps opportunistically
with no cron, and already rides Convex subscriptions rather than a realtime
service (rationale at `:25-29`). A Buzz channel becomes a presence surface with
**one literal added to `SURFACE_TYPE` (`:37`) and one branch in `requireSurface`
(`:53-88`)** — a genuinely two-line integration. `PresenceRail`, `PresenceNote`,
`AgentEdge` (`src/components/dashboard/presence-rail.tsx`) then work unchanged.

### `convex/events.ts` (247 lines)

`emitEvent(ctx, e)` (`:27`) inserts an `events` row (`schema.ts:1836`), fans out
to matching `webhookSubscriptions` with a scheduled `webhookDelivery.deliver`
per match (`:45-68`), and schedules an Ably nudge on
`operate:<scopeType>:<scopeId>` (`:76-95`). `scopeForList` (`:100`), `userActor`
(`:109`), `forProject` (`:140`), `feed` (`:189`, `MAX_FEED = 100` at `:126`).

**Reuse as-is.** Every Buzz-side state change should call `emitEvent` so it shows
up in the shared activity feed, reaches registered agent webhooks, and produces
the live nudge — for free. New event types are just new `type` strings; the
namespace convention (`task.*`, `comment.created`, `agent.*`, `question.*`) says
Buzz events should get their own prefix.

### `src/app/dashboard/chat/*`

`page.tsx` (15 lines) — `Suspense` wrapper, because `ChatView` reads the channel
from `useSearchParams` (comment at `:8-9`).
`chat-view.tsx` (613 lines) — `ChatView` (`:38`) holds scope + channel selection;
`ChannelRail` (`:133`); `Room` (`:271`) subscribes to `api.chat.thread`, mutates
through `api.messages.create`, `api.chat.markRead`, `api.chat.setTopic`, can spawn
`api.tasks.create` / `api.pages.create` from a message, signals typing via
`api.realtime.chatSignal` (`:290`), reads mentionables from
`api.pages.mentionableActors` (`:293`) and refs from `api.chat.referenceTargets`
(`:297`) / `api.chat.resolveRefs` (`:311`), and opens the Ably stream with
`useAblyChannel(channelId, …)` (`:318`).

**Read it as the reference implementation, then leave it alone.** It is
full-bleed by cancelling the shell padding (`-mx-4 -my-6`), which a dedicated
`/chat` shell will not need. `mentionIdsFrom` (`:607`) is a useful 6-line helper
worth copying.

`src/components/dashboard/chat/composer.tsx` (327 lines) — `ChatComposer` (`:48`)
with `buildSections` (`:241`) driving the `@`/`#`/`[[` suggestion menu. Good
candidate for extraction into something both dashboards use, but **extract by
copying first**; refactoring a shared file is exactly the merge-conflict shape §9
warns about.

### `src/components/dashboard/comments.tsx` (649 lines)

`Comments` (`:36`) over `api.messages.listForParent` + `api.messages.listMentionableUsers`;
`MessageItem` (`:128`), `ReplyItem` (`:308`), `MessageBody` (`:403`), `renderPart`
(`:418`), `Avatar` (`:435`), `Composer` (`:452`). This is the task/page comment
surface. **Leave alone** — it is Work-side and heavily used.

### `src/lib/use-ably-channel.ts` (157 lines)

`useAblyStream(subject, authorize, onSignal)` (`:52`) — **already generic in the
channel**: the access check and channel name both live server-side inside
`authorize`, so nothing in the hook knows what it is subscribing to (comment at
`:43-48`). `useAblyChannel` (`:139`) is the thin chat-specific wrapper.
`TYPING_TTL_MS = 5000` (`:151`), `TYPING_THROTTLE_MS = 2500` (`:153`).
Reconnect/refresh logic at `:110-118` (re-auth 60s before expiry).

**Reuse `useAblyStream` verbatim.** A Buzz-side hook is a ~6-line wrapper naming
a different Convex authorize action. Do not touch this file.

### `src/lib/mentions.ts` (40 lines)

`MENTION_RE = /@\[([^\]]+)\]\(([^)]+)\)/g` (`:5`), `parseMentionBody` (`:11`),
`extractMentionedClerkIds` (`:33`), `formatMentionToken` (`:38`). Pure. Reuse
as-is — the token grammar must not fork, or an agent's mention written in Chat
won't resolve in Work.

### `convex/_refs.ts` (85 lines)

`REF_KINDS` (`:19`), `extractRefs` (`:44`), `formatRef` (`:61`), `bodyToText`
(`:76`), `bodyPreview` (`:83`). Pure, no ctx — usable from both Convex and the
client (comment at `:16-17`). Reuse as-is; adding a Buzz ref kind is one entry in
`REF_KINDS` **plus** a branch in `chat.resolveRefs` (`convex/chat.ts:372`) — do
both or you ship a token that renders as a dead label.

---

## 4. Agents — reuse, don't fork

### `convex/schema.ts:1662` `agents`

Already models everything a Buzz "agent as channel member" needs except the
keypair: `name`/`description`/`emoji`/`color`, `parentType: user|workspace` +
`parentId` (the scope), `status: active|paused`, `role: member|readonly` (`:1673`),
`capabilities: string[]` (`:1677`), `maxConcurrentTasks` (`:1681`),
`allowedListIds` (`:1683`), `dailyActionLimit` (`:1686`), `notifyUrl`/`notifySecret`
(`:1690-1691`), and live presence `lastSeenAt` / `lastConnectedAt` /
`lastHeartbeatAt` / `currentTaskId` / `statusText` (`:1694-1702`).

Critically: **an agent's document id is used everywhere a clerkId-shaped string
is stored** — message authors, assignees, mentions, `*ActorId` columns. See
`chat.thread`'s author resolution (`convex/chat.ts:181-186`) and
`presence.markPresence`'s `actorType` (`convex/presence.ts:120`). That is the
whole reason an agent can already be a room member with no new concept.

Supporting tables: `agentUsage` (`:1708`, per agent/UTC-day + burst minute),
`agentRuns` (`:1721`, including the live AG-UI-shaped `steps`/`liveState`),
`agentKeys` (`:1778` — `keyHash`, `keyPrefix`, `revokedAt`, `lastUsedAt`, indexed
`by_hash`), `oauthAccessTokens` (`:1815`).

### `convex/_agentAuth.ts` (398 lines)

- `Actor` type (`:18`) — `{type: "user"|"agent"|"system", id, name}`. **This is the shared currency between the two dashboards.**
- `sha256Hex` (`:48`) — pure-JS SHA-256 because Convex's deterministic isolate has no `crypto.subtle` (comment at `:23-26`). Directly relevant to D2/D3: it is the existing proof that the key-verification path works in a mutation, and the precedent for putting `@noble/*` in the default runtime.
- `DEFAULT_DAILY_ACTION_LIMIT = 2000` (`:95`), `BURST_LIMIT_PER_MINUTE = 60` (`:100`).
- **`requireAgentByKey(ctx, apiKey, mode)` (`:120`)** — the single gate. Accepts an `agentKeys` hash *or* an `oauthAccessTokens` hash (`:129-139`), checks revocation/expiry/`status`, checks OAuth scopes (`:163-173`), then for `mode: "write"`: rejects readonly, **charges x402 credits before the counters** (`:187-243`), enforces daily budget (`:257-262`) and burst cap (`:263-269`). `mode: "presence"` is neither role-gated nor budgeted (comment at `:112-115`) — that is the mode a Buzz presence/typing call should use.
- `requireUnrestricted` (`:290`), `agentCanTouchList` (`:296`), `agentActor` (`:305`), and the agent-side hierarchy helpers `canAgentAccessSpace` (`:311`), `requireSpaceAccessForAgent` (`:320`), `requireProjectAccessForAgent` (`:335`), `requireListAccessForAgent` (`:352`), `requireTaskAccessForAgent` (`:374`), `requireWorkspaceAccessForAgent` (`:389`).

### `convex/agentKeys.ts` (34 lines)

`createKey` (`:13`) — a `"use node"` action, CSPRNG, returns plaintext once,
stores only the SHA-256 hash via `agents._storeKey` (`convex/agents.ts:802`).
**This is the exact template for D3's secp256k1 keypair minting**: Node action for
generation, default-runtime verification.

### `convex/agents.ts` (816 lines)

Human-facing management. Queries: `fleetSpend` (`:101`), `listForCurrentUser`
(`:183`), `currentTaskTitles` (`:227`), `detail` (`:248`),
`listAssignableForList` (`:352`), `listForWorkspace` (`:424`), `liveRunForTask`
(`:457`), `stats` (`:486`, 7-day analytics), `listKeys` (`:559`). Mutations:
`create` (`:585`), `update` (`:619`), `remove` (`:690`), `revokeKey` (`:782`).
Internal: `_assertManageAccess` (`:794`), `_storeKey` (`:802`).

### `convex/agentApi.ts` (8358 lines, 166 exports)

The key-authenticated surface the MCP server calls.

**How Buzz should attach:** add a `pubkey` (and server-held secret reference) to
the `agents` row — or a sibling `buzzKeys` table if you prefer not to touch
`agents` — and let Buzz channel membership be `(channelId, actorId)` where
`actorId` is a clerkId or an agent id, exactly as `channelReads` already does
(`schema.ts:1884-1886`). Every governance control (role, allowedLists, daily
budget, burst cap, x402 metering, pause) then applies to Buzz writes for free by
calling `requireAgentByKey(ctx, apiKey, "write")`. **Do not build a second agent
identity, a second key table, or a second budget counter.**

---

## 5. Schema — can a large new table set live in its own file?

### How it is organised today

`convex/schema.ts` is 2382 lines: one `import { defineSchema, defineTable } from "convex/server"` (`:1`) and one `export default defineSchema({ …~90 tables… })` starting at `:24`. Every table is inline. There are **no** sub-files and **no** directories under `convex/` except `_generated/`.

### Yes — composing from another file works

`defineSchema` takes a plain object whose values are `defineTable(...)` results.
Nothing about that requires them to be written inline. Convex `^1.42.3`
(`package.json`) has no restriction here; `defineTable` is a pure builder from
`convex/server`. The idiomatic split:

```ts
// convex/buzz/tables.ts
import { defineTable } from "convex/server";
import { v } from "convex/values";
export const buzzTables = {
  buzzEvents: defineTable({ /* … */ }).index("by_kind", ["kind", "created_at"]),
  buzzChannels: defineTable({ /* … */ }),
  // …
};
```

```ts
// convex/schema.ts — the one-line change
import { buzzTables } from "./buzz/tables";
export default defineSchema({
  users: defineTable({ /* … */ }),
  // … everything unchanged …
  ...buzzTables,          // ← append immediately before the closing `});` at :2382
});
```

Two edits to `schema.ts`: one `import` line near `:1`, one spread line before the
close at `:2382`. Both append-only at the file's two extremities, which is the
minimum-conflict shape (§9).

Caveat worth stating: a file under `convex/` that exports only table definitions
is still crawled by the Convex CLI as a module. `convex/buzz/tables.ts` exporting
no Convex functions is harmless (it appears in `_generated/api.d.ts` as a module
with no functions, exactly like `convex/_authz.ts` does today —
`convex/_generated/api.d.ts:13`). If you would rather it not appear at all, name
it `convex/buzz/_tables.ts`; the leading-underscore convention is already used for
every non-function module in this codebase (`_authz`, `_agentAuth`, `_refs`,
`_x402`, …).

### Nested module directories

**Yes.** Convex maps the path under `convex/` to the API object: `convex/buzz/channels.ts` exporting `export const list = query(…)` is callable as `api.buzz.channels.list`. There is no configuration to enable it.

Two operational notes:
- `convex/_generated/api.d.ts` is currently a hand-rolled stub with a flat import list (`:11-40`). It will **not** know about `convex/buzz/*` until `npx convex dev` (or `npx convex deploy`) regenerates it. Until then, `api.buzz.channels.list` will not typecheck from the Next tree. Expect to run the CLI once after adding the directory, and expect the regenerated file to be a large diff — a shared-file conflict risk in its own right (§9).
- `convex/tsconfig.json` exists and typechecks the Convex tree separately from `npm run typecheck` (which is Next-only).

---

## 6. Real-time — Convex vs Ably

**Convex is the source of truth and the primary live channel.** Every `useQuery`
is a subscription; a mutation that writes a row pushes to every subscriber. The
file header at `convex/realtime.ts:9-11` is explicit: "Convex already pushes
every query result to subscribed clients, so this is not how the dashboard stays
fresh — that part needs no help."

**Ably carries only what a query cannot**, per `convex/realtime.ts:13-21`:
1. Liveness/presence ("is atlas-01 online *right now*" — polling `lastSeenAt` is wrong in both directions).
2. Nudges to a client that is not holding the relevant Convex subscription (or is not looking at the app).
3. In-flight drags (the space-look signal) — a write per frame is exactly what the debounce prevents (`:239-246`).

Publishing is fire-and-forget: a failed publish must never roll back the mutation
(`:23-25`), which is why `emitEvent` *schedules* `internal.realtime.publish`
rather than awaiting it (`convex/events.ts:82-95`).

### Surface

| Export | Line | Purpose |
| --- | --- | --- |
| `scopeChannel(scopeType, scopeId)` | `:30` | `operate:<type>:<id>` |
| `userChannel(clerkId)` | `:38` | |
| `chatChannel(channelId)` | `:43` | |
| `spaceLookChannel(spaceId)` | `:54` | |
| `publish` (internalAction) | `:58` | REST POST to `https://rest.ably.io` (`:27`) |
| `chatSubscribeToken` (action) | `:126` | access-check → subscribe-only, single-channel token, `TOKEN_TTL_MS = 30min` (`:112`) |
| `chatSignal` (action) | `:179` | typing/presence signal — **an action, never a DB write** |
| `publishFromClient` (action) | `:204` | |
| `spaceLookToken` / `spaceLookSignal` | `:249` / `:303` | gated on `mayTheme`, ~90ms trailing throttle, 3s expiry |

The browser never bundles the Ably SDK — `src/lib/use-ably-channel.ts` opens an
`EventSource` against `https://realtime.ably.io/sse` (`:26`) with the minted
token. Two stated reasons (`convex/realtime.ts:105-110`): the API key never
leaves the server, and the SDK does not survive this project's webpack parse.

### Env

`ABLY_API_KEY` — **Convex-side only**, last line of `.env.example`. Set with
`npx convex env set ABLY_API_KEY …`. There is no `NEXT_PUBLIC_ABLY_*`, by design.
**Ably being unconfigured is a supported state**: `authorize()` returns null, the
hook reports `"unavailable"` (`use-ably-channel.ts:80-86`), and the room still
works off Convex. Chat must preserve that property — a huddle that hard-fails
without Ably is a regression against how the rest of the app behaves.

Other env of note for Chat: `NEXT_PUBLIC_CONVEX_URL`, Clerk keys, `RESEND_*`
(notification emails), `PLATFORM_ADMIN_EMAILS`, `X402_*`. Full list in
`.env.example`.

---

## 7. Authz — the exact helper surface

`convex/_authz.ts` (370 lines). The model: a user can access a Space if it is
their personal space (`parentType: "user"`, `parentId === identity.subject`) or
they have a `memberships` row for its workspace (`:6-11`).

| Export | Line | Returns |
| --- | --- | --- |
| `type Identity` | `:13` | `{ subject: string }` |
| `requireIdentity(ctx)` | `:15` | identity; **throws on `users.suspendedAt`** (`:22-29`) — one place covers every authenticated read and write |
| `assertNotSuspended(ctx, subject)` | `:37` | for entry points that resolve identity directly |
| `canAccessSpace(ctx, space, identity)` | `:48` | boolean; also enforces **private spaces** (creator / `memberClerkIds` / workspace owner, `:64-75`) |
| `getSpaceForList(ctx, list)` | `:89` | the one place that knows list → space (handles `space` / `project` / legacy `folder`) |
| `getProjectForList(ctx, list)` | `:111` | project or null |
| `requireListAccess(ctx, listId)` | `:119` | `{list, space, identity}` |
| `requireSpaceAccess(ctx, spaceId)` | `:134` | `{space, identity}` |
| `requireProjectAccess(ctx, projectId)` | `:147` | `{project, space, identity}` |
| `requireTaskAccess(ctx, taskId)` | `:166` | `{task, list, space, identity}` |
| `requireDocLikeParentAccess(ctx, parentType, parentId)` | `:191` | `user\|workspace\|space\|list` |
| `requireMessageParentAccess(ctx, parentType, parentId)` | `:229` | `{identity, workspaceId}` for `task\|space\|workspace\|channel\|page` |
| `mayGovernSpace(ctx, space, subject)` | `:312` | the bar for changes everyone in a space sees (privacy *and* theming) |
| `requireScopeAccess(ctx, {scopeType, scopeId})` | `:338` | `{subject}` — **the scope-shaped check**, `user \| workspace` |
| `requirePageAccess(ctx, pageId)` | `:359` | `{page, subject}` |

### How a new Buzz function should call it

Buzz's tenancy boundary is the workspace / personal space (D4), which is exactly
the `{scopeType, scopeId}` shape. So:

- **A channel-level read/write:** load the channel row, then `await requireScopeAccess(ctx, { scopeType: channel.scopeType, scopeId: channel.scopeId })`. That is one call and it inherits suspension enforcement, membership, and the personal-space rule.
- **A message/event under a channel:** resolve to its channel first, then the above. Mirror `convex/chat.ts:75-82` `channelAccess`, but call `requireScopeAccess` rather than re-rolling the membership query — the existing `scopeAccess` (`chat.ts:52`) predates `requireScopeAccess` (`_authz.ts:338`) and is a duplicate we should not multiply.
- **Anything a shared room sees changed** (channel rename/topic/archive, room theme): gate on `mayGovernSpace` (`:312`), the same bar privacy and theming use.
- **Agent-side:** never `requireIdentity`; use `requireAgentByKey` + the `require*ForAgent` family (`convex/_agentAuth.ts:320-397`).
- **Never bypass.** `ctx.db.get(id)` followed by returning it is the read-leak shape the Phase 13 sweep existed to remove.

The `_authz` surface is genuinely complete for Chat's needs. The only anticipated
extension is a `requireChannelAccess`-style helper *in Buzz's own file*, built out
of `requireScopeAccess` — not a new primitive in `_authz.ts`.

---

## 8. Theming — scoping a different look to `/chat`

### How it works today

Three layers, all CSS custom properties, no component knows about any of it.

1. **`src/app/globals.css` (2146 lines)** — `@import "tailwindcss"` (`:1`), the dark variant bound to `data-theme` rather than a class (`@custom-variant dark (&:is([data-theme="dark"] *))`, `:7`), the Tailwind v4 `@theme` block of *brand* tokens (`:19-124` — `--color-page`, `--color-background`, `--color-foreground`, `--color-pastel-*`, `--font-sans`, `--font-title`, …), then a `:root` block of *appearance* tokens with shipped-design fallbacks (`:125-155` — `--ui-radius-card`, `--ui-gap`, `--ui-pad`, `--ui-font-scale`, `--ui-motion-scale`, `--ui-sidebar-width`, `--ui-font-body`, `--ui-font-display`, `--ui-icon-stroke`, `--ui-muted-toward-*`), theme-conditional blocks at `:236`, `:341`, `:396`, and structural attribute selectors: `[data-list-style=…]` (`:469-491`), `[data-sidebar=…]` (`:597-668`), `[data-customizing=…]` (`:432-448`).
2. **`src/lib/appearance.ts` (772 lines)** — pure. `Appearance` type (`:70`), `DEFAULT_APPEARANCE` (`:115`), `normalizeAppearance` (`:188`, total, clamps, ignores unknown keys), the `PLACE_KEYS` / `PERSONAL_KEYS` partition (`:250` / `:269`), `resolveAppearance` (`:357`) and `resolveLayered` (`:400`) with the `sources` map, `prunePatch` (`:434`), `fontStackFor` (`:519`) / `displayStackFor` (`:524`), **`resolveTokens(input): Record<string, string>` (`:585`)** — the settings → CSS-var function — and `ANIMATABLE_TOKENS` (`:656`), `APPEARANCE_PRESETS` (`:695`).
3. **`src/components/appearance/appearance-provider.tsx` (507 lines)** — resolves stored/preview/effective, then two effects: `resolveTokens(effective)` → `applyTokens` on first paint, `morphTokens` thereafter (`:237-245`), and the structural half writing `root.dataset.sidebar` / `density` / `surface` / `listStyle` (`:250-261`). Writes are debounced ~450ms (`persist`, `:286`). `useAppearance()` at `:484`.

Everything is stamped on `document.documentElement`. `data-theme` (light/dark)
is stamped even earlier, by the inline script in `src/app/layout.tsx:88-93`.

### The cleanest way to give `/chat` a different look

**Do not** add a second token-writer that fights the provider for `:root`, and
do not fork `globals.css` — a second stylesheet drifts the first time a token
changes, which is the same failure the gallery's "use the app's own compiled CSS"
rule (`scripts/build-gallery.mjs:8-11`) exists to prevent.

The idiomatic move, following the app's own precedent (`[data-list-style]`,
`[data-sidebar]`, `[data-customizing]`):

1. **One wrapper attribute.** `src/app/chat/layout.tsx` renders its subtree inside `<div data-app="chat">` (or stamps `document.documentElement.dataset.app = "chat"` in a tiny client effect if you need it to reach portals — toasts, dropdowns and the command palette render in portals attached to `<body>`, so an attribute on a wrapper `div` will **not** reach them; prefer the root attribute if Chat's popovers must be themed).
2. **One appended block in `globals.css`.** At the end of the file, `[data-app="chat"] { --color-background: …; --color-page: …; --ui-radius-card: …; }` plus a `[data-theme="dark"] [data-app="chat"]` variant. Because every component reads tokens, the entire Chat tree re-skins with no component changes. Append at the bottom — §9.
3. **Personal accessibility keys still win.** D5 requires that a user's type size, motion, contrast and body typeface still apply. They do automatically, because `AppearanceProvider` writes `--ui-font-scale` / `--ui-motion-scale` / `--ui-muted-toward-*` / `--ui-font-body` as *inline styles on `:root`*, and an inline style on the root beats a stylesheet rule on a descendant selector for those specific properties **only if the descendant block does not redeclare them**. So: **the Chat block must redeclare only PLACE-ish tokens (colour, radius, surface, shadow) and must never redeclare `--ui-font-scale`, `--ui-motion-scale`, `--ui-muted-toward-fg/bg`, `--ui-font-body`, `--ui-row-height`.** Worth an assertion in a test, in the spirit of `tests/appearance.test.ts` and `tests/space-appearance.test.ts`.
4. **Chat-only structural choices** ride their own `data-*` attributes on the same wrapper, never new global ones.

If Chat later wants a *fully* independent palette rather than an override, add a
`chat` entry to `APPEARANCE_PRESETS` (`src/lib/appearance.ts:695`) rather than a
parallel system — but for phase one the attribute-scoped block is smaller,
reversible, and touches one shared file in one appended place.

---

## 9. Conflict risk — a concurrent "dynamic UI" build

### OFF LIMITS — do not open, do not edit, do not import into a shared refactor

Backend:
- `convex/uiComponents.ts`
- `convex/dataStream.ts`
- `convex/screens.ts`
- `convex/panelIntent.ts`
- (adjacent, same author-surface) `convex/plans.ts`, `convex/calibration.ts`

Pure libs:
- `src/lib/panel.ts`
- `src/lib/screen-layout.ts`
- `src/lib/data-stream.ts`
- `src/lib/component-style.ts`
- `src/lib/panel-intent.ts`
- `src/lib/panel-memory.ts`
- `src/lib/provenance.ts`
- `src/lib/anime.ts` (the FLIP/jiggle physics the grid depends on)
- `src/lib/nav-dock.ts`

Components:
- `src/components/dashboard/panel.tsx`
- `src/components/dashboard/panel-builder.tsx`
- `src/components/dashboard/panel-proposal.tsx`
- `src/components/dashboard/panel-memory.tsx`
- `src/components/dashboard/provenance-sheet.tsx`
- `src/components/dashboard/screen/editable-grid.tsx`
- `src/components/dashboard/project-screen/project-screen.tsx`
- `src/components/dashboard/project-screen/widgets.tsx`
- everything in `src/components/appearance/` — in particular `appearance-provider.tsx`, `customize-provider.tsx`, `style-studio.tsx`, `style-gallery.tsx`, `style-carousel.tsx`, `card-builder.tsx`, `intent-composer.tsx`, `panel-question.tsx`, `use-component-style.ts`, `sidebar-dock.tsx`, `app-dock.tsx`, `dock-slot.tsx`, `floating-nav-toggle.tsx`, `actor-glyph.tsx`, `watch-control.tsx`

Tests belonging to that work (don't edit, don't "fix"):
`tests/panel.test.ts`, `panel-intent.test.ts`, `panel-proposals.test.ts`,
`panel-memory.test.ts`, `data-stream.test.ts`, `component-style.test.ts`,
`screen-layout.test.ts`, `screen-proposals.test.ts`, `provenance.test.ts`,
`nav-dock.test.ts`, `space-appearance.test.ts`, `appearance*.test.ts`,
`tests/ui/editable-grid.test.tsx`, `tests/ui/authored-panels.test.tsx`,
`tests/ui/morph-layout.test.tsx`, `tests/ui/project-view.test.tsx`,
`tests/ui/design/*` (the gallery apps).

Schema tables owned by that work — do not touch, do not reuse, do not add a
column to: `uiComponents` (`convex/schema.ts:1477`), `screenLayouts` (`:1430`),
`screenProposals` (`:1512`), `panelProposals` (`:1545`), `uiPreferences`
(`:1364`).

### SHARED — surgical, additive, append-only edits only

| File | The one edit | Where |
| --- | --- | --- |
| `convex/schema.ts` | one `import { buzzTables } from "./buzz/_tables"` + one `...buzzTables,` spread | import beside `:1`; spread as the **last** entry before the closing `});` at `:2382` |
| `src/app/globals.css` | one appended `[data-app="chat"] { … }` block (+ its dark variant) | **end of file**, after line 2146. Never edit `@theme` (`:19-124`) or the `:root` blocks (`:125`, `:230`, `:298`, `:393`) |
| `src/components/dashboard/sidebar.tsx` | one component inserted at the top of `SidebarHeader` | `:194`, immediately after `<SidebarHeader>` opens. Import the new component at the end of the import block (~`:82`). **Do not** restructure `SidebarHeaderSwitcher`, `SidebarContentBody`, or the tree functions |
| `package.json` | new deps (`@noble/curves`, `@noble/hashes`, …) appended to `dependencies` | keep alphabetical placement; expect `package-lock.json` conflicts — resolve by re-running `npm install`, never by hand-merging the lock |
| `src/middleware.ts` | one entry appended to `isProtectedRoute` | `:5-9` |
| `src/app/dashboard/layout.tsx` | **ideally zero edits.** If Chat needs a global mounted app-wide, mount it in `src/app/chat/layout.tsx` instead | — |
| `convex/_generated/api.d.ts` + `api.js` | regenerated by `npx convex dev` — a big machine diff | if it conflicts, take *either* side and re-run `npx convex dev`; never hand-merge |
| `convex/presence.ts` | one literal in `SURFACE_TYPE` (`:37`) + one branch in `requireSurface` (`:53`) | only if Chat wants the shared presence rail |
| `convex/schema.ts` `mentions.parentType` (`:1038`) | one literal | only for the unified inbox |
| `convex/_refs.ts` `REF_KINDS` (`:19`) | one literal | only if Chat objects become referenceable |

### Files that look shared but are not

`src/components/toast.tsx`, `src/components/motion.tsx`, `src/components/ui/*`,
`src/lib/utils.ts`, `src/lib/time.ts`, `src/lib/dates.ts`, `src/lib/mentions.ts`,
`convex/_authz.ts`, `convex/_agentAuth.ts`, `convex/events.ts` — **import them,
never modify them.** Every one is a stable dependency of both builds; a
"small improvement" to any of them is the highest-cost merge conflict available.

### Practical rule

Chat code lives in `convex/buzz/*`, `src/app/chat/*`, `src/components/chat/*`,
`src/lib/buzz/*`, `tests/buzz-*.test.ts` (D8). Anything outside those namespaces
should be an edit you can describe in one sentence and see in a three-line diff.

---

## 10. Tests & verification

### `npm test` — vitest, two projects

`vitest.config.ts` defines two projects (rationale at `:8-14`):

- **`backend`** — `environment: "edge-runtime"`, `include: ["tests/**/*.test.ts"]`, `server.deps.inline: ["convex-test"]`. This is where Convex functions run under `convex-test@0.0.54` and where pure-unit tests of `src/lib/*` live. Aliases `@` → `src`, `@convex` → `convex` (`:17-27`).
- **`ui`** — `environment: "jsdom"`, `plugins: [react()]` (needed because the app tsconfig sets `jsx: "preserve"`), `include: ["tests/ui/**/*.test.tsx"]`, `setupFiles: ["tests/ui/setup.ts"]` (`:37-52`).

~90 backend suites and ~17 UI suites exist today. Chat's suites belong in
`tests/` with a `buzz-` prefix so they never collide.

Nearest models to copy: `tests/chat.test.ts`, `tests/presence.test.ts`,
`tests/mentions.test.ts`, `tests/agent-auth.test.ts`, `tests/webhooks.test.ts`.
For the signing work (D2), a pure unit test of the NIP-01 canonical
serialization + Schnorr verify belongs in the `backend` project and needs no
Convex at all.

### `npm run build`

`next build` (`package.json:8`), with `next.config.mjs` wrapping it in
`withSerwistInit` (swSrc `src/app/sw.ts` → `public/sw.js`). Next 15 runs ESLint
and TypeScript as part of the build. `npm run typecheck` is `tsc --noEmit` over
the **Next tree only** — the Convex tree has its own `convex/tsconfig.json` and is
typechecked by the Convex CLI, so a Convex-only type error will not surface in
either `npm run typecheck` or `npm test`. Run `npx convex dev` (or `deploy`) to
find those.

**`npm run build` is a prerequisite for the gallery** — see below.

### `npm run gallery`

`"gallery": "node scripts/build-gallery.mjs && node scripts/design-shots.mjs"`
(`package.json:12`).

**`scripts/build-gallery.mjs`** bundles `tests/ui/design/*` with Vite into
`/tmp/design-gallery`, producing four real hydrating pages: `index.html`,
`sidebar.html`, `labels.html`, `grid.html` (`:71`, `:78`). Two things it does on
purpose:
- It renders a *bundle*, not a static string, because the charts measure their container before drawing — a server-rendered gallery would report everything fine no matter what shipped (`:3-7`).
- Its stylesheet is the **app's own compiled CSS** read from `.next/static/css` (`appCss()`, `:22-30`). If `npm run build` has not run, it exits with "run `npm run build` first, or the gallery will show you the components without the design system" (`:36-41`). **So: `npm run build` → `npm run gallery`.**

**`scripts/design-shots.mjs`** serves `/tmp/design-gallery` over HTTP on port 4599
(`:39-50`) and screenshots it with `playwright-core` chromium at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, viewport 1180×1400,
`deviceScaleFactor: 2` (`:52-59`). PNGs go to **`/tmp/design-shots`**, deliberately
a different directory from the build output — `build-gallery` runs Vite with
`emptyOutDir`, so shots written into the build were deleted by the next rebuild
(`:21-25`). Dark shots flip `data-theme` on the root, which is the app's own
mechanism (`:12-14`) — not a `.dark` class.

The whole harness exists because "the charts and panels were verified by tests
for weeks and never once looked at" (`:3-7`). **Read the PNGs.**

**`scripts/verify-resize.mjs`** is the gesture arbiter: same local server, same
chromium, loads `grid.html`, and drives a *real* pointer drag on the resize grip,
then asserts the committed layout AND the on-screen height changed while the
neighbour did not (`:1-6`, `:41-45`). Written because "the vertical resize was
fixed twice against jsdom and reported broken twice by a person. jsdom cannot
drag."

### What this means for Chat's phases

- Anything visual (channel rail, transcript density, huddle tiles, the mode switcher in both sidebar states): add a page to `tests/ui/design/` following `sidebar.html`/`sidebar-app.tsx`, then `npm run build && npm run gallery`, then **look at `/tmp/design-shots/*.png`** in light and dark.
- Anything gestural (drag-to-reorder channels, drag a message to a task, resize a huddle tile): copy `scripts/verify-resize.mjs` into a `scripts/verify-<thing>.mjs` and drive a real pointer.
- `tests/ui/*.test.tsx` under jsdom is fine for logic and structure, and is not evidence that anything looks or feels right.
- Note `tests/ui/design/` is currently gallery ground for the concurrent dynamic-UI work (`grid-app.tsx`, `sidebar-app.tsx`). **Add new files; do not edit the existing four.**

---

## Quick reference — the integration points, in one list

| # | Point | Cost |
| --- | --- | --- |
| 1 | Protect `/chat` | 1 line, `src/middleware.ts:5-9` |
| 2 | Chat shell providers | new `src/app/chat/layout.tsx`, mirroring `dashboard/layout.tsx:43-88` |
| 3 | Mode switcher | new component inserted at `sidebar.tsx:194` |
| 4 | Buzz tables | new `convex/buzz/_tables.ts` + 2 lines in `schema.ts` |
| 5 | Nested API namespace | free (`api.buzz.*`), one `npx convex dev` to regenerate |
| 6 | Authz | call `requireScopeAccess` (`_authz.ts:338`) / `mayGovernSpace` (`:312`) |
| 7 | Agent identity + governance | call `requireAgentByKey` (`_agentAuth.ts:120`); mint keys like `agentKeys.createKey:13` |
| 8 | Presence in Chat rooms | 1 literal + 1 branch in `convex/presence.ts:37,53` |
| 9 | Unified inbox | 1 literal in `mentions.parentType` + 1 branch in `mentions.feedForCurrent:26` |
| 10 | Activity + webhooks + live nudge | call `emitEvent` (`events.ts:27`) |
| 11 | Ephemeral realtime | wrap `useAblyStream` (`use-ably-channel.ts:52`) + a new Convex token action modelled on `realtime.chatSubscribeToken:126` |
| 12 | Chat theme | 1 appended block at the end of `globals.css`, keyed on `[data-app="chat"]` |
