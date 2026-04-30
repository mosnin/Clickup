# Pace stylesheet

Living document. The system is **pill geometry, generous whitespace, monochrome surfaces, emerald + amber for action**. When in doubt, copy the closest existing pattern — don't invent.

## 1. Stack & libraries

- Framework: Next.js 15.1.0, App Router, `src/` directory, TypeScript everywhere.
- Styling: Tailwind CSS v4 (`tailwindcss: ^4.0.0`). Config is **CSS-based** in `src/app/globals.css` via `@theme {}` — there is no `tailwind.config.ts`. Custom CSS overrides live in the same file.
- Component library: hand-rolled. One shadcn-style primitive at `src/components/ui/button.tsx` using `class-variance-authority` + `tailwind-merge` via `cn()` from `@/lib/utils`. **No Radix UI. No `@shadcn/ui`.** All other components are bespoke.
- Icons: `lucide-react` ^0.468.0. Single-stroke at default stroke-width 2 — no weight axis. Three legal sizes: `h-3 w-3` (12px micro), `h-3.5 w-3.5` (14px chip), `h-4 w-4` (16px default). Anything bigger needs justification.
- Animation: **none installed.** No framer-motion, no GSAP. Tailwind transitions only.
- Font: **none imported yet.** `src/app/layout.tsx` doesn't load `next/font`. Body inherits the OS sans-serif. Listed in Cleanup queue.

## 2. Typography

Headings always carry `font-semibold tracking-tight`. Body is `text-sm` by default (UI density beats prose density). Numerics in tables go `font-mono tabular-nums`.

| Role | Class | Pixel size | Notes |
| --- | --- | --- | --- |
| Hero (marketing) | `text-3xl sm:text-4xl font-semibold tracking-tight` | 30→36 | Landing only |
| Page H1 | `text-2xl sm:text-3xl font-semibold tracking-tight` | 24→30 | Every dashboard surface |
| H2 | `text-lg font-semibold` | 18 | Card heads |
| Section label | `text-xs font-semibold uppercase tracking-wider text-muted-foreground` | 12 | Group labels |
| Body | `text-sm` | 14 | Default |
| Body lead | `text-base` | 16 | Marketing prose |
| Meta | `text-xs text-muted-foreground` | 12 | Captions |
| Micro | `text-[10px]` or `text-[11px] uppercase tracking-wider` | 10–11 | kbd, badges |

Weights used: `font-medium` (500) for emphasized inline, `font-semibold` (600) for headings + buttons, `font-mono` for durations / kbd.

Line-height inherits Tailwind defaults (`text-sm` → 1.25rem, `text-base` → 1.5rem). Don't override unless prose is dense — use `leading-relaxed` for the Brain answer card.

Letter spacing: `tracking-tight` on all headings, `tracking-wider` on uppercase labels. Nowhere else.

Text color hierarchy:

- `text-foreground` — primary content. Default in light mode is near-black (`#0a0a0a`).
- `text-muted-foreground` — secondary, captions, meta.
- `text-brand-700` / `text-brand-600` — interactive emphasis (links on hover, badges on success surfaces).
- `text-red-700` / `text-amber-700` / `text-emerald-700` — semantic (state colors below).

## 3. Color system

The de jure brand is **emerald** primary, **amber** accent. The de facto CSS tokens still hold indigo (a scaffolding leftover) — see Cleanup queue. Treat emerald + amber as the truth.

### Tokens (current, from `src/app/globals.css`)

```css
@theme {
  --color-background: #ffffff;
  --color-foreground: #0a0a0a;
  --color-muted: #f4f4f5;
  --color-muted-foreground: #71717a;
  --color-border: #e4e4e7;
  --color-brand-50: #eef2ff;   /* should be emerald-50 #ecfdf5 */
  --color-brand-100: #e0e7ff;  /* should be emerald-100 #d1fae5 */
  --color-brand-500: #6366f1;  /* should be emerald-500 #10b981 */
  --color-brand-600: #4f46e5;  /* should be emerald-600 #059669 */
  --color-brand-700: #4338ca;  /* should be emerald-700 #047857 */
  --radius-pill: 9999px;
}
```

### Surface roles

| Role | Token / class | Use |
| --- | --- | --- |
| Page background | `bg-background` | Body |
| Card | `bg-background` + `border border-border` | Default raised surface |
| Sidebar | `bg-background` + `border-r border-border` | Always |
| Muted block | `bg-muted/30` or `bg-muted/40` | Empty states, footer card, table heads |
| Inverted surface | `bg-foreground text-background` | Toasts, bulk action bar |

### State colors (used inline; not in tokens yet)

