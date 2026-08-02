# Buzz parity spec — 01: Core communication surface

A rebuild specification for the **core communication surface** of the Buzz desktop
client (`github.com/block/buzz`, `desktop/` — React 19 + TanStack Query +
Tauri + Nostr relay). Everything below is derived from reading the source; each
section cites `path:symbol` relative to `desktop/src/` so the original can be
re-read. Where behaviour is pinned by a `*.test.mjs` unit test, the rule is
stated as a rule — those tests are the executable spec.

Scope: `features/{channels,chat,messages,communities,community-members,presence,user-status,custom-emoji,notifications,search,channel-templates}`
plus `shared/ui` and `shared/hooks` where those features depend on them.

Out of scope for this document (referenced only where the comms surface touches
them): agents/personas/teams, huddles (voice), forum post views, moderation
queue, reminders, projects, workflows, pulse, home feed composition.

---

## 0. Substrate: how data actually moves

Buzz is not a REST app. Understanding four mechanics makes every later section
legible.

### 0.1 Events

Everything is a Nostr-style signed event:

```ts
// shared/api/types.ts:RelayEvent
type RelayEvent = {
  id: string;          // 64-char lowercase hex
  localKey?: string;   // LOCAL ONLY: render identity for optimistic events
  pubkey: string;      // signer
  created_at: number;  // unix SECONDS
  kind: number;
  tags: string[][];    // e.g. ["h", channelId], ["e", id, "", "reply"], ["p", pubkey]
  content: string;
  sig: string;
  pending?: boolean;   // LOCAL ONLY: optimistic, not yet acked
};
```

Tag conventions used pervasively (`features/messages/lib/threading.ts`):

| Tag | Meaning |
| --- | --- |
| `["h", channelId]` | channel membership of the event (`getChannelIdFromTags`) |
| `["e", id, "", "root"]` | thread root reference |
| `["e", id, "", "reply"]` | direct parent reference |
| `["p", pubkey]` | author self-tag AND mention tags (both) |
| `["emoji", shortcode, url]` | NIP-30 custom emoji resolution |
| `["imeta", ...]` | media attachment metadata |
| `["broadcast", "1"]` | a reply that ALSO renders top-level in the channel |

### 0.2 Kind registry

`shared/constants/kinds.ts` — the single source of truth. The kinds that matter
for comms:

| Kind | Constant | Meaning |
| --- | --- | --- |
| 1 | `KIND_TEXT_NOTE` | plain note (social) |
| 5 | `KIND_DELETION` | NIP-09 deletion marker |
| 7 | `KIND_REACTION` | NIP-25 reaction |
| 9 | `KIND_STREAM_MESSAGE` | **message v1** |
| 9005 | `KIND_NIP29_DELETE_EVENT` | Buzz-native deletion (relay soft-deletes, emits 40099) |
| 20002 | `KIND_TYPING_INDICATOR` | ephemeral typing |
| 20001 | *(presence, see `presence/lib/presence.ts`)* | ephemeral presence |
| 30078 | `KIND_READ_STATE` / `_CHANNEL_SECTIONS` / `_CHANNEL_MUTES` / `_CHANNEL_STARS` / `_CHANNEL_SORT` | NIP-78 app data, discriminated by `d` tag |
| 30030 | `KIND_EMOJI_SET` (`shared/api/customEmoji.ts`) | custom emoji set |
| 30315 | `KIND_USER_STATUS` | custom user status |
| 30622 | `KIND_DM_VISIBILITY` | relay-signed per-viewer hidden-DM snapshot |
| 39005 | `KIND_CHANNEL_THREAD_SUMMARY` | relay-pushed thread reply rollup |
| 39006 | `KIND_CHANNEL_WINDOW_BOUNDS` | pagination bounds |
| 40001 | *(legacy)* | pre-migration stream messages |
| 40002 | `KIND_STREAM_MESSAGE_V2` | **message v2** |
| 40003 | `KIND_STREAM_MESSAGE_EDIT` | **edit event** (overlays a v1/v2 message) |
| 40008 | `KIND_STREAM_MESSAGE_DIFF` | diff message — renders its OWN row |
| 40099 | `KIND_SYSTEM_MESSAGE` | system row (join/leave/topic/…) |
| 43001–43006 | `KIND_JOB_*` | agent job lifecycle rows |
| 45001 / 45003 | `KIND_FORUM_POST` / `KIND_FORUM_COMMENT` | forum |
| 48100–48103 | `KIND_HUDDLE_*` | huddle lifecycle |

Derived kind sets — **rebuild these exactly, they are load-bearing**:

- `CHANNEL_MESSAGE_EVENT_KINDS = [9, 40002, 45001, 45003]` — "human-visible new
  content". This is the **unread trigger set**. Reactions, edits, diffs,
  deletions and system messages are deliberately excluded: they can land after
  the last human-visible message and would create phantom unreads.
- `CHANNEL_EVENT_KINDS` — everything a channel live-subscription requests
  (5, 7, 9005, message kinds, 40001, 40003, 40008, 40099, 48100–48103).
- `CHANNEL_AUX_EVENT_KINDS = [5, 7, 9005, 40003]` — "auxiliary": events that
  **overlay onto or hide** an existing row instead of rendering one. History
  fetches request content kinds only so a `limit` budget buys visible depth
  (a 200-event window on a reaction-heavy channel was only ~136 messages);
  aux events are backfilled separately **by `#e` reference over loaded ids**,
  not by time window, so a late edit/delete for an old visible message still
  applies.
- `CHANNEL_TIMELINE_CONTENT_KINDS = [9, 40002, 40008, 40099, 43001..43006, 48100]`
  — kinds that render their own row. Must stay in sync with
  `messages/lib/formatTimelineMessages.ts:isTimelineContentEvent`.
- `isConversationalUnreadKind(kind)` — false for 40099 and 43001–43006 and
  48100–48103. Undefined kind (optimistic rows) returns **true** so a genuinely
  unread message is never dropped. Reason: a freshly created channel carries one
  `channel_created` + N `member_joined` rows that would otherwise show as
  "4 unread, 1 message".
- `DM_NOTIFIABLE_EVENT_KINDS = CHANNEL_MESSAGE_EVENT_KINDS + [48100]`
  (`channels/isDmNotifiableKind.ts`) — huddle-start is included only for DMs,
  because in a DM the start card *is* the invite.

### 0.3 Transport layers

Three layers, in priority order:

1. **Tauri commands** (`shared/api/tauri.ts`) — request/response over the
   Rust bridge: `getChannels`, `createChannel`, `sendChannelMessage`,
   `editMessage`, `deleteMessage`, `addReaction`, `removeReaction`,
   `searchMessages`, `getPresence`, `getChannelWindowEvents`, …
2. **Relay WebSocket** (`shared/api/relayClient.ts`) — `subscribeLive(filter, cb)`,
   `subscribeToChannelLive`, `subscribeToTypingIndicators`,
   `subscribeToPresenceUpdates`, `subscribeToUserStatusUpdates`,
   `subscribeToReconnects`, `fetchEvents(filter)`, `publishEvent`,
   `sendMessage`, `sendPresence`, `sendTypingIndicator`, `publishUserStatus`.
3. **TanStack Query cache** — the app's actual state store. Query keys:
   - `["channels"]` (`channels/hooks.ts:channelsQueryKey`)
   - `["channels", id, "detail"]`, `["channels", id, "members"]`
   - `["channel-window", channelId]` (`messages/lib/messageQueryKeys.ts:channelWindowKey`)
   - `["channel-messages", channelId]` (`channelMessagesKey`) — the *flattened projection*
   - `["thread-replies", channelId, rootId]` (`threadRepliesKey`)
   - `["presence", ...sortedPubkeys]`, `["user-status", ...sortedPubkeys]`
   - `["custom-emoji"]`, `["custom-emoji-own"]`, `["channel-templates"]`
   - `["search-messages", q, limit, channelId, authors, since, until, unresolvedOperator]`

**Critical invariant:** the *window store* (`["channel-window", id]`) is the
source of truth; `["channel-messages", id]` is a re-flattened projection of it
(`messages/lib/projectChannelWindow.ts:projectChannelWindowMessages`). Patching
only the flattened array gets reverted by the next live event. See
`messages/hooks.ts:useEditMessageMutation.onSuccess` — it updates the store
**first**, then the flattened cache for immediate paint.

### 0.4 The channel window store

`messages/lib/channelWindowStore.ts`:

```ts
type ChannelWindowStore = {
  pages: ChannelWindowPage[];               // newest page first, cursor-linked
  liveOverlay: RelayEvent[];                // top-level live events not yet in a page
  liveAux: RelayEvent[];                    // live structural events (reactions/edits/deletes)
  liveSummaries: Record<rootId, LiveThreadSummary>;  // relay-pushed 39005s
};
type ChannelWindowPage = {
  startCursor: ChannelWindowCursor | null;  // { createdAt, eventId }
  rows: { event, thread: ChannelWindowThreadSummary | null }[];
  aux: RelayEvent[];
  nextCursor: ChannelWindowCursor | null;
  hasMore: boolean;
};
```

- Relay order is `created_at DESC, id ASC` (`compareRelayOrder`).
- Cursors are **composite** `(createdAt, eventId)`. A bare `until` cursor cannot
  escape a second denser than one page — it re-returns the same slice forever.
  See `shared/api/types.ts:ChannelPageCursor` and `ThreadCursor` doc comments.
- `assertValidPage` throws if `hasMore !== (nextCursor !== null)`, on duplicate
  row ids, or on a row outside its cursor interval.

---

## 1. Channel model

### 1.1 Kinds of channel

`shared/api/types.ts`:

```ts
type ChannelType = "stream" | "forum" | "dm";
type ChannelVisibility = "open" | "private";
type ChannelRole = "owner" | "admin" | "member" | "guest" | "bot";
```

The product-level channel kinds are a **product of three axes**, not a single
enum. Rebuild them the same way:

| Product concept | Encoding |
| --- | --- |
| Public channel | `channelType: "stream"`, `visibility: "open"` |
| Private channel | `channelType: "stream"`, `visibility: "private"` |
| DM (1:1) | `channelType: "dm"`, `participantPubkeys.length === 2` |
| Group DM | `channelType: "dm"`, `participantPubkeys.length > 2` |
| Ephemeral channel | any stream/forum with `ttlSeconds !== null` or `ttlDeadline !== null` |
| Forum | `channelType: "forum"` — different query path, NOT the message timeline |
| "Project" channel | **not a channel kind.** Projects are a separate feature (`features/projects`); templates + canvas are what make a channel project-shaped. |

`Channel`:

```ts
type Channel = {
  id: string;                    // uuid
  name: string;                  // stored WITHOUT the leading '#'
  channelType, visibility;
  description: string;
  topic: string | null;
  purpose: string | null;
  memberCount: number;
  memberPubkeys: string[];
  lastMessageAt: string | null;  // ISO
  archivedAt: string | null;     // ISO — archived when non-null
  participants: string[];        // DM display names, index-aligned with…
  participantPubkeys: string[];
  isMember: boolean;
  ttlSeconds: number | null;
  ttlDeadline: string | null;    // ISO
};

type ChannelDetail = Channel & {
  createdBy, createdAt, updatedAt;
  topicSetBy, topicSetAt, purposeSetBy, purposeSetAt;
  topicRequired: boolean;
  maxMembers: number | null;
  nip29GroupId: string | null;
};
```

Name canonicalisation — `channels/lib/canonicalChannelName.ts`:

- `canonicalChannelName(name)` = `name.replace(/^[#\s]+/u, "").trimEnd()`.
  The `#` is display-only; storage never holds it. Keep aligned with the Rust
  `buzz_core::channel::canonical_channel_name`.
- `channelNamesMatch(a, b)` compares canonicalised, lowercased.

Ephemeral display — `channels/lib/ephemeralChannel.ts`:

- `DEFAULT_EPHEMERAL_TTL_SECONDS = 7 * 24 * 3600` (7 days of *inactivity*).
- `isEphemeralChannel(ch)` = `ttlSeconds !== null || ttlDeadline !== null`.
- `getEphemeralChannelDisplay(ch, nowMs)` → `{ detailLabel, tooltipLabel }`.
  - With a live `ttlDeadline`: compact `"1m left" | "Nm left" | "Nh left" | "Nd left" | "Cleanup due"`,
    tooltip `"Ephemeral channel. Cleans up in N minutes. Scheduled for Mar 3, 2:34 PM."`
  - Without a deadline: compact `"30m TTL" | "12h TTL" | "7d TTL"`, tooltip
    `"Ephemeral channel. Cleans up after 7 days of inactivity."`
- `parseTtlDuration("1d12h")` → seconds. Rules: whitespace stripped,
  case-insensitive, **unit required** (bare number rejected), no repeated unit,
  no leftover characters, total must be > 0, else `null`.
- `formatTtlDuration(seconds)` is the inverse (`"1d12h"`); `<= 0` → `""`.

### 1.2 Creation flow

`features/sidebar/lib/useCreateChannelForm.ts:useCreateChannelForm` is the one
form-state hook; both the standalone `CreateChannelDialog` and the create mode
of `ChannelBrowserDialog` mount it so they cannot diverge.

Form state: `name`, `description`, `visibility` (default `"open"`),
`ephemeral` (default false), `ttlSeconds` (default 7d), `selectedTemplateId`,
`errorMessage`, `typePopoverOpen`.

Behaviours:

- Resetting: every field resets when `active` flips true; `initialName` is
  applied and the caret is placed **at the end** after a 50 ms delay (so the
  dialog's open animation starts first). Focus is skipped if something inside
  `#create-channel-form` already has it.
- Template selection (`handleTemplateChange`): sets description from the
  template, and sets visibility from the template **only if the user has not
  touched visibility** (`visibilityTouchedRef`). Clearing the template resets
  description and (untouched) visibility.
- Submit: trims name, bails on empty, calls
  `onCreate({ name, description?, visibility, ttlSeconds?, templateId? })`,
  then `onCreated()`. Errors render inline as `Failed to create channel.` /
  the thrown message.
- `CreateChannelInput` sent to the backend is
  `{ name, channelType: "stream"|"forum", visibility, description?, ttlSeconds? }`
  (`shared/api/types.ts:CreateChannelInput` — note `channelType` excludes `"dm"`).

Channel-type control: `channels/ui/ChannelTypePicker.tsx` — a dropdown radio
group with exactly two options, **Ongoing** (`Hash` icon) and **Temporary**
(`ClockFading` icon). The ephemeral TTL editor is `ChannelTypeSettings.tsx`;
visibility is `ChannelPermissionsSettings.tsx`.

Post-create side effects (`channel-templates/useApplyTemplate.ts`):

- `applyCanvas(templateId, channelId, channelName)` — substitutes
  `{channel.name}` and `{template.name}` in `template.canvasTemplate` and calls
  `setCanvas`. Best-effort: failures never block navigation.
- `applyAgents(templateId, channelId)` — expands `template.agents.personas` and
  `template.agents.teams` into managed agents, de-duplicating persona ids across
  both lists (`seenPersonaIds`), resolving runtime via `resolvePersonaRuntime`
  falling back to the user's last-used runtime then the first available. Partial
  failures raise a `toast.warning("N agents from the template could not be created")`.
  Invalidate `["channels", id, "members"]`, `["managed-agents"]`, `["relay-agents"]`.

DM creation: `channels/hooks.ts:useOpenDmMutation` → `openDm({ pubkeys })`.
The new-message composer lives at `messages/ui/NewMessageScreen.tsx` +
`useNewMessageRecipients.ts` (route `messages.new`). **DM participant sets are
immutable** — adding a person to a DM creates a *different* conversation.

### 1.3 The channel browser dialog

`channels/ui/ChannelBrowserDialog.tsx` — the single entry point for both
browsing and creating.

Props: `channels`, `channelTypeFilter?: "stream" | "forum"`, `open`,
`onOpenChange`, `onJoinChannel`, `onSelectChannel`, `onCreateChannel?`,
`isCreatingChannel?`.

Two modes in one dialog: `"browse"` and `"create"` (`mode` state). Create mode
renders `ChannelCreateView` with a back arrow ("Back to search") that returns to
browse and re-focuses the search input on the next animation frame.

Browse mode structure:

1. Header: title (`"Browse channels"` / `"Add a forum"`) + close button.
2. Search shell: magnifier icon + text input + a sort dropdown
   (`Alphabetical` | `Recent` | `Most members`, default `alpha`).
   Placeholder: `"Search or create a channel"` when creation is available,
   otherwise `"Search channels by name or description"`.
3. Tabs with an animated underline indicator: **All channels** / **Joined** /
   **Archived**. The indicator's `left`/`width` are measured from the active
   trigger via `useLayoutEffect` + `ResizeObserver` + `document.fonts.ready`,
   and only updated when it moves by ≥ 0.5px.
4. Pinned **create row** (Are.na-style) then the channel list.

Visibility filter (the rule that decides what you may even see):

```
channel.channelType !== "dm" &&
(channel.archivedAt ? channel.isMember
                    : channel.visibility === "open" || channel.isMember) &&
(channelTypeFilter ? channel.channelType === channelTypeFilter : true)
```

i.e. **archived channels are visible only to members**; unarchived private
channels only to members; open channels to everyone.

Tabs partition that set: `all` = everything matching, `joined` = unarchived ∧
`isMember`, `archived` = `archivedAt !== null`.

Search: the query is canonicalised (`canonicalChannelName`) then lowercased and
**deferred** (`useDeferredValue`) for the filter, but the create row reads the
**live, non-deferred** query so its visibility and label can never disagree for
a frame.

Fuzzy scoring — `channels/lib/channelSearchScore.ts`. Lower is better, `null` =
no match:

| Score | Band |
| --- | --- |
| 0 | name exactly equals query |
| 1 | name starts with query |
| 2 | a word (split on `[\s\-_./]+`) exactly equals query |
| 3 | a word starts with query |
| 4 | name contains query |
| 5 | separator-collapsed name contains separator-collapsed query (`releasenotes` → `release-notes`) |
| 6 | collapsed query (≥2 chars) is an in-order **subsequence** of the name (`reln` → `release-notes`) |
| 7 | description plain-substring match (description never fuzzy) |

Deliberately **no Levenshtein / typo tolerance** — it reorders results
unpredictably and hides a channel the user can plainly see.
`scoreChannelMatch` returns 0 for an empty query.

Ordering: sort by the chosen sort mode first (`sortChannelsForSidebar` for
alpha/recent; `memberCount desc, name asc` for members), then — **only when
searching** — re-sort by match score ascending.

The create row (`CreateChannelRow`):

- Shown iff `onCreateChannel` exists **and** no existing non-DM channel of the
  same `channelTypeFilter` has a name matching the live query
  (`channelNamesMatch`). It is present from the moment the dialog opens (so it
  is clear you may browse *or* create) and specialises to
  `Create channel “<query>”` as you type.
- It participates in keyboard navigation as **virtual index 0**; channels shift
  down by `channelNavOffset = 1`, keeping keyboard order identical to visual order.

Keyboard (handled on the search input):

| Key | Effect |
| --- | --- |
| `ArrowDown` | move selection down, clamped to `navItemCount - 1`; from `null` selects 0 |
| `ArrowUp` | move selection up, clamped to 0; from `null` selects the last item |
| `Enter` | if the create row is selected **or** there are zero channel matches → enter create mode with the query prefilled; else open the selected channel (or the first) |

Selection resets to `null` on typing, tab change, and sort change; it is clamped
whenever `navItemCount` shrinks. Everything (query, tab, sort, selection,
joining id, mode, prefill) resets when `open` goes false.

Channel row (`ChannelCard`): `#` + name + `archived` warning badge; second line
is `"N members"` + `·` + description. A **Join** button appears for non-members,
hidden until row hover/focus-within, showing `"Joining..."` while pending. On
successful join: close the dialog then `onSelectChannel(id)`. On failure: clear
the joining state and leave the dialog open.

Empty states (`BrowseState`, icon + title + description):

| Condition | Title | Description |
| --- | --- | --- |
| query non-empty | `No channels match your search` | `No channel by that name yet — create it to get started.` (creation available) / `Try a different name or keyword.` |
| tab=archived, no query | `No archived channels` | `Archived channels you have joined will appear here.` |
| tab=joined, no query | `No joined channels` | `Channels you join will appear here.` |
| tab=all, no query | `No channels to browse` | `All open channels are available in the sidebar. Create a new channel to get started.` |

Icon is `Search` when a query is present, `Compass` otherwise. All strings
swap `channel` → `forum` when `channelTypeFilter === "forum"`.

### 1.4 Joining, leaving, archiving, deleting

`channels/hooks.ts` — every mutation and its exact cache policy:

| Hook | Backend | Cache behaviour |
| --- | --- | --- |
| `useChannelsQuery` | `getChannels()` | sorted by `sortChannels`; `staleTime` and `refetchInterval` **60 s**, not in background; seeded from a per-relay localStorage snapshot (`channels/channelSnapshot.ts`) with `initialDataUpdatedAt: 0` so the seed is already stale and a revalidate fires immediately |
| `useCreateChannelMutation` | `createChannel` | `onSuccess` → `upsertCachedChannel`; `onSettled` invalidates with `refetchType: "none"` — an immediate `getChannels()` blocked the dialog and could clobber the new channel with a read-after-write-lagged snapshot |
| `useOpenDmMutation` | `openDm` | `onSuccess` upsert; `onSettled` full invalidate |
| `useHideDmMutation` | `hideDm` | true optimistic: `onMutate` cancels + filters the DM out, `onError` restores `context.previous` |
| `useUpdateChannelMutation` | `updateChannel` | `onSuccess` writes both detail and list; `onSettled` invalidates with `refetchType: "none"` (awaiting the refetch kept the edit dialog on "Saving…") |
| `useSetChannelTopicMutation` / `useSetChannelPurposeMutation` | `setChannelTopic` / `setChannelPurpose` | fire-and-forget `invalidateChannelState` (awaiting blocks the dialog) |
| `useArchiveChannelMutation` / `useUnarchiveChannelMutation` | `archiveChannel` / `unarchiveChannel` | `onSuccess` writes `archivedAt = new Date().toISOString()` / `null` into both list and detail; `onSettled` awaits `invalidateChannelState` |
| `useDeleteChannelMutation` | `deleteChannel` | `onSuccess` removes from list and `removeQueries` for detail + members; `onSettled` also invalidates `["managed-agents"]` and `["relay-agents"]` |
| `useJoinChannelMutation` / `useLeaveChannelMutation` | `joinChannel` / `leaveChannel` | `onSettled` awaits `invalidateChannelState` |
| `useAddChannelMembersMutation` | `addChannelMembers` | invalidates the **effective** channel from `variables`, not the hook closure (which may have changed mid-send) |
| `useRemoveChannelMemberMutation` | `removeChannelMember` | invalidates channel state + agent lists |
| `useCanvasQuery` / `useSetCanvasMutation` | `getCanvas` / `setCanvas` | `["channel-canvas", channelId]` |

Helpers worth copying verbatim:

- `sortChannels` — dedupe by id into a Map, then sort by
  `channelTypeOrder = { stream: 0, forum: 1, dm: 2 }` then `name.localeCompare`.
- `upsertCachedChannelMember(current, channelId, member)` — records a membership
  mutation before the read-after-write refetch. **Never decorates a DM**:
  DM participant sets are immutable, so adding a member there creates a separate
  conversation.
- `upsertCachedChannel`, `reconcileRefreshedCachedChannel` — the latter lets a
  freshly-opened channel repair the route after a read-after-write-lagged list
  response, while a refresh that already contains the channel wins.
- `useUpsertCachedChannel` — awaits any in-flight active refetch, *then* writes.
- `useSelectedChannel(channels, preferredChannelId)` — falls back to the first
  non-forum channel, then `channels[0]`; re-selects when the current selection
  disappears from the list.

### 1.5 Channel settings

Two surfaces:

**A. The management panel** — `channels/ui/ChannelManagementSheet.tsx`, rendered
as an auxiliary panel (docked / floating / single-panel modes via
`shared/layout/AuxiliaryPanel*`). Title `"Channel"`; a sub-view titled
`"Canvas"` reached through an `IngressRow` with a back arrow.

Summary view contents, in order:

1. `ChannelHero`.
2. Inline error banners for `detailsQuery.error` and `membersQuery.error`.
3. Quick-action row: **Copy ID** (toast `"Copied channel ID"`), **Join**
   (`"Joining..."`), **Leave** (`"Leaving..."`, closes the panel on success),
   **Edit** (opens the edit dialog). Each gated on `canJoin` / `canLeave` /
   `canManageChannel`.
4. Narrative group — only rendered if at least one of description/topic/purpose
   is non-blank: `Description`, `Topic`, `Purpose` rows.
5. Canvas ingress row with a preview and `"Loading..."`.
6. Field group: `Channel ID` (copyable), `Name`, `Type`, `Visibility`,
   `Members` (count), `Status: Archived` (only when archived),
   `Ephemeral: <ttl>` (only when `ttlSeconds !== null`).
7. Footer moderation actions (`ChannelManagementModerationActions.tsx`) —
   Archive / Unarchive / Delete, shown only when
   `activeView === "summary" && canManageChannel && channelType !== "dm"`.
   Delete goes through a confirm dialog.

**B. The edit dialog** (owner/admin only): title
`Edit {private|public} channel`; fields **Name** (input) and **Description**
(textarea, 2 rows), then for non-DM channels `ChannelTypeSettings`
(Ongoing/Temporary + TTL) and `ChannelPermissionsSettings` (visibility, which
mutates immediately via `handleConvertVisibility`). Footer: Cancel / Save.
Save is disabled unless the user actually edited something
(`hasUserEditedChannelDraft`).

Topic vs purpose vs description — three distinct fields:

- `description` — the browsable blurb, set at creation, edited in the dialog.
- `topic` — "what we're on right now", `setChannelTopic`, emits a `topic_changed`
  system message.
- `purpose` — long-lived charter, `setChannelPurpose`, emits `purpose_changed`.

`channels/lib/channelDescription.ts:getChannelDescription` is the single header
subtitle resolver: prefixes `"Archived."` and
`"Read-only until you join this open channel."`, then the **first** non-blank of
`[topic, description, purpose]` (only the first, to avoid duplication when they
overlap), joined by spaces. Falls back to `"Channel details and activity."`,
or `"Connect to the relay to browse channels and read messages."` when there is
no channel.

### 1.6 Member lists and roles

`channels/ui/MembersSidebar.tsx` + `MembersSidebarMemberCard.tsx` +
`ChannelMembersBar.tsx` (a compact avatar bar in the header).

Classification — `channels/lib/useClassifiedMembers.ts`:

1. **Archived wins over bot.** Peel archived identities first
   (`identity-archive/hooks.ts:useIsArchivedPredicate`), so a zombie agent folds
   into "Archived" instead of appearing as an active Bot.
2. Split the remainder into **people** and **bots**. `isBot(member)` is
   `member.role === "bot" || managedAgentPubkeys.has(pk) || relayAgentPubkeys.has(pk)`.
3. `isMyBot(member)` = the pubkey is in the caller's managed agents.
4. Each list sorted by `compareMembersByRole`.

Sorting — `channels/lib/memberUtils.ts`:

```
roleOrder = { owner: 0, admin: 1, member: 2, guest: 3, bot: 4 }
compareMembersByRole(l, r, me):
  me first (l === me → -1, r === me → 1)
  then roleOrder delta
  then formatMemberName(l).localeCompare(formatMemberName(r))
formatMemberName(m, me) = m.pubkey === me ? "You" : (m.displayName ?? truncatePubkey(m.pubkey))
```

Adding members: `channels/ui/ChannelMemberInviteCard.tsx` and
`AddChannelBotDialog.tsx` (persona / team / generic sections).
`AddChannelMembersInput = { channelId, pubkeys, role? }` where role excludes
`"owner"`; the result is `{ added: string[], errors: {pubkey, error}[] }` — a
partial success is a normal outcome and must be rendered as such.

### 1.7 Channel templates

`shared/api/types.ts:ChannelTemplate`:

```ts
{
  id, name, description: string | null,
  channelType: "stream" | "forum",
  visibility: "open" | "private",
  canvasTemplate: string | null,        // supports {channel.name} / {template.name}
  agents: {
    personas: { personaId, runtime, model, role, backend }[],
    teams:    { teamId, runtime, model, backend }[],
  },
  isBuiltin: boolean, createdAt, updatedAt
}
```

`channel-templates/hooks.ts` — `useChannelTemplatesQuery` (`staleTime` and
`refetchInterval` 30 s), create / update / delete / **duplicate** mutations.
Create and duplicate optimistically prepend the returned template to the cached
list, filtering out any same-id entry first.

---

## 2. Message model

### 2.1 Versions and the edit overlay

There are two message kinds (`9` v1, `40002` v2) plus a separate **edit event**
kind `40003`, a **diff** kind `40008`, and a **system** kind `40099`.

`messages/lib/formatTimelineMessages.ts:formatTimelineMessages` is the one
projector from `RelayEvent[]` → `TimelineMessage[]`. Its passes, in order:

1. **Deletions.** Collect the `e`-tag targets of every kind-5 and kind-9005
   event (`getDeletionTargets` — accepts only 64-char hex). Both are deletion
   markers, mirroring the relay.
2. **Edits.** Build `targetId → { content, tags, createdAt }` from kind-40003
   events, skipping deleted edits and edits targeting deleted messages.
   **Most recent `created_at` wins.** The edit's own tags are kept so the
   renderer can overlay imeta.
3. **Visible set** = events that are `isTimelineContentEvent` and not deleted.
4. **Reactions.** For every kind-7: target = the **last** valid `e` tag
   (`getReactionTargetId` scans backwards); emoji = `content.trim() || "+"`;
   for a `:shortcode:` emoji, resolve `emojiUrl` from a matching
   `["emoji", shortcode, url]` tag. Presence is keyed
   `${targetId}:${actorPubkey}:${emoji}` so duplicate deliveries collapse, and
   the **earliest** `created_at` is retained so pill chronology is invariant to
   input-array order.
5. Aggregate into `TimelineReaction` pills. Pill order: **earliest reaction time
   ascending** (Slack-style: first-reacted emoji leftmost), tiebreak
   `emoji.localeCompare` for determinism. `users[].displayName` is `"You"` for
   self, else `displayName || nip05Handle || truncatePubkey`.
6. Emit one `TimelineMessage` per visible event.

```ts
// messages/types.ts
type TimelineMessage = {
  id: string;
  renderKey?: string;      // localKey ?? id — stable across optimistic→ack
  createdAt: number;
  pubkey?: string;         // ATTRIBUTED author (may be a delegated actor)
  signerPubkey?: string;   // raw event.pubkey, lowercased
  author: string;          // resolved display label
  isAgent?: boolean; ownerPubkey?: string|null; ownerLabel?: string|null;
  avatarUrl?: string|null;
  role?: string;                     // channel role of the author
  personaDisplayName?: string;       // bots only
  respondTo?: "owner-only"|"allowlist"|"anyone";  // bots only
  time: string;            // pre-formatted "2:34 PM"
  body: string;            // EDITED content when an edit exists
  parentId?: string|null; rootId?: string|null; depth: number;
  accent?: boolean;        // authored by the current user
  pending?: boolean; edited?: boolean; highlighted?: boolean;
  kind?: number; tags?: string[][];
  reactions?: TimelineReaction[];
};
```

Two subtleties:

- `pubkey` vs `signerPubkey`. `resolveEventAuthorPubkey({ event, preferActorTag: true,
  relaySelfPubkey, requireChannelTagForPTags: true })` (`shared/lib/authors.ts`)
  resolves the *attributed* author, which for relay-signed events is an actor
  tag rather than the signer. Any check that needs "who cryptographically signed
  this" must use `signerPubkey`.
- `tags` is `applyEditTagOverlay(event.tags, edit?.tags)`
  (`messages/lib/applyEditTagOverlay.mjs` — a `.mjs` sibling **on purpose** so
  `node:test` runs the exact same source the renderer uses). It swaps the
  original's imeta tags for the edit's imeta tags and preserves every non-imeta
  tag (`h`, mention `p`s, …).

Depth resolution (`getDepth`): memoised, cycle-guarded (`resolvingEventIds`),
0 for no parent, `parentDepth + 1` when the parent is loaded, and when the
parent is **not** loaded a fallback of `2` if `rootId !== parentId` else `1`.

Profile-pubkey collection helpers (batch one `useUsersBatchQuery`):
`collectMessageAuthorPubkeys` (both signer and attributed actor; for system
messages, the payload's `actor`/`target`), `collectMessageMentionPubkeys`,
`collectReactionActorPubkeys`, and the union `collectMessageProfilePubkeys`.

`countTopLevelTimelineRows(events)` — counts *visible top-level rows* a raw
window would render, not `events.length`. Used by fetch-older to decide how far
to page: a history batch heavy with replies can add 100 events but only a
handful of rows.

### 2.2 Threading

`messages/lib/threading.ts`:

```
getThreadReference(tags):
  eventTags = tags where tag[0] === "e"
  if none            → { parentId: null, rootId: null }
  rootTag  = FIRST tag with tag[3] === "root"
  replyTag = LAST  tag with tag[3] === "reply"
  if no replyTag     → { parentId: null, rootId: null }
  parentId = replyTag[1]
  rootId   = rootTag?.[1] ?? parentId
```

- `isBroadcastReply(tags)` — `["broadcast","1"]`. A broadcast reply is a reply
  that **also** renders as a top-level row.
- `isThreadReply(tags)` = has a parent ∧ not broadcast.
- `buildReplyTags(channelId, author, parentId, rootId, mentions)` — emits
  `["p", author]`, `["h", channelId]`, `["p", …mentions]`, then either
  `["e", root, "", "reply"]` (when parent === root) or
  `["e", root, "", "root"] + ["e", parent, "", "reply"]`.
- `normalizeMentionPubkeys(list, self)` — lowercase, dedupe, **drop self**.
  Client-side best effort; the relay validates authoritatively (hex, 64 chars,
  cap 50).
- `diffAddedMentionPubkeys(originalPubkeys, editedPubkeys, self)` — returns only
  mentions an **edit newly adds**, case-insensitively. A typo-fix edit that
  leaves the mention set unchanged yields `[]`, so the edit event carries no
  `p` tags and **re-wakes nobody**.
- `resolveReplyRootId(parentEventId, events)` — climbs to the parent's root, or
  falls back to the parent id when the parent is not loaded.

### 2.3 Thread panes and the summary row

`messages/lib/threadPanel.ts`:

- `buildMainTimelineEntries(messages, unreadReplyIds, relaySummaries, profiles)`
  → `MainTimelineEntry[]`, keeping only `parentId == null || isBroadcastReply`.
  Each entry carries a `summary: TimelineThreadSummary | null`.
- `buildDescendantStatsByMessageId` walks messages **newest-first** and, for
  each, climbs the ancestor chain (hop-capped at `messages.length + 1` to defeat
  cycles) incrementing `descendantCount`, `unreadDescendantCount`, raising
  `lastReplyAt`, and pushing at most **3** distinct participants
  (`MAX_SUMMARY_PARTICIPANTS`) newest-first.
- The rendered summary reverses that to **oldest-first**, so a facepile puts the
  most recent replier rightmost. The relay-sourced summary
  (`buildRelayThreadSummary`) takes the relay's most-recent-first
  `participantPubkeys`, slices 3, and reverses — for the same reason.
- `mergeThreadSummaries(local, relay)` — `replyCount = max`, `lastReplyAt = max`
  (0 → null), participants = relay-then-local by id, last 3.
- Huddle-started rows (`KIND_HUDDLE_STARTED`) are forced to `summary: null`.

The thread pane itself (`buildThreadPanelDataFromIndex`):

- `threadHead` is the head message with `depth` normalised to 0.
- `visibleReplies` is built by `appendExpandedReplies` starting at depth 1:
  each direct child is emitted; if it is in `expandedReplyIds` its own children
  are emitted recursively at depth+1 and it carries **no** summary; otherwise it
  carries a summary of its whole subtree.
- Reply-depth normalisation goes through `normalizeInlineReplyMessage`, which
  memoises `{...message, depth}` in a `WeakMap<TimelineMessage, Map<depth, …>>`.
  Building it fresh every render hands `MessageRow` a new object identity on
  every unrelated churn (typing/presence) and defeats the row/markdown memo
  (~1.4 ms/row re-parse).
- `replyTargetMessage` falls back to the (normalised) thread head.
- `hasNestedThreadBranches(entries)` — any `depth > 1` or any non-null summary.

Thread pane layout modes — `channels/lib/threadViewModePreference.ts`:

- `ThreadViewMode = "focus" | "split"`, default **`"split"`**.
- Stored in `localStorage["buzz.channels.threadViewMode"]`; a device-level UI
  preference, deliberately **not** reset on community switch.
- Exposed through a module-level `useSyncExternalStore` (`useThreadViewMode`,
  `getThreadViewMode`, `setThreadViewMode`); `getServerSnapshot` returns the
  default.
- `focus` = a large right-anchored drawer over the channel with a narrow
  scrim-dimmed sliver of channel left visible as an orientation cue and a
  click-target back (`channels/ui/FocusThreadDrawer.tsx`).
  `split` = a resizable side panel (`shared/hooks/useThreadPanelWidth.ts`).
  Only applies at viewports wide enough for two panes; narrow viewports keep
  single-panel/floating-overlay behaviour.

Thread replies are fetched separately: `messages/useThreadReplies.ts` →
`["thread-replies", channelId, rootId]`, forward keyset cursor
`ThreadCursor = { createdAt, eventId }`. The event-id tiebreak is load-bearing
because bursty threads routinely share a `createdAt` second.
`messages/useLoadMissingAncestors.ts` backfills a reply's missing ancestors.
`messages/useIndependentThreadPanel.ts` + `lib/independentThreadPanel.ts` power
a thread pane detached from the active channel.

### 2.4 Quoting and forwarding

- **Quoting** exists only as markdown blockquote formatting in the composer
  toolbar (`messages/ui/FormattingToolbar.tsx`, label `"Quote"`, `Quote` icon).
  There is no quote-with-attribution message primitive.
- **Forwarding does not exist.** The nearest primitives are "Copy link"
  (`buzz://message?…`, §3) and pasting a message link, which renders as an
  inline `MessageLinkPill` reading `#channel · abc123`
  (`shared/ui/markdown/MessageLinkPill.tsx`).
- **Reply** is the sharing primitive; **Remind me later**
  (`features/reminders`) is the "save for later" primitive. There is no
  pin/bookmark/star **on a message** — starring exists only for channels.

### 2.5 Drafts

`messages/lib/useDrafts.ts` — a localStorage-backed store with a module-level
subscriber set exposed through `useSyncExternalStore` (`useDraftsSnapshot`),
because localStorage is not reactive. Every write bumps a version counter and
notifies.

```ts
type DraftState = {
  content: string;
  selectionStart: number; selectionEnd: number;
  channelId: string;            // stored explicitly — NEVER parsed back out of the key
  createdAt: string; updatedAt: string;  // ISO
  pendingImeta: ImetaMedia[];
  mentionRefs?: { displayName, pubkey, isAgent }[];
  spoileredAttachmentUrls: string[];
  status: "active" | "sent";     // always "active" at runtime
};
```

Rules:

- Storage key: `buzz-drafts.v2:<canonicalRelayScope>:<pubkey>`, legacy
  `buzz-drafts.v1:<pubkey>`. `canonicalizeRelayScope` preserves path/query case
  (unlike the shared `normalizeRelayUrl`) so `wss://host/Team` and
  `wss://host/team` are separate buckets.
- **One-time forward migration**: v1 entries are read only when no v2 store
  exists *and* a relay scope is set; the v1 key is deleted after a successful
  flush so no other workspace can import the same legacy bucket.
- Draft keys are `channelId` for the channel composer and `thread:<threadHeadId>`
  for a thread composer.
- `MAX_DRAFTS = 100`, evicting the least-recently-`updatedAt`.
- `saveDraftEntry` is a **no-op** when content is blank and there are no
  attachments. `persistDraftEntry` saves-or-clears, preserving `createdAt`.
- `renameDraftEntry(oldKey, newKey)` is atomic (one flush, one notify) and
  returns `"migrated" | "collision" | "noop"`. It collapses onto an existing
  destination **only when every persisted field is identical**
  (`draftStatesEqual` compares content, selection, channelId, both timestamps,
  status, and every `ImetaMedia` optional field, plus mentionRefs and spoiler
  URLs). Any divergence is a collision and both records are preserved.
  Callers must not compose this from save+clear (two flushes, clobber risk).
- Legacy `sent:`-prefixed records are dropped on read; `markDraftSentEntry` now
  just clears the active draft.
- `getAllDraftEntries()` sorts most-recently-updated first.
- UI: `messages/ui/DraftsPanel.tsx` + `DraftDetailPane.tsx`.
  `messages/ui/draftSubmitKey.ts:resolveSentDraftKey(effectiveDraftKey, loadDraft)`
  returns the key only when an entry actually exists in the store at submit
  time (fast sends never persist a draft, so there is nothing to clear).

### 2.6 Optimistic send, failure, retry

`messages/hooks.ts:useSendMessageMutation`.

Target resolution happens **twice, identically** — once in `mutationFn` and once
in `onMutate` — so the optimistic row lands in the same channel as the real
send:

```
resolveSendChannel(targetChannel, capturedChannelId, channelsCache, fallbackChannel)
  = targetChannel                                        // relay-returned object wins
 ?? resolveEffectiveChannel(capturedChannelId, cache, fallback)
resolveEffectiveChannel(id, cache, fallback)
  = id == null ? fallback : (cache?.find(c => c.id === id) ?? null)
```

If a captured id resolves to nothing → throw `"Channel is no longer available."`
(never silently fall back to the live channel — navigation must not redirect a
message). Forum channels throw
`"This channel does not support message sending yet."`

Transport choice: replies, messages with imeta tags, and messages with NIP-30
emoji tags go through the **REST** `sendChannelMessage` so the relay's tag
validation runs; everything else uses the WebSocket `relayClient.sendMessage`.
`splitOutgoingTags(mediaTags)` splits the merged outgoing tag set into
`{ mediaTags (imeta), emojiTags, mentionTags }` because each has its own
validated Tauri argument — emoji tags must not ride the imeta-only channel
(the Rust `imeta_tags` guard rejects non-imeta prefixes and silently dropped
emoji sends).

Optimistic row — `createOptimisticMessage`:

```
localKey = `optimistic-${crypto.randomUUID()}`
id = localKey; sig = ""; pending = true; kind = 9
created_at = floor(Date.now()/1000)
tags = reply ? buildReplyTags(...) : [["h", channelId], ["p", self], ...mentionPs]
       + mediaTags
```

It is merged into the **window store** via `mergeLiveChannelWindowEvent` and the
flat cache is re-projected.

- `onError`: `recordTimeoutFromRejection(error.message)` (a community timeout
  surfaces as the relay's `OK false` reason and blocks further sends with a
  composer chip), then restore `previousMessages` and `previousWindow`.
- `onSuccess`: `clearTimeoutState()` (an accepted send proves the write-block is
  lifted), remove the pending row from `liveOverlay` by id, then merge the real
  event **carrying `localKey: optimisticId`** so the row does not remount.

Reconciliation — `messages/lib/messageMerge.ts`:

```
isMatchingPendingMessage(pending, incoming):
  pending.pending && !incoming.pending
  && content equal && kind equal
  && pubkey equal (case-insensitive)
  && channel h-tag equal
  && thread parentId equal && thread rootId equal
```

When matched, the incoming event inherits the pending row's `localKey`, and the
merge drops any row with the same `id` **or** the same render key. This is what
makes an optimistic bubble become the real message with no flash.

Composer failure handling (`messages/ui/MessageComposer.tsx`): the composer
clears itself optimistically but snapshots `savedContent`, `savedImeta` and
`savedSpoileredAttachmentUrls`; on a thrown send/edit it **restores all three**.
There is no automatic retry — the restored composer *is* the retry affordance.

Send is refused when: content is blank and there is no media; `disabled`;
already sending; still uploading; a mention-send flow is preparing; or a
captured thread context has no `parentEventId`.

### 2.7 Ordering

`messages/lib/messageQueryKeys.ts`:

- `dedupeMessagesById` keeps the **last** occurrence (iterates backwards, then
  reverses) — later deliveries win.
- `sortMessages` = dedupe, then `created_at` ascending, **tiebreak on `id`
  ascending**. Without the tiebreak, two events sharing a `created_at` land in
  different positions depending on whether history or the live sub delivered
  first, which reads as a "missing"/shuffled message at a fixed scroll offset.
- `mergeTimelineHistoryMessages(current, history)` detects an older page
  (`newestHistory <= oldestCurrent`) and concatenates accordingly.
- The window store uses the inverse relay order:
  `compareRelayOrder` = `created_at` **descending**, then `id` ascending.

### 2.8 Pagination and virtualization

Cold load: `useChannelMessagesQuery` calls `getChannelWindowEvents(channelId)`,
parses it into a page, `replaceNewestChannelWindow`s it into the store, and
returns `reconcileChannelWindowMessages(next, previousMessages)`.
`staleTime` 5 min, `gcTime` 60 min. Disabled for forum channels.

Older pages: `messages/lib/pageOlderMessages.ts:pageOlderMessagesUntilRowFloor`
— **page size 50**, one server-defined window per call, de-duplicated by an
in-flight `Map<channelId, Promise>` so concurrent triggers coalesce.
`shouldContinue()` aborts a write if the channel changed mid-flight.

`messages/useFetchOlderMessages.ts` exposes:

- `hasOlderMessages` — derived **reactively from the store's tail `hasMore`**,
  never a private latch. A latch reset only on channel change went stale on
  reconnect (a refreshed newest window reports `hasMore: true`, but the latch
  stayed false and froze paging at page one).
- `historyExhausted` — distinct from `!hasOlderMessages`: an empty/unloaded
  window also reports "no more", but exhaustion requires a **resolved tail page**
  proving the channel's beginning. Only this may gate the oldest day divider.

Virtualization is [`virta`](https://github.com/inokawa/virtua)-based
(`messages/ui/TimelineMessageList.tsx`, `useVirtualizedBottomSettle.ts`,
`useVirtualizedViewportResize.ts`, `virtuaWheelModePatch.test.mjs`).

`messages/lib/virtualizedTimelineItems.ts`:

- `buildVirtualizedItems(dayGroups, leadingContent, historyExhausted)` emits
  `leading-content?`, then per day group a `day-divider` **only at a proven
  boundary**, then the group's items, then a `bottom-spacer`.
- A boundary is *proven* when `groupIndex > 0` (a strictly older loaded day
  precedes it) **or** `historyExhausted`. The oldest loaded day gets no divider
  while more history exists: its start is the arbitrary edge of the loaded
  window, and a divider there would have to accept older same-day rows
  prepending *behind* it, breaking exact-suffix key admission.
- Divider keys are namespaced `day-divider:<key>` so they cannot collide with
  message ids or `unread-*` sentinels.
- `didPrependVirtualizedTimeline(prevKeys, keys)` — true only when
  `keys.length > prevKeys.length` **and every previous key is the exact suffix**
  (`prevKeys[i] === keys[i + delta]`). Virtua shifts its positional size cache by
  the length delta, so `shift` is enabled only under that exact condition.
- Height estimates: bottom-spacer 96, leading-content 60, day-divider 32,
  otherwise `estimateTimelineItemHeight`.

`messages/lib/rowHeightEstimate.ts` — cheap, no-DOM, no-markdown-parse estimate
used for `contain-intrinsic-size` so a never-painted media/code row realises near
its true height instead of teleporting on scroll-up. Constants:
`MEDIA_MAX_WIDTH 384`, `MEDIA_MAX_HEIGHT 256`, `TEXT_LINE_HEIGHT 20`,
`CODE_LINE_HEIGHT 19`, `CHARS_PER_LINE 64`, `ROW_CHROME 26`,
`CONTINUATION_ROW_CHROME 8`, `MEDIA_BLOCK_MARGIN_TOP 4`, `REACTION_ROW 24`,
`PREVIEW_CARD 70`, `MESSAGE_ITEM_BOTTOM_PADDING 10`, `MIN_ESTIMATE 60`,
`CONTINUATION_MIN_ESTIMATE 28`, `DIVIDER_HEIGHT 32`, `SYSTEM_GROUP_HEIGHT 80`.
Fenced code is split out and counted at mono line-height; imeta `dim`s scale into
the media box; dim-less inline media (markdown `![](url)` and bare media URLs on
their own line) reserve the full box; a bare non-media URL alone on a line adds a
link-preview card.

Row retention: `messages/ui/timelineRetention.ts:nextRetainedTimelineKeys` keeps
an ID-keyed neighbourhood around the reader — admission band
`[offset - 8·viewport, offset + 9·viewport]`, eviction band
`[offset - 12·viewport, offset + 13·viewport]` (the wider band is hysteresis so
small direction changes don't churn mounts), plus the visual tail
`[scrollSize - 3·viewport, end]`. Returns the previous set by identity when
unchanged.

Anchored scroll: `messages/ui/useAnchoredScroll.ts` (+ `anchoredScrollPolicy.ts`,
`useSettleGatedPrependMessages.ts`, `useBufferedTimelineMessages.ts`,
`useLoadOlderOnScroll.ts`, `useUpwardPaginationWheel.ts`). Key rules:

- `BOTTOM_THRESHOLD_PX = 72` for UI "at bottom" (`timelineSnapshot.ts:isNearBottom`);
  programmatic bottom pins require the physical floor,
  `TRUE_BOTTOM_THRESHOLD_PX = 1` (`settleProgrammaticBottomPin`).
- `selectLatestMessageAutoScrollBehavior({hasExplicitBottomRequest, isAtBottom,
  shouldStickToBottom, targetMessageId})` → `null` if a deep-link target is
  pending, `"smooth"` on an explicit bottom request, `"auto"` when sticky or at
  bottom, else `null`.
- `shouldSettleVirtualizedBottom` requires `isAtBottom && delta !== "prepend" &&
  (arrived > 0 || changed)` — a prepend must never yank you to the bottom.
- `classifyTimelineMessageDelta({current, previous})` → `"prepend" | "append" |
  "replace" | "none"`, decided by comparing first/last ids and lengths.

### 2.9 Jump-to-message and deep links

Link format — `messages/lib/messageLink.ts`:

```
buzz://message?channel=<uuid>&id=<eventId>[&thread=<rootId>]
```

- `buildMessageLink` throws on a missing `channelId`/`messageId`; an empty
  `threadRootId` is treated as "no thread" so callers can pass
  `getThreadReference(tags).rootId` straight through.
- `parseMessageLink` returns a discriminated result
  (`{ok:true,value} | {ok:false,reason}`) with reasons `invalid-url`,
  `wrong-scheme`, `wrong-host`, `missing-channel`, `missing-id` — callers render
  a plain link rather than throwing.
- `isMessageLink(href)` — cheap pre-check for the markdown renderer.
- `resolveMessageLinkRenderTarget({href, label})` → `"pill"` when
  `label === href` (a CommonMark autolink) and `"label"` when the author gave it
  a label, so an autolink becomes a chip and a labelled link keeps its words.
- `thread` is currently emitted but **not consumed**: both the click handler and
  the OS deep-link listener route via `goChannel(channelId, { messageId })` and
  let `useAnchoredScroll` resolve the target.

OS deep links: `shared/deep-link.ts:listenForMessageDeepLinks` +
`shared/useMessageDeepLinks.ts` — mirrors the cold-start race handling of the
`connect` listener, so a payload that arrives before the listener mounts is
still picked up.

Resolution against a snapshot — `messages/lib/timelineSnapshot.ts`:

- `resolveDeepLinkTarget(messages, targetMessageId)` → `{resolved, index}`.
  **Every decision must read the same snapshot the DOM committed.** If the
  lookup reads a fresher list than the rows actually rendered, the jump fires
  against a row that isn't there and silently fails.
- In the current build all loaded rows are mounted, so `jumpToMessage` is purely
  DOM-based (`scrollToMessage(id, {highlight:true})`) with no virtualizer
  convergence step.
- A jumped-to row renders with `highlighted: true`, which paints a
  `route-target-highlight-fade` 2 s primary tint (reduced-motion safe).

Search hits that fall outside the loaded window are spliced in: the hit is
converted into a synthetic `RelayEvent` (`app/navigation/searchHitEventCache.ts:
buildSearchHitEvent` — `sig: ""`, tags `[["h", channelId]]`), cached (LRU, 200)
and merged into `resolvedMessages` so the DOM scroll can land it.

### 2.10 Date separators, grouping, system rows

`messages/lib/timelineItems.ts:buildTimelineItems(entries, firstUnreadMessageId)`
walks the top-level entries once and emits a flat discriminated union:

```ts
type TimelineItem =
  | { kind: "day-divider"; key; headingTimestamp }   // timestamp, not a baked label
  | { kind: "unread-divider"; key }
  | { kind: "system"; key; entry }
  | { kind: "system-group"; key; entries }
  | { kind: "message"; key; entry; isContinuation; isFollowedByContinuation }
```

**Day dividers.** `timelineSnapshot.ts:buildDayGroupBoundaries` starts a new
group at index 0 and whenever `!isSameDay(prev.createdAt, msg.createdAt)`
(local calendar day). The boundary key is
`day-${startOfLocalDaySeconds(createdAt)}` — keyed by start-of-day, **not** by
the first message, so prepending an older message into an already-rendered day
reuses the key instead of remounting the whole section. The divider carries a
`headingTimestamp` rather than a prebaked label so the render still resolves
"Today"/"Yesterday" against the current clock, not build time.

Labels — `messages/lib/dateFormatters.ts`:

| Function | Output |
| --- | --- |
| `formatTime` | `"2:34 PM"` (en-US, numeric hour, 2-digit minute) |
| `formatTimeWithoutDayPeriod` | strips a trailing `AM`/`PM` incl. NBSP/NNBSP |
| `formatFullDateTime` | `"Wednesday, April 2, 2026 at 2:34 PM"` (tooltip) |
| `formatDayHeading` | `"Today"` / `"Yesterday"` / `"Monday, March 31st"` / `"Monday, March 31st, 2025"` (prior year) |
| `formatShortMonthDayOrdinal` | `"May 19th"` |
| `formatThreadSummaryLastReplyTime` | `<60 s` → `"just now"`; `<1 h` → `"N minutes ago"`; `<1 d` → `"N hours ago"`; `<7 d` → `"N days ago"`; else `"on May 19th"` |
| `isSameDay`, `startOfLocalDaySeconds` | local-calendar helpers |

Ordinal suffix handles 11/12/13 → `th` correctly.

**Grouping consecutive messages** — `messages/lib/messageGrouping.ts`:

- `MESSAGE_GROUPING_WINDOW_SECONDS = 600` (10 minutes).
- `hasSameMessageAuthor(prev, cur)` — trims and lowercases both pubkeys; missing
  or empty pubkeys **never** match.
- `isWithinGroupingWindow(prevAt, curAt)` — `0 <= gap <= 600`. A negative gap
  (out-of-order) and any missing timestamp are out of window. The boundary is
  **inclusive** (exactly 600 groups; 601 does not).
- A message is a continuation iff: not pending, previous group entry exists and
  is not pending, same author, within the window. Pending rows always render
  standalone (their own header, so send status can sit beside the timestamp),
  and stay that way until the ack arrives.
- `isFollowedByContinuation` is back-patched onto the previous message item so
  it can drop its bottom padding.
- Day dividers, unread dividers and system rows all **reset** the grouping state.
- Applied consistently across the channel timeline, the threaded reply panel and
  the home inbox detail view.

**System-message grouping.** Consecutive `member_joined` payloads collapse into
a `system-group` row. `MEMBERSHIP_GROUP_WINDOW_SECONDS = 300`. Two entries group
when the mode matches (`joined` when actor===target, else `added`) and, for
`added`, the actor matches, and they are within 5 minutes and non-decreasing in
time, and no barrier sits between them. Barriers are day-boundary indices **and**
the first-unread index. Groups are anchored from their **newest** entry
(scanning backwards) and keyed by the newest entry's render key, so prepending
older history cannot repartition already-rendered rows or change a group's
identity.

**System-message copy** — `messages/ui/SystemMessageRow.tsx:describeSystemEvent`
plus the pure `messages/lib/systemEventCopy.ts`:

| `payload.type` | Title | Action |
| --- | --- | --- |
| `members_added` | target name | `added by <actor>, along with <names…>` |
| `members_joined` | target name | `joined the channel along with <names…>` |
| `member_joined` (actor===target) | target | `joined the channel` |
| `member_joined` (actor≠target) | target | `added by <actor>` |
| `member_left` | actor | `left the channel` |
| `member_removed` | actor | `removed <target> from the channel` |
| `topic_changed` | actor | `changed the topic to “X”` / `cleared the topic` |
| `purpose_changed` | actor | `changed the purpose to “X”` / `cleared the purpose` |
| `channel_created` | actor | `created this channel` |
| `channel_archived` / `channel_unarchived` | actor | `archived/unarchived this channel` |
| `message_deleted` with `public_reason` | `Removed by community moderators` | the sanitised public reason |
| `message_deleted` without | actor | `removed a message` |

`describeChannelTextFieldChange(field, value)` — a blank or whitespace-only value
means **cleared**, not `changed the topic to ""` (the relay reports a clear as a
`topic_changed` with an empty string). Uses curly quotes `“ ”`.
`toInlineName(label, isSelf)` returns lowercase `"you"` mid-sentence (the
name-slot resolver returns `"You"`), and decides on the **caller's pubkey
comparison**, never by matching the string `"You"` — display names are
user-controlled, identity is not.

System messages also trigger cache invalidation: on `member_joined`,
`member_left`, `member_removed` the live handler invalidates
`["channels", channelId, "members"]` and `["channels"]`
(`messages/hooks.ts:useChannelSubscription`).

---

## 3. Message actions

### 3.1 The hover toolbar

`messages/ui/MessageActionBar.tsx`. A rounded, blurred pill that is
**always visible below `sm`** and on desktop `opacity-0 / pointer-events-none`
until `group-hover/message` or `group-focus-within/message`, staying open while
the reaction picker or the more-menu is open.

Left→right: up to 4 quick-reaction buttons (desktop only) · divider ·
**React** (`SmilePlus`) · **Reply** (`CornerUpLeft`) · **More** (`EllipsisVertical`).
Each has a tooltip. The whole bar returns `null` when none of reply / react /
more-menu is available.

Quick reactions — `messages/ui/useQuickReactionEmojis.ts`:

- Defaults `["👍","❤️","😂","🎉"]`; recents stored under
  `buzz.quick-reaction-emojis.v1:<activeCommunityId>` (falls back to an unscoped
  key), max **24** entries, each `{emoji, count, lastUsedAt}`.
- Ranking: `count` descending, then `lastUsedAt` descending; the resolver fills
  up to `limit` from recents, then from defaults, skipping duplicates.
- A `:shortcode:` recent is **filtered out** unless that shortcode exists in the
  current community's custom-emoji palette (`canRenderQuickReactionEmoji`).
- `recordQuickReactionEmoji(emoji)` runs **after** a successful toggle. It
  deliberately does **not** update the currently-open tray — the stored recents
  apply on reload or via the `storage` event from another tab, so the tray does
  not shuffle under the cursor.

The more-menu (`MoreActionsMenu`), in order, each item conditional on its
handler being supplied:

1. **Edit message** (`Pencil`)
2. **Mark read / Mark unread** (`MailCheck` / `MailOpen`) — a single toggle whose
   label is driven by `isUnread`, computed by the same predicate the unread badge
   uses.
3. **Follow thread / Unfollow thread** (`BellRing` / `BellOff`)
4. **Copy message** (`Copy`) — copies `message.body`, toast
   `"Message copied to clipboard"`
5. **Remind me later** (`Clock`)
6. **Copy link** (`Link2`) — `buildMessageLink({channelId, messageId, threadRootId})`,
   toast `"Link copied to clipboard"`
7. *separator*
8. **Report message** (`Flag`) → `ReportMessageDialog`
9. **Delete message** (`Trash2`, destructive) → `DeleteMessageConfirmDialog`
10. Moderation items (`MessageModerationMenuItems`)

Gates:

- `hasCopyActions = !message.pending && kind !== KIND_HUDDLE_STARTED` — copy
  message and copy link both require a real, delivered event.
- `canReport = !pending && kind !== KIND_HUDDLE_STARTED && Boolean(message.pubkey)`
  — a NIP-56 report needs a real target and a known author to name in the `p` tag.
- Edit/delete permission — `messages/lib/canManageMessage.ts:canManageMessageForCurrentUser`:
  huddle-started rows are **immutable regardless of authorship**; otherwise
  permission is granted to the self-author (normalised pubkey equality) **or**
  to the verified owner of an agent author (`ownsAuthorAgent` against the
  profile's `ownerPubkey`). Mirrors the relay's authz.

Focus subtlety worth copying: selecting **Edit** sets `editJustSelectedRef` and
`onCloseAutoFocus` calls `preventDefault()` once, suppressing Radix's
focus-restoration to the trigger — Radix restores in a `setTimeout` that fires
after the composer's `requestAnimationFrame` focus and would otherwise win the
race. The flag resets inside the handler so Escape/other closes keep normal
trigger restoration (a11y intact).

### 3.2 Reactions

Optimistic toggling — `messages/ui/useReactionHandler.ts`:

- `applyOptimisticReaction(reactions, emoji, remove, emojiUrl)`:
  - remove: no-op unless the user actually reacted; count-1; count 0 removes the
    pill entirely; otherwise drop the `"You"` user entry and clear
    `reactedByCurrentUser`.
  - add on an existing pill: no-op if already reacted; else count+1 and set the
    flag.
  - add on a new pill: append `{emoji, emojiUrl, count:1, reactedByCurrentUser:true,
    users:[{pubkey:"", displayName:"You", avatarUrl:null}]}` **at the end** —
    chronological ordering is the formatter's job; this helper must never re-sort.
- `selectDisplayReactions(optimistic, source)` — the optimistic state is used
  **only while its captured `sourceReactions` reference is still current**. The
  moment the formatter emits a new array the optimistic overlay is discarded.
- `canToggle = Boolean(onToggleReaction && !message.pending)`.
- A rejected toggle clears the optimistic state, sets `errorMessage` (default
  `"Failed to update the reaction."`) and rethrows.

Mutation — `messages/hooks.ts:useToggleReactionMutation`: `removeReaction(eventId, emoji)`
or `addReaction(eventId, emoji, emojiUrl)` where `emojiUrl` is resolved from the
cached community palette for a `:shortcode:` (`shared/api/customEmoji.ts:reactionEmojiUrl`)
so the kind-7 carries the NIP-30 `["emoji", shortcode, url]` tag. Unicode
reactions resolve to no URL.

A positive-valence emoji added (not removed) fires a particle burst
(`onReactionBadgeBurstRequest` + `shared/ui/EmojiBurstProvider.tsx:isPositiveEmojiParticle`).

Pill rendering: `messages/ui/MessageReactions.tsx` — the pill shows the glyph (or
an `<img>` for a custom emoji, URL rewritten through the localhost media proxy by
`shared/lib/mediaUrl.ts:rewriteRelayUrl`, because WKWebView bypasses the VPN
tunnel and a direct relay URL 403s), the count, and a hover tooltip listing
reactor display names.

### 3.3 Emoji picker and custom emoji

`custom-emoji/ui/EmojiPicker.tsx` is **the one picker for the whole app** —
composer, message reaction, system-message reaction, status. Only the raw picker
lives there; each site owns its own popover/trigger (those legitimately differ),
but the config + custom-emoji wiring + select handling are centralised because
they *did* drift and custom emoji went missing from some pickers.

- Built on `emoji-mart`. `init({ data })` is warmed **once at idle**
  (`requestIdleCallback`, 1.5 s timeout, else `setTimeout` 250 ms) at module
  scope, because `<Picker>` builds the ~1.8k-emoji index synchronously on mount
  and froze the cursor on first open. `init` is a no-op after the first call.
- `disableSearchInputCorrections(host, autoFocus)` reaches into the
  `em-emoji-picker` shadow root, disables spellcheck/autocorrect/autocapitalize
  on the search input and (when `autoFocus`) focuses it — deterministic focus
  owned by us, so Radix's focus scope cannot race emoji-mart's async focus.
  Uses a `MutationObserver` because the shadow content mounts asynchronously.
- **Selection is normalised to a single string**: a standard emoji emits its
  `native` glyph; a custom emoji has no `native`, so it emits `:shortcode:`
  (emoji-mart's `id` *is* the shortcode). Every consumer stores/sends that string
  and lets the renderers resolve it.

The custom-emoji palette — `custom-emoji/hooks.ts`:

- kind **30030** (NIP-30), d-tag `CUSTOM_EMOJI_SET_D_TAG`.
- The palette is the client-side **union of every member's own set**, so the
  query key `["custom-emoji"]` is stable — not keyed by channel or pubkey.
- Three freshness layers: the catch-up fetch (`listCustomEmoji`), a live
  subscription over all members' 30030s that invalidates on any arrival
  (`useCommunityEmojiLiveUpdates`), and a 2-minute poll backstop
  (`staleTime 60 s`, `refetchInterval 120 s`). A reconnect also invalidates,
  because a 30030 published while disconnected never replays through the live sub.
- `["custom-emoji-own"]` (`useOwnCustomEmojiQuery`) is the caller's **own**
  editable set — the only thing the settings card
  (`custom-emoji/ui/CustomEmojiSettingsCard.tsx`) may add to or remove from.
  Both mutations invalidate both keys.
- `custom-emoji/emojiMartCategory.ts:buildCustomEmojiCategory` builds the
  emoji-mart `custom` prop: one category `{id: "buzz-custom", name: "Custom"}`
  whose emojis are `{id: shortcode, name: ":shortcode:", keywords: [shortcode],
  skins: [{src: rewriteRelayUrl(url)}]}`. Returns `undefined` for an empty
  palette so the picker shows only standard categories.
- In message bodies, `:shortcode:` is rendered by
  `shared/lib/remarkCustomEmoji.ts`; outgoing tags are built by
  `shared/lib/customEmojiTags.ts:buildCustomEmojiTags(content, palette)`.

### 3.4 Edit and delete

Edit — `messages/hooks.ts:useEditMessageMutation`:

- `editMessage(channelId, eventId, content, imetaTags, emojiTags, mentionPubkeys)`.
- `mentionPubkeys` are **only the newly added** mentions (`diffAddedMentionPubkeys`).
- `mediaTags` semantics: `undefined` = don't touch; a **defined-but-empty array**
  is the explicit "wipe all attachments" signal, and the receiver overlay drops
  imeta for it. The composer therefore coerces `mediaTags ?? []`.
- `onSuccess` applies an "apply-on-success" cache update (not a true optimistic
  update — the edit round-trip can lag perceptibly): window store first via
  `mapChannelWindowEvents`, then the flattened cache.
- Receiver side: the newest 40003 for a target wins and sets `edited: true`;
  the row renders a muted `(edited)` with tooltip *"This message has been edited"*.

Delete — `useDeleteMessageMutation` → `deleteMessage(channelId, eventId)`;
`onSuccess` filters the id out of the flat cache; `onError` raises
`toast.error("Failed to delete message: <msg>")`. Confirmation is
`messages/ui/DeleteMessageConfirmDialog.tsx`. The relay soft-deletes and emits a
`message_deleted` 40099 tombstone row (see §2.10).

### 3.5 Context menus

- **Message**: the more-menu above (Radix `DropdownMenu`, `modal={false}`,
  `align="end" side="top" sideOffset={6}`).
- **Channel / DM row in the sidebar**:
  `features/sidebar/ui/ChannelContextMenu.tsx:ChannelContextMenuItems`, in order:
  1. **Copy** submenu → *Copy channel name* (toast `"Channel name copied to clipboard"`),
     *Copy channel ID*.
  2. **Move to section** submenu → each existing section (check mark on the
     current one, section emoji otherwise), separator, *New section...*,
     *Remove from section* (only when assigned).
  3. separator · **Mark as read** (`CheckCircle2`) when `hasUnread`, else
     **Mark unread** (`CircleDot`). Exactly one of the two ever renders.
  4. separator · **Mute channel** / **Unmute channel** (`BellOff` / `Bell`).
  5. **Star channel** / **Unstar channel** (`Star` / `StarOff`).
  6. separator · **Leave channel** (destructive) · a disabled
     `"Loading channel actions..."` (spinner) or `"Channel actions unavailable"`
     (warning) row while owner capabilities resolve · **Archive channel**
     (when `canManageChannel`) · **Delete channel** (destructive, when
     `canDeleteChannel`).
  Every action is wrapped in `deferMenuAction(...)` so the menu closes before the
  mutation runs. Owner capabilities come from
  `useChannelModerationCapabilities(members, currentPubkey, enabled)` and members
  are only fetched when owner actions could apply (`channelType !== "dm" && onDeleteChannel`).
- **Media** inside a message: `shared/ui/markdown/MediaContextMenu.tsx`,
  `shared/ui/useVideoContextMenu.tsx`, `shared/ui/videoDownload.ts`.

---

## 4. Read state and unreads

This is the most intricate subsystem. It implements **NIP-RS** (read state) —
an encrypted, multi-device, monotonic, hierarchical read-marker protocol —
plus a session-local "forced unread" overlay that the protocol deliberately
cannot express.

### 4.1 The read-state blob

`channels/readState/readStateFormat.ts`:

```ts
type ReadStateBlob = { v: 1; client_id: string; contexts: Record<string, number> };
```

- Published as kind **30078** with tags `[["d", "read-state:<slotId>"], ["t","read-state"]]`,
  content NIP-44-encrypted to self.
- Context keys: a bare `channelId`, or `thread:<64-hex rootId>`, or
  `msg:<64-hex messageId>`. Values are unix seconds.
- Constants: `READ_STATE_FETCH_LIMIT 500`, `READ_STATE_HORIZON_SECONDS 7 days`,
  `MAX_CONTEXTS 10_000`, `LOCAL_MAX_PRUNABLE_CONTEXTS 1_000`,
  `READ_STATE_MAX_PLAINTEXT_BYTES 32_768` (NIP-44 caps plaintext at 65 535 and
  the relay at 256 KB; 32 KB leaves room for ~1.4× ciphertext expansion),
  `READ_STATE_MAX_SLOTS 8` (8 slots × ~650 channel keys ≈ 5 200 channels).
- Validation: `isValidBlob` requires `v === 1`, a 1–64-char `client_id`, a plain
  object `contexts` with ≤ `MAX_CONTEXTS` keys. `sanitizeContexts` drops keys
  longer than 256 **bytes** (UTF-8), non-integer values, and values outside
  `[0, 4294967295]`.
- `isValidReadStateDTag` requires the `read-state:` prefix and a 1–64-char ASCII
  slot id. `parseReadStateEvent` additionally requires **exactly one** `d` tag
  and **exactly one** `t: read-state` tag and that `event.pubkey === self`.
- `maxReadAt(...markers)` folds a list of `number | null` to the max non-null.

localStorage keys (all per-pubkey):
`buzz.channel-read-state.v2:<pk>` (contexts, ISO strings),
`buzz.channel-read-state.publishable.v1:<pk>`,
`buzz.channel-read-state.source-created-at.v1:<pk>`,
`buzz.nip-rs.client-id:<pk>`, `buzz.nip-rs.slot-id:<pk>`,
`buzz.nip-rs.extra-slot-ids:<pk>`.

### 4.2 The hierarchical frontier rule

`channels/readState/readStateManager.ts:resolveEffectiveTimestamp`:

```
effective(ctx) = max(merged[ctx], effective(parent(ctx)))
```

- The thread→channel relationship is **not serialised** into the blob; it is
  derived from the event graph at evaluation time via an injected
  `parentResolver`. `channels/ui/ChannelScreen.tsx` installs one that maps every
  `thread:`/`msg:` context to the **active** channel id, and clears it on unmount.
- When the resolver yields no parent (channels, or an unresolvable root), the
  frontier degrades to the context's own value.
- Returns `null` when the context was never read and no parent term covers it.

**`getOwnTimestamp(ctx)` vs `getEffectiveTimestamp(ctx)`** is the trap:
`getEffectiveTimestamp` folds in the parent resolver, which is installed by the
*active* screen. Any caller evaluating a `thread:<root>` outside the active
channel (e.g. the sidebar's background scan) **must** use `getOwnTimestamp`, or
it borrows the wrong channel's marker.

### 4.3 Merge, publish, conflict, budget

`ReadStateManager` lifecycle:

1. `initialize()` — hydrate from localStorage, `fetchAndMerge()` (kind 30078,
   `authors:[self]`, `#t:["read-state"]`, `since: now - 7d`, `limit: 500`),
   start a live subscription on the same filter, then schedule a publish if the
   current contexts differ from what was last published.
2. `markContextRead(ctx, ts)` — advance + mark **publishable** + set
   `contextSourceCreatedAt[ctx] = max(now, maxFetchedCreatedAt + 1)`.
3. `seedContextRead(ctx, ts)` — advance **without** marking publishable.
4. `advanceContext` — markers are strictly **monotonic**: `ts <= current` never
   lowers the value; it only (idempotently) adds the context to the publishable
   set and schedules a publish.
5. Publishing is debounced **5 000 ms**; `destroy()` flushes a pending publish
   immediately.

Merging remote blobs (`mergeEvents`):

- Every own-slot blob is **max-merged**, never winner-takes-all — multiple slots
  must union.
- `applyRemoteContextTimestamp` takes `max(current, incoming)` and reports
  `"advanced" | "unchanged"`; advanced contexts are recorded in
  `pendingSyncedAdvances` (drained by `drainSyncedAdvances()`) and marked
  publishable so this client converges.
- **Slot squatting**: if a blob at *our* d-tag carries a different `client_id`,
  rotate `slotId` to a fresh 16-byte hex and persist it, so we never clobber
  another client.
- An incoming event from another `client_id` schedules a re-publish so our blob
  converges.

Publishing:

- `fetchOwnBlobBeforePublish()` re-reads all own slots first.
- `currentContexts()` collects only publishable contexts and applies
  `trimContextsToBudget` — evicting **oldest `msg:` first, then oldest `thread:`**;
  channel keys are never evicted. Returns `null` when even channel-keys-only
  exceeds the budget, which switches to the multi-slot path.
- `splitContextsIntoBudgetedSlots` distributes channel keys **round-robin** across
  slots, growing the slot count until each blob fits or `maxSlots` is reached
  (then returns `null` and the publish is suppressed with an error log).
  `thread:`/`msg:` entries all go into the **primary** slot and are trimmed there.
- `created_at` on a published event is `max(now, maxFetchedCreatedAt + 1)` so it
  always supersedes what we just read.
- Transitioning **split → single** publishes NIP-09 kind-5 deletes for the extra
  slots and resets `lastPublishedContexts` — but only inside that guard.
  Resetting unconditionally would clear relay-fetched state every debounce cycle
  and reintroduce a retry storm.
- `isIdenticalToLastPublished` suppresses no-op publishes in both modes (the
  split path compares the union of all slots).

Local pruning — `readStateStorage.ts:pruneStaleContexts(contexts, now)`:
drop `msg:`/`thread:` markers older than the 7-day horizon, then cap the
survivors at 1 000 newest. **Channel keys are never pruned** — they are small,
bounded by membership, and losing one would resurrect the channel's badge.
The publishable set and the source-createdAt map are filtered to the pruned key
set on write.

React binding: `channels/readState/useReadState.ts:useReadState(pubkey, relayClient)`
returns `{getEffectiveTimestamp, getOwnTimestamp, isReady, markContextRead,
seedContextRead, drainSyncedAdvances, setContextParentResolver, readStateVersion}`.
`readStateVersion` is a monotonically bumped counter used as an explicit memo
invalidation signal. Everything is a no-op until a pubkey and relay client exist.

### 4.4 Forced unread ("Mark unread")

NIP-RS markers are monotonic and **cannot represent a retrograde unread state**,
so mark-unread lives in a separate, deliberately non-synced overlay.

`channels/forcedUnreadStore.ts`:

```
localStorage["buzz-forced-unread.v1:<pubkey>"] : Record<channelId, number | null>
```

The value is the channel's **own NIP-RS marker at the moment mark-unread was
invoked** (or `null` if none existed). The rail observer gates the forced-unread
OR on that baseline: if the observed synced marker has since advanced past it,
the cross-device read wins and the dot is not lit. On identity change the
in-memory map is swapped to the new pubkey's data; old data is **not** wiped.

The per-message analogue (`forcedUnreadMsgRef` in
`channels/ui/useChannelUnreadState.ts`) is **session-only**, cleared on channel
leave, and read only as an OR-overlay by the badge predicates — never written to
the marker store.

### 4.5 Channel unread — the sidebar algorithm

`channels/useUnreadChannels.ts`. Inputs: the channel list, the active channel,
the read state, plus observed relay evidence.

**Observed evidence.** Two refs, both reset on identity/relay change:

- `latestByChannelRef: Map<channelId, unixSeconds>` — the newest *external
  trigger* event seen. Derived evidence only; the only thing ever done with it is
  compare against the NIP-RS marker.
- `observedUnreadEventsByChannelRef: Map<channelId, Map<eventId, ObservedUnreadEvent>>`
  — capped at `CATCH_UP_LIMIT = 1000` per channel, evicting the oldest by
  `createdAt`.

```ts
// channels/unreadChannelCounts.ts
type ObservedUnreadEvent = {
  id; createdAt; rootId: string | null; highPriority: boolean;
  countsTowardBadge: boolean; countsTowardAppBadge: boolean;
};
makeObservedUnreadEvent({channelType, isThreadedReply, highPriority, …}):
  isDm = channelType === "dm"
  countsTowardBadge    = isDm || isThreadedReply || highPriority
  countsTowardAppBadge = isDm || (!isThreadedReply && highPriority)
```

`resolveObservedUnreadRootId(tags)` = `null` for a broadcast reply, else
`getThreadReference(tags).rootId` — a broadcast reply reads as top-level, so it
must not inherit a thread marker.

**Per-event read resolution** — `observedUnreadEventReadAt`:

```
readAt(event) = maxReadAt(
   channelReadAt,                       // effective(channelId)
   getOwnTimestamp("msg:" + event.id),
   event.rootId ? getOwnTimestamp("thread:" + event.rootId) : null)
event is unread  ⟺  readAt === null || event.createdAt > readAt
```

Note the deliberate mix: the **channel** term uses `getEffectiveTimestamp`, while
the thread/message terms use `getOwnTimestamp` (§4.2).

**Catch-up.** For every channel not yet caught up this session (claimed
optimistically so re-renders don't duplicate REQs; claims released on cleanup and
on per-channel failure so the next run retries):

```
readAt = getEffectiveTimestamp(channelId)
since  = readAt === null ? 0 : readAt + 1      // NIP-01 `since` is inclusive
fetchEvents({ kinds: channelCatchUpEventKinds(channelType), "#h": [channelId],
              since, limit: 1000 })
```

`channelCatchUpEventKinds` = `DM_NOTIFIABLE_EVENT_KINDS` for DMs, else
`CHANNEL_MESSAGE_EVENT_KINDS`.

Pass 1 over the results builds relationship sets: self-authored replies →
`participatedRootIds` (keyed on **rootId**), self-authored top-level →
`authoredRootIds` (keyed on the **event id**), external events that mention me →
`mentionedRootIds` (keyed on rootId; top-level mentions are ignored because thread
badges only exist for replies). All four sets persist in localStorage via
`channels/unreadRootIdStore.ts:makeRootIdStore(prefix, maxEntries=1000)`
(`buzz-thread-participation.v1`, `buzz-thread-authored.v1`,
`buzz-thread-mentioned.v1`, `buzz-thread-muted.v1` — keyed by pubkey only, no
relay, so they read correctly whichever community is active).

Pass 2 skips self-authored events and anything `<= readAt`, applies
`shouldNotifyForEvent`, and accumulates `maxExternal`, the observed events, and
thread-reply activity items.

The effect is keyed on a **sorted, joined channel-id string**, not the array
reference — React Query refetches return new array identities with identical
contents and would otherwise cancel every in-flight catch-up forever.

**The unread memo** (recomputed on `readStateVersion`, `latestVersion`,
`channels`, `activeChannelId`):

```
for each channel, skipping the ACTIVE channel:
  if forcedUnread has channel:
      unread.add(id); counts[id] = 1; appBadge += 1;   // dot tier only, NOT high-priority
      continue
  if latestByChannelRef has no entry for id: continue   // no observed evidence
  unreadCount = count of observed events that are unread
  if unreadCount === 0: continue
  unread.add(id)
  counts[id]  = count of unread events with countsTowardBadge
  appBadge   += count of unread events with countsTowardAppBadge
  highPriority.add(id) if channelType === "dm"
                        else if any unread event has highPriority
```

Returned sets/maps are **reference-stabilised**: `setsEqual` / `mapsEqual`
compare contents and reuse the previous object when equal, so downstream memos do
not re-run every render.

**Marking read** — `markChannelRead(channelId, readAt, { topLevelOnly })`:

```
resolveChannelReadMarker(callerReadAt, observedLatest):
  markAt = max(toUnixSeconds(callerReadAt) ?? 0, observedLatest ?? 0) || null
  clearObserved = markAt !== null && observedLatest !== undefined && observedLatest <= markAt
```

- `topLevelOnly: true` is the **passive channel-open path**: the caller's
  `readAt` is already the newest *top-level* message, so the marker lands exactly
  there — `observedLatest` (which counts thread replies) is not folded in, and the
  observed refs are **not** cleared. That keeps the sidebar dot lit for a channel
  whose only unread is an unopened thread reply: merely viewing the channel no
  longer absorbs the reply.
- Explicit "mark read" actions (Escape, sidebar menu, mark-all) omit the flag,
  so the fold happens and the observed refs are cleared. Clearing matters:
  without it `latest > readAt` evaluates `T > T` (false) but the channel lingers
  in the set because `advanceContext`'s monotonic guard suppressed the
  `readStateVersion` bump.
- Any mark-read first deletes the channel from the forced-unread map.

`markAllChannelsRead()` iterates the current unread set, deletes each from
forced-unread, marks each read at `latestByChannel ?? effective(channelId)`, and
clears both observed refs.

**Cross-device convergence**: an effect drains `drainSyncedAdvances()` on every
`readStateVersion` bump and deletes any advanced channel from the forced-unread
map, so a read on another device clears the dot here immediately.

### 4.6 In-channel unread — divider and pill

`channels/ui/useChannelUnreadState.ts` + `messages/lib/unreadMarker.ts`.

**The open-time frontier.** `openFrontierRef: Map<channelId, number|null>` is
written **during render** (not in an effect) the first time a channel id is seen,
so it is captured before any effect for that commit advances the marker. It is
keyed per channel and recomputed only when the channel id changes — never when
the frontier advances, or the divider would vanish the instant the open marks the
channel read. It is deleted on channel leave so a revisit captures a fresh
position (otherwise a stale frontier produces a phantom "New" divider over
already-read messages).

**Channel marker** — `computeChannelUnreadMarker(messages, frontierSeconds, suppressed, currentPubkey)`:

| Rule | Behaviour (asserted in `unreadMarker.test.mjs`) |
| --- | --- |
| empty timeline | `{null, 0}` |
| `frontierSeconds === null` | every top-level message is unread |
| `createdAt > frontier` | unread — the comparison is **strictly greater**, so a message exactly at the frontier is read |
| `message.parentId != null` | skipped — thread replies are out of scope for the channel divider, even if newer |
| `pubkey === currentPubkey` (case-insensitively) | skipped — you know about your own posts |
| `suppressed === true` | `{null, 0}` regardless of frontier, including the never-read case |
| result | `firstUnreadMessageId` = oldest unread; `unreadCount` = number of unread top-level messages |

The input is pre-filtered by `isConversationalUnreadKind` so system/job/huddle
rows never inflate the pill.

`suppressed` is `isActiveChannelForcedUnread || isActiveWelcomeInitialUnreadSuppressed`.
Rationale: a deliberate mark-unread has no meaningful "new" boundary inside the
timeline (the open-time snapshot already covers every message), so the pill and
divider would render nothing while the sidebar says unread — a visible
contradiction. The flag clears on channel re-open.
(`channels/ui/useWelcomeInitialUnreadSuppression.ts` does the same for the
onboarding welcome channel.)

**Divider placement** — `messages/lib/threadPanel.ts:shouldRenderUnreadDivider(index, id, firstUnreadId)`
returns `index > 0 && id === firstUnreadId`. When the first unread is the first
rendered row (a fresh/never-read channel) there is nothing above it to separate
from, so the divider is suppressed.

Rendering: `messages/ui/UnreadDivider.tsx` — a hairline rule with a centred
uppercase **New** in the primary colour, `aria-label="New messages"`,
`data-testid="message-unread-divider"`.

**The unread pill** (`messages/ui/MessageTimeline.tsx`):

- Top pill, direction `up`, label `unreadCountLabel(n)` = `"N new message(s)"`,
  `data-testid="message-unread-pill"`. Shown iff not dismissed, `unreadCount > 0`,
  `firstUnreadMessageId !== null`, and the skeleton is not visible.
- It is a **transient, per-open affordance**: dismissed when the user clicks it
  (which jumps to the oldest unread) or reaches the bottom of the timeline.
  `hasShownPillRef` guards the dismiss effect from firing on mount, when
  `isAtBottom` initialises to `true` before the pill ever rendered. Both reset on
  channel change.
- Bottom pill, direction `down`, shown whenever `!isAtBottom`. Label priority:
  buffered pending count → new-message count → `"Jump to latest"`.
  `data-testid="message-scroll-to-latest"`.
- A spinner chip renders while `isFetchingOlder || isHoldingPrepend ||
  isRenderedTimelineBehindHistoryPrepend(deferred, live)` — the flag clears on
  fetch resolve but rows paint a frame later, so the spinner must outlive it.

### 4.7 Thread unreads

**Per-message markers (LP4 v3).** Instead of one thread frontier there is one
grow-only `msg:<id>` marker per reply, so reading an ancestor never covers a
descendant.

`computeThreadUnreadMarker(replies, getReadAt, currentPubkey, isForcedUnread)`:

```
reply is unread ⟺ isForcedUnread(id) || getReadAt(id) === null || reply.createdAt > getReadAt(id)
self-authored replies are skipped (case-insensitive pubkey compare)
returns { firstUnreadReplyId (oldest unread), unreadCount }
```

Asserted by `unreadMarker.test.mjs`, including the case a single frontier cannot
express: with `readAt = (id) => id === "r2" ? 20 : null`, r1 and r3 remain unread
while r2 is read.

**On thread open**, only the replies **visible** on open are marked read — never
the whole subtree (the deliberate reversal of an earlier whole-subtree behaviour).
A reply nested in a still-collapsed branch keeps its badge until it too is
revealed. Muted threads are skipped entirely.

**The in-thread divider** reads a separate `threadOpenReadSnapshotRef:
Map<rootId, Map<replyId, number|null>>` frozen before the on-open mark-read
effect. The lookup must use `snapshot.has(replyId)`, **not `??`**: a never-read
reply snapshots to `null`, and a nullish-coalescing fallthrough would discard
that and re-read the now-advanced live marker, collapsing the divider over the
very replies that should anchor it. The snapshot is captured during render for
every visible reply (idempotent — first capture wins) and dropped on close.

**Per-row subtree badges in the panel** —
`channels/lib/threadReplyUnreadCounts.ts:computeThreadReplyUnreadCounts`:
scoped to the open thread's `subtreeReplyIds`, keyed only by `visibleReplyIds`
(so the map matches row presence), omitted for `expandedReplyIds` (their children
render inline) and for zero counts (no `"0"` badge).

**Root badges in the main timeline** —
`channels/lib/threadBadgeCounts.ts:computeThreadBadgeCounts`:

- Only for roots where `isNotified(rootId)` is true.
- Subtree membership is keyed on each reply's **`rootId`**, not walked through
  the parent chain: a reply whose intermediate ancestor is missing from the
  loaded window still carries its true rootId and rolls up correctly. For an
  intact chain the tally is identical; each reply has exactly one rootId so it is
  counted once; a malformed parent cycle keys off no root.

**Thread interest gate** (`isNotifiedForThread`) is the OR of: participated ∨
authored ∨ followed ∨ mentioned-in — minus muted. Follows are stored in
`buzz-thread-follows.v1:<pubkey>`; mutes in `buzz-thread-muted.v1:<pubkey>`
(`muteThread` / `unmuteThread` on the hook).

### 4.8 Badge rollups

- **Per-channel badge count** = unread observed events with `countsTowardBadge`
  (DM ∨ threaded reply ∨ high priority). A plain channel message therefore lights
  the **dot** but does not add to the number — the number is reserved for things
  addressed to you.
- **High-priority set** — any unread DM, or any unread mention/broadcast.
  Forced-unread is **dot tier only**, never high-priority.
- **App/OS badge** = `unreadChannelNotificationCount` = unread events with
  `countsTowardAppBadge` (DM ∨ (top-level ∧ high-priority)). Applied via
  `notifications/lib/desktop.ts:setDesktopAppBadge({kind:"none"|"dot"|"count"})`
  — `setBadgeCount` everywhere, plus a macOS-only `setBadgeLabel(" ")` for the
  dot state; E2E mirrors it onto `window.__BUZZ_E2E_APP_BADGE_*`.
- **Home badge** — `notifications/lib/homeBadge.ts`:
  - `buildHomeBadgeFeedItems(feed, extraInboxItems, localUnreadFeedIds)` =
    mentions + needsAction + extras, plus any `activity`/`agentActivity` item in
    the local-unread set, deduped by id preserving first occurrence.
  - `isHomeBadgeFeedItemUnread(item, opts)` — locally-unread wins; else resolve a
    read marker and compare `createdAt >`; when there is **no** marker at all,
    fall back to "not in the seen-id set".
  - `resolveHomeBadgeFeedItemReadAt` — for a **top-level** item the channel
    marker; for a **thread reply** the thread marker **and** the per-message
    marker (max), and *not* the channel marker.
  - `shouldCountTowardHomeBadgeSubtotal(item, highPriorityChannelIds, force)` —
    an item in a channel already counted as high-priority only re-counts in the
    Home subtotal if it is a **threaded reply in a non-DM channel**; otherwise it
    would be double-counted.
- **Community rail** — `communities/communityUnreadObserver.ts` computes
  `{hasUnread, mentionCount}` for **inactive** communities by opening a read-only
  relay client and replaying the same predicates offline: fetch the member
  channel set (kind 39002 `#p`), exclude archived (39000) and hidden DMs (30622),
  read the mute store (30078 `channel-mutes`), decrypt read-state (30078
  `read-state`, 7-day horizon, limit 500), then existence-check unread
  (limit 50) and count mentions (limit 100). Thread relationship sets are read
  from the same per-pubkey localStorage stores the active path writes.

### 4.9 Mark-as-read triggers, summarised

| Trigger | Call |
| --- | --- |
| Opening / viewing a channel (member only) | `markChannelRead(id, latestTopLevelMessageIso, { topLevelOnly: true })` — re-fires whenever the newest top-level message changes (`channels/ui/ChannelScreen.tsx`) |
| `Escape` in a channel view | `markChannelRead(id, channel.lastMessageAt)` — full fold |
| `Shift+Escape` anywhere | `markAllChannelsRead()` |
| Sidebar context menu → Mark as read | `markChannelRead(id, channel.lastMessageAt)` |
| Sidebar context menu → Mark unread | `markChannelUnread(id)` |
| Message more-menu → Mark read/unread | per-message `msg:<id>` marker / session forced-unread set |
| Opening a thread | `markMessageRead(replyId, reply.createdAt)` for each **visible** reply, unless the thread is muted |
| Expanding a collapsed branch | same, for the newly revealed direct children only |
| Cross-device sync | `drainSyncedAdvances()` clears forced-unread for advanced channels |

`app/useMarkAsReadShortcuts.ts` guards Escape carefully: it ignores repeats when
`event.defaultPrevented`, when a primary modifier or Alt is held, and — crucially
— when `shared/hooks/escapeSurfaces.ts:hasActiveEscapeSurface()` is true. Window
listeners fire in registration order, so the app-mount listener would otherwise
always beat a panel that opened later. Instead of racing, background shortcuts
**yield** to any open closable surface. Nested controls (autocomplete, edit mode)
still win by calling `preventDefault()` on the element.

---

## 5. Presence, typing, user status

### 5.1 Presence

`presence/lib/presence.ts` (pure) + `presence/hooks.ts` (React).

```ts
type PresenceStatus = "online" | "away" | "offline";
PRESENCE_HEARTBEAT_INTERVAL_MS = 60_000;
PRESENCE_TTL_SECONDS = 3 * 60;        // three heartbeat windows
PRESENCE_IDLE_TIMEOUT_MS = 10 * 60_000;
```

- Live events are kind **20001**, self-signed. `parseLivePresenceEvent` takes the
  subject as `event.pubkey` and **never trusts a `p` tag** — a client could forge
  one to spoof another user. Only the relay-signed REST/seed path trusts a
  p-tag subject. Unknown status strings return `null`.
- `resolveAutomaticPresenceStatus(osIdleSeconds, lastActivityAt, now)` — OS-wide
  idle is authoritative when the platform exposes it
  (`shared/api/osIdle.ts:getOsIdleSeconds`); otherwise fall back to in-app
  activity. **Away means "the human is not at the machine"** (Slack/Discord
  semantics), never "Buzz is not the focused window" — window visibility is
  explicitly not an input.
- Manual override (`usePresenceSession`): preference `"auto" | "away" | "offline"`
  persisted at `buzz-presence-preference:<pubkey>`. Setting `online` stores
  `"auto"`. `skipNextSyncRef` prevents a double publish when the user's own
  mutation already sent the status.
- Heartbeat: republish `currentStatus` every 60 s while not offline, **skipping
  ticks when the relay is not connected or `isRateLimited()`** — the publish
  would fail anyway and consumes quota the recovery needs.
- Activity signals: capture-phase `pointerdown`, `pointermove`, `wheel` (passive),
  `keydown`, and `focus`, throttled to 1/s. Activity is written to a **ref**, and
  only the derived status lives in React state — the previous shape re-rendered
  the app root on every keystroke typed anywhere.
- Query: `usePresenceQuery(pubkeys)` → key `["presence", ...normalizedSorted]`,
  `getPresence`, `staleTime 30 s`, `refetchInterval 60 s` **only while
  connected** (a backstop poll for REST-only writers and TTL expiry of crashed
  clients; WS handles the fast path).
- `usePresenceSubscription()` (mount once at the app root) updates the cache
  in place with `setQueriesData` + a `predicate` that only touches queries whose
  key actually contains the pubkey (`presenceQueryWantsPubkey`), and
  `mergePresenceUpdate` merges pubkeys **absent** from the lookup (get_presence
  omits offline/unknown pubkeys, so a live online event often targets one).
  Reconnect invalidates all presence. Subscribe failures retry with exponential
  backoff capped at 30 s.
- Drawing: `presence/ui/PresenceBadge.tsx` — `PresenceDot` (2.5 × 2.5 rounded
  dot, `aria-hidden`) and `PresenceBadge` (pill with dot + label).
  Colours: online `bg-emerald-500`, away `bg-amber-500`, offline
  `bg-muted-foreground/35`. Chip variants (fill + matching text, no dot) via
  `getPresenceChipClassName`. Labels `"Online" | "Away" | "Offline"`.

### 5.2 Typing

`messages/useTypingBroadcast.ts` (send) and `messages/useChannelTyping.ts` (receive).

Send: kind **20002**, throttled to at most once per `TYPING_SEND_INTERVAL_MS =
3 000` per channel; the throttle clock resets when the channel changes.
`sendTypingIndicator(channelId, parentEventId, rootEventId)` — the parent/root
scope the indicator to a thread.

Receive:

```
TYPING_INDICATOR_TTL_MS = 8_000
TYPING_PRUNE_INTERVAL_MS = 1_000
TYPING_POST_MESSAGE_SUPPRESS_MS = 2_000
```

- State key is `${pubkey}:${threadHeadId ?? "channel"}` — typing in a thread and
  typing in the channel are distinct.
- An entry's expiry is `min(now + 8 s, event.created_at*1000 + 8 s)`; an event
  already expired on arrival is dropped.
- Rejected: wrong channel (`h` tag mismatch), self, and any event whose
  `created_at <= latestMessageCreatedAt` for that key.
- When a message (kind 9 or 40008) from that author lands in the same scope, the
  entry is removed and further indicators are suppressed for 2 s — otherwise a
  throttled indicator sent just before the message re-lights the dots.
- `firstSeenAt` is preserved across refreshes so the display order is stable;
  a 1 s interval prunes expired entries only while any typist is active.
- All typing state resets on channel change.
- Drawing: `messages/ui/TypingIndicatorRow.tsx` — overlapping avatars (`-ml-1.5`)
  plus a shimmering label:
  `"A is typing..."` / `"A and B are typing..."` / `"A, B, and C are typing..."` /
  `"A, B, and N others are typing..."` (N = `length - 2`).
  `aria-live="polite"`; `data-testid="message-typing-indicator"` only when
  non-empty. An `activity` variant renders smaller inside the composer accessory
  (`messages/ui/ComposerActivityAccessory.tsx`,
  `channels/ui/useChannelActivityTyping.ts` — which also splits humans from bots).

### 5.3 Custom user status

`user-status/hooks.ts` — kind **30315**, d-tag `"general"`.

```ts
type UserStatus = { text: string; emoji: string; updatedAt: number };
```

- `parseUserStatusEvent` reads `content` as the text and the first
  `["emoji", …]` tag as the emoji; `updatedAt = created_at`.
- `useUserStatusQuery(pubkeys)` — key `["user-status", ...normalizedSorted]`,
  fetch `kinds:[30315], authors, "#d":["general"], limit: pubkeys.length`;
  seeds every requested pubkey to `null`; newest `updatedAt` wins; a status with
  neither text nor emoji collapses to `null`. `staleTime 60 s`,
  `refetchInterval 120 s`.
- `useUserStatusSubscription()` — live updates only patch keys **already present**
  in a cached lookup, and only when strictly newer (`existing.updatedAt >= parsed`
  is ignored). Same exponential-backoff retry and reconnect-invalidate shape as
  presence.
- `useSetUserStatusMutation` publishes and optimistically writes both the
  single-pubkey key and every lookup that already contains the pubkey.
- **No expiry field.** There is no "clear after 30 minutes"; clearing is explicit
  (publish empty text + empty emoji).
- Dialog — `user-status/ui/SetStatusDialog.tsx`: emoji button (opens the shared
  `EmojiPicker` in a popover; a small `×` badge clears the emoji), a text input
  (`"What's your status?"`, autofocus, Enter-to-save unless Shift), five preset
  chips — *In a meeting 🗣️*, *Commuting 🚌*, *Out sick 🤒*, *Vacationing 🏖️*,
  *Working remotely 🏠* — and a footer with **Clear status** (only when one
  exists), **Cancel**, **Save** (disabled until text or emoji is present; text is
  trimmed).
- Rendering — `user-status/ui/StatusEmoji.tsx`: a stored status emoji is a bare
  string (unlike a reaction, which carries a companion `emojiUrl`). If it matches
  `/^:([^:\s]+):$/` and resolves against the community palette, render an `<img>`
  with `rewriteRelayUrl(url)`; otherwise render the text. Every display site uses
  this component so shortcode resolution cannot drift across the five call sites.

---

## 6. Search

### 6.1 Query syntax

`search/lib/parseSearchOperators.ts:parseSearchOperators(raw)` →
`{ text, from, in, since, until }`.

- Operator regex: `/(?:^|\s)(from|in|after|before):(\S+)/gi`. Operators must
  start at a **token boundary** — a `\b` is deliberately avoided because it also
  matches after `-` and `/`, which would turn `built-in:react` and
  `https://x.com/in:foo` into operators.
- `from:` — pubkey hex, npub, or `@name` (leading `@` stripped by
  `normalizeFromHandle`).
- `in:` — channel UUID or `#name` (leading `#` stripped by `normalizeInChannel`).
- `after:YYYY-MM-DD` → unix seconds at **local** start of that day, inclusive
  (`since`).
- `before:YYYY-MM-DD` → local start of day **minus 1 second**, because NIP-01
  `until` is an *inclusive* upper bound; this keeps `before:` exclusive of the
  named day, Slack-compatible (`until`).
- Trailing punctuation is stripped from operator values (`in:general,` → `general`).
- **Later occurrences of the same operator win.**
- An invalid date (`after:yesterday`, `2026-13-01`, `2026-02-30`) is left in the
  returned `text` so it still participates in FTS. Date validation round-trips
  through a `Date` to reject overflow.
- Remaining text is whitespace-collapsed and trimmed; it is the FTS/prefix query.
- Known limitation: multi-word handles (`from:@Will Pfleger`) capture only the
  first whitespace-delimited token.

Helpers: `isHexPubkey` (64 hex, no `0x`), `isChannelUuid` (canonical UUID shape),
and the discriminated `OperatorResolveResult<T> = {status:"none"} |
{status:"resolved", value} | {status:"unresolved"}` — the three-state result
exists so callers **never silently widen the search** when resolution fails.

### 6.2 Global search (⌘K)

`search/useSearchResults.ts` + `search/ui/TopbarSearch.tsx`.

- `MIN_SEARCH_QUERY_LENGTH = 2`; query debounced **300 ms**; the debounce is
  bypassed to `""` while under the minimum.
- A search is considered "live" (`hasSearchQuery`) when the debounced query is
  ≥ 2 chars **or** any operator is present — so `in:general` alone is a valid
  search.
- `in:` resolution: UUID passes through; otherwise case-insensitive match against
  `channel.name` **or** the user's channel label override
  (`features/sidebar/lib/channelLabels.ts`).
- `from:` resolution: hex passes through normalised; otherwise matched against a
  candidate seed built from managed agents, relay agents, a `from:`-specific user
  search, and the main user search.
- If **any** operator is unresolved, the message query is disabled and
  `messageResults` is forced to `[]` — never a widened search.
  `isWaitingOnFromResolution` holds the empty state while the `from:` user search
  is still loading, so an "unresolved" flash never appears before candidates land.
- Message query — `search/hooks.ts:useSearchMessagesQuery`: default limit 12,
  `searchMessages({q, limit, channelId, authors, since, until})`,
  `staleTime 30 s`, `gcTime 5 min`. **One** length floor lives here
  (`trimmedQuery.length >= 2`) so it cannot drift across call sites.
- Result composition, in order: **channels** (max 5) → **users** (ranked) →
  **messages**. Channels are filtered by the same visibility rule as the browser
  and match on name, description, or label; sorted so display-name matches
  outrank description-only matches, then alphabetically.
- User results exclude archived identities, and exclude known agents unless they
  are the caller's managed agents or have `respondTo === "anyone"`. Ranking is
  `features/profile/lib/userCandidateSearch.ts:rankUserCandidatesBySearch`.
- Message hits are deduped by `eventId`; author profiles for the hits are batched.
- Selection index is clamped whenever the result list shrinks; everything clears
  when the dialog closes.

```ts
// shared/api/searchTypes.ts
type SearchHit = { eventId, content, kind, pubkey, channelId, channelName,
                   createdAt, score, threadRootId? };
type SearchMessagesResponse = { hits: SearchHit[]; found: number };
```

### 6.3 Navigating from a hit

`app/navigation/resolveSearchHitDestination.ts`:

```
no channelId                       → null (unnavigable)
kind === KIND_FORUM_POST (45001)   → { kind:"forum-post", channelId, postId: eventId }
kind === KIND_FORUM_COMMENT (45003)→ getEventById(eventId) → rootId ?? parentId
                                     → { kind:"forum-post", channelId, postId, replyId: eventId }
                                     (on fetch failure or no post id → plain channel)
otherwise                          → { kind:"channel", channelId, messageId: eventId,
                                        threadRootId: hit.threadRootId ?? null }
```

Then `app/navigation/searchHitEventCache.ts` caches a synthetic `RelayEvent` for
the hit (LRU 200) so the channel route can splice it into the timeline even when
it is far outside the loaded window — the DOM scroll then lands it.

Result rendering: `search/ui/SearchResultItem.tsx` (three shapes: channel, user,
message hit with channel name + timestamp + snippet),
`search/ui/SearchPromptPlaceholder.tsx` (the pre-query state that teaches the
operator syntax).

### 6.4 In-channel find (⌘F)

`search/useChannelFind.ts` + `search/ui/ChannelFindBar.tsx`.

- Opens on `⌘F` / `Ctrl+F` (`hasPrimaryShortcutModifier`, no Alt, no Shift),
  `preventDefault`ed.
- `MIN_QUERY_LENGTH = 2`, relay debounce **300 ms**.
- Two result sources, merged in this order:
  1. **Client-side**, instant: every loaded message whose lowercased `body`
     contains the lowercased query, in timeline order.
  2. **Relay-backed** (`useSearchMessagesQuery` scoped to the channel,
     `limit: 100`), appended for hits not already present. Relay hits may point
     at messages outside the loaded cold window — they stay in the match list and
     the route-target splice path loads the active one.
- `activeIndex` wraps in both directions (`goToNext` / `goToPrevious`) and is
  clamped to 0 when results change.
- `matchingMessageIds: Set` is used to highlight every match in-place
  (`shared/lib/rehypeSearchHighlight.ts`).
- The bar closes and fully resets on channel change.

---

## 7. Notifications

### 7.1 The notify predicate

`notifications/lib/shouldNotify.ts:shouldNotifyForEvent(event, currentPubkey, opts)`
— evaluated **in this exact order**:

```
1. isBroadcastReply(tags)                     → true    (always notifies)
2. hasMentionForEvent(event, me)              → true    (mentions pierce mutes)
3. channelId ∈ mutedChannelIds                → false
4. parentId === null (top-level message)      → true
5. rootId ∈ mutedRootIds                      → false
6. rootId ∈ participatedRootIds               → true
7. rootId ∈ followedRootIds                   → true
8. rootId ∈ authoredRootIds                   → true
9. otherwise                                  → false
```

Note the two deliberate orderings: a **broadcast** and a **mention** both outrank
a channel mute; a **thread mute** outranks participation/follow/authorship.

`hasMentionForEvent` = any `["p", pk]` tag equal to the current pubkey
(lowercased); requires a non-empty pubkey.

`isHighPriorityEventForUser` = mention ∨ broadcast.

### 7.2 Live delivery pipeline

`channels/useLiveChannelUpdates.ts` subscribes per channel:

```
subscribeLive({ kinds: CHANNEL_EVENT_KINDS, "#h":[channelId], limit: 1000,
                since: floor(Date.now()/1000) })
```

with exponential-backoff retry (base 1 s, cap 30 s) and a `withChannelTagFallback`
that injects the `h` tag when the relay omitted it.

Per incoming event:

1. Resolve the channel id from tags; if it is not a known channel, debounce-invalidate
   `["channels"]` (500 ms trailing, and `refreshChannelsWhenIdle` re-arms rather
   than firing while a fetch is in flight — `getChannels` is an expensive
   O(channels) fan-out and traffic arrives in bursts).
2. Self-authored trigger events fire `onSelfChannelMessage` **before** the
   author-exclusion guard, so thread participation is tracked.
3. `isExternalTriggerEvent` = a trigger kind ∧ not self-authored.
4. **De-duplication**: `trackSeenEvent(seenNotificationEventIds, id, 5000)` —
   one shared guard for *every* notification side effect, because reconnect
   replay overlaps each live filter by five seconds and a mention arrives through
   both the channel filter and the mention filter.
5. DM alerts (`handleDmEvent`) additionally require `isDmNotifiableKind(kind)`,
   `created_at >= dmSubscriptionStartedAt` (suppressing backlog replays), an
   external author, a known DM channel, and **not the channel currently being
   viewed** unless `notifyForActiveChannel`.
6. If `shouldNotifyForEvent` passes: `onChannelMessage` (unread tracking) and,
   for DMs or threaded replies, `onThreadReplyNotification` (Home activity).
   If it fails and the event is a threaded reply, `onThreadReplyCandidate` fires
   so a caller can async-backfill and re-decide.
7. Thread-reply desktop notifications fire only for non-DM channels and only when
   the channel is not the active one (unless opted in).
8. Regardless, merge into `["channel-messages", channelId]` if that cache exists
   — `useChannelSubscription` also writes there, but there is a race window
   before it connects; the merge is idempotent.

On reconnect: invalidate `["channels"]` and reset `dmSubscriptionStartedAt` to
now, so replayed backlog (past `created_at`) is naturally suppressed.

### 7.3 Settings model

`notifications/hooks.ts` — stored at
`buzz-notification-settings.v2:<pubkey>` (v1 values are abandoned, not migrated).

```ts
type NotificationSettings = {
  desktopEnabled: boolean;        // default true
  homeBadgeEnabled: boolean;      // default true
  notifyWhileViewing: boolean;    // default false
  sounds: Record<SoundSlot, SoundName>;
  slotAlertsEnabled: Record<SoundSlot, boolean>;
  slotAlertsSnapshot: Record<SoundSlot, boolean> | null;
};
```

Slots (`notifications/lib/sound.ts`): `dm`, `mention`, `thread_reply`,
`needs_action`, `job_accepted`, `job_progress`, `job_result`, `job_error`.
Labels/descriptions are in `SLOT_LABELS` / `SLOT_DESCRIPTIONS`.
`COMING_SOON_SLOTS` = the four `job_*` slots — wired end-to-end but rendered
disabled with a "coming soon" badge until an emitter exists.

Defaults: every slot's sound is `"flutter"`; `DEFAULT_SLOT_ALERTS_ENABLED` is all
true except `job_progress`. `RECOMMENDED_SOUND_BY_SLOT` suggests
dm→unison, mention→ping, thread_reply→doop, needs_action→doodone,
job_accepted→boo, job_progress→dng, job_result→unison, job_error→oh-no.
Sound names: bong, boo, dng, doo, doodone, doong, doop, flirl, flutter, oh-no,
ping, unison — played from `/sounds/<name>.mp3`, cached per name, `currentTime`
reset before `play()`, all failures swallowed (the user may not have interacted
with the page yet).

The **master switch** (`setAllSlotAlertsEnabled`) is not a plain bulk write:
turning it off snapshots the granular picks into `slotAlertsSnapshot` and zeroes
the live rows; turning it on restores the snapshot **if it had anything enabled**,
else enables every live row. Any individual row toggle clears the snapshot,
because a manual pick supersedes a pending restore. `COMING_SOON_SLOTS` are never
touched by either path.

Permission handling (`setDesktopEnabled(true)`): refresh permission → if
`"default"`, request it → if not `"granted"`, force `desktopEnabled` back to
false and set an error message —
`"Desktop notifications are blocked for Buzz. Enable them in system settings to turn alerts on."`
(denied) or `"Desktop notifications are unavailable in this environment."`
Turning it off never prompts. All settings sanitise unknown/ill-typed values back
to defaults on read.

### 7.4 Delivery

`notifications/use-feed-desktop-notifications.ts:useFeedDesktopNotifications`:

- Seen-ids persist at `buzz-home-feed-seen.v1:<pubkey>`, capped at **500**.
- **First feed load never notifies**: `hasInitializedFeedRef` marks the entire
  initial feed as seen and returns. Empty feeds mark initialised too, so the first
  later live alert is not mistaken for backlog.
- It waits for sender profiles before delivering, so titles carry names —
  unless the feed is empty.
- Eligible items = `eligibleFeedNotificationItems(feed, {mentions, needsAction}, channels)`
  minus already-seen, minus items in muted channels **unless the item is a
  mention**.
- Sender name is used only when it is a real display name, not a truncated-pubkey
  fallback.
- Delivery = `sendDesktopNotification({title, body, target})` then, only if the
  send succeeded, `playNotificationSound(resolveSlotSound(settings, slotForFeedKind(kind, category)))`.
- `slotForFeedKind`: category `"mention"` → `mention`; kinds 43002/43003/43004/43006
  → the matching job slot; `KIND_APPROVAL_REQUEST` → `needs_action`; default
  `needs_action`.

`notifications/lib/notificationFormat.ts`:

- `resolveNotificationChannelLabel(channelId, channels)` → `"#name"` or `null`
  when the channel is not in the list yet (the caller must degrade gracefully,
  never block the toast).
- `truncateNotificationBody(content, fallback)` — trim; blank → `fallback`;
  longer than **140** chars → `slice(0, 137).trimEnd() + "..."`.
- `formatNotificationTitle({prefix, channelLabel})` → `"prefix in #channel"` or
  just `"prefix"`.

`notifications/lib/desktop.ts` platform behaviour:

- Permission state is `NotificationPermission | "unsupported"`; concurrent
  requests share one in-flight promise.
- **Linux**: the bundled Tauri notification plugin posts over a D-Bus connection
  it drops immediately, and GNOME 46+ then dismisses the notification before it is
  seen — so Linux routes through a backend `invoke("show_native_notification", …)`
  that keeps the connection alive, and click-backs arrive as a
  `native-notification-activated` backend event rather than the plugin's
  `onAction` (whose connection is torn down before it can fire).
- Notification payloads carry a `DesktopNotificationTarget`
  `{channelId, channelName, content, createdAt, eventId, kind, pubkey, threadRootId}`
  in `extra.buzzNotificationTarget`; `parseNotificationTarget` validates each
  field and rejects a target with neither `channelId` nor `eventId`.
  Clicks are re-dispatched as a `buzz:desktop-notification-action` window
  CustomEvent, so web and Tauri paths converge on one listener.
- `requestDockBounce()` no-ops when the document already has focus.
- Notifications are created with `silent: true` — Buzz plays its own sound.

### 7.5 Muting

| Scope | Storage | Effect |
| --- | --- | --- |
| Channel | `buzz-channel-mutes.v1:<pubkey>`, synced as 30078 d-tag `channel-mutes` (`sidebar/lib/channelMutesStorage.ts`, `channelMutesSync.ts`) | `shouldNotifyForEvent` step 3; home-badge items in the channel are skipped **unless** `category === "mention"` |
| Thread | `buzz-thread-muted.v1:<pubkey>` | step 5; also skips the mark-read-on-open pass for that thread |

Mute store shape: `{version: 1, channels: Record<id, {muted: boolean, updatedAt: number}>}`.
`mergeStores(local, remote)` is **last-write-wins per channel** by `updatedAt`
(local wins ties). `parseMutePayload` rejects anything not `version === 1` and
drops malformed entries.

### 7.6 What suppresses a notification, in one list

1. `desktopEnabled === false`, or OS permission not granted.
2. The relevant slot is disabled (`slotAlertsEnabled.mention` /
   `.needs_action` for feed alerts).
3. The event is self-authored.
4. The event id has already been delivered this session (`trackSeenEvent`).
5. It is the **initial** feed load.
6. The event's `created_at` predates the DM subscription start (backlog replay).
7. The channel is the one currently being viewed and `notifyWhileViewing` is off
   (DM alerts and thread-reply alerts both honour this).
8. The channel is muted and the item is not a mention.
9. The thread root is muted and the item is not a mention or broadcast.
10. The event kind is not human-visible (`isDmNotifiableKind` for DMs,
    `CHANNEL_MESSAGE_EVENT_KINDS` otherwise).
11. `shouldNotifyForEvent` returns false (a thread reply in a thread you have no
    relationship with).

---

## 8. Keyboard shortcuts

Canonical registry: `shared/lib/keyboard-shortcuts.ts:KEYBOARD_SHORTCUTS`.
`getPlatformKeys(shortcut)` picks mac vs Windows; `getPlatformKeysById(id)`
gives menus and tooltips a hint that cannot drift from the registry.
Category order for the help sheet: Navigation, Messages, Formatting, Zoom.

| id | Action | macOS | Windows/Linux | Implemented in |
| --- | --- | --- | --- | --- |
| `quick-search` | Open the search dialog | `⌘K` | `Ctrl+K` | `app/AppShell.tsx` keydown |
| `browse-dms` | New direct message | `⇧⌘K` | `Shift+Ctrl+K` | `app/AppShell.tsx` |
| `new-channel` | Create channel dialog | `⇧⌘N` | `Shift+Ctrl+N` | `app/AppShell.tsx` |
| `browse-channels` | Channel browser | `⇧⌘O` | `Shift+Ctrl+O` | `app/AppShell.tsx` |
| `go-home` | Home feed | `⇧⌘A` | `Shift+Ctrl+A` | `app/AppShell.tsx` |
| `open-settings` | Open/close settings | `⌘,` | `Ctrl+,` | `app/useSettingsShortcuts.ts` (matches `key === ","` **or** `code === "Comma"`) |
| `go-back` | Previous page | `⌘[` | `Alt+←` | `app/navigation/useBackForwardControls.ts` |
| `go-forward` | Next page | `⌘]` | `Alt+→` | `app/navigation/useBackForwardControls.ts` |
| `find-in-channel` | Find in the current channel | `⌘F` | `Ctrl+F` | `search/useChannelFind.ts` |
| `toggle-sidebar` | Show/hide sidebar | `⌘S` | `Ctrl+S` | `shared/ui/sidebar.tsx` (`SIDEBAR_KEYBOARD_SHORTCUT = "s"`) |
| `mark-current-read` | Mark this conversation read | `Escape` | `Escape` | `app/useMarkAsReadShortcuts.ts` |
| `mark-all-read` | Mark everything read | `⇧Escape` | `Shift+Escape` | `app/useMarkAsReadShortcuts.ts` |
| `zoom-in` | Zoom in | `⌘+` | `Ctrl+=` | `app/useWebviewZoomShortcuts.ts` (`+`, `=`) |
| `zoom-out` | Zoom out | `⌘-` | `Ctrl+-` | `app/useWebviewZoomShortcuts.ts` |
| `zoom-reset` | Reset zoom | `⌘0` | `Ctrl+0` | `app/useWebviewZoomShortcuts.ts` (`key "0"`, `code Digit0`/`Numpad0`) |
| `send-message` | Send | `Enter` | `Enter` | Tiptap `submitOnEnter` (`messages/lib/useRichTextEditor.ts`) |
| `new-line` | Line break | `Shift+Enter` | `Shift+Enter` | ditto |
| `publish-note` | Publish a Pulse note | `⌘Enter` | `Ctrl+Enter` | `features/pulse` |
| `close-dialog` | Close dialog / settings | `Escape` | `Escape` | `shared/hooks/useEscapeKey.ts` |
| `push-to-talk` | Hold to unmute in a huddle | `Ctrl+Space` | `Ctrl+Space` | `features/huddle` |
| `format-bold` | Bold | `⌘B` | `Ctrl+B` | composer |
| `format-italic` | Italic | `⌘I` | `Ctrl+I` | composer |
| `format-strikethrough` | Strikethrough | `⌘⇧X` | `Ctrl+Shift+X` | composer |
| `format-code` | Inline code | `⌘E` | `Ctrl+E` | composer |
| `format-link` | Link selection / edit link under caret | `⌘K` | `Ctrl+K` | `messages/lib/useLinkEditor.tsx` |

Unregistered but real, found in components:

| Keys | Context | Effect |
| --- | --- | --- |
| `↑` / `↓` | channel browser search input | move the virtual selection (create row is index 0) |
| `Enter` | channel browser search input | create (when the create row is selected or there are no matches) else open the selection |
| `Enter` | Set-status text input | save (Shift+Enter does not) |
| `Escape` | composer while editing | cancel the edit (`MessageComposer.tsx`) |
| `Tab` | composer while the link card is open | move into the link editor (`messages/lib/linkEditorFocus.ts`) |
| `↑` / `↓` / `Enter` / `Escape` | mention, channel and emoji autocompletes | navigate / accept / dismiss (`MentionAutocomplete.tsx`, `ChannelAutocomplete.tsx`, `EmojiAutocomplete.tsx`) |
| `Enter` / `Shift+Enter` | in-channel find bar | next / previous match |

**Shortcut arbitration rules** (copy these, they are why the app feels correct):

1. `⌘K` is claimed by the composer's link editor when text is selected: the
   element-level handler runs first and calls `preventDefault()`; the
   window-level handler in `AppShell` checks `event.defaultPrevented` and yields.
2. All `AppShell` shortcuts bail on `event.repeat` and on `altKey`, and are not
   installed at all while settings are open.
3. `Escape` never means "mark read" while any closable foreground surface is
   registered (`escapeSurfaces.ts`) — see §4.9.
4. `hasPrimaryShortcutModifier(event)` (`shared/lib/platform.ts`) is the one
   ⌘-vs-Ctrl check; never test `metaKey` directly.

---

## 9. Empty, loading and error states

### 9.1 The timeline surface state machine

`messages/lib/timelineSnapshot.ts` and `timelineLoadingState.ts` are pure and
tested; rebuild them exactly.

```
selectDeferredListRenderState(deferredCount, liveCount):
  deferredCount > 0 → "list"
  liveCount === 0   → "empty"
  otherwise         → "pending"      // deferred lags live by a frame

selectTimelineBodySurface({deferredCount, liveCount, isLoading, hasPersistentIntro}):
  isLoading                 → "skeleton"
  renderState === "pending" → hasPersistentIntro ? "empty" : "skeleton"
  otherwise                 → renderState
```

The `hasPersistentIntro` branch exists because a channel/DM intro is already
meaningful stable content; replacing it with a skeleton while React's deferred
snapshot catches up makes an append look like a page reload.

```
selectTimelineLoadingState(status, hasSettled):
  isPending                                  → true
  !hasSettled && isPlaceholderData && len>0  → false   // paint stale, revalidate
  !hasSettled                                → isFetching  // hold the skeleton for the whole cold load
  settled                                    → isFetching && (isPlaceholderData || len === 0)
```

The trap this guards: `data !== undefined` looks like "loaded" but the cache is
seeded early — by stale `placeholderData` on revisit and by the live
subscription's `setQueryData` — before the authoritative history fetch settles.
Treating that as loaded flashes the intro/empty state over a list about to stream in.

```
resolveTimelineLoadingLatch(settledChannelId, activeChannelId, loadingNow):
  monotonic per channel — once settled, a background refetch never re-shows the
  skeleton; a different channel id resets the latch.
```

`selectTimelineIntroSurface({hasChannelIntro, hasDirectMessageIntro,
hasReachedChannelStart, isSkeletonVisible})` → `null` while the skeleton shows,
`"direct-message-intro"` if a DM intro exists, `"channel-intro"` only when
`hasReachedChannelStart`, else `null`.

### 9.2 Per-surface inventory

| Surface | Loading | Empty | Error |
| --- | --- | --- | --- |
| **Channel timeline** (`messages/ui/MessageTimeline.tsx`) | `TimelineSkeleton` with a content-shaped row count from `useTimelineSkeletonRows` | `emptyTitle "No messages yet"`, `emptyDescription "Send the first message to start the thread."` (`data-testid="message-empty"`) — or the channel/DM intro block when it applies | send failures restore the composer; delete failures raise a toast; relay outage is surfaced by `app/RelayConnectionOverlay.tsx` |
| **Channel intro** (`messages/ui/ChannelIntroBlock.tsx`, `channels/ui/useChannelIntro.tsx`) | — | rendered only when history is exhausted (the true channel start) | — |
| **DM intro** (`messages/ui/DirectMessageIntroAvatarStack.tsx`, `channels/lib/dmParticipantDisplay.ts:buildDirectMessageIntro`) | — | avatar stack + participant names, always shown for a DM (persistent intro) | — |
| **Older history** | spinner chip pinned to the top of the timeline (`data-testid="message-timeline-fetching-older"`) held until rows actually paint | — | `console.error("Failed to fetch older messages", …)`, silent to the user |
| **No channel selected** (`channels/ui/ChannelScreenEmptyState.tsx`) | — | `Select a channel to view messages.` | — |
| **Channel browser** | inherits the channel list; join shows `"Joining..."` on the button | four distinct titles/descriptions, §1.3 | a failed join clears the joining state and leaves the dialog open |
| **Channel management panel** | `"Loading..."` on the canvas ingress row | narrative group omitted entirely when description/topic/purpose are all blank | inline destructive-tinted banners for `detailsQuery.error`, `membersQuery.error`, join/leave/archive/unarchive/update errors |
| **Channel context menu** | disabled `"Loading channel actions..."` with a spinner | — | disabled `"Channel actions unavailable"` with a warning triangle |
| **Thread panel** (`messages/ui/MessageThreadPanelSkeleton.tsx`) | skeleton | thread head with no replies | — |
| **Search (global)** | `SearchPromptPlaceholder` before the minimum query length; `isWaitingOnFromResolution` holds the empty state while `from:` resolves | zero results after resolution | an unresolved `from:`/`in:` yields **no** message results rather than a widened search |
| **Find in channel** | — | `matchCount === 0` | — |
| **Presence** | `presenceQuery.isLoading` | pubkeys omitted by `get_presence` are treated as offline/unknown | subscribe failures retry with backoff; the poll backstop covers a permanently failed socket |
| **User status** | — | `null` status renders nothing | — |
| **Custom emoji** | `useCustomEmoji()` returns `[]` while loading, so the picker shows standard categories only | `buildCustomEmojiCategory` returns `undefined` | live-subscription failure logs and falls back to the 2-minute poll |
| **Notifications** | `isUpdatingDesktopEnabled` disables the toggle | — | `errorMessage` under the toggle (blocked / unavailable / thrown message) |
| **Drafts panel** | — | no active drafts | corrupt localStorage logs `"[useDrafts] localStorage corrupt, starting fresh"` and starts empty |
| **Relay connection** | `app/RelayConnectionOverlay.tsx`, `shared/api/useRelayConnection.ts` | — | `shared/api/relay*` — stall watchdog, closed-policy, rate-limit gate, reconnect controller with replay |

Shared primitives: `shared/ui/skeleton.tsx`, `shared/ui/Shimmer.tsx`,
`shared/ui/spinner.tsx`, `shared/ui/ViewLoadingFallback.tsx`,
`shared/ui/alert.tsx`, `shared/ui/sonner.tsx` (toasts),
`features/sidebar/ui/sidebarLoadingSkeleton.tsx`.

---

## 10. Non-obvious rules worth preserving

These are the invariants the unit tests exist to protect. Each one encodes a bug
that was actually shipped.

### Kind sets and unread eligibility

1. **Reactions, edits, diffs, deletions and system messages must never trigger
   unread.** They can land *after* the last human-visible message; counting them
   creates phantom unreads. (`CHANNEL_MESSAGE_EVENT_KINDS`)
2. **An `undefined` kind counts as conversational.** Optimistic rows have no kind
   yet; failing open there would drop a legitimately unread message.
   (`isConversationalUnreadKind`, `kinds.test.mjs`)
3. **A freshly created channel is not unread.** `channel_created` + N
   `member_joined` rows are visible but non-conversational, or the pill reads
   "4 unread, 1 message".
4. **Auxiliary events are fetched by `#e` reference, not by time window.** A
   `limit`-bounded time window silently drops a late edit or delete for a visible
   old message, and dilutes the visible-depth budget (a 200-event window on a
   reaction-heavy channel was only ~136 messages).
5. **Kind 40008 (diff) is a content kind, not aux** — it renders its own row.
   The two lists look symmetrical and are not.

### Read state

6. **Markers are monotonic; mark-unread cannot be expressed in them.** It lives
   in a separate localStorage overlay, is not synced, and is gated on the marker
   value captured at force-time so a genuine cross-device read wins.
7. **`getOwnTimestamp` vs `getEffectiveTimestamp`.** The parent resolver maps
   every thread to the *active* channel. Evaluating a background channel's thread
   through `getEffectiveTimestamp` borrows the wrong channel's marker.
8. **The open-time frontier is captured during render, not in an effect.**
   Opening a channel immediately advances the live marker; a frontier read in an
   effect is already the post-open value and the divider vanishes instantly.
9. **The open-time frontier is keyed per channel and deleted on leave.** Reusing
   a stale frontier on revisit paints a phantom "New" divider over already-read
   messages.
10. **The thread divider snapshot must be probed with `.has()`, not `??`.** A
    never-read reply snapshots to `null`; `??` falls through to the now-advanced
    live marker and collapses the divider over exactly the replies that should
    anchor it.
11. **`markChannelRead` clears the observed refs only when the marker actually
    covers them.** Otherwise `latest > readAt` evaluates `T > T` (false) but the
    channel lingers in the unread set, because the monotonic guard suppressed the
    version bump that would have recomputed it.
12. **Passive channel-open uses `topLevelOnly`.** Folding `observedLatest`
    (which counts thread replies) into a passive open silently absorbs an unread
    thread reply just because you glanced at the channel.
13. **A message at exactly the frontier is READ.** The comparison is strictly
    `createdAt > readAt`, everywhere — channel, thread and per-message.
14. **Self-authored messages are never unread**, compared case-insensitively.
    Identity and signer pubkeys are both lowercase hex today, but a case mismatch
    would miscount your own post.
15. **The unread divider is suppressed at index 0.** With nothing above it there
    is no boundary to draw, only a confusing banner on a fresh channel.
16. **A deliberate mark-unread suppresses the in-timeline marker entirely.**
    Otherwise the sidebar says unread while the timeline shows no boundary — a
    visible self-contradiction.
17. **Thread subtree membership keys on `rootId`, not the parent chain.** A reply
    whose intermediate ancestor is outside the loaded window still carries its
    true root and must roll up; a parent-chain walk loses it, and a malformed
    cycle must key off nothing rather than loop.
18. **Opening a thread marks only the visible replies read.** Marking the whole
    subtree hides replies in collapsed branches forever.
19. **Read-state slot rotation on `client_id` mismatch.** Two clients sharing a
    d-tag coordinate would clobber each other's blobs.
20. **All own-slot blobs are max-merged, never winner-takes-all.**
21. **`created_at` on a published blob is `max(now, maxFetchedCreatedAt + 1)`** so
    it always supersedes what was just read — clock skew otherwise loses writes.
22. **Byte-budget eviction order is `msg:` oldest → `thread:` oldest; channel keys
    are never evicted.** Losing a channel key resurrects that channel's badge.
23. **`lastPublishedContexts` is reset only inside the split→single guard.**
    Resetting unconditionally clears relay-fetched state every debounce cycle and
    reintroduces a publish retry storm.
24. **Extra slots are deleted (kind 5) when leaving split mode**, or
    `fetchOwnBlobBeforePublish` re-inflates `lastPublishedContexts` from stale
    blobs on every subsequent cycle.
25. **`since = readAt + 1`** on the catch-up REQ: NIP-01 `since` is inclusive, so
    without the +1 the last-read message comes back as unread. The client-side
    `> readAt` check is the belt to that suspenders.

### Ordering, dedup and races

26. **Same-second events tiebreak on `id`.** Without it, two events sharing a
    `created_at` land in different positions depending on whether history or the
    live sub delivered first — reading as a "missing"/shuffled message at a fixed
    scroll offset.
27. **Pagination cursors are `(createdAt, eventId)`, never a bare `until`.** A
    bare timestamp cursor cannot escape a second denser than one page: it
    re-returns the same slice forever and older history becomes unreachable.
    Same reasoning for the forward thread cursor.
28. **`dedupeMessagesById` keeps the LAST occurrence** (iterate backwards, then
    reverse) — a later delivery is the more authoritative one.
29. **Optimistic→real reconciliation matches on content + kind + pubkey + channel
    + parentId + rootId**, and the real event inherits the pending row's
    `localKey`. Matching on id alone leaves a duplicate; not inheriting the key
    remounts the row and the message visibly flickers.
30. **Send target is resolved identically in `mutationFn` and `onMutate`.**
    Otherwise the optimistic bubble and the real send can land in different
    channels after a navigation.
31. **A captured channel id that resolves to nothing throws.** Falling back to the
    live channel would deliver a message to the wrong room.
32. **`shouldNotifyForEvent`'s ordering is the spec**: broadcast and mention
    outrank a channel mute; a thread mute outranks participation/follow/authorship.
33. **One shared seen-event guard for every notification side effect.** Reconnect
    replay overlaps live filters by five seconds and a mention arrives through two
    filters; a per-callback guard lets a duplicate escape through the other path.
34. **The first feed load never notifies** — the whole backlog would fire at once.
35. **DM backlog is suppressed by `created_at < dmSubscriptionStartedAt`**, reset
    on every reconnect.
36. **Channel-list invalidation is trailing-debounced and re-armed while a fetch
    is in flight.** `getChannels` is an O(channels) relay fan-out and off-channel
    traffic arrives in bursts.
37. **Catch-up claims are optimistic and released on cleanup/failure.** Without
    the claim, re-renders duplicate REQs; without the release, a transient relay
    failure freezes that channel until identity reset.
38. **Catch-up effects key on a sorted, joined id string**, not the array
    reference — React Query hands back new identities with identical contents and
    would cancel every in-flight catch-up forever.
39. **Async catch-up results are dropped when the (pubkey, relay) scope drifted**
    mid-flight, and an empty scope is rejected explicitly, because `"" !== ""` is
    false and would let a writer fire before the first valid scope exists.
40. **Unread Sets/Maps are reference-stabilised by content comparison**, or every
    downstream memo re-runs on every render.

### Cache invalidation

41. **The window store is the source of truth; the flat message array is a
    projection.** Patching only the projection is reverted by the next live event.
    Edits update the store first, then the projection for immediate paint.
42. **Create and update invalidate with `refetchType: "none"`.** An immediate
    `getChannels()` blocked the dialog on "Saving…" and could clobber the
    relay-returned row with a read-after-write-lagged snapshot.
43. **`upsertCachedChannelMember` never decorates a DM.** DM participant sets are
    immutable, so "adding a member" is a *different* conversation and the source
    DM must not gain a phantom member.
44. **`useAddChannelMembersMutation` invalidates the channel from `variables`,
    not the hook closure** — the closure may have changed mid-send.
45. **`useUpsertCachedChannel` awaits the in-flight active refetch before
    writing**, or the refetch lands after and drops the channel again.
46. **A `member_joined`/`left`/`removed` system message invalidates the member
    list and the channel list**, because membership changes have no other push.

### Rendering and virtualization

47. **Day-group keys are start-of-local-day, not the first message's id.**
    Prepending an older message into a rendered day must not remount the section.
48. **A day divider is emitted only at a PROVEN boundary** — a strictly older
    loaded day precedes it, or history is exhausted. The oldest loaded day's
    "start" is the arbitrary edge of the window; a divider there would have to
    accept older same-day rows prepending behind it, breaking exact-suffix key
    admission.
49. **Virtua `shift` is enabled only when every previous key is the exact suffix
    of the new key list.** Anything else corrupts the positional size cache.
50. **Divider keys are namespaced (`day-divider:`, `unread-`)** so they can never
    collide with a 64-hex event id.
51. **Membership groups are anchored from their NEWEST entry and keyed by it.**
    Anchoring from the oldest lets a prepend repartition already-rendered rows and
    change a group's identity mid-scroll.
52. **Pending rows never group.** They render standalone so the send status can
    sit beside the timestamp, and stay standalone until the ack.
53. **The grouping window boundary is inclusive** (exactly 600 s groups) and a
    negative gap never groups.
54. **Thread reply depth-normalisation is memoised in a `WeakMap` keyed on the
    source message.** Building `{...msg, depth}` fresh on every render defeats the row +
    markdown memo and costs ~1.4 ms/row on unrelated churn (typing, presence).
55. **Reaction pills sort by EARLIEST reaction time, and duplicate deliveries
    retain the earliest timestamp.** Otherwise pill order depends on input-array
    order and shuffles between renders.
56. **The optimistic reaction overlay is discarded the moment the formatter emits
    a new source array** (identity comparison), and it never re-sorts.
57. **Optimistic reactions append at the end**; ordering is the formatter's job.
58. **Thread summary participants are stored newest-first (max 3) and reversed
    for display**, so the facepile's rightmost avatar is the most recent replier —
    both the client-assembled and the relay-sourced paths reverse.
59. **The unread pill's dismiss-on-bottom effect is guarded by
    `hasShownPillRef`**, because `isAtBottom` initialises to `true` on mount and
    would dismiss the pill before it ever rendered.
60. **A prepend must never settle the scroll to the bottom**
    (`shouldSettleVirtualizedBottom` excludes `delta === "prepend"`).
61. **Programmatic bottom pins use a 1 px floor, not the 72 px UI threshold.**
62. **Deep-link resolution must read the same snapshot the DOM committed.** A
    fresher list scrolls to a row that is not there yet and fails silently.
63. **The older-history spinner outlives `isFetchingOlder`** — the flag clears on
    fetch resolve but rows paint a frame later.

### Composer, drafts, editing

64. **An edit's `p` tags carry only NEWLY ADDED mentions.** A typo-fix edit must
    re-wake nobody.
65. **`mediaTags: undefined` means "don't touch"; `[]` means "wipe attachments".**
    The composer must coerce `?? []` on the edit path and the receiver overlay
    must honour the empty set.
66. **`applyEditTagOverlay` swaps only imeta tags** and preserves `h`, mention
    `p`s and everything else. It lives in a `.mjs` so the test runs the exact
    source the renderer uses.
67. **Emoji tags must not ride the imeta-only Tauri argument.** The Rust guard
    rejects any non-imeta prefix, which silently dropped emoji sends —
    `splitOutgoingTags` exists for this.
68. **Messages carrying media or emoji tags must go over REST**, so the relay's
    tag validation runs; the WebSocket path emits no extra tags.
69. **Draft key ↔ channel id must not be recovered by parsing the key.** Thread
    keys are `thread:<headId>`; the containing `channelId` is stored explicitly.
70. **`renameDraftEntry` collapses onto an existing key only when every persisted
    field is identical**, including selection offsets, both timestamps and every
    optional `ImetaMedia` field. Anything else is a collision and both records
    survive.
71. **Rename is atomic (one flush, one notify).** Composing it from save + clear
    issues two flushes and can overwrite a concurrent write.
72. **The v1→v2 draft migration deletes the v1 key after a successful flush**, so
    a second workspace cannot import the same legacy bucket.
73. **Draft relay scope preserves path/query case** (unlike the shared
    `normalizeRelayUrl`), so `wss://host/Team` and `wss://host/team` are distinct.
74. **A failed send/edit restores content, attachments and spoiler state** — the
    restored composer is the retry affordance; there is no auto-retry.

### Emoji, presence, typing

75. **Quick-reaction recents never re-order the currently open tray.** They apply
    on reload or via the `storage` event, so the tray does not shuffle under the
    cursor.
76. **A `:shortcode:` quick reaction is hidden when the shortcode is not in the
    active community's palette** — it would render as literal text.
77. **`emoji-mart`'s index is warmed once at idle.** `<Picker>` builds it
    synchronously on mount and froze the cursor on the first reaction popover.
78. **The picker owns focus deterministically** via a shadow-root
    `MutationObserver`; leaving it to emoji-mart's async focus races Radix's
    focus scope and loses.
79. **Custom emoji URLs are rewritten through the localhost media proxy.**
    WKWebView bypasses the VPN tunnel and a direct relay URL 403s into a broken
    image.
80. **Live presence trusts only `event.pubkey`, never a `p` tag.** A `p` tag on a
    self-signed presence event is a spoofing vector; only the relay-signed
    REST/seed path may attribute by `p`.
81. **`get_presence` omits offline/unknown pubkeys**, so a live "online" event
    often targets a pubkey absent from the lookup — merge it in, do not drop it.
82. **Away means "human away from the machine", never "window not focused".**
    Window visibility is deliberately not an input.
83. **Presence activity lives in a ref; only the derived status is React state.**
    The earlier shape re-rendered the app root on every keystroke typed anywhere.
84. **Heartbeats are skipped while disconnected or rate-limited** — the publish
    fails anyway and consumes the quota recovery needs.
85. **The presence TTL is three heartbeat windows, and the relay owns it.** Deploy
    a relay TTL increase *before* shipping a slower client heartbeat.
86. **Typing state keys on `pubkey:threadHeadId`,** so channel typing and thread
    typing are independent.
87. **A message from an author suppresses their typing indicator for 2 s and
    permanently ignores indicators older than that message.** A throttled
    indicator sent just before the message would otherwise re-light the dots.
88. **`firstSeenAt` is preserved across indicator refreshes** so the typist order
    is stable.
89. **User-status live updates only patch pubkeys already present in a lookup,
    and only when strictly newer.**

### Search

90. **Search operators anchor at a token boundary, not `\b`.** `\b` also matches
    after `-` and `/`, turning `built-in:react` and `https://x.com/in:foo` into
    operators.
91. **`before:` subtracts one second** because NIP-01 `until` is inclusive —
    otherwise the named day is included and `before:` stops being exclusive.
92. **Invalid dates stay in the FTS text** rather than being swallowed.
93. **An unresolved `from:`/`in:` disables the message query entirely.** Silently
    widening a filtered search is worse than showing nothing.
94. **`isWaitingOnFromResolution` holds the empty state** while the `from:` user
    search loads, so "no results" never flashes before candidates arrive.
95. **The 2-char minimum lives in exactly one place** (`useSearchMessagesQuery`)
    so call sites cannot drift.
96. **Channel-name fuzzy matching is deliberately typo-intolerant.** Levenshtein
    reorders results unpredictably and hides a channel the user can plainly see;
    the subsequence pass (min 2 chars) is the only fuzzy affordance.
97. **Description matches always rank below every name match**, and descriptions
    are matched by plain substring only.

### UI arbitration

98. **`Escape` yields to any open closable surface.** Window listeners fire in
    registration order, so the app-mount handler would always beat a panel that
    opened later; `escapeSurfaces` inverts the race into an explicit yield.
99. **`⌘K` in the composer is the link editor, not global search** —
    `preventDefault()` on the element handler, `defaultPrevented` check on the
    window handler.
100. **Selecting "Edit message" suppresses Radix's focus restoration exactly
     once.** Radix restores in a `setTimeout` that fires after the composer's
     `requestAnimationFrame` focus and steals it; the suppression must reset so
     Escape-close keeps normal trigger restoration.
101. **Context-menu actions are wrapped in `deferMenuAction`** so the menu closes
     before the mutation runs.
102. **The channel-browser create row reads the LIVE query while the list reads
     the DEFERRED one**, so its visibility and label can never disagree for a
     frame.
103. **The create row occupies keyboard index 0** and channels shift down, so
     keyboard order matches visual order exactly.
104. **Archived channels are visible only to members**; the same predicate is
     used by the browser and by global search, and must not drift.
105. **Blank topic/purpose renders "cleared the topic", not `changed the topic to
     ""`.** The relay reports a clear as a change carrying an empty string.
106. **`toInlineName` decides on a pubkey comparison, never by matching the
     string "You".** Display names are user-controlled; identity is not.
107. **Archived identities outrank "bot" in member classification.** A zombie
     agent must fold into "Archived", not appear as an active Bot.

---

## Appendix A — file index by concern

| Concern | Primary files |
| --- | --- |
| Kinds / event vocabulary | `shared/constants/kinds.ts` (+`.test.mjs`) |
| Channel CRUD + cache policy | `channels/hooks.ts`, `channels/channelSnapshot.ts` |
| Channel browser | `channels/ui/ChannelBrowserDialog.tsx`, `channels/lib/channelSearchScore.ts`, `channels/lib/canonicalChannelName.ts` |
| Channel creation | `sidebar/lib/useCreateChannelForm.ts`, `sidebar/ui/CreateChannelFormFields.tsx`, `channels/ui/ChannelTypePicker.tsx`, `ChannelTypeSettings.tsx`, `ChannelPermissionsSettings.tsx` |
| Channel settings | `channels/ui/ChannelManagementSheet.tsx`, `ChannelManagementSheetRows.tsx`, `ChannelManagementModerationActions.tsx`, `ChannelCanvas.tsx` |
| Ephemeral channels | `channels/lib/ephemeralChannel.ts` (+`.test.mjs`), `channels/ui/EphemeralChannelBadge.tsx`, `channels/useEphemeralChannelDisplay.ts` |
| Members / roles | `channels/ui/MembersSidebar*.tsx`, `channels/lib/useClassifiedMembers.ts`, `channels/lib/memberUtils.ts`, `channels/channelMemberProfileCache.ts` |
| Templates | `channel-templates/hooks.ts`, `channel-templates/useApplyTemplate.ts` |
| Message projection | `messages/lib/formatTimelineMessages.ts`, `applyEditTagOverlay.mjs`, `messages/types.ts` |
| Threading | `messages/lib/threading.ts`, `threadPanel.ts`, `threadTreeLayout.ts`, `messages/useThreadReplies.ts`, `useLoadMissingAncestors.ts`, `channels/lib/threadViewModePreference.ts` |
| Timeline assembly | `messages/lib/timelineItems.ts`, `timelineSnapshot.ts`, `virtualizedTimelineItems.ts`, `rowHeightEstimate.ts`, `dateFormatters.ts`, `messageGrouping.ts` |
| Timeline rendering | `messages/ui/MessageTimeline.tsx`, `TimelineMessageList.tsx`, `MessageRow.tsx`, `SystemMessageRow.tsx`, `DayDivider.tsx`, `UnreadDivider.tsx`, `TimelineSkeleton.tsx` |
| Scroll behaviour | `messages/ui/useAnchoredScroll.ts`, `anchoredScrollPolicy.ts`, `useVirtualizedBottomSettle.ts`, `useSettleGatedPrependMessages.ts`, `useLoadOlderOnScroll.ts`, `timelineRetention.ts` |
| Pagination | `messages/lib/channelWindowStore.ts`, `channelWindowResponse.ts`, `channelWindowReconciliation.ts`, `projectChannelWindow.ts`, `pageOlderMessages.ts`, `messages/useFetchOlderMessages.ts` |
| Send / edit / delete / react | `messages/hooks.ts`, `messages/lib/messageMerge.ts`, `messages/ui/useReactionHandler.ts`, `messages/lib/canManageMessage.ts` |
| Composer | `messages/ui/MessageComposer.tsx`, `MessageComposerToolbar.tsx`, `FormattingToolbar.tsx`, `ComposerAttachments.tsx`, `ComposerReplyEditBanner.tsx`, `messages/lib/useRichTextEditor.ts`, `useMentions.ts`, `useMediaUpload.ts`, `useEmojiAutocomplete.ts`, `useLinkEditor.tsx` |
| Drafts | `messages/lib/useDrafts.ts`, `messages/ui/DraftsPanel.tsx`, `DraftDetailPane.tsx`, `draftSubmitKey.ts` |
| Message actions | `messages/ui/MessageActionBar.tsx`, `useQuickReactionEmojis.ts`, `DeleteMessageConfirmDialog.tsx`, `messages/lib/messageLink.ts` |
| Read state | `channels/readState/{readStateFormat,readStateManager,readStateSnapshot,readStateStorage,useReadState}.ts` |
| Unreads | `channels/useUnreadChannels.ts`, `unreadChannelCounts.ts`, `forcedUnreadStore.ts`, `unreadRootIdStore.ts`, `ui/useChannelUnreadState.ts`, `messages/lib/unreadMarker.ts`, `channels/lib/threadBadgeCounts.ts`, `threadReplyUnreadCounts.ts` |
| Live updates | `channels/useLiveChannelUpdates.ts`, `messages/hooks.ts:useChannelSubscription`, `channels/refreshChannelsWhenIdle.ts` |
| Notifications | `notifications/hooks.ts`, `use-feed-desktop-notifications.ts`, `lib/{shouldNotify,desktop,sound,feed,homeBadge,notificationFormat}.ts` |
| Mutes / stars / sections / sort | `sidebar/lib/channelMutesStorage.ts`, `channelStarsStorage.ts`, `channelSectionsStorage.ts`, `channelSortPreference.ts` (+ `*Sync.ts`) |
| Presence | `presence/lib/presence.ts`, `presence/hooks.ts`, `presence/ui/PresenceBadge.tsx`, `shared/api/osIdle.ts` |
| Typing | `messages/useChannelTyping.ts`, `useTypingBroadcast.ts`, `ui/TypingIndicatorRow.tsx`, `channels/ui/useChannelActivityTyping.ts` |
| User status | `user-status/hooks.ts`, `ui/SetStatusDialog.tsx`, `ui/StatusEmoji.tsx` |
| Custom emoji | `custom-emoji/hooks.ts`, `emojiMartCategory.ts`, `ui/EmojiPicker.tsx`, `ui/CustomEmojiSettingsCard.tsx`, `shared/api/customEmoji.ts`, `shared/lib/remarkCustomEmoji.ts`, `customEmojiTags.ts` |
| Search | `search/lib/parseSearchOperators.ts`, `search/hooks.ts`, `useSearchResults.ts`, `useChannelFind.ts`, `ui/{TopbarSearch,ChannelFindBar,SearchResultItem,SearchPromptPlaceholder}.tsx`, `app/navigation/{resolveSearchHitDestination,searchHitEventCache}.ts` |
| Communities | `communities/useCommunities.tsx`, `communityStorage.ts`, `communityUnreadObserver.ts`, `communityMarkRead.ts`, `ui/CommunitySwitcher.tsx` |
| Community members | `community-members/hooks.ts`, `ui/{AddMemberDialog,CommunityInviteDialog,CommunityMembersCard,InviteLinkSection}.tsx` |
| Shortcuts | `shared/lib/keyboard-shortcuts.ts`, `app/{useMarkAsReadShortcuts,useSettingsShortcuts,useWebviewZoomShortcuts}.ts`, `app/navigation/useBackForwardControls.ts`, `shared/hooks/{useEscapeKey,escapeSurfaces}.ts` |

## Appendix B — pure functions with `*.test.mjs` (the executable spec)

`messages/lib/`: `unreadMarker`, `messageGrouping`, `timelineItems`,
`timelineSnapshot`, `timelineLoadingState`, `virtualizedTimelineItems`,
`rowHeightEstimate`, `dateFormatters`, `threadPanel`, `threadTreeLayout`,
`messageLink`, `messageMerge` (via `messageQueryKeys`), `messageQueryKeys`,
`messageRowEquality`, `messageSnapshot`, `messageMentionPubkeys`,
`formatTimelineMessages`, `applyEditTagOverlay`, `systemEventCopy`,
`channelWindowStore`, `channelWindowResponse`, `projectChannelWindow`,
`auxBackfill`, `diffAddedMentionPubkeys`, `mentionCandidates`, `mentionRanking`,
`mentionHighlightExtension`, `normalizeMentionClipboard`, `orderMentionPubkeys`,
`plainTextProjection`, `renderScopedReactions`, `spoilerFormatting`,
`spoilerMark`, `selectionBlockFormatting`, `customEmojiNode`,
`imetaMediaMarkdown`, `useDrafts`, `useDraftsReactivity`, `useDraftRootStatus`,
`useMentions`, `useMessageEmoji`, `useMediaUpload`, `resolveLinkAt`,
`linkEditorFocus`, `openPopoverLink`, `inboxReplyMigration`,
`persistentAgentAudience`, `effectiveExplicitAgentPubkeys`,
`flushMentionDebounce`, `agentSnapshotClipboard`, `snapshotSharedBy`,
`videoReviewContext`, `timelineImagePreload`.

`messages/ui/`: `useAnchoredScroll` (×4 suites), `useBufferedTimelineMessages`,
`useComposerHeightPadding`, `useQuickReactionEmojis`, `useReactionHandler`,
`useSettleGatedPrependMessages`, `useVirtualizedBottomSettle`,
`useVirtualizedViewportResize`, `virtuaWheelModePatch`,
`timelineSnapshotProjection`, `MessageComposerAutoSend`,
`MessageComposerDraftImagePersist`, `MessageComposerDraftPredicate`,
`DraftsPanelPredicate`, `configNudgeAuthPubkey`, `persistentAgentAudienceHosts`.

`channels/`: `channelMemberProfileCache`, `channelSnapshot`,
`focusedThreadCloseRequest`, `hooks`, `isDmNotifiableKind`,
`refreshChannelsWhenIdle`, `unreadReadMarker`, `useUnreadChannels.storage`,
`lib/canonicalChannelName`, `lib/channelSearchScore`, `lib/ephemeralChannel`,
`lib/huddleAvailability`, `lib/threadBadgeCollapseOnOpen`,
`lib/threadBadgeCounts`, `lib/threadBadgeInvariants`,
`lib/threadReplyUnreadCounts`, `lib/threadViewModePreference`,
`readState/{readStateFormat,readStateManager,readStateStorage}`,
`ui/{ThreadViewModeToggle,agentSessionScrollIds,agentSessionSelection,useChannelActivityTyping,useThreadViewModeSwitch,useWelcomeInitialUnreadSuppression}`.

`notifications/`: `hooks`, `lib/feed`, `lib/shouldNotify`,
`lib/shouldNotifyChannelMutes`.

`presence/lib/presence`. `search/lib/parseSearchOperators`.
`communities/`: `applyCommunitiesOrder`, `communityMarkRead`,
`communityNavigationStorage`, `communityStorage`, `communityUnreadObserver`,
`legacyCommunityStorage`, `relayProbe`, `resolveCommunityUpdateResult`.
`shared/api/customEmoji`. `shared/hooks/escapeSurfaces`.
`sidebar/lib/`: `channelMutesStorage`, `channelSectionsHelpers`,
`channelSectionsStorage`, `channelSectionsSync`, `channelSortPreference`,
`channelSortSync`, `channelStarsStorage`, `dmSidebarSort`,
`sidebarBackgroundTarget`, `useActiveWorkingChannelsById`.
