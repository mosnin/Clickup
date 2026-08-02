# Buzz parity — 05: Application shell, navigation, and visual design system

Source of record: `github.com/block/buzz`, `desktop/` workspace (Tauri v2 + React 19 +
Vite + TanStack Router + Tailwind v4 + shadcn "new-york"). Every path below is
relative to `desktop/` unless noted.

This document is a rebuild specification for the **shell** (window chrome, rail,
sidebar, panes, overlays), the **navigation model**, the **theme/token system**,
the **shared UI primitives**, and the **onboarding / settings / profile**
surfaces. It is written to be sufficient without the repo.

---

## 0. Stack facts that shape the design

| Concern | Choice | Where |
| --- | --- | --- |
| Shell | Tauri v2 native window, custom title bar, macOS traffic lights **overlaid** on the app chrome (`trafficLightPosition` in `tauri.conf.json`) | `src/app/AppTopChrome.tsx` |
| Router | TanStack Router with **hash history** (`createHashHistory`), scroll restoration keyed on pathname | `src/app/router.tsx:router` |
| Routes | Virtual-file routes → generated `routeTree.gen.ts` | `src/app/routes.ts:routes` |
| Styling | Tailwind v4 (`@import "tailwindcss"` + `@config` pointing back at a v3-style `tailwind.config.js`) | `src/shared/styles/globals.css`, `tailwind.config.js` |
| Components | shadcn `new-york`, base color `zinc`, CSS variables on, aliases `@/shared/ui` + `@/shared/lib/cn` | `components.json` |
| Typeface | **Inter Variable**, bundled via `@fontsource-variable/inter` (never a CDN). Stack: `"Inter Variable", Inter, "Avenir Next", "Segoe UI", sans-serif` | `tailwind.config.js:theme.extend.fontFamily.sans`, `globals/theme.css` `body` |
| Motion | `motion/react` (Framer successor) for component motion; hand-rolled CSS keyframes for the shell/onboarding; CSS View Transitions for community switches | `globals/motion.css`, `src/app/communityViewTransition.ts` |
| DnD | `@dnd-kit/core` + `@dnd-kit/sortable` (community rail reorder, sidebar section/channel reorder) | `src/features/sidebar/ui/SidebarDnd.tsx`, `CommunityRail.tsx` |
| Identicons | `jdenticon` (`toSvg`) — used only for numbered bot copies | `src/features/messages/ui/BotIdenticon.tsx` |

The document is a **fixed-height shell**: `html, body, #root { height:100% }` and
`html, body { overflow:hidden; overscroll-behavior:none }` so the window never
rubber-bands (`globals/theme.css`). A JS wheel-boundary lock
(`useWebviewScrollBoundaryLock`) is the belt to that CSS's braces.

---

## 1. Layout anatomy

### 1.1 The stacking order, outermost → innermost

`src/app/AppShell.tsx:AppShell` renders, in order:

```
PreventSleepProvider
└ AppShellTrayMenu           (no DOM; syncs the native tray)
└ ChannelNavigationProvider
  └ AppShellProvider          (read-state + thread-follow context)
    └ HuddleProvider
      └ RemindMeLaterProvider
        └ div.buzz-huddle-shell          h-dvh, overflow-hidden, overscroll-none,
        │                                data-huddle-open={bool}
        │  ├ div.buzz-huddle-app-surface  absolutely positioned inset-0, z-10,
        │  │                              flex-row, bg-background
        │  │  ├ BuzzTheme.GradientLayer   absolute inset-0 -z-10   (§4.4)
        │  │  ├ CommunityRail             w-14 (56px), only when >1 community
        │  │  └ SidebarProvider           flex-1, flex-col, min-h-0
        │  │     └ AppProfilePanelProvider
        │  │        ├ AppTopChrome        h-40px strip (hidden while /settings)
        │  │        └ EITHER  SettingsScreen (lazy)   —— when pathname === "/settings"
        │  │           OR     [ AppSidebar | SidebarInset(main) | RelayConnectionOverlay ]
        │  │        ├ RequestedAgentCreateDialogs / AgentManagementDialogs
        │  │        ├ AppShellOverlays    (channel browser, channel management sheet)
        │  │        └ SendFeedbackController
        │  └ div.absolute inset-x-0 bottom-0 z-0 h-(--buzz-huddle-drawer-height)
        │     └ AppHuddleBar
```

Key structural decisions to reproduce:

- **The huddle bar is behind, not below.** `.buzz-huddle-shell` paints the huddle
  drawer surface (`--huddle-drawer-surface`, black in light mode) and the app is
  an *absolutely positioned* surface on top of it. Opening a huddle animates the
  app surface's `bottom` from `0` → `var(--buzz-huddle-drawer-height)` (5rem)
  while rounding its bottom corners to 24px and adding a lift shadow — the app
  "lifts off" the drawer rather than the drawer sliding in.
  `globals/components.css` `.buzz-huddle-app-surface` /
  `.buzz-huddle-app-surface-open`, transition `260ms cubic-bezier(0.32,0.72,0,1)`.
- **Settings replaces the sidebar + main, not the shell.** `/settings` is a real
  history entry; when active the app renders `SettingsScreen` (its own
  `Sidebar` + `SidebarInset`) in place of the app sidebar/main, and hides
  `AppTopChrome` (Settings draws its own 40px drag strip).
  `AppShell.tsx` `settingsOpen = location.pathname === "/settings"`.
- **Main content is a floating card.** `BuzzTheme.ContentSurface`
  (`src/app/BuzzThemeSurfaces.tsx:ContentSurface`) wraps `<Outlet/>` in
  `relative z-10 mb-2 ml-px mr-2 mt-px flex min-h-0 flex-1 flex-col
  overflow-hidden rounded-2xl bg-background shadow-content-edge`. So the app
  reads as a white rounded sheet inset ~2px/8px inside the tinted chrome.
  `shadow-content-edge` = `-1px -1px 0 0 hsl(var(--sidebar-border)/0.45)` — a
  hairline on the *top and left* only, i.e. the two edges facing the chrome.

### 1.2 Region inventory

| Region | Component | Size / behaviour |
| --- | --- | --- |
| **Top chrome** | `src/app/AppTopChrome.tsx:AppTopChrome` | Height `--buzz-top-chrome-height`, **40px fixed** (`shared/layout/chromeLayout.ts:TOP_CHROME_HEIGHT_DEFAULT`). `bg-sidebar`, `z-45`, `data-tauri-drag-region`, `cursor-default select-none`. Contains only: sidebar toggle + back + forward. Wheel events are `preventDefault`ed on capture so scrolling over the chrome never scrolls anything. |
| **Traffic-light clearance** | same | macOS & not fullscreen → left padding `pl-[80px]` (no rail) or `pl-[32px]` (rail present, which already occupies the far left); otherwise `pl-3`. Nav row nudged `translate-y-[3px]` on macOS. **All px on purpose** — native lights ignore the app's ⌘+/− rem zoom. |
| **Community rail** | `src/features/sidebar/ui/CommunityRail.tsx:CommunityRail` | `w-14` (56px), `px-2.5 pb-5`, top padding `calc(var(--buzz-top-chrome-height,40px)+7px)`. `bg-sidebar`, `z-20`, vertical scroll. **Hidden entirely when ≤1 community** (`AppShell.tsx:hasCommunityRail = communities.length > 1`). |
| **Sidebar** | `src/features/sidebar/ui/AppSidebar.tsx:AppSidebar` | `collapsible="offcanvas"`, `variant="sidebar"`, `!border-r-0`. Width `--sidebar-width`, default **300px**, min **220**, max **420**, persisted in `localStorage["buzz-sidebar-width"]`. Collapsed = fully off-canvas (`w-0`), not an icon rail (icon width `48px` exists in the primitive but the app uses offcanvas). Toggle: ⌘S or the top-chrome button. Open state stored in a `sidebar_state` cookie (7 days). When the rail is present the sidebar body shifts `md:-ml-[11px] md:w-[calc(100%+11px)]` so its rows tuck under the rail edge. |
| **Sidebar resize rail** | `shared/ui/sidebar.tsx:SidebarRail` | 16px hit strip on the sidebar's right edge, `cursor-col-resize`, pointer-capture drag, 3px dead-zone before drag begins. **Magnetic detent at 300px**: within 8px it snaps exactly; between 8–28px it eases quadratically out of the detent; beyond 28px it tracks the pointer. Crossing/landing on the default fires `performSidebarDefaultHaptic()`. Double-click does nothing here (the *auxiliary* panels reset on double-click). During drag `data-resizing=true` kills the width transition, sets `cursor:col-resize` on `<html>` and `user-select:none` on `<body>`. |
| **Main inset** | `shared/ui/sidebar.tsx:SidebarInset` + `MainInsetProvider` | `<main>`, `isolate min-h-0 min-w-0 overflow-hidden bg-sidebar`, carries `data-buzz-glass-inset`, `data-buzz-shadow-viewport`, and inline `chromeCssVarDefaults` (`--buzz-top-chrome-height: 40px`, `--buzz-channel-content-top-padding: 5.75rem`). In Buzz-light `data-buzz-shadow-viewport` gets `overflow:visible` so the content card's shadow feathers into the gradient. |
| **Channel pane** | `src/features/channels/ui/ChannelPane.tsx` under `ChannelScreen` | `flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden`. Header (`ChatHeader`) is `px-5 py-2`, an `h-9` row: hash/lock/file icon + title + hover-revealed copy button on the left, action cluster right. Content padding clears the measured header via `--buzz-channel-content-top-padding` (default 5.75rem, measured at runtime by `useMeasuredCssVariable`). |
| **Right auxiliary panes** (thread, profile, members, agent session, channel management) | `shared/layout/AuxiliaryPanelShell.tsx:AuxiliaryPanel`, `src/features/channels/ui/RightAuxiliaryPane.tsx` | Default **380px**, min **300px**, max `max(720, viewportWidth − 300)` — i.e. the static cap is a *floor* so ultrawides can go wider (`shared/layout/auxiliaryPanelLayout.ts`). Rendered width is additionally clamped at paint to `min(widthPx, calc(100% − 300px))`. Thread width persists in `sessionStorage["buzz.desktop.thread-panel-width"]`. |
| **Auxiliary resize handle** | `AuxiliaryPanelShell.tsx` | 12px strip on the panel's left edge, `-translate-x-1/2`, `cursor-col-resize`; a 1px hairline appears on hover/focus (`bg-border/80`), starting `top-10` so it doesn't cross the header. **Double-click resets to default width** (tooltip says so). |
| **Auxiliary header** | `shared/layout/AuxiliaryPanelHeader.tsx` | Fixed 52px (`h-13` / `pt-13`) title row. Three modes from `getAuxiliaryPanelMode(isSplitLayout, isFloatingOverlay)`: `docked` (split, inline), `panel` (floating overlay), `single-panel` (full-width takeover). Surfaces: `default` = `bg-background/80 backdrop-blur-md` (dark: `/70` + `backdrop-blur-xl`), `soft` = `/75`→`/45`, `transparent`. |
| **Huddle bar** | `src/app/AppHuddleBar.tsx` → `features/huddle/components/HuddleBar.tsx` | 5rem tall (`--buzz-huddle-drawer-height`). `.buzz-huddle-drawer` re-declares the **whole token set as a forced dark scheme** (`color-scheme: dark`, `--background: var(--huddle-drawer-surface)`, `--foreground: 0 0% 98%`, etc.) so every shadcn component inside it renders dark regardless of app theme. Grid `[1fr auto 1fr]`, `px-5 py-3`, horizontal scroll with the scrollbar hidden. Controls are 48px squares (`buzz-huddle-control-button h-12 w-12 rounded-md`). |
| **Relay connection overlay** | `src/app/RelayConnectionOverlay.tsx` | `fixed z-50 w-[284px]`, `left-3` (or `left-[68px]` with the rail), `bottom-3` (or `calc(var(--buzz-huddle-drawer-height)+12px)` when the huddle is open). Only shown while the sidebar surface is hidden — otherwise the same card lives in the sidebar footer. Enter/exit: opacity + 20px y, `0.25s cubic-bezier(0.22,1,0.36,1)`. |
| **Overlays / modals** | `src/app/AppShellOverlays.tsx` | Lazy `ChannelBrowserDialog` and `ChannelManagementSheet`. Both are mounted through `useDeferredModalOpen()` — the component mounts one frame *before* `open` flips, so Radix's enter animation actually runs instead of being skipped by a same-frame mount. `MODAL_EXIT_ANIMATION_MS = 150`. |