| State | Bg | Text | Where |
| --- | --- | --- | --- |
| Success | `bg-emerald-100` | `text-emerald-700` | Running timer pill, "Synced" badge |
| Warning | `bg-amber-100` | `text-amber-800` | Billable badge, AI loading dot |
| Danger | `bg-red-50` | `text-red-700` | Inline destructive copy |
| Info | `bg-brand-50` | `text-brand-700` | "Recently changed" flash, About-this-task pill |

### Dark mode

Tokens flip on `prefers-color-scheme: dark` — no class toggle. Background → `#0a0a0a`, foreground → `#fafafa`, muted/border step accordingly. Brand tokens DO NOT flip (they're brand). Don't add a manual dark toggle until users ask.

## 4. Spacing scale

Base unit: 4px (Tailwind default — `1` = 4px, `2` = 8px, `3` = 12px, `4` = 16px). Stick to even steps.

### Padding

- Buttons: `sm` h-8 px-3 / `md` h-10 px-5 / `lg` h-12 px-6.
- Inputs: `px-3 py-1.5` (rounded-full or rounded-2xl).
- Cards: `p-3` (compact rows), `p-4` or `p-5` (default), `p-6` (dashboard cards), `p-10` (empty states), `p-6 sm:p-10` (large marketing chrome).
- Page container: `mx-auto max-w-5xl px-4 py-8 sm:px-8`. Marketing chrome uses `max-w-6xl`.

### Gap

Default flex gap is `gap-2` (8px). Step up to `gap-3` (12px) when the row mixes icon + text + meta. `gap-1` for tight chip groups. `gap-6`+ only for marketing hero blocks.

### Vertical rhythm

`space-y-2` between adjacent rows in a list. `space-y-3` inside form fields. `space-y-4` between cards. `space-y-6` between page sections. `space-y-10` only between major hero / section blocks on marketing.

### Margins

Avoid raw margins. Use parent gap or `space-y-*` instead. The exceptions: `mt-1` to peel a caption off its label, `mt-3` between a heading and its content.

## 5. Border & radius

### Radius scale (Tailwind tokens)

| Token | Class | Use |
| --- | --- | --- |
| Pill | `rounded-full` | Buttons, chips, tags, pills, sidebar links, dots, mobile drawers, palette input |
| Card | `rounded-3xl` | Default raised surface, cards, dashboard tiles, modals |
| Nested | `rounded-2xl` | Cards inside cards, mobile-drawer rows, smaller chips |
| Marketing | `rounded-[2rem]` | Big footer slab only |
| Field | `rounded` | kbd only |

Buttons are **always** `rounded-full`. Cards are **always** `rounded-3xl`. Don't mix.

### Borders

`border border-border` is the default. Border width is always 1px. Use `border-brand-500` only on active / focus / hover-emphasis. `border-dashed` for "drop zone" empty states (Board view). Never use `border-2` except on the row checkbox circle (`border-2` for the toggle-complete dot) — that's the one exception.

### Borders vs shadows

- Need to **bound** a region against the page → border.
- Need to **lift** a region above the page → shadow.
- Active/raised modal content gets BOTH (`border + shadow-2xl`).
- Toasts/action bars are inverted (`bg-foreground`) and skip the border, lean on shadow alone.

## 6. Shadows

| Level | Class | Use |
| --- | --- | --- |
| Default raised | `shadow-sm` | Marketing pill header, footer card |
| Floating | `shadow-lg` | Toasts |
| Modal | `shadow-2xl` | Command palette, bulk action bar, future dialogs |
| (Reserve) | `shadow-md` / `shadow-xl` | Don't use — pick the level above or below. |

The shadow ladder is intentionally short. Three rungs. Anything else is invented complexity.

## 7. Components

### 7.1 Button (`src/components/ui/button.tsx`)

Base classes:

```
inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full
text-sm font-medium transition-colors
focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-background
disabled:pointer-events-none disabled:opacity-50
```

| Variant | Classes | Use |
| --- | --- | --- |
| `primary` (default) | `bg-brand-600 text-white hover:bg-brand-700` | The single most important action on a surface |
| `secondary` | `bg-muted text-foreground hover:bg-border` | Co-equal action |
| `ghost` | `hover:bg-muted` | Toolbar, icon-adjacent actions |
| `outline` | `border border-border bg-transparent hover:bg-muted` | Mobile sheet "Log in", form cancels |

| Size | Classes | Use |
| --- | --- | --- |
| `sm` | `h-8 px-3` | Inside cards, table rows, palette items |
| `md` (default) | `h-10 px-5` | Page-level CTA |
| `lg` | `h-12 px-6 text-base` | Marketing hero only |

There is no `destructive` variant yet. Inline `text-red-700` / icon-only `Trash2` in a `ghost` shell handles destructive cases for now. If destructive shows up in three more places, promote it to a variant.

One CTA per surface. If a surface has two same-weight CTAs, you've got two surfaces.

### 7.2 Input

```
rounded-full border border-border bg-background px-3 py-1.5 text-sm
focus:outline-none focus:ring-2 focus:ring-brand-500
```

Date / time inputs use the same pill shell. Multi-line goes `rounded-2xl` and `p-3` (chat composer).

### 7.3 Card

Default: `rounded-3xl border border-border bg-background p-5`. Hover-interactive cards add `transition-colors hover:border-brand-500`. Empty-state cards swap to `bg-muted/30 p-10 text-center`.

### 7.4 Modal / dialog

We don't use Radix. The pattern is hand-rolled and consistent across Command Palette and First-Run dialog:

```
fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[10vh]
  ├ backdrop:  absolute inset-0 bg-foreground/40 backdrop-blur-sm
  └ surface:   relative w-full max-w-xl overflow-hidden rounded-3xl border border-border bg-background shadow-2xl
```

Bottom-pinned bars (toasts, bulk actions) use `fixed bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-foreground text-background shadow-lg|2xl`.

### 7.5 Badge / tag

```
inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium
```

Colors per state: `bg-emerald-100 text-emerald-700`, `bg-amber-100 text-amber-800`, `bg-brand-100 text-brand-700`. Status pills (per-list) take their color from the user-defined status row and render via `style={{ backgroundColor }}` rather than Tailwind.

### 7.6 Table

```
table:  w-full text-sm
thead:  border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground
row:    border-b border-border align-middle (transition-colors duration-700 for the recently-changed flash)
last:   no bottom border
```

Cells `px-3 py-2`. Numerics get `font-mono tabular-nums`. Mobile collapses to swipeable cards instead of squeezing the table — don't ship a horizontally-scrolling table on phones.

## 8. Navigation

### 8.1 Sidebar (`src/components/dashboard/sidebar.tsx`)

- Width: `w-72` (288px). Static on `md+`, drawer on mobile.
- Frame: `flex flex-col border-r border-border bg-background`.
- Mobile: starts `-translate-x-full`, slides to `translate-x-0` when opened, with a `bg-foreground/40 backdrop-blur-sm` scrim behind.
- Header strip: `border-b border-border px-4 py-3` with `<PaceWordmark />` on the left and a close icon on mobile.
- Footer strip: `border-t border-border px-4 py-3` with the Clerk `UserButton` and "Account" caption.
- Body: `flex-1 overflow-y-auto p-3`.

Link rows:

```
inactive:  text-muted-foreground hover:bg-muted hover:text-foreground
active:    bg-muted text-foreground
shape:     rounded-2xl px-2 py-1.5 text-sm transition-colors
```

The Search button shows a `⌘K` kbd hint on the right; that hint is the only place we put a kbd in a nav row.

### 8.2 Pill header (marketing, `src/components/marketing/pill-header.tsx`)

- Container: `sticky top-0 z-50 px-3 pt-3 sm:px-6 sm:pt-6`.
- Pill: `rounded-full border border-border bg-background/80 backdrop-blur-md shadow-sm` at `max-w-6xl`.
- Height: implicit from `py-2` + content. Don't pin a fixed height.
- Mobile: nav links collapse into a `rounded-3xl` sheet that slides under the pill (`max-h-96 / max-h-0` opacity-0 transition).

### 8.3 Bottom tabs (mobile only, `src/components/dashboard/bottom-tabs.tsx`)

- Fixed at the bottom on phones; hidden on `md+`. Five slots: Home / Inbox / **+** / Brain / Trash. The `+` is a center FAB that opens the command palette.
- Dashboard layout adds `pb-20` mobile padding so content clears the bar.
- Tap targets are full-width per slot, never < 44px tall (iOS minimum).

### 8.4 Active state, universally

- A nav item is active when it matches the current pathname exactly, or when it's a parent of the current pathname (e.g. `/dashboard/time?week=...`). Active state is `bg-muted text-foreground`. Never use a brand color for active sidebar links — that fights with the brand-colored "current list" dot.

## 9. Visual hierarchy rules

- **Primary** (one per surface): the action that ships work forward. `Button variant=primary` filled with `bg-brand-600`. Always `text-foreground` text inside it (white on emerald).
- **Secondary**: co-equal but reversible (Cancel, Back, Filter). `variant=ghost` or `outline`.
- **Tertiary**: discoverable but quiet. Plain text link with `text-muted-foreground hover:text-foreground`.
- Size before color: a `text-3xl` heading already wins the eye. Don't also paint it brand. Save color for the action chip below it.
- Weight before color: `font-semibold` carries hierarchy. `text-foreground` + `font-semibold` beats `text-brand-600` + `font-medium` every time.
- The brand color is for **action**, not decoration. Emerald earns its way onto the page by being clickable.
- Always-stand-out elements: the single primary CTA, the active nav item, the "recently changed" flash (`bg-brand-50` for ~1.6s), the running-timer pill, an unread mention badge.

## 10. Animation & interactions

We do not have a motion library. Tailwind transitions only. Three speeds:

| Speed | Class | Use |
| --- | --- | --- |
| Fast | `transition-colors` (~150ms default) | Hover/focus, button bg, link color |
| Medium | `transition-all` or `transition-transform` (~300ms default) | Drawer slide, mobile sheet expand, sidebar drawer |
| Slow | `duration-700` | "Recently changed" flash on tasks. Reserve for ambient state changes — never on a click. |

Easing: Tailwind defaults (`ease-in-out`). Don't override unless designing a specific physical metaphor.

Hover states: every interactive element changes either background (`hover:bg-muted`), border (`hover:border-brand-500`), or underline (`hover:underline`). Pick one — never two.

Page transitions: none. Next.js's instant route swap is the transition.

Loading states: `animate-pulse` skeleton blocks shaped like the content they replace. `rounded-full` for headings, `rounded-3xl` for cards, `bg-muted/40` fill. Heights match the live element. No spinners except inside an in-flight button label ("Saving…").

Realtime tells:
- Pulsing emerald dot for "synced" / "running": `inline-block h-1.5 w-1.5 rounded-full bg-emerald-500` plus `animate-pulse` when in flight.
- Amber dot for "loading": `bg-amber-500 animate-pulse`.

## 11. Dashboard homepage (`src/app/dashboard/page.tsx`)

- Outer container is the standard dashboard frame: `mx-auto max-w-5xl px-4 py-8 pb-20 pt-16 sm:px-8 md:pb-8 md:pt-8`.
- Header: page H1 (`text-2xl sm:text-3xl font-semibold tracking-tight`) and a `text-sm text-muted-foreground` line that mentions ⌘K with a `<kbd>` chip. The kbd hint is non-negotiable on the home surface — it teaches the keyboard shortcut.
- Body sections separated by `space-y-10`. Each section opens with a `text-xs font-semibold uppercase tracking-wider text-muted-foreground` label.
- Cards: `rounded-3xl border border-border bg-background p-5`, gridded `sm:grid-cols-2`. Hover: `hover:border-brand-500 transition-colors`.
- The personal/workspace cards each show a colored dot (the space color, set via inline `style={{ backgroundColor }}`) followed by the name in `font-medium`, then `text-sm text-muted-foreground` summary stats.
- Visual weight: the H1 carries the page; the active-card hover carries interaction; the brand color appears only on hover and on the running-timer pill in the sidebar. Nothing else competes.

## 12. Auth pages (`src/app/(auth)/layout.tsx`)

- Layout: `flex min-h-dvh flex-col`. No marketing chrome.
- Header: `<PaceWordmark />` at `px-4 pt-6 sm:px-8`. That's the only branding.
- Main: `flex flex-1 items-center justify-center px-4 py-12`. Clerk's hosted component centers within.
- Sign-in and sign-up share the same layout. No brand decoration, no hero copy, no testimonials. The auth screen's job is to let the user in — anything else is theatre.
- The Clerk component is allowed to keep its own typography. Don't try to skin it.

## 13. Cleanup queue

Open inconsistencies. Document, don't ship a fix here.

- ~~**Brand tokens are still indigo.**~~ **Resolved.** Flipped to the emerald scale (`#ecfdf5 / #d1fae5 / #10b981 / #059669 / #047857`). Brand and tokens finally agree.
- ~~**No accent token.**~~ **Resolved.** Added `--color-accent-50/100/500/600/700` mapped to amber. Migrate ad-hoc `bg-amber-*` references to `bg-accent-*` as you touch them.
- ~~**No font is loaded.**~~ **Resolved.** `next/font/google` Geist wired in `src/app/layout.tsx` with weights 400/500/600/700 and attached to `<html>` via `className={geist.variable}`; `--font-sans` declared in `@theme` so `font-sans` resolves to Geist.
- **Destructive button variant is implicit.** Three rows already inline `text-red-700` for destructive copy. Promote to `variant="destructive"` with `bg-red-600 text-white hover:bg-red-700` once a fourth use shows up.
- **Dialog primitive is duplicated.** Command palette and First-Run dialog hand-roll the same backdrop + surface pattern. Extract a `<Dialog />` shell component when a third dialog needs to ship.
- **Tailwind v4 + dark-mode flips brand-tokens unintentionally.** Brand tokens currently sit outside the `prefers-color-scheme: dark` block — good — but the contrast of `text-white` on `bg-brand-600` should be verified once we switch to emerald (emerald-600 is borderline AA). If the spot-checks fail, drop primary buttons to `text-foreground` on `bg-brand-500` instead.

End of stylesheet.
