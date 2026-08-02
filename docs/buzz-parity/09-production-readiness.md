# Chat dashboard — what is left before production

Measured, not remembered: the unmounted list comes from counting references to
every exported component, and the rest from the agents' own reports of what they
deliberately did not build.

Status at the time of writing: **C0–C12 complete**, 137 test files, 2,616 tests
green, production build compiles, seven `/chat` routes.

---

## 1. Blocking — it does not work without these

### 1.1 Surfaces built but never mounted

The cost of parallel agents: each was told not to edit files another owned, so
several finished surfaces have no call site. They are complete and tested; they
are simply not on screen.

| Surface | Where it belongs |
| --- | --- |
| `HuddleBar`, `HuddleCard` | the room — the bar above the composer, the card in the transcript |
| `RoomAgentsPanel` | the room's aux pane (it appears in the gallery, not in the app) |
| `TypingLine` | under the transcript, in the band the presence module reserves |
| `ReportMessageDialog` | the message action bar's report slot |
| ~~`ChatSearchLauncher`~~ | **mounted** in the top chrome — see 3.1 |
| ~~`ChannelBrowserDialog`~~ | **mounted** on the Channels section's `+`, which was a disabled control |
| `NotificationSettingsPanel`, `NotifyExplainer` | a Chat settings route, which does not exist |

Two notes from mounting those last two, because both were the kind of thing
only a call site can find:

- **The channel browser was talking to a mutation that does not exist.** Its
  hand-written `FunctionReference`s described the dialog's own form rather than
  `buzz/channels.ts`'s argument validators — it sent `kind`, which `create` has
  no argument for, `visibility: "public"`, which is not in its union, and a
  `join` with no scope. Every write from it would have been refused the moment
  it was mounted, and its UI test asserted the *caller's* shape, so it passed.
  Fixed at the call site with `wireVisibility`/`wireChannelType`, and the test
  now asserts the validator's words.
- **`ChannelSidebar` still leaves a room with a scope-less `buzz/channels:leave`.**
  Same class of defect, same file family, not touched here because nothing in
  this pass mounts it. It is a two-line thread of `scope` from `useChatShell`.

### 1.2 `npx convex dev` has never run here

`convex/_generated/` is the checked-in stub, so several modules reach their own
internal functions through `anyApi` with a hand-written `FunctionReference`
cast. Every one carries a comment saying to delete it once the CLI regenerates.
**Nothing in Chat has ever executed against a real Convex deployment** — the
tests run against `convex-test`, which is a faithful harness and is not a
deployment.

### 1.3 The workflow webhook door has no HTTP route

`fireWebhook` is an internal mutation waiting for `POST /hooks/{id}`;
`convex/http.ts` was owned by nobody in the phase that needed it. Webhook-
triggered workflows cannot fire until it exists.

### 1.4 Environment

| Variable | Needed for | Without it |
| --- | --- | --- |
| `ABLY_API_KEY` | typing, presence liveness, huddle reactions and captions | supported and degraded: rooms work, no live dots |
| SFU provider credentials | huddle audio | supported and degraded: rooms, rosters and the record work; nobody can hear anybody |
| `OPENAI_API_KEY` | nothing in Chat | Chat does not use it (D9 — turns run on the agent's runtime) |

---

## 2. Not built, deliberately, and each one is a decision to confirm

- **Pulse search** — the tab says it is not wired rather than showing the wrong
  feed.
- **Chat settings route** — no `/chat/settings` at all.
- **Forum issues (kind 1621)**, **repo ref state authoring**, **collection
  creation UI** — read paths exist; authoring is an API call.
- **Moderation kick and timeout** — refused from the queue with a reason rather
  than half-implemented.
- **Local archive, identity archive, mesh compute, on-device speech** — out of
  scope by D10.
- **Screen share, video, deafen, recording** — Buzz does not have them either.

---

## 3. Worth deciding before shipping

### 3.1 Two search surfaces — **decided: keep both**

C5 built `ChatSearchLauncher` with its own dialog. C12 then taught the product's
existing command palette to return Chat hits. This section used to recommend
deleting the Chat-only dialog; measuring it said otherwise, and the measurement
is the whole argument:

- `bridge.search` **declared** `kind: "room"` in its unified hit type and the
  handler never emitted one, so ⌘K returned messages, tasks and pages but no
  rooms. (Closed — it now emits rooms through `listChannelsCore`, which is the
  same function the rail draws from, so there is no second copy of the
  visibility rule.)
- `bridge.search` passes plain text. `convex/buzz/search.ts` accepts
  `channelIds`/`authors`/`since`/`until`, and `src/lib/buzz/search-query.ts`
  parses `from:` / `in:` / `after:` / `before:`. **Only the dialog reaches any
  of it**, and nothing in the palette's shape could.

So they answer different questions and both are kept, the way a file manager
has both a jump bar and a search pane: ⌘K is the cross-dashboard quick-switch,
⌘⇧F is in-room search with operators. The keystrokes were the actual conflict —
the launcher shipped bound to ⌘K, which the palette already owns at the window,
so which one opened came down to which mounted first. `tests/ui/chat-search-launcher.test.tsx`
holds the arbitration.

### 3.2 The desktop app (C13)

Not started. Tauri wrapping the deployed URL, the same remote-web-app pattern
`capacitor.config.ts` already uses. Needs a release pipeline for three
platforms.

### 3.3 The verification sweep (C14)

Static half is done and clean: no control characters, no `window.confirm`, no
`eval`, no scope-blind reads, no imports of the concurrent build's modules.
Dynamic half outstanding: the gallery at 1280px and 390px, light and dark,
across every Chat surface, with the PNGs actually read back.

---

## 4. Known risks, stated rather than discovered later

- **Media**: no transcoding, so an HEVC-in-MP4 plays only for whoever posted it;
  no magic-byte sniffing, because a mutation cannot read a blob; storage URLs
  are unguessable capability URLs rather than a per-community gate. All three
  are weaker than Buzz and all three are written down at the code.
- **A new agent is silent** until somebody runs a harness for it (D9). The room
  says so in place; it remains the thing most likely to be mistaken for a bug.
- **`agentApi` key material travels as a function argument**, inherited from the
  existing agent surface, so deployment logs are sensitive. Pre-existing, not
  introduced here.
- **Two copies of a few pure vocabularies** (media tags, moderation, presence
  constants) exist because the Convex tree cannot import from the Next tree.
  Each pair has a test asserting they agree.