### 1.3 Responsive behaviour

- `useIsMobile()` = viewport `< 768px` → the sidebar becomes a portaled Radix
  `Sheet` (`SIDEBAR_WIDTH_MOBILE = 288px`) instead of an inline column. Because
  the sheet renders outside the app surface it is the **only** place that repaints
  the Buzz gradient separately (`globals/theme.css`, the
  `[data-sidebar="sidebar"][data-mobile="true"]` rules).
- `useIsAuxiliaryPanelOverlay()` = viewport `< 600px`
  (`AUXILIARY_PANEL_SINGLE_COLUMN_BREAKPOINT_PX = MIN_WIDTH * 2`) → right panels
  stop being an inline column and become a floating overlay:
  `PANEL_OVERLAY_CLASS = "fixed bottom-0 right-0 top-11 z-40 h-auto shadow-xl
  max-w-[calc(100vw-2rem)]"` over a `fixed inset-0 z-30 bg-black/20` backdrop
  (`shared/ui/OverlayPanelBackdrop.tsx`). Note `top-11` (44px) clears the drag
  chrome and `h-auto` is required — `h-full` would resolve to 100vh and hang
  below the viewport.
- Resize handles disappear in overlay/single-panel mode (there is nothing to
  resize against).
- `useElementWidthBreakpoint` exists for container-relative decisions (panes
  measure themselves rather than the viewport).

### 1.4 Window dragging

`AppShell.helpers.ts:isWindowDragHandleEvent` + `useTauriWindowDrag`:

1. Walk `event.composedPath()`. A `[data-tauri-drag-region]` ancestor makes the
   event a drag **unless** an interactive element sits between (attr values:
   `"false"` = never, `"deep"` = always, `""`/`"true"` = only when it is the
   direct target).
2. Otherwise, anything within the top **44px** that is not inside
   `button, a, input, textarea, select, label, summary, [role=button|link|menuitem|tab|checkbox|radio|switch|option], [contenteditable=true], [tabindex]:not([tabindex="-1"])`
   is a drag handle.
3. Buzz **stops Tauri's own injected drag listener** (`stopImmediatePropagation`
   on mousedown/mouseup) because Tauri hardcodes maximize-on-double-click; Buzz
   calls `performTitleBarDoubleClickAction()` so macOS "double-click to zoom /
   minimise" preferences are honoured.
4. `StartupWindowDragRegion` is the same logic as a standalone component for the
   pre-app (onboarding/loading) screens, plus an invisible `fixed top-0 h-10`
   strip.

---

## 2. Sidebar

### 2.1 Section order (top to bottom)

`AppSidebar.tsx` renders exactly this sequence:

1. **Pinned header** — `AppSidebarPinnedHeader` (`mx-[3px] px-2 pb-2 pt-3`,
   `data-testid="sidebar-pinned-header"`). Contains only `TopbarSearch`:
   a full-width `h-8 rounded-md bg-sidebar-border/35 px-2` button with a
   `Search` glyph, the label **"Search everything"** (or the live query), and a
   right-aligned `⌘K` `<kbd>` at `text-2xs`. Under the Buzz theme its fill is
   overridden to `--buzz-search-surface` (4% black / 4% white).
2. **Primary menu** — `AppSidebarPrimaryMenu`, a `SidebarHeader` marked
   `data-tauri-drag-region` (so the top of the nav also drags the window),
   `data-testid="sidebar-primary-menu"`. Rows, in order:
   - **Inbox** (`Inbox`, route `/`) — carries the unread badge.
   - **Pulse** (`Activity`, `/pulse`) — behind the `pulse` preview feature.
   - **Projects** (`FolderGit2`, `/projects`) — behind `projects`.
   - **Agents** (`Bot`, `/agents`).
   - **Workflows** (`Zap`, `/workflows`) — behind `workflows`.
3. **Starred** — only when ≥1 starred channel. `ChannelGroupSection`,
   `data-testid="starred-list"`.
4. **Custom sections** — user-created, in stored order, each a
   `CustomChannelSection` inside the `SidebarDndContext`.
5. **Channels** — everything unassigned & unstarred, `data-testid="stream-list"`,
   `draggable` (it is the drop target for "remove from section"), quick action
   labelled **"Browse channels"**.
6. **Forums** — behind the `forum` preview feature, `data-testid="forum-list"`,
   create action labelled **"New forum"**.
7. **Direct messages** — `SidebarSection`, `data-testid="dm-list"`, quick action
   **"New message"**.
8. Error text (`px-3 py-2 text-sm text-destructive`) when the channel query
   failed and it is not the "relay unreachable" case (that gets the card).
9. **Footer** (`data-buzz-glass-footer-wrap`, `z-30`): relay reconnect card →
   update card → `SidebarProfileCard`.
10. `SidebarRail` (the resize strip).

### 2.2 Community switcher (the rail)

`CommunityRail.tsx`:

- One 36px (`h-9 w-9`) button per community. Resting shape is `rounded-2xl`
  with `bg-sidebar-accent/60`; **active** becomes `rounded-xl bg-primary
  text-primary-foreground`; hover on inactive morphs to `rounded-xl
  bg-primary/80 text-primary-foreground` — the Discord "squircle→squarer on
  select" gesture, done purely with `transition-all` on the radius.
- Content: the community's icon image (`object-cover`) or `getInitials(name)`,
  falling back to the 🐝 emoji.
- **Two-tier unread indicator**, computed by the pure
  `communityRailIndicators(unread)`:
  - `showBadge` — a mention/thread-reply count. `absolute -bottom-0.5 -right-0.5
    h-4 min-w-4 rounded-full bg-primary text-2xs font-semibold
    text-primary-foreground ring-2 ring-sidebar`, capped at `99+`.
  - `showDot` — plain unread with no mentions: `h-2 w-2 rounded-full bg-primary
    ring-2 ring-sidebar`. Mutually exclusive with the badge.
  - **Nothing is drawn unless `unread.state === "ready"`.** An unobserved relay
    (`unknown`/`loading`/`error`) shows no indicator at all and the tile drops to
    `opacity-60` while pending. This is deliberate: a fabricated badge is worse
    than none.
- Tooltip (`side="right"`) reads `"<name> — N mentions"` / `"— unread"` / plain
  name; the same string is the `aria-label`.
- Right-click → context menu: **Mark all as read** · ─ · **Copy community URL** ·
  *(owner/admin only)* **Invite to community** · **Community settings**.
- **Drag to reorder** with `@dnd-kit` (`PointerSensor`, 6px activation distance;
  `KeyboardSensor` with `sortableKeyboardCoordinates`). Source tile drops to
  `opacity-30`; a `DragOverlay` renders a `rounded-xl bg-primary shadow-lg
  ring-1 ring-sidebar-border` clone marked `data-buzz-flat` (see §4.4 — that
  attribute opts the chip out of the gradient's transparency rule).
- Trailing **+ Add community** button, same shape/hover treatment.

### 2.3 Section headers, actions, collapse

- `SidebarGroupLabel` is an `h-8 rounded-md px-2 text-xs font-medium
  text-sidebar-foreground/70` row. Under the Buzz theme its colour is forced to
  `--buzz-muted-foreground` (40% black / 40% white).
- The label is a `<button aria-expanded>` toggling collapse. A **2.5px chevron**
  sits after the text at `opacity-0`, revealed on `group-hover/sidebar-section`,
  `group-focus-within`, or `data-section-actions-open=true`; it rotates
  `-90°` when collapsed.
- Right edge (`absolute right-1 top-1/2 -translate-y-1/2 gap-0.5`): an optional
  **quick action** (`+`, or the browse glyph) and always a **`⋮` more-actions
  menu**. Both use `SECTION_ICON_BUTTON_CLASS`
  (`size-6 rounded-[4px] p-1 text-sidebar-foreground/50`, hover
  `bg-sidebar-border/35`) and `SECTION_ACTION_VISIBILITY_CLASS`
  (`opacity-0` → visible on section hover/focus-within/menu-open).
- `SectionActionsMenu` items, rendered only when their handler exists:
  Mark all as read · New message · Browse channels (with the platform key hint) ·
  Create channel · Rename section · Move up · Move down · ─ · **Sort ▸**
  (radio: *Recent* / *A–Z*) · ─ · **Delete section** (destructive).
- Collapse state is **component state, not persisted** — `collapsedGroups` for
  the four fixed groups and `collapsedSections` keyed by section id.

### 2.4 Channel rows

`SidebarSection.tsx:ChannelMenuButton`:

- Base is `SidebarMenuButton`: `h-8 rounded-md p-2 gap-2 text-sm`, `[&>svg]:size-4`.
- Leading icon by type: DM → participant avatar (24px `ProfileAvatarWithStatus`
  with a presence dot; group DMs with >1 other show a **count chip** instead —
  a 24px `rounded-full bg-sidebar-accent/80 text-2xs font-semibold` disc);
  private → `Lock`; forum → `FileText`; else `Hash`.
- Label truncates (`min-w-0 flex-1 truncate`, `data-sidebar-row-label`).
- Trailing, in order: ephemeral-channel badge → **working badge** → mute bell →
  unread badge.
- **Working badge** (`ChannelWorkingBadge`): a `rounded-full px-1.5 py-0.5
  text-2xs font-medium tabular-nums motion-safe:animate-pulse` chip showing
  elapsed time (and `(n)` when >1 agent), `bg-primary/10 text-primary` normally,
  `bg-sidebar-active-foreground/20` when the row is active. Tooltip:
  `"<Agent> and N agents working"`.
- **Unread**: a count badge `h-5 min-w-5 rounded-full bg-primary px-1 text-2xs
  font-semibold text-primary-foreground tabular-nums` (`99+` cap), or a bare
  `h-2 w-2 rounded-full bg-primary` dot when the count is unknown. Unread rows
  also go `font-semibold`. **Never shown on the active row.**
  In screenshots, non-DM unread appears as the small dot at the right edge, DMs
  as the numeric pill.
- Muted, unread-free rows render at `opacity-50` and gain a `BellOff` glyph.
- DM rows get a hover-revealed **`X` close** button occupying the same slot as
  the badge (`SIDEBAR_ROW_ACTION_REPLACED_BADGE_CLASS` fades the badge out on
  hover so they never overlap); `md:opacity-0` means the action is always visible
  on touch.
- Active row: `data-[active=true]` → `bg-sidebar-active font-semibold
  text-sidebar-active-foreground shadow-xs`. Under the Buzz theme this is
  overridden to a flat 7% black tint with **no shadow** (§4.5).
- The **label width is stabilised** by `SidebarMenuLabel`
  (`shared/ui/sidebar-menu-label.tsx`): it renders an invisible `font-semibold`
  copy in the same grid cell so switching to the active (bold) state never
  reflows the row.

### 2.5 Row context menu

`ChannelContextMenu.tsx:ChannelContextMenuItems`, in order:

**Copy ▸** (channel name / channel ID) · **Move to section ▸** (each section with a
check on the current one, ─, *New section…*, *Remove from section*) · ─ ·
**Mark as read** / **Mark unread** · ─ · **Mute/Unmute channel** ·
**Star/Unstar channel** · ─ · **Leave channel** (destructive) ·
*loading/unavailable placeholder while capabilities resolve* ·
**Archive channel** (manage capability) · **Delete channel** (destructive, delete
capability).

Every item goes through `deferMenuAction()` so the Radix menu finishes closing
before the mutation runs. Icons are wrapped in `ContextMenuIconSlot` so items
without an icon still align.

### 2.6 Drag & drop inside the sidebar

`SidebarDnd.tsx:SidebarDndContext` wraps custom sections + the ungrouped
Channels group:

- `collisionDetection: pointerWithin`, `PointerSensor` with 6px activation.
- **Channels** are `useDraggable` (`{type:"channel", channelId}`); dragging drops
  the row to `opacity-30`, overlay is a `rounded-md bg-sidebar px-2 py-1.5
  text-sm shadow-lg ring-1 ring-sidebar-border` pill with a `Hash` glyph,
  marked `data-buzz-flat`.
- **Drop targets**: `DroppableSectionBody` (`section-drop:<id>`) → assign;
  `DroppableUngroupedBody` (`ungrouped`) → unassign. Hovering a target adds
  `ring-2 ring-primary/30` to the whole body.
- **Sections** are `useSortable` (`verticalListSortingStrategy`) — the header row
  is the drag handle; overlay is an uppercase tracking-wider label chip.
- Persistence: `localStorage` keys `buzz-channel-sections.v1:<pubkey>:<relay>`
  (sections + assignments), `buzz-channel-sort.v1:…` (per-group sort mode),
  plus stars and mutes. **All are relay-scoped** so switching community does not
  bleed layout. Orphaned assignments/sort-modes are stripped on read.

### 2.7 Unread overflow affordance

`useUnreadOverflow` + `MoreUnreadButton`: when unread rows are scrolled out of
view, a pill floats at the top (`topChromeInset.top`) or bottom of the sidebar
scroller. The pill is `UnreadPill` (`shared/ui/UnreadPill.tsx`) —
`h-7 rounded-full border-border/70 bg-background/95 px-2 text-2xs
text-muted-foreground/70 shadow-xs backdrop-blur-sm` with an up/down arrow and
the label `"N new messages"`. Clicking scrolls to the next unread.

### 2.8 Sidebar scroll behaviour

- `SidebarContent` is `overflow-auto [scrollbar-gutter:stable]` +
  `buzz-sidebar-scrollbar` — a **hover-only scrollbar**: `scrollbar-color:
  transparent transparent` at rest, thumb colour appears on `:hover`
  (`--buzz-sidebar-scrollbar-thumb`, which the Buzz theme sets to its 4% hover
  fill). Webkit thumb is 10px wide with a 3px transparent border, so it reads as
  a 4px rounded bar.
- A capture-phase wheel handler clamps scrolling at both ends so the gesture
  never chains out to the window (Magic Mouse horizontal pan escaped through
  here once).
- Clicking sidebar background (not a row) calls `requestFocusedThreadClose()` —
  `isSidebarBackgroundTarget` decides via the `data-sidebar-background` markers.

### 2.9 Sidebar profile card (footer)

`SidebarProfileCard.tsx`: a `rounded-xl px-2 py-2 hover:bg-sidebar-border/35`
row (Buzz theme swaps that for `--buzz-hover-surface`). Layout: 32px avatar with a
**masked** presence-dot cut-out (`MaskedAvatarBadgeFrame` punches a
r=7.5 hole at (28,28) so the dot doesn't overlap the image), then a two-line
stack — display name `text-sm font-semibold`, and beneath it either the user
status (emoji + text) or the community label (`🐝 <community>`). **On hover the
status line cross-fades to the community label** and back, both absolutely
positioned so nothing reflows. Clicking anywhere opens `ProfilePopover`.

---

## 3. Navigation

### 3.1 Route table

`src/app/routes.ts` (virtual file routes, root `routes/root.tsx`):

| Path | File | Search params | Screen |
| --- | --- | --- | --- |
| `/` | `routes/index.tsx` | `item`, `profile`, `profileTab`, `profileView` | `HomeScreen` (the Inbox) |
| `/agents` | `routes/agents.tsx` | `profile`, `profilePersona`, `profileTab`, `profileView` | lazy `AgentsScreen` |
| `/pulse` | `routes/pulse.tsx` | `profile`, `profileTab`, `profileView` | lazy `PulseScreen` (preview) |
| `/reminders` | `routes/reminders.tsx` | — | reminders |
| `/settings` | `routes/settings.tsx` | `section` | rendered by `AppShell`, not the outlet |
| `/workflows` · `/workflows/$workflowId` | `routes/workflows*.tsx` | — | `WorkflowsRouteScreen` (preview) |
| `/projects` · `/projects/$projectId` | `routes/projects*.tsx` | `commitHash`, `pullRequestId`, `issueId` | projects (preview) |
| `/messages/new` | `routes/messages.new.tsx` | — | `NewMessageScreen` |
| `/channels/$channelId` | `routes/channels.$channelId.tsx` | `messageId`, `threadRootId`, `agentSession`, `autoSend` | `ChannelRouteScreen` |
| `/channels/$channelId/posts/$postId` | `routes/channels.$channelId.posts.$postId.tsx` | `replyId` | forum post |

**Hash history** is used because the app is a `file://`-ish Tauri webview.
`getScrollRestorationKey` is the pathname, so returning to a channel restores its
scroll but changing `?messageId=` does not.

`AppShell.helpers.ts:deriveShellRoute(pathname)` is the single mapping from URL →
`{selectedChannelId, selectedView}` where `AppView =
"home"|"channel"|"messages"|"agents"|"workflows"|"pulse"|"projects"`. The sidebar's
active state is driven only by this.

### 3.2 Navigation API

`src/app/navigation/useAppNavigation.ts:useAppNavigation` is the only thing that
navigates. Every call goes through `commitNavigation`, which **builds the target
location first and no-ops if `href` is unchanged** — this is what stops repeated
clicks from stacking identical history entries.

Exports: `goHome`, `goAgents`, `goPulse`, `goProfile(pubkey)` (→ `/pulse?profile=`),
`goProjects`, `goProject`, `goWorkflows`, `goWorkflow`, `goChannel(id, {messageId,
threadRootId, agentSession, autoSend, replace})`, `goNewMessage`, `goForumPost`,
`goSettings(section)`, `closeSettings`, `closeWorkflowDetail`, `closeForumPost`,
`openSearchHit(hit)`.

- `goChannel` sets `resetScroll: true` **only** when a `messageId` is present.
- `closeSettings` / `closeForumPost` / `closeWorkflowDetail` prefer
  `router.history.back()` and fall back to a `replace` navigation — so Escape out
  of Settings returns you where you were, and never leaves a dead entry.
- **Settings section changes use `replace`** (`AppShell.tsx:handleSettingsSectionChange`)
  so back always exits Settings in one step rather than walking sixteen sections.
- `openSearchHit` caches the hit's event (`searchHitEventCache.ts`) then resolves
  it to a destination (`resolveSearchHitDestination.ts`) — forum post vs channel
  message — so the target row can be spliced into the timeline even if the feed
  hasn't loaded it.

### 3.3 Back / forward

`src/app/navigation/useBackForwardControls.ts`:

- `canGoBack` is TanStack's `useCanGoBack()`.
- **`canGoForward` is derived by hand**: the hook keeps a `Map<index, key>` of
  visited history entries (trimmed to 200) and a `maxIndex`. Navigating to an
  index whose stored key differs means the forward stack was truncated, so
  `maxIndex` resets to the current index. `canGoForward = locationIndex < maxIndex`.
- Keyboard: macOS `⌘[` / `⌘]`, Windows/Linux `Alt+←` / `Alt+→`. Suppressed when
  the event target is an input/textarea/contenteditable (`isEditableTarget`).

### 3.4 Global shortcuts owned by the shell

Registered in `AppShell.tsx` (window-level `keydown`, skipped while Settings is
open, and **respecting `event.defaultPrevented`** so a focused composer can claim
⌘K for link editing):

| Keys | Action |
| --- | --- |
| ⌘K | Open search |
| ⇧⌘K | New direct message |
| ⇧⌘N | New channel |
| ⇧⌘O | Browse channels |
| ⇧⌘A | Home / Inbox |
| ⌘, | Toggle Settings (`useSettingsShortcuts`, capture phase + `stopImmediatePropagation`) |
| ⌘S | Toggle sidebar (`SidebarProvider`) |
| Esc | Mark current channel read — **yields** to any open closable surface via `hasActiveEscapeSurface()` |
| ⇧Esc | Mark all read |
| ⌘+ / ⌘− / ⌘0 | Webview zoom, 0.75–1.5 in 0.1 steps, persisted at `localStorage["buzz:text-scale"]`, base 16px |
| ⌘[ / ⌘] (Alt+←/→) | Back / forward |

The canonical list users see lives in `shared/lib/keyboard-shortcuts.ts:
KEYBOARD_SHORTCUTS` with categories **Navigation / Messages / Formatting / Zoom**
and per-platform key strings; `getPlatformKeysById(id)` renders them inline in
menus.

### 3.5 Community switching and view transitions

`src/app/communityViewTransition.ts` + `useCommunityNavigationTransitions.ts`.

Switching community is not a route change — it swaps the relay under the whole
app. The sequence, wrapped in `runCommunityViewTransition`:

1. Save the outgoing community's destination (`{kind:"channel", channelId}` or
   `{kind:"home"}`).
2. `await goHome({replace:true})` — **Home is a deliberate teardown barrier**: the
   outgoing channel must unmount before the relay changes, or its read-marker
   effect will advance markers on the wrong relay.
3. `markPendingCommunityRestore(id)`; if the target has a remembered channel,
   `history.replace("/channels/<id>")` **before** the target mounts, so no
   intermediate Inbox frame is ever painted.
4. `communities.switchCommunity(id)`.

All of that runs inside `document.startViewTransition(...)`, whose update
callback also awaits a `targetReady` promise that the incoming shell resolves
(`completeCommunityViewTransition()`), with a **5s timeout** fallback. Only one
transition can be pending; a new one finishes the old.

**What actually animates: nothing.** `globals/motion.css` sets
`::view-transition-old(root), ::view-transition-new(root) { animation: none }`.
The transition is used purely to *freeze the outgoing frame* until the target
relay is ready, then swap atomically. Animating the two snapshots produced a
flash. This is the single most surprising and most worth-preserving decision in
the navigation layer.

`useDeferredStartup` / `useDeferredLoad` gate expensive subscriptions behind
first paint; `AppShell` restores the remembered destination exactly once
(`hasRestoredCommunityDestinationRef`) and only when the transition explicitly
marked a pending restore — cold boot and reconnect remounts keep whatever route
the user actually opened.

### 3.6 Deep links

`buzz://message?…`, `buzz://connect?relay=…`, `buzz://join?relay=…&code=…`
are handled by the Rust side and forwarded as Tauri events;
`useMessageDeepLinks()` dispatches message links into the router with the same
resolution path as search hits. Connect/join links seed the add-community
prefill and can arrive *before* onboarding completes (they persist and carry an
`acknowledged` flag).

---

## 4. Theme system

### 4.1 Two layers of tokens

Buzz has an unusual arrangement: the shadcn variables are **derived at runtime
from a Shiki syntax theme**, and the static CSS values in `globals/theme.css`
exist only as the pre-hydration fallback (Catppuccin Latte for `:root`,
Catppuccin Macchiato for `.dark`).

`shared/theme/adaptive-theme.ts:createThemeVars(bg, fg, comment, gitColors)`:

- `isDark = luminance(bg) < 0.5`.
- `calculateChromeColors(bg)` derives the **sidebar/chrome** colour by stepping
  the background's luminance down by
  `0.035 * ln(1 + (bgLum + 0.0135) * 10)` and binary-searching (20 iterations)
  for a mix that hits that luminance. If the target would go below 0, it instead
  pins chrome at luminance 0 and *raises* the primary background. This is why
  every theme has a chrome/content separation that is perceptually constant
  rather than a fixed alpha.
- `elevate(n) = adjust(primaryBg, ±n)` (toward white in dark themes, black in
  light) gives `--popover` (0.08) and `--muted`/`--accent`/`--secondary` (0.06).
- `--border` = `mix(bg, fg, isDark ? 0.15 : 0.12)`.
- `--muted-foreground` is the syntax theme's **comment** colour. That one choice
  is why secondary text always harmonises with the theme.
- Git decoration colours become `--status-added/-deleted/-modified` and
  `--ui-warning` / `--ui-warning-bg` (an `rgba` overlay at 0.10/0.08).
- Everything is emitted as `"H S% L%"` component strings (`hexToHsl`) because
  Tailwind wraps them (`hsl(var(--x))`), which is what makes `/40` alpha
  modifiers work on every token.

`createThemeVars` also emits the full **huddle** token family
(`--huddle-drawer-surface`, `-control-surface`, `-control-hover-surface`,
`-control-chevron-surface`, `-control-chevron-hover-surface`,
`-control-foreground`, `-popover-surface`, `-popover-border`, `-tooltip-surface`,
`-tooltip-foreground`) — in light themes these are hardcoded dark greys
(`#333333`, `#3d3d3d`, `#292929`, `#383838`) so the huddle drawer is always dark.

### 4.2 Token inventory (Tailwind mapping)

`tailwind.config.js` maps: `background`, `foreground`, `card(.foreground)`,
`popover(.foreground)`, `primary(.foreground)`, `secondary(.foreground)`,
`muted(.foreground)`, `accent(.foreground)`, `destructive(.foreground)`,
`border`, `input`, `ring`, `chart-1..5`, plus a full `sidebar` family
(`DEFAULT`, `foreground`, `primary(.foreground)`, `active(.foreground)`,
`accent(.foreground)`, `border`, `ring`), plus raw-value families
`status.{added,deleted,modified}` and `warning.{DEFAULT,bg}`.

### 4.3 Typography, radii, shadows, spacing

- **Radius**: `--radius: 0.625rem` (10px). Tailwind `rounded-lg = var(--radius)`,
  `md = radius − 2px`, `sm = radius − 4px`. Larger radii are literal
  (`rounded-xl`, `rounded-2xl`) and used for cards/dialogs/content surface.
- **Type scale** (extended below Tailwind's `xs`):
  | Token | Size | Use |
  | --- | --- | --- |
  | `text-3xs` | 0.5rem (8px) | tiny glyphs / micro labels |
  | `text-2xs` | 0.6875rem (11px) | **the meta-text workhorse** — timestamps, badges, kbd, counts |
  | `badge` | 0.625rem (10px) | compact status badges |
  | `text-xs`…`text-base` | stock | body copy is `text-base`; chat === base |
  | `text-title` | 2.5rem / 1.15 / −0.02em | onboarding page titles |
  | `text-nsec-key` | 2.25rem / 1.3 | the private key, in monospace |
  All in **rem** so ⌘+/− (which scales `<html>` font-size) scales them.
- **Spacing**: one addition, `4.5 = 1.125rem`.
- **Shadows** (custom):
  - `shadow-content-edge` = `-1px -1px 0 0 hsl(var(--sidebar-border)/0.45)` — the
    main content card's top/left hairline.
  - `shadow-panel-left` = `-1px 0 0 0 hsl(var(--border)/0.8), -16px 0 32px -12px
    rgb(0 0 0/0.18)`. **Both layers run on −x** because Tailwind's stock shadows
    are all y-offset and cast nothing sideways; a left-only `border` can't do
    this job either because it tapers out at the rounded corners instead of
    turning them.
  - `POPOVER_SHADOW` (`shared/ui/popoverSurface.ts`) =
    `0 6px 18px lch(0% 0 0/0.02), 0 3px 9px lch(0% 0 0/0.04), 0 1px 1px lch(0% 0 0/0.04)`
    — three tight layers in `lch` for a neutral, non-blue shadow.
- **Popover surface**: `POPOVER_SURFACE_CLASS` =
  `border border-border/60 bg-[color-mix(in_srgb,hsl(var(--background))_80%,hsl(var(--muted))_20%)]`
  — popovers are 80/20 background/muted, not flat `--popover`.
- **Motion tokens** (`globals/motion.css`, `:root`):
  `--motion-duration-instant 120ms`, `-fast 180ms`, `-standard 240ms`,
  `-arrival 500ms`; `--motion-ease-standard cubic-bezier(.25,1,.5,1)`,
  `--motion-ease-arrival cubic-bezier(.16,1,.3,1)`;
  `--motion-distance-arrival .75rem`, `--motion-blur-arrival 2px`.
  Primitive `.motion-enter-conversation` = blur+rise+fade for a newly created
  message. Every keyframe has a `prefers-reduced-motion` override that collapses
  it to 1ms with no transform/blur.
- **Modal motion** (`shared/ui/modalMotion.ts`): overlay fades 200ms in / 150ms
  out; content adds `zoom-in-95` / `zoom-out-95` from `origin-center`. Backdrop
  blur is `backdrop-blur-[5px]` (`modalBackdrop.ts`) and the scrim is
  `bg-black/10` in light, `bg-black/80` in dark (`sheet.tsx` reads `useTheme()`
  to pick).

### 4.4 Named themes and the "Buzz" theme

`shared/theme/theme-loader.ts` exposes **63 themes**: `buzz`, `buzz-dark`, then
the Shiki bundle alphabetically (andromeeda … vitesse-light). `LIGHT_THEMES` is
an explicit set; `THEME_PAIRS` maps light↔dark counterparts both ways (18 pairs,
Buzz first).

**`buzz` / `buzz-dark` are not Shiki themes.** They alias GitHub Light / GitHub
Dark for every base colour (`resolveShikiThemeName` must be used before handing a
name to Shiki, or code blocks silently fall back to plain text). Their one
distinguishing feature is the **gradient**.

**The gradient ("grainient" is a different thing — see 4.6).**
`BuzzThemeSurfaces.GradientLayer` renders `absolute inset-0 -z-10` with **two
sibling layers**, light and dark, both permanently painted, and only their
`opacity` toggled by the `.dark` class:

```
--buzz-gradient-light-top:    #e6e6b6   (pale chartreuse)
--buzz-gradient-light-bottom: #c4d0da   (cool grey-blue)
--buzz-gradient-dark-top:     #4a4616   (olive)
--buzz-gradient-dark-bottom:  #0a1423   (near-black navy)
```

Each layer is `linear-gradient(to bottom, top, bottom)` with
`background-size: 100vw 100vh; background-repeat: no-repeat`.

Why it is built this way (all three reasons are load-bearing):
1. **One gradient for the whole app surface.** The rail, top chrome, sidebar,
   inset margin, and Settings all render *transparent* and reveal the same
   continuous ramp — so there is exactly one ramp and no seams between panes.
2. **Not `background-attachment: fixed`.** WKWebView retains a stale raster for
   fixed backgrounds when the app changes appearance without a reload.
3. **Both layers stay painted; only opacity flips.** Replacing
   `background-image` on a translucent surface also causes WKWebView to keep the
   old raster.

`ThemeProvider` marks the root with `data-buzz-sidebar` (and `data-buzz-theme=
buzz|buzz-dark`). The theme also declares per-row-type foreground hooks that
default to `inherit` — `--buzz-channel-fg`, `--buzz-dm-fg`, `--buzz-nav-fg` —
scoped to `[data-testid=stream-list]`, `[data-testid=dm-list]`, and
`[data-testid=sidebar-primary-menu]` so each row family *can* carry its own text
colour without disturbing the default.

### 4.5 Buzz-theme overrides (unlayered CSS, deliberately)

`globals/theme.css` places these rules **outside `@layer`**, because Tailwind's
`bg-sidebar` lives in the `utilities` layer and unlayered declarations beat
layered ones without `!important`.

| Token | Light | Dark |
| --- | --- | --- |
| `--buzz-muted-foreground` | `rgb(0 0 0/40%)` | `rgb(255 255 255/40%)` |
| `--buzz-search-surface` | `rgb(0 0 0/4%)` | `rgb(255 255 255/4%)` |
| `--buzz-chrome-foreground` | `rgb(0 0 0/50%)` | `rgb(255 255 255/50%)` |
| `--buzz-hover-surface` | `rgb(0 0 0/4%)` | `rgb(255 255 255/4%)` |
| `--buzz-active-surface` | `rgb(0 0 0/7%)` | `color-mix(hsl(0 0% 100%) 16%, transparent)` |
| `--buzz-active-foreground` | `var(--foreground)` | `0 0% 100%` |

Applied to: the active nav pill (flat tint, **`box-shadow:none`** — the selection
sits flat on the gradient), hover on non-active menu buttons and sub-buttons,
sibling-hover from row actions, the search box (plus its label/kbd/glyph at the
40% muted tone), the profile card hover, section labels and
`[data-buzz-sidebar-secondary]` footer text, the top-chrome trigger/back/forward
glyphs, and section `+`/`⋮` action hover.

Two scoping rules worth copying verbatim:
- The active-pill override is scoped to `[data-testid=app-sidebar]` /
  `[data-testid=settings-sidebar]`, **not `:root`** — `--sidebar-active` is also
  consumed by avatar edit buttons and persona rows, and a root override turned
  those white-on-white in dark mode.
- Floating chips that are `bg-sidebar` but are *not* canvas surfaces opt out with
  `[data-buzz-flat]` (the DnD overlay pills) — otherwise they'd become
  transparent over the full-app gradient.

**Translucency (macOS only).** For Buzz themes the provider additionally sets
`data-buzz-translucent`, which makes root/body transparent so the native
`NSVisualEffectView` (material `"sidebar"`) shows through; the gradient layers
switch to `color-mix(..., 70%)` colour + a 2.4% white/`#12161d` frost wash.
The sequencing in `ThemeProvider.tsx` is the subtle part: translucency is only
enabled once **both** the native vibrancy layer has been installed (awaited IPC
`set_window_vibrancy`) **and** the `data-buzz-sidebar` marker is present, via
`maybeEnableBuzzTranslucent(theme, requestToken)` called from both effects — a
monotonic `buzzVibrancyRequest` token drops stale continuations. Turning
translucency *off* is always safe and happens synchronously. If the IPC fails,
translucency stays off (you must never have a transparent webview with nothing
behind it).

### 4.6 The "grainient" (a separate thing — first-run/loading background)

`src/app/ThemeGrainientBackground.tsx` renders two divs inside
`.buzz-setup-grainient` (`absolute inset-0 overflow-hidden pointer-events-none`):

- **`__wash`** — `background-color: hsl(var(--background))` plus **four radial
  gradients**, one per colour, each with its own animatable position and stops:
  colours are `hsl(var(--chart-5)/α)`, `hsl(var(--chart-3)/α)`,
  `hsl(var(--primary)/α)`, `hsl(var(--chart-2)/α)`; α is
  `0.46 / 0.34 / 0.24` light, `0.68 / 0.50 / 0.34` dark. `filter: saturate(1.08)`,
  `contain: paint`, `transform: translateZ(0)`.
- The blob positions are **registered custom properties**
  (`@property --buzz-grainient-x-0 { syntax:"<percentage>" }` etc.) which is what
  makes them *interpolable*: the `buzz-grainient-orbit` keyframe animates all
  eight coordinates over **10s linear infinite alternate**, so the blobs drift
  around each other. Without `@property` these would snap, not tween.
- **`__veil`** — a vignette: `radial-gradient(ellipse 74% 54% at 50% 52%,
  transparent, background/0.04 72%, background/0.16)` plus a top-to-bottom
  `background/0.04 → /0.12` wash, which pulls the centre forward and settles the
  edges.
- `prefers-reduced-motion` kills the orbit animation but keeps the composition.

It is used by `AppLoadingGate` (cold boot) with a single `FlappingBee` centred
above it. There is no grain texture despite the name — the "grain" reads from the
overlapping low-alpha radials.

### 4.7 Density

There is no user-facing density setting. Density is expressed structurally:
sidebar rows `h-8`, sub-rows `h-7`, section labels `h-8`, buttons `h-9` (sm `h-8`,
xs `h-6`, icon `h-8 w-8`, icon-xs `h-6 w-6`), inputs `h-9`, settings rows
`min-h-16`, auxiliary headers `h-13`, top chrome `40px`, huddle `5rem`. The only
"density" prop in the codebase is `AuxiliaryPanelHeader`'s
`comfortable | compact`.

### 4.8 House lint rules (`desktop/scripts/*`)

These three guards encode conventions worth adopting wholesale.

**`check-px-text.mjs`** (core: `scripts/check-px-text-core.mjs`) — scans all of
`src` (`.ts`, `.tsx`, `.css`) and **fails the build** on:
- any arbitrary Tailwind text size: `text-[15px]`, `text-[0.9rem]`, `text-[1em]`
  (regex `\btext-\[\d+(\.\d+)?(px|rem|em)\]`) — note it rejects arbitrary **rem**
  too, not just px, because arbitrary rems re-fragment the scale that `2xs`/`3xs`
  were introduced to consolidate;
- CSS `font-size: Npx` (with a negative lookbehind so `--font-size:` custom
  properties from third-party widgets don't trip it).
Rationale: ⌘+/− zoom scales the root font-size, so **only rem text scales**; a px
literal freezes against zoom. That regression shipped once in the message
timeline. Exceptions are an explicit allowlist of `path:literal` pairs — currently
four `text-[4rem]`/`text-[6rem]` avatar-emoji glyphs, which are display glyphs
sized to their avatar box rather than readable text. Colour literals like
`text-[#fff]` don't match (no unit-bearing number).

**`check-file-sizes.mjs`** — hard **1000-line cap** per file across
`src-tauri/src` (`.rs`), `src/app`, `src/features`, `src/shared/{api,context,lib,ui}`
(`.ts`/`.tsx`) and `src/shared/styles` (`.css`). You can see the effect on the
code: `AppShell.tsx` is 999 lines, `AppSidebar.tsx` carries
`// biome-ignore format: keep compact to stay within file size limit`, and
features are split into `X.tsx` / `X.helpers.ts` / `X.types.ts` triples rather
than growing.

**`check-pubkey-truncation.mjs`** — flags any `*pubkey*.slice(…)` /
`.substring(…)` (and bare `pubkey`/`npub`) outside `shared/lib/pubkey.ts` and the
E2E bridge. Rationale: **a truncated pubkey prefix is forgeable by vanity
grinding**, so every display truncation must go through the one canonical
`truncatePubkey` (or `<PubKey>`), which also offers full-key reveal. Five
different truncation formats had grown before the guard. Exceptions are
`path:lineNumber` pairs for non-identity uses (array windows, hue derivation).

---

## 5. Shared UI primitives (`src/shared/ui`)

### 5.1 shadcn-derived, with Buzz deltas

| Component | Variants / API | Buzz-specific notes |
| --- | --- | --- |
| `button.tsx` `Button`, `buttonVariants` | variant: `default`(bg-primary + shadow) · `destructive` · `outline`(`border-input/40 bg-background hover:bg-muted/70`) · `secondary` · `ghost` · `link`. size: `default h-9 px-4` · `sm h-8 px-3 text-xs` · `xs h-6 px-2 text-xs` · `lg h-10 px-8` · `icon h-8 w-8` · `icon-xs h-6 w-6 [&_svg]:size-3.5`. `asChild`. | Base radius is `rounded-lg`; icons forced to `size-4`; gap `1.5`. |
| `badge.tsx` `Badge` | `default·secondary·outline·destructive·warning·success·info` | Always uppercase, `text-2xs font-semibold tracking-[0.18em]`, asymmetric padding `pb-[3px] pt-[5px]` to optically centre uppercase. |
| `alert.tsx` `Alert/Title/Description` | `default`(bg-muted/40) · `destructive`(bg-destructive/10) | No border, `rounded-2xl`, `text-xs`. |
| `card.tsx` `Card` + Header/Title/Description/Content/Footer | variant `default`(`rounded-xl border-border/70 bg-card/80 shadow-xs`) · **`textured`** | The textured variant is a **nine-slice powder texture PNG** (`assets/card-texture*.png`, light/dark × regular/compact) that bakes the card surface into the image: solid white centre feathering into speckle with a 96px transparent bleed. Contract: never layer an opaque bg on top; default padding is `--buzz-card-textured-safe-inset`; the layout must leave room for the bleed (an `overflow:hidden` ancestor clips it). Helper `texturedSurfaceClasses({size,tone})`. |
| `dialog.tsx` | `DialogContent` takes `surface: "default" | "none" | "textured"` and `showCloseButton` | `default` = `rounded-2xl bg-background p-6 shadow-2xl`; `textured` shifts the gutter to account for the powder bleed and moves the close button into the solid centre. Title `text-xl font-semibold tracking-tight`. |
| `sheet.tsx` | side `top·bottom·left·right` (right default) | Overlay picks `bg-black/80` (dark) vs `bg-black/10` (light) from `useTheme()`, plus `backdrop-blur-[5px]`. Enter 500ms / exit 300ms slide. |
| `alert-dialog.tsx`, `popover.tsx`, `dropdown-menu.tsx`, `context-menu.tsx`, `tabs.tsx`, `tooltip.tsx`, `avatar.tsx`, `separator.tsx`, `switch.tsx`, `checkbox.tsx`, `toggle.tsx`, `carousel.tsx`, `sonner.tsx` | standard shadcn surface | `Switch` is `h-5 w-9` with a 16px thumb and **no shadow**. `Checkbox` is `h-4 w-4 rounded-xs` and draws its tick with a **`motion.path` pathLength animation** (180ms, `[.23,1,.32,1]`), skipped under reduced motion. `Toggle` adds an `xs` size (`h-5 rounded-md px-1.5 [&_svg]:size-3.5`) and a `ghost` variant. `TooltipProvider` is mounted with `delayDuration={0}` inside `SidebarProvider`. |
| `input.tsx` / `textarea.tsx` | — | `h-9 rounded-lg border-input/40`, `text-base` on mobile → `md:text-sm` (stops iOS zoom-on-focus), and **`autoCapitalize="none" autoCorrect="off" spellCheck={false}` by default**. |
| `progress.tsx` `Progress` | `value?: number \| null` | No Radix. `null` ⇒ indeterminate `w-1/3` sweep keyframe; otherwise a full-width bar translated by `-(100−v)%`. |
| `skeleton.tsx` `Skeleton`, `SkeletonReveal` | `pulsing`, and Reveal takes `{loading, skeleton, layout:"absolute"|"flow"}` | `SkeletonReveal` cross-fades skeleton→content and force-reflows (`getBoundingClientRect()`) when re-entering loading so the transition restarts instead of being coalesced. |
| `spinner.tsx` `Spinner` | `size` (number/string) | `.sprout-arc-spinner`, `border-4 border-current/10 border-t-current`, `role="status"` unless `aria-hidden`. |
| `sidebar.tsx` | the whole shadcn sidebar family + `useSidebar`/`useOptionalSidebar` | See §1.2/§2. Additions over stock: width persistence, the magnetic resize rail with haptics, `isResizing` in context, `disableRail`, and `useOptionalSidebar` (returns `null` instead of throwing — needed by the top chrome, which renders outside a provider during Settings). |

### 5.2 Buzz-original primitives

| Component | Purpose / API |
| --- | --- |
| `PubKey.tsx` `PubKey` | The **only** sanctioned pubkey display. `variant="compact"` (default) renders `truncatePubkey` (`abcdefgh…wxyz`, 8+4, untouched if ≤12 chars) as a monospace button; hover for 500ms (close delay 200ms) or click opens a popover with the full **npub** and hex plus per-row copy buttons. `variant="full"` renders the whole npub inline with a copy popover — **required on any security decision surface** (invite/approve, removal, trust/pairing, new DM, key import) because a truncated key is forgeable. |
| `UserAvatar.tsx` | sizes `xs h-5 text-3xs` · `sm h-6 text-2xs` · `md h-9 text-xs`; `accent` swaps the fallback to `bg-primary`. **Animated avatars** (parsed from the URL) show a poster frame and swap to the animation on hover, and drop their container fill/shadow so the pop-out isn't flattened. |
| `AnimatedCount.tsx` + `animatedCountParts.ts` | Odometer digits. Splits a formatted number into slots; changed digit slots roll up or down by direction; non-digit slots (separators) fade in the same direction; settles after 260ms. |
| `UnreadPill.tsx` | `{direction, label, onClick, testId}` — the floating "N new messages" pill (see §2.7). Exports `unreadCountLabel(n)`. |
| `Shimmer.tsx` | Wraps a string in `.buzz-shimmer` and sets `--buzz-shimmer-spread: len*2px` so the sweep width tracks the text length. |
| `PageHeader.tsx` | The three-level heading ramp used everywhere: `PageHeader` (h1, `text-2xl font-semibold tracking-tight` + `text-base` muted description, optional `action` right-aligned), `SectionHeader` (h2, `text-lg`), `SubsectionLabel` (`text-2xs font-semibold uppercase tracking-wide text-muted-foreground`). |
| `ViewLoadingFallback.tsx` | Content-shaped skeletons per view kind: `agents·channel·forum·projects·pulse·workflows`, optionally including the header row. |
| `VirtualizedList.tsx` | Thin generic over `@tanstack/react-virtual`; exports `ListVirtualizer`. |
| `TopChromeBackdrop.tsx` | The blurred strip pinned inside a scroller so content scrolls *under* the global chrome. `bg-background/75 backdrop-blur-md` (dark `/45 + blur-xl`), z-40 (below the z-45 chrome controls), height from `--buzz-top-chrome-height`, with an `after:` 1px `border/35` divider positioned at the chrome's bottom edge. |
| `OverlayPanelBackdrop.tsx` | Exports `PANEL_BASE_CLASS`, `PANEL_OVERLAY_CLASS`, `PANEL_ENTER_MOTION_CLASS` (`buzz-side-panel-enter`: 260ms `cubic-bezier(.32,.72,0,1)`, `transform-origin: right center`) and the click-catcher backdrop. |
| `StartupWindowDragRegion.tsx` | Standalone window-drag behaviour for pre-app screens (§1.4). |
| `PoofBurstProvider.tsx` | Dismiss animation: `POOF_TRIGGER_CLASS`/`POOF_ORIGIN_CLASS`/`POOF_POINTER_ORIGIN_CLASS`, `POOF_DURATION_MS = 430`. Dismiss buttons wait the full duration before calling `onDismiss`, so the puff plays before the element unmounts. Assets `public/pow/poof1..5@3x.png`. |
| `EmojiBurstProvider.tsx` | Reaction particle bursts; `POSITIVE_EMOJI_PARTICLES`, `useEmojiBurst()`, `isPositiveEmojiParticle()`. |
| `SpoilerParticles.tsx` | Canvas particle dissolve for spoiler reveal (`mountSpoilerParticleCanvas`). |
| `sidebar-action-card.tsx` `SidebarCompactActionCard` | The footer notification card (relay reconnect, update available). Tone `neutral|success`, surface `background|secondary`; title/description/icon all cross-fade via `AnimatePresence mode="wait"` when they change, and the description uses a two-line reel that scrolls the old value out. Dismiss `X` is a floating `-right-1 -top-2` disc revealed on card hover, with the poof. |
| `sidebar-menu-label.tsx` | Width-stable label (§2.4). |
| `step-progress.tsx` `StepProgress` | Segmented progress: active segment `w-6 bg-primary`, complete `w-1.5 bg-primary/35`, upcoming `w-1.5 bg-muted-foreground/25`, all `h-1.5 rounded-full`. |
| `smoothCorners.ts` | Figma-style **squircle** corner smoothing (`SMOOTH_CORNER_SMOOTHING = 0.6`) implemented as a computed `clip-path: path(...)`; reads the element's computed border radii per corner, distributes the rounding+smoothing budget between adjacent corners, and degrades to plain radii when `clip-path: path()` is unsupported. |
| `markdown.tsx` + `markdown/*` | The message renderer: `CodeBlock` (Shiki), `MarkdownTable`, `ProgressiveImage`, `MarkdownVideoPlayer`, `FileCard`, `AgentSnapshotCard`, `MessageLinkPill`, `MaskedLinkTooltip`, `SpoilerInline`, `InlineEmojiPopover`, `MediaContextMenu`, `MarkdownInput`, plus `nodeCache` and `imageLightbox`. |
| `VideoPlayer.tsx` + `videoPlayerState.ts` / `videoAspectRatio.ts` / `videoDownload.ts` / `useVideoContextMenu.tsx` | Full player with the timestamped **review comments** rail (see screenshot 4). |
| `attachment.tsx`, `link-preview-attachment.tsx`, `config-nudge-attachment.tsx` | Composer/message attachment cards. |
| `chooser-dialog-content.tsx`, `identity-card-skeleton.tsx`, `import-status-icon.tsx`, `styled-qr-code.tsx` | Dialog scaffold, identity skeleton, `pending·importing·done·error` glyph, and the branded QR used for mobile pairing. |
| `icons.ts` | Two custom lucide icons built with `createLucideIcon`: **`HashSearch`** (a `#` with a magnifier — used for "Browse channels") and **`ListSortDescending`**. |
| `buzz-logo/` | `BuzzMark` (static SVG — paints on the first frame before scripting, which is why it backs every loader), `FuzzyLogo` (animated, `fuzz`/`loop`/`loopRestSeconds` props), `FlappingBee` (HTML-level `<svg>` wings with a continuous beat keyframe), `BuzzLogoAnimation` + its CSS. |
| `deferredModalOpen.ts` | `useDeferredModalOpen()` → `{openNextFrame, cancelDeferredModalOpen}`; `MODAL_EXIT_ANIMATION_MS = 150`. |
| `mentionChip.ts` | `MENTION_CHIP_BASE_CLASSES`, `…_HOVER_CLASSES`, `…_PREFIX_CLASS`, `MESSAGE_MARKDOWN_CLASS`, `INLINE_CODE_CHIP_CLASS`. |
| `modalSearchStyles.ts` | `MODAL_SEARCH_SHELL_CLASS` (a `rounded-xl border-input bg-muted/40 px-3 py-2.5` click-to-focus shell whose border brightens on hover and focus-within) and `MODAL_SEARCH_INPUT_CLASS` (a borderless input whose text goes `muted/55 → muted → foreground` across rest/hover/focus). Used by the search dialog and the channel browser. |

---

## 6. Onboarding

Onboarding is **three separate flows**, chosen by `App.tsx` from
`useMachineOnboardingState` / `useAppOnboardingState` / `useCommunityOnboarding`,
all rendered before the router mounts.

### 6.1 Shared onboarding chrome

`ui/OnboardingChrome.tsx`:
- `TOTAL_ONBOARDING_PAGES = 7` — landing, identity/key, harness setup, default
  config, community choice, community profile, meet the team. (Password backup is
  an optional *subview*, not a position.)
- Chrome = a `fixed inset-x-0 top-12 z-10 pointer-events-none` row with the
  `BuzzMark` at `w-11` top-left and a centred dot track: active is
  `h-1.5 w-7 rounded-full bg-foreground`, inactive `h-1.5 w-1.5 bg-foreground/30`.
- CTA shapes (all `h-[2.375rem] rounded-full px-6`):
  `ONBOARDING_PRIMARY_CTA_CLASS` (label `--buzz-onboarding-cta-label`, light blue
  on a dark pill), `ONBOARDING_LANDING_CTA_CLASS` (label
  `--buzz-welcome-chartreuse`, used **only** on the landing screen),
  `ONBOARDING_SECURITY_PRIMARY_CTA_CLASS` (white pill, black label, dark
  surfaces only), `ONBOARDING_SECONDARY_CTA_CLASS`
  (`h-9 rounded-full bg-foreground/10 px-6`), and two icon-control classes that
  deliberately have **no hover pill** (a hover box reads as a floating rectangle
  on the powder texture).
- Slide motion: `OnboardingSlideTransition` with effects `fade`,
  `mask-reveal-up`, `mask-reveal-down`, `line-slide`, direction
  `forward|backward`.
- `OnboardingFooterProvider` / `OnboardingFooter` docks the CTA row; the shell's
  bottom gradient stop doubles as the scrim colour so content scrolling under the
  CTA fades out.

### 6.2 Onboarding palette (`globals/components.css`)

`.buzz-onboarding-neutral-theme` overrides the shadcn tokens to a pure neutral
scale (`--background 0 0% 100%`, `--foreground 0 0% 9%`, `--muted-foreground
0 0% 45.1%`, …) and adds:

```
--buzz-welcome-chartreuse:      #d7d72e   (landing background + landing CTA label)
--buzz-onboarding-shell-bottom: #d7e7f6   (gradient bottom + docked-footer scrim)
--buzz-onboarding-cta-label:    #d7e6f0
--buzz-onboarding-backup-ink:   #717106   (olive: the nsec text + its caption)
```

Backgrounds:
- Steps: a **dot grid over a vertical gradient** —
  `radial-gradient(circle, rgb(0 0 0/.08) 1px, transparent 1px)` on a 24px
  lattice, layered *first* (on top), over `linear-gradient(chartreuse →
  #d7e7f6)`.
- Landing (`.buzz-onboarding-welcome`): flat chartreuse + the same dot grid, and
  `--buzz-onboarding-shell-bottom` is redefined to chartreuse so the footer scrim
  stays invisible.
- **Security subview** (`.buzz-onboarding-security-theme`): the flow deliberately
  leaves the bright world for a dark one — `color-scheme: dark`, near-black
  `#010103` base, a blue dot grid (`rgb(143 211 255/.11)`), an elliptical blue
  glow at 50%/58%, and a `#010103 → #040914 → #082b49` vertical ramp.
- The theme reacts to the OS scheme via `[data-system-color-scheme]` for the
  *portaled* pieces (dialogs, emoji picker) while the shell itself stays light.
- `.buzz-onboarding-step-frame` fixes the content box to
  `min(1000px, 100dvh − 106px − 7rem)` so every step's CTA lands in the same place.

### 6.3 Machine onboarding (first launch on this computer)

`ui/MachineOnboardingFlow.tsx`, pages `identity → key-import | backup → setup →
config`.

1. **`identity` (landing)** — flat chartreuse, `LandingBees` decoration, the
   wordmark image at `max-w-[600px]`, tagline *"Your people, your agents, your
   projects — all in one place."* (`text-2xl leading-none`), then
   **"Create a new identity key"** (landing CTA) and **"Use an existing key"**
   (secondary). `IdentityKeyHelpDialog` sits below.
2. **`key-import`** — spotlight variant of `NostrKeyImportForm`. Title switches
   between *"Enter your private key"*, *"Re-import your key"* (identity lost) and
   *"Unlock your account"* (`keyImportStage === "backup-password"`); the heading
   block re-animates on stage change. Supports pasting an `nsec` **or** an
   encrypted backup file + password.
3. **`backup`** — `BackupStep`. Sells the creation moment: an **artificial 1400ms
   hold** (`INTRO_HOLD_MS`, module-level `introPlayed` so it plays once per app
   session and remounts skip it) showing `FuzzyLogo` under "Creating your identity
   key", then a 700ms fade to *"Your unique identity key has been created"*.
   The key sits on a **textured `Card`** in `text-nsec-key` monospace olive ink,
   **blurred (`blur-[4px]`) and `select-none` by default**; the fixed-length mask
   is 63 bullets joined with U+200B (WebKit won't line-break a run of `•`). The
   raw nsec enters the DOM only after an explicit eye-toggle or copy. Storage copy
   adapts to `system-keyring` / `local-file` / unknown. An `Info` caption warns
   *"Never share your private key."* A "review backup options" link opens the
   options subview (three panels: keychain explainer, **Copy to clipboard** for a
   password manager, **Create locked backup**) — and choosing the password path
   swaps the whole shell to the dark security theme with a floating
   "↑ Return to onboarding" pill. **Neither backup method ever blocks Next**
   (`backupNextDisabled()` returns `false`, permanently).
4. **`setup`** — *"Set up your agent harnesses"*. A responsive grid (1/2/4 cols)
   of `RuntimeCard`s that probe the machine for CLI harnesses, offer install, show
   per-runtime instructions, and report readiness. If installation fails for all
   of them the flow **does not soft-lock** — it completes and points at
   Settings → Agents.
5. **`config`** — *"Configure your default model settings"*: provider/model/effort
   defaults in a `max-w-[328px]` column, then **Finish**.

### 6.4 Community onboarding (joining/creating a community)

`communityOnboarding.tsx` defines a persisted transaction
(`localStorage["buzz-community-onboarding-transaction.v1"]`) with
`source ∈ {first-community, add-community, membership-recovery, deep-link-connect,
deep-link-join}` and `stage ∈ {claiming, connecting, profile, team-intro,
finalizing, entering}`, plus `firstCommunityPage ∈ {join, member, owned}`.

Screens (`ui/CommunityOnboardingFlow.tsx`):
- `claiming` / `connecting` — `Users` glyph, *"Joining <community>"*, subtitle
  *"Accepting your invite…"* / *"Connecting securely…"*, with Retry on error and
  Cancel.
- `profile` — *"Build your profile"* / "Add a name and avatar. They'll show up on
  your messages, reactions, and agent handoffs." A large avatar circle (opens the
  avatar editor, which **blurs and dims the page behind it** —
  `opacity-45 blur-[3px]`) and a "Your username" field, `max-w-[500px]`.
- `team-intro` — *"Meet your starter team"* (`max-w-[760px]`); the starter agents
  (`public/onboarding/starter-team/{honey,bumble,fizz}.png`) arrive from below in a
  **120ms-staggered** entrance (`.motion-kickoff-character-enter`, index via
  `--stagger-index`) and the stage fades out (`.motion-kickoff-stage-exit`) when
  the first real agent message lands.
- `entering` — backend setup is done and the app is already mounting on the
  Welcome channel *underneath*; this screen stays up as an **opaque curtain**
  until Welcome reports settled (or a safety timeout), then fades. No flash of a
  half-built room.

Supporting screens: `PendingInviteGate`, `MembershipDenied` (with change-community
and import-key escapes), `JoinPolicyNotice`, `InviteRedeemForm`,
`KeyringLockedScreen`, `RelaunchRequiredScreen`, `ResetFailedScreen`,
`RecoveryScreen`.

### 6.5 Relay-scoped profile onboarding

`ui/OnboardingFlow.tsx` — two steps (`profile`, `avatar`), plus `key-import` and
`membership-denied` as alternates.

- **`profile`**: *"What should we call you?"* — the name field is a **borderless
  48–60px centre-aligned input** (`text-4xl sm:text-5xl font-semibold`) with a
  fake blinking caret + ghost placeholder "Enter your name" rendered behind it;
  the real input goes `text-transparent caret-transparent` while empty so the two
  never double up. Enter submits.
- **`avatar`**: *"Next, add a display image"* — a two-column grid
  (`minmax(300px,420px) minmax(0,500px)`, 1080px max) with a 192px live preview
  on the left and the editor (upload / emoji / animated capture / custom colour)
  on the right; the whole grid uses `layout="position"` so mode switches slide
  rather than jump.
- Membership is checked **before** saving the profile (`checkMembershipStatus()`),
  so a gated relay produces a proper "denied" screen rather than a 403 mid-save.
  Failure modes are distinguished: `denied` · `unreachable` (offer "Change
  community") · `error` ("Server error — try again").
- Recovery affordances on every error: *Skip for now* (nothing saved yet) or
  *Continue without saving* (a saved name already exists).

---

## 7. Settings

Route `/settings?section=<id>`; rendered by `AppShell` in place of the sidebar +
main, lazily (`React.lazy`). Escape or ⌘, closes.

### 7.1 Layout

`features/settings/ui/SettingsView.tsx`:
- Its **own** `Sidebar` (`data-testid="settings-sidebar"`) that starts with an
  aria-hidden 40px `data-tauri-drag-region` spacer (Settings hides the global top
  chrome, so it re-creates the drag strip), then a "← Back to app" row, then the
  grouped nav, then a footer showing `v<appVersion>` at
  `text-xs text-sidebar-foreground/45` (marked `data-buzz-sidebar-secondary`).
- The sidebar is force-opened on desktop while Settings is mounted.
- Content: another `SidebarInset` with the same 40px drag spacer and the same
  floating white card (`rounded-2xl bg-background shadow-content-edge`,
  `mb-2 ml-px mr-2 mt-px`). Inside: `overflow-y-auto px-5 sm:px-6 pt-6 pb-12`
  and a `mx-auto max-w-4xl` column.
- The whole inset fades in on mount (`opacity-0 → opacity-100`, 200ms,
  motion-safe only).

### 7.2 Nav groups and sections

`settingsNavGroups` (labels are group headers in the settings sidebar):

- **Personal** — Profile · Appearance · Notifications · Voice · Shortcuts ·
  Custom emoji · Local archive
- **Communities** — Hosted communities · Templates · Invites
- **App** — Agents · Compute · Experiments · Mobile · Updates

`settingsSections` (the descriptor list, with icons and feature gates):

| id | Label | Icon | Gate |
| --- | --- | --- | --- |
| `appearance` | Appearance | `MonitorCog` | — |
| `profile` | Profile | `UserRound` | — |
| `notifications` | Notifications | `BellRing` | — |
| `voice` | Voice | `Volume2` | — |
| `experimental` | Experiments | `FlaskConical` | — |
| `agents` | Agents | `Bot` | `managed-agents` |
| `channel-templates` | Templates | `LayoutTemplate` | `channel-templates` |
| `compute` | Compute | `Cpu` | — |
| `shortcuts` | Shortcuts | `Keyboard` | — |
| `hosted-communities` | Hosted communities | `MessagesSquare` | — |
| `community-members` | Invites | `Ticket` | owner/admin only (runtime) |
| `moderation` | Moderation | `ShieldAlert` | — |
| `custom-emoji` | Custom emoji | `Smile` | `custom-emoji` |
| `local-archive` | Local archive | `Archive` | — |
| `mobile` | Mobile | `Smartphone` | — |
| `updates` | Updates | `Download` | — |

Gate semantics (`SettingsView.tsx`): the manifest is **preview-only**, so a gate
id present in `preview-features.json` requires opt-in, and an id *absent* from it
renders unconditionally (fail-open). If the current section becomes invisible the
view redirects to the first visible one. `DEFAULT_SETTINGS_SECTION = "profile"`.

### 7.3 Row vocabulary

`SettingsOptionGroup` = `overflow-hidden rounded-2xl bg-muted/20` (a grouped
iOS-style card, no borders/dividers). `SettingsOptionRow` = `flex min-h-16
items-center justify-between gap-4 px-4 py-3 text-sm` — label + muted
description on the left, control on the right. `SettingsSectionHeader` is
`PageHeader` with a fixed `mb-12`.

### 7.4 Every setting, by section

**Appearance** (`SettingsPanels.tsx:ThemeSettingsCard`) — "Choose a theme for Buzz."
- **Mode selector**: three pill buttons **System / Light / Dark** (`SunMoon`/`Sun`/`Moon`),
  active = `border-primary bg-primary/10`. Picking System sets `followSystem` and,
  if the current theme is unpaired, falls back to the first paired theme (otherwise
  System could not switch anything). Picking Light/Dark clears `followSystem` and
  jumps to the counterpart theme, or the first theme of that mode if unpaired.
- **Theme grid**: `max-h-[430px]` internal scroller with top/bottom fade masks,
  168×112px preview tiles + a caption. In System mode each tile is a
  `SystemPreferencePreviewFrame` showing the **light and dark halves together**;
  in Light/Dark mode a single `ThemePreviewFrame`. Active tile:
  `ring-2 ring-primary ring-offset-2`. Buzz tiles additionally render their
  gradient stops (`BUZZ_GRADIENT_STOPS`).
- **Accent colour**: 10 swatches — Neutral · Blue `#3b82f6` · Cyan `#06b6d4` ·
  Green `#22c55e` · Orange `#f97316` · Red `#ef4444` · Pink `#ec4899` ·
  Lilac `#c0a2f1` · Purple `#a855f7` · Indigo `#6366f1`. 28px discs, hover
  `scale-110`, selected gets a ring and a check. **Hidden entirely while a Buzz
  theme is active** (Buzz pins the neutral accent); the reveal/hide is a −10px
  translate + fade at `0.16s [.23,1,.32,1]`, and the grid's bottom fade is
  suppressed while the picker is visible so it can't wash out the swatches.
- **Thread layout** (a `SettingsOptionRow` with a dropdown radio):
  **Focus** — "Threads open over the channel, full width"; **Split** — "Threads
  open in a side panel next to the channel".

**Profile** — "Update how your name, avatar, and bio appear across Buzz."
Display name, avatar editor (upload / emoji / animated capture / custom colour
backdrop), bio, the identity block with `<PubKey variant="full">`,
`PrivateKeyBackupRow` ("Private key" — reveal/copy/create locked backup), and
`SignOutSection`.

**Notifications** — "Desktop alerts are on by default. Fine-tune what gets through below."
- *Desktop alerts* (switch; label becomes "Requesting..." while the OS prompt is up).
- *Notify while viewing* — "Also alert for direct messages in the conversation you have open." (disabled unless desktop alerts are on).
- *Sound* — master switch for per-event alerts.
- Per-slot rows, each with a `SoundPicker` **and** a switch:
  Direct messages · @Mentions · Thread replies · Needs action ·
  Agent: job accepted · Agent: progress update · Agent: job result ·
  Agent: job error. The four agent slots render `aria-disabled`, at
  `opacity-40`, with a **"Coming soon"** chip (nothing emits those events yet),
  and are hidden behind a "View all / Show less" toggle.
- *Home badge* — "Show a Home badge for mentions and needs-action items in the sidebar."
- A destructive banner when permission is `denied`/`unsupported`.

**Voice** — "Choose whether Buzz reads new agent responses aloud during an active huddle." Includes the *Pocket TTS voice* picker.

**Experiments** — one bordered row per preview feature with a switch, from
`preview-features.json`: **Workflows** ("YAML-defined automations with approval
gates") · **Projects** ("Git repository browser and collaboration") · **Pulse**
("Activity feed with notes, social posts, and agent activity") · **Forum
Channels** ("Forum-style threaded channels for long-form discussions") ·
**Agent-managed profiles** ("Let agents manage their own relay name and avatar
instead of restoring the desktop copy" — also pushes the value to the Rust side).

**Agents** — three stacked cards: *Prevent sleep* ("Control how agents behave in
conversations and run on this machine"), *Harnesses* (catalog, install, custom
harness form), *Agent defaults* ("Provider, model, effort, and environment
settings inherited by local agents. Agent-specific settings always take
priority.").

**Templates** — channel templates: canvas, teams, runtimes.
**Compute** — mesh-compute settings.
**Shortcuts** — read-only table grouped by Navigation / Messages / Formatting /
Zoom, platform-aware key rendering.
**Hosted communities** — Builderlab sign-in (explicitly scoped: "Buzz works with
any relay… Builderlab sign-in is used on this page alone"), create/manage
Block-hosted communities.
**Invites** — member roster + invite minting; only visible to owner/admin, with
explicit loading ("Checking invite permissions…"), error ("Invite settings could
not be checked" + Try again) and missing-snapshot warning states in the settings
sidebar itself.
**Moderation** — "Review reported content and take action. Visible to community
moderators only."
**Custom emoji** · **Local archive** · **Mobile** (QR pairing card) ·
**Updates** (`UpdateChecker`).

---

## 8. Profile

### 8.1 Profile popover (from the sidebar card)

`features/profile/ui/ProfilePopover.tsx` — a `role="menu"` sheet containing:
avatar + display name header with the current presence dot; a **presence chip**
that expands to the full status list (`ALL_STATUSES`, each with its dot and
label); **"Update your status"** (opens `SetStatusDialog` for emoji + text);
a community switcher slot (`CommunitySwitcher variant="profile-menu"` with
add-community and invite actions); **Send feedback**; **Settings**.

### 8.2 Profile panel (people and agents)

`features/profile/ui/UserProfilePanel.tsx` composed through
`UserProfilePanelFrame` → `AuxiliaryPanel` (so it obeys the 380/300/720 widths,
the resize handle, and the docked/panel/single-panel modes).

- Tabs (`UserProfilePanelTabs.tsx`), built dynamically: **Info** always;
  **Runtime**, **Channels**, **Memories** for agents.
- `ProfileIngressRow` is the row vocabulary: `rounded-2xl bg-muted/20 px-4 py-2`
  with a 36px circular icon disc, a label, and truncated trailing value.
- Info shows `ProfileFieldRows` / `ProfileFieldGroup`; agent diagnostics split
  "Last error" out into a destructive `Badge`.
- Activity is a `Carousel` of recent items scoped by
  `profileActivityFeedScope`.
- Actions: DM, add to channel, edit agent, persona dialogs, snapshot export,
  archive/delete confirmations.

### 8.3 Avatars

- `ProfileAvatar` (`features/profile/ui/ProfileAvatar.tsx`) is the identity
  avatar: falls back **image → locally cached data URL → initials → `UserRound`**,
  tracking failures *per resolved URL* so a poster and its hover animation
  recover independently (the relay proxy 404s when the relay is down; without the
  data-URL fallback every avatar would collapse to initials during an outage).
  Pending uploads render at `brightness-75` under a spinner disc.
- `MaskedAvatarBadgeFrame` punches an SVG-mask hole in the avatar so a presence
  dot or badge sits *in* the silhouette rather than on top; `STATUS_DOT_MASK_CURVE`
  is the shared curve, `scaleProfileAvatarStatusGeometry` scales the geometry to
  any avatar size.
- Animated avatars (`parseAnimatedAvatarUrl`) show a poster frame and play on
  hover; they carry their own backdrop disc, so the container fill and shadow are
  dropped (`bg-transparent shadow-none`) or the pop-out flattens.
- `globals/avatar-framing.css` + the `.avatar-sdr-clamp` utility
  (`dynamic-range-limit: standard`) pin HDR gain-map avatars to the SDR envelope
  so they stop glowing brighter than the rest of the UI on capable displays.
- **jdenticon is used in exactly one place**: `BotIdenticon`
  (`features/messages/ui/BotIdenticon.tsx`) renders `toSvg(value, size)` for
  numbered bot copies (`Scout::01` vs `Scout::02`), memoised, `aria-hidden`,
  default 20px. It is not the general avatar fallback — `getInitials()` is.

### 8.4 Display names and pubkey truncation

- Resolution order for a display name (`AppSidebar.tsx`):
  `profile.displayName` → identity `displayName` → `"Current identity"`.
  Onboarding additionally treats a name starting `npub1`/`nostr:npub1` as a
  **fallback, not a real name** (`isFallbackDisplayName`) and blanks it so the
  user is actually asked.
- `shared/lib/pubkey.ts`: `normalizePubkey` (trim + lowercase — hex is
  case-insensitive but callers compare with `===`) and `truncatePubkey`
  (`slice(0,8) + "…" + slice(-4)`, pass-through if ≤12 chars).
- The rule, enforced by `check-pubkey-truncation.mjs`: **never hand-roll a
  truncation**; use `truncatePubkey` or `<PubKey>`; and any surface where the
  user makes a trust decision must render `<PubKey variant="full">` (the whole
  npub), because short prefixes are cheap to vanity-grind.

---

## 9. Screenshots (`docs/assets/screenshots/`)

All four are macOS windows composited on the Sequoia blue-wave wallpaper, with a
soft drop shadow and ~12px window radius. Window width is roughly 1720px at 2×.

### 9.1 `channel-thread.png` — the canonical shell

- **Window chrome strip**: ~48px tall, painted the pale-chartreuse **top** of the
  Buzz light gradient (`#e6e6b6`-ish). Traffic lights at far left, then the
  sidebar-toggle glyph, then `‹` `›` at ~50% black. No title text.
- **Sidebar** (~300px): the gradient continues down it, easing from chartreuse at
  the top to a cool grey-blue by the profile card. Contents top-to-bottom:
  - Search pill: full-width, ~32px, a barely-there 4% black fill, magnifier +
    "Search everything" + `⌘K`, all at 40% black.
  - `Inbox`, `Agents` nav rows (this build has Pulse/Projects gated off), 32px
    rows, 16px lucide glyphs, ~14px labels.
  - Section **"The Hive"** — an emoji-prefixed custom section (🐝) whose label is
    tiny, 40% black, sentence case (**not** uppercase). Rows `# announcements`,
    `# general`, each with a small **solid dot** flush right marking unread.
  - Section **"Product"** (🛠) — `# design`, `# flight-path` (**active**),
    `# mobile`.
  - Section **"Launch Swarm"** (🚀) — `# marketing`, `🔒 queen-bee-launch`.
  - Section **"Channels"** — `🔒 Welcome`.
  - Section **"Direct messages"** — Jordan Brooks, Maya Chen, Priya Shah, each
    with a 24px circular avatar carrying a small presence dot at the lower-right,
    and a dark circular **`1`** unread pill flush right.
  - The active row `# flight-path` is a soft ~7% black rounded rectangle, bold
    label, **no shadow**, with a `0s` working-timer chip on the right.
  - Footer: 32px avatar with a green presence dot, "Alex Rivera" in semibold,
    and beneath it "🐝 Honeycomb Studios" at ~11px 40% black.
- **Main card**: pure white, `rounded-2xl`, inset ~2px from the top and left of
  the chrome and ~8px from the right/bottom, with a hairline on its top-left
  edges. Header row: `#` glyph in grey + **flight-path** in bold ~15px; on the
  right a `👥 9` member count, a headphones (huddle) glyph, and a sliders glyph —
  all ghost buttons.
- **Message list**: 36px circular avatars, name in semibold ~14px followed by a
  grey timestamp at ~11px, body at ~15px/1.5 in near-black. Rows are tight
  (~24px between authors) with no dividers. A **"NEW" divider** is a full-width
  hairline with the centred uppercase word in grey. Agent mentions render as
  inline grey chips with a small bot glyph (`🤖 Fizz`). Reaction pills are
  `h-5 rounded-full` grey with an emoji + count; a reply-count pill uses a speech
  bubble glyph.
- **Composer**: a full-width `rounded-xl` box with a hairline border, placeholder
  "Message #flight-path", a bottom toolbar of four ghost glyphs (@, paperclip,
  emoji, `AA`) and a circular dark **send** button at the far right.
- Below the composer, a status line: a small agent avatar + "Honey: Working".

### 9.2 `channel-agents.png` — hover state, reactions, link cards

Same shell (sidebar shows Inbox / Projects / Agents). Differences worth copying:
- A floating **"↑ 28 new messages"** pill centred at the top of the timeline:
  `h-7 rounded-full`, near-white `bg-background/95`, hairline border, tiny shadow,
  ~11px grey label with an up-arrow.
- The hovered message row is tinted a very light grey across the full width, and a
  **hover action bar** floats at its top-right: a white `rounded-lg` pill with a
  hairline and small shadow containing 👍 ❤️ 😂 🎉, an add-reaction glyph, a reply
  arrow and a `⋮`.
- A **reaction burst**: several large red hearts animating up and out from the
  reaction pill (`EmojiBurstProvider`).
- An existing reaction reads `❤️ 1` in a grey rounded pill with an adjacent
  add-reaction ghost button.
- **Link/PR cards** are compact: a `rounded-lg` light-grey block, ~56px tall, with
  a small white icon tile on the left (git-branch glyph), a grey eyebrow
  ("Buzz · PR" / "GitHub · PR") and a bold truncated title.
- Links inside message text are underlined in the body colour.

### 9.3 `create-channel.png` — the "Add a channel" dialog

- The app behind is **blurred (~5px) and dimmed**; the scrim is very light
  (`bg-black/10`), so the chartreuse chrome still reads through.
- Dialog: white, `rounded-2xl`, ~670px wide, generous `p-6` gutters, a strong soft
  shadow. Title **"Add a channel"** at ~20px semibold with an `×` ghost button at
  the top-right corner.
- **Search shell** below the title: a `rounded-xl` field with a light grey fill
  and a hairline border, magnifier at left, placeholder "Search or create a
  channel", and a sort glyph at the right.
- **Tabs**: "All channels · Joined · Archived" as text triggers on a bottom
  hairline, no pills; the active tab is near-black with a 2px underline that
  slides between triggers (180ms `[.23,1,.32,1]`).
- **"＋ Create a new channel"** is the first row: a light-grey `rounded-xl` block
  with a white circular `+` tile.
- Channel rows: `# name` in semibold ~15px on line one; "N members · <description>"
  in ~13px grey on line two; rows separated by hairlines and the list scrolls
  inside `h-[min(60vh,30rem)]`.

### 9.4 `media-comments.png` — the video lightbox with review comments

- A **full-window dark overlay** (near-black) with its own header bar: the file
  name `flight-path-motion-preview.mp4` at left, and two ghost glyph buttons at
  right (toggle comments panel, close).
- Left: the video, letterboxed on black with a subtle radial vignette. Player
  controls are a floating translucent grey bar: play, `00:04`, a scrub track with
  **two avatar markers pinned at comment timestamps**, `00:06`, `1x`, a volume
  glyph and a volume slider.
- Under the video, a floating **reaction dock**: a dark `rounded-full` bar with
  😂 😍 😮 🙌 👍 👎 and an add-reaction glyph.
- Right: a ~380px **Comments** rail on the same dark surface — header "💬 Comments"
  with a count chip. Each comment is a slightly lighter dark card: avatar + name +
  time, then a **monospace timestamp chip** (`00:00`, `00:04.2`) inline before the
  comment text, and a "Reply" action beneath.
- Footer of the rail: a `00:04` chip and a **"Comment at current frame"** checkbox,
  then a composer identical in structure to the channel composer (placeholder
  "Leave your comment…", @ / paperclip / emoji / `AA`, circular send).

---

## 10. Non-obvious rules worth preserving

1. **The Buzz gradient is painted once, on the whole app surface, and every child
   chrome canvas is transparent.** Not per-pane backgrounds; not
   `background-attachment: fixed` (WKWebView keeps a stale raster); and both the
   light and dark layers stay painted with only `opacity` toggled, for the same
   reason. Floating chips that legitimately need their own fill opt out with
   `data-buzz-flat`.

2. **Theme overrides are deliberately unlayered CSS.** `bg-sidebar` lives in
   Tailwind's `utilities` layer, and an unlayered declaration beats it without
   `!important`. And `@custom-variant hover (&:hover)` must stay *below every
   `@import`* in `globals.css` — CSS requires `@import` first, so moving it up
   silently drops the rest of the sheet. (That variant exists because WebView2 on
   some Windows hosts answers `@media (hover:hover)` false with a mouse attached,
   which left every hover-revealed control permanently hidden.)

3. **Fixed px is allowed in exactly two places, and both are documented as
   exceptions**: the top-chrome height/nav buttons and the macOS traffic-light
   clearance. The native lights do not scale with ⌘+/− rem zoom, so rem clearance
   shrinks under them. Everything else must be a rem token — enforced by
   `check-px-text.mjs`, which rejects arbitrary **rem** literals too.

4. **A community indicator is never drawn from an unobserved relay.**
   `communityRailIndicators` only trusts `state === "ready"`; `unknown`, `loading`
   and `error` render nothing. A fabricated badge is worse than no badge.

5. **Community switching routes through Home as a teardown barrier**, then
   `history.replace`s the remembered channel *before* the target community mounts.
   Without the barrier the outgoing channel's read effect advances markers on the
   wrong relay; without the pre-replace the user sees an Inbox frame flash.

6. **View transitions are used to freeze, not to animate.**
   `::view-transition-old/new(root) { animation: none }`. The transition exists so
   the outgoing snapshot survives until the new relay is ready; animating the two
   snapshots produced a flash.

7. **`canGoForward` is hand-derived** from a bounded `Map<index, key>` of history
   entries, because the router does not expose it. A key mismatch at an index
   means the forward stack was truncated.

8. **Settings section changes `replace` the history entry.** Sixteen sections must
   not become sixteen back-presses.

9. **Modals mount one frame before they open** (`useDeferredModalOpen`) or Radix
   skips the enter animation.

10. **`useOptionalSidebar` exists** so the top chrome can render outside a
    `SidebarProvider` (during Settings) instead of throwing; the trigger just
    disables itself.

11. **The sidebar resize has a magnetic detent at its default width** with a
    quadratic ease-out of the detent and a haptic tick on crossing — it is sticky
    without being blocking.

12. **`SidebarMenuLabel` reserves the bold width invisibly** so activating a row
    (which switches to `font-semibold`) never reflows the sidebar.

13. **The unread badge and the DM close button share one slot**, with the badge
    fading out on hover — they never stack.

14. **Escape yields.** `hasActiveEscapeSurface()` lets any open drawer/panel own
    Escape; only when nothing is open does Escape mean "mark read". Window
    listeners fire in registration order, so without the explicit yield the
    app-mounted listener would win.

15. **Global shortcuts respect `event.defaultPrevented`** so a focused composer can
    claim ⌘K for the link editor before the shell opens search.

16. **Translucency is only enabled after the native vibrancy layer is confirmed
    installed** — a transparent webview over nothing shows the desktop through.
    Turning it off is always safe and is done synchronously; turning it on is
    guarded by a monotonic request token so a stale IPC continuation can't
    re-enable it after a newer theme switch.

17. **Buzz themes pin the neutral accent** and the accent picker hides itself
    rather than showing a control that does nothing. The stored accent is left
    untouched so it returns when the user leaves Buzz.

18. **The active-pill token override is scoped to the two sidebars, not `:root`.**
    `--sidebar-active` is also consumed by avatar edit buttons and persona rows,
    and a root-level override turned those white-on-white in dark mode.

19. **The private key is blurred, unselectable, and absent from the DOM** until an
    explicit reveal or copy; the mask is a fixed 63 bullets joined with U+200B
    (WebKit will not line-break a run of `•`), so rendering the mask never fetches
    key material. Neither backup method blocks Next — `backupNextDisabled()`
    returns `false`, permanently.

20. **A truncated pubkey is a recognition aid, never proof.** One canonical
    `truncatePubkey`; `<PubKey variant="full">` on every trust-decision surface;
    the build fails if a `pubkey.slice(…)` sneaks in elsewhere.

21. **1000 lines per file, enforced.** It is why `AppShell.tsx` is 999 lines and
    why features split into `X.tsx` / `X.helpers.ts` / `X.types.ts`.

22. **The huddle drawer re-declares the full token set as a forced dark scheme**
    rather than styling each control, so every shadcn component dropped into it is
    correct by construction — and the app *lifts off* the drawer (animating
    `bottom` + corner radius + shadow) instead of the drawer sliding in.

23. **The grainient's blob positions are `@property`-registered percentages.**
    Without the registration they would snap between keyframes instead of tweening.

24. **`shadow-panel-left` runs both layers on −x.** Tailwind's stock shadows are
    all y-offset and cast nothing sideways; a left-only border cannot substitute
    because it tapers out at the rounded corners instead of turning them.

25. **The boot colour is applied by an inline script in `index.html`** that reads
    the same `buzz-theme-cache` entry `ThemeProvider` writes — and on a virgin
    profile seeds light/dark from the OS — so cold boot never flashes black on a
    light theme or the wrong scheme before React mounts.
