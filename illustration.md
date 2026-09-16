# Illustrations — the ForgeUI set, and where each one earns its place

The logged-out site currently argues in prose and screenshots. This file is the
plan for the illustration layer: **the full ForgeUI shopping list as supplied**,
the rules for adapting it to our design system, and a placement map that says
which illustration goes on which page and *what benefit it is there to prove*.

Two standing rules govern everything below.

1. **Benefit first, feature second.** An illustration is not decoration and it
   is not a diagram of our architecture. It exists to get a reader to the Aha
   moment faster than a paragraph can. Every entry in the placement map names
   the *promise* it carries, not the subsystem it depicts.
2. **Do not stuff, do not half-ass.** A page with an illustration beside every
   paragraph reads as a brochure and nothing lands. Fewer, larger, correct.
   Anything on the Hold list below stays off the site until it has a job.

---

## 1. The list (as supplied)

### Illustrations

```
npx shadcn@latest add @forgeui/cloud-orbit
npx shadcn@latest add @forgeui/data-pipeline
npx shadcn@latest add @forgeui/timeline
npx shadcn@latest add @forgeui/onboarding-steps
npx shadcn@latest add @forgeui/workflowrun
npx shadcn@latest add @forgeui/model-mesh
npx shadcn@latest add @forgeui/pagescan
npx shadcn@latest add @forgeui/emptyproject
npx shadcn@latest add @forgeui/revenuechart
npx shadcn@latest add @forgeui/spaminbox
npx shadcn@latest add @forgeui/chatthread
npx shadcn@latest add @forgeui/export-flow
npx shadcn@latest add @forgeui/notification-stack
npx shadcn@latest add @forgeui/agentresearch
npx shadcn@latest add @forgeui/speedgauge
npx shadcn@latest add @forgeui/bankcard
npx shadcn@latest add @forgeui/apirequest
npx shadcn@latest add @forgeui/emptyschedule
npx shadcn@latest add @forgeui/modepicker
npx shadcn@latest add @forgeui/trendlines
npx shadcn@latest add @forgeui/codeprompt
npx shadcn@latest add @forgeui/agentcursors
npx shadcn@latest add @forgeui/codepresence
npx shadcn@latest add @forgeui/recordimport
npx shadcn@latest add @forgeui/handoffmenu
npx shadcn@latest add @forgeui/botreply
npx shadcn@latest add @forgeui/integrationwall
npx shadcn@latest add @forgeui/metricschart
```

### Animated components

```
npx shadcn@latest add @forgeui/animated-form
```

Peer dependencies quoted with the set (deduplicated):

```
npm i motion clsx tailwind-merge
npm i gsap @gsap/react react-icons clsx tailwind-merge
npm i lucide-react clsx tailwind-merge
npm i react-icons clsx tailwind-merge
npm i motion react-icons clsx tailwind-merge
```

Already in `package.json`: `motion`, `gsap`, `lucide-react`, `clsx`,
`tailwind-merge`. **Not** installed, and deliberately so — see §3:
`@gsap/react`, `react-icons`.

### Header blocks to choose from

```
npx shadcn@latest add @forgeui/header05
npx shadcn@latest add @forgeui/header02
```

### Heroes to choose from (if needed)

```
npx shadcn@latest add @forgeui/hero-section02
npx shadcn@latest add @forgeui/hero-section06
npx shadcn@latest add @forgeui/hero-section10
npx shadcn@latest add @forgeui/hero-section15
```

### Logo clouds to choose from

```
npx shadcn@latest add @forgeui/logo-cloud03
npx shadcn@latest add @forgeui/logo-cloud01
```

### Feature sections to choose from

```
npx shadcn@latest add @forgeui/feature01
npx shadcn@latest add @forgeui/feature02
npx shadcn@latest add @forgeui/feature03
npx shadcn@latest add @forgeui/feature04
npx shadcn@latest add @forgeui/feature05
npx shadcn@latest add @forgeui/feature06
npx shadcn@latest add @forgeui/feature07
npx shadcn@latest add @forgeui/feature08
npx shadcn@latest add @forgeui/feature09
```

---

## 2. Registry access

The registry is **`forgeui.in`** (not `.com` — that is a different site, and
every path on it 404s). Registered in `components.json` exactly as ForgeUI's
CLI docs specify, so the token is resolved from the environment and **never
committed**:

```jsonc
"registries": {
  "@forgeui": {
    "url": "https://forgeui.in/r/{name}.json",
    "headers": { "Authorization": "Bearer ${FORGEUI_API_TOKEN}" }
  }
}
```

The env var is `FORGEUI_API_TOKEN` — that exact name, because the CLI reads it
by name out of `.env.local` (already covered by `.gitignore`'s `.env*.local`):

```
FORGEUI_API_TOKEN=forgeui_pro_…
```

It is a **build-time CLI credential only**. It is not read by Next.js or
Convex at runtime, which is why it is not in `.env.example` alongside the
application's env vars — putting it there would imply deployments need it.

### Verified behaviour of the endpoint

| Request | Response |
| --- | --- |
| No auth | `401 Unauthorized` — "This is a ForgeUI Pro block." |
| `Authorization: Bearer <token>` | Authenticates — the token is **valid** |
| Current quota state | `429 Too Many Requests` — "Rate limit reached (200 blocks / 24h)" |

**The account's 200-blocks-per-24h quota is currently exhausted.** That is a
server-side limit on the ForgeUI account, not a sandbox restriction and not
something a retry fixes: installs resume when the window rolls over. Until
then `npx shadcn@latest add @forgeui/<name>` will fail with 429 no matter how
the project is configured.

## 3. Adaptation rules

The components arrive in ForgeUI's default shadcn styling — light canvas,
neutral greys, `react-icons`, `@gsap/react`. None of that is our site. Treat
every download as **source material to be rewritten into our vocabulary**, not
as a drop-in. Concretely:

**Palette.** The logged-out site is a continuous black canvas. Inside the
marketing scope the azure ramp is re-declared as a cyan/aqua ramp — use the
tokens, never literal hex:

| Use | Token |
| --- | --- |
| Page canvas / bands | `#000` via `.mk-band` |
| Panel surfaces | `--mk-panel` `#141414`, `--mk-panel-2` `#1b1b1b` |
| Accent ramp | `--color-azure-300 … 700` (`#a5e8ff` → `#7beadb` in marketing scope) |
| CTA fill | `.mk-gradient-fill` |
| Missing raster asset | `--color-placeholder` via `<Placeholder />` |

**Icons.** `lucide-react` only — it is the configured `iconLibrary` and the
whole app's icon voice. **Strip every `react-icons` import** and map it to its
lucide equivalent; do not install `react-icons` to save the work. Per the house
rule, an icon must be an affordance, a form control, a semantic indicator or an
`.icon-tile` — no decorative icons smuggled in with a downloaded block.

**Motion.** Marketing motion goes through `src/components/marketing/gsap.tsx`
and nothing else: `useGsap()` scopes a `gsap.context` and reverts on unmount,
`EASE_OUT`/`EASE_IN_OUT` and the `DUR` durations are the only timing values,
and `GsapReveal`/`GsapParallax`/`GsapCountUp` are the scroll primitives.
**Do not install `@gsap/react`** — `useGsap()` is our `useGSAP`, and two
context helpers in one tree is how the timings drift apart. Components shipped
on `motion` may keep it (it is already a dependency) but must respect
`prefersReducedMotion()`; anything that animates on scroll needs
`[data-gs-hidden]` so there is no pre-hydration flash.

**Type.** Instrument Sans via `next/font/local`. **Never load a font from a
CDN** — if a block references Google Fonts, delete the link and inherit.

**Structure.** Layout primitives come from `src/components/marketing/ui.tsx`
(`Container`, `Eyebrow`, `SectionHeading`, `CtaButton`, `ScreenshotFrame`,
`IconDock`, `Placeholder`). A downloaded block that ships its own container and
heading gets those replaced, or the page loses its rhythm.

**Copy.** All strings land in `src/lib/marketing-content.ts`, never inside the
component. IA links land in `src/lib/marketing-nav.ts`.

**Responsive.** 360 / 768 / 1280 before merging. An illustration that only
composes at desktop width is not finished.

---

## 4. Placement map

Each row: the illustration, where it goes, and **the benefit it proves**. The
benefit line is the thing the reader should feel — the feature name is what we
say *after* they already want it.

### Home — `/`

| Illustration | Section | Benefit it proves |
| --- | --- | --- |
| `agentcursors` | `sections/together.tsx` | "You can watch it happen." Agents and teammates moving on one board, live — presence is the payoff the feature grid only claims. |
| `timeline` | `sections/work-trail.tsx` | "Nothing happens off the record." The append-only trail is what makes delegation survivable; this is the section's whole argument. |
| `metricschart` | `sections/showcase.tsx` | "Drift shows up as a number, not a surprise." Scope you can see. |
| `feature0X` layout | `sections/feature-cards.tsx` | Layout only — pick one section shape and use it consistently; do not mix three. |

The hero stays as it is. `HeroUnicorn` plus the GSAP mount timeline is the
site's signature entrance and the supplied `hero-section0X` blocks are generic
by comparison. Same for `header02/05` — our `marketing/nav.tsx` already has the
mega-menu and the full-screen mobile overlay. **Evaluate `logo-cloud01/03`**
against the existing `sections/logo-cloud.tsx` runtime dock; adopt only if it
reads better on black.

### How it works — `/how-it-works`

| Illustration | Benefit it proves |
| --- | --- |
| `onboarding-steps` | "Four steps, and you are running." The page's spine — the four steps already exist in `HOW_IT_WORKS`; this makes the shortness of the path visible before the reader reads a word. |
| `cloud-orbit` | "Bring the agent you already use." Any runtime, one endpoint. |

### Features — `/features`

| Anchor | Illustration | Benefit it proves |
| --- | --- | --- |
| `#agents` | `agentcursors` + `notification-stack` | "You always know what your agents are doing." |
| `#mcp` | `cloud-orbit` (primary), `model-mesh` (secondary) | "It works with what you already run." One endpoint, every runtime. |
| `#governance` | `handoffmenu` + `speedgauge` | "Nothing ships without you saying yes." Approval gates, and budgets that cannot be quietly exceeded. |
| `#collaboration` | `codepresence` | "Two agents never clobber each other." Claims and blockers as something you can see being respected. |
| `#tasks` | `modepicker` | "One set of work, four ways to look at it." |
| `#sprints` | `workflowrun` | "The cadence runs without you running it." |
| `#docs` | `pagescan` | "Your agents read the same docs your team does." |
| `#webhooks` | `data-pipeline` | "Every change leaves the building signed." |

### Pricing — `/pricing`

| Illustration | Benefit it proves |
| --- | --- |
| `bankcard` | "Agents pay for their own compute." The x402 credit wallet, which is the genuinely novel thing on this page. |
| `speedgauge` | "You set the ceiling." Daily budgets and burst caps — the reason a prepaid wallet is safe. |

### Use cases — `/use-cases/[slug]`

| Slug | Illustration | Benefit it proves |
| --- | --- | --- |
| `engineering` | `codeprompt` | "Coding agents that ship inside your sprint." |
| `agencies` | `export-flow` | "Client-ready work leaves in one motion." |
| `marketing` | `emptyschedule` | "A campaign calendar that stays full." |
| `operations` | `workflowrun` | "Recurring back-office work that runs itself." |
| `founders` | `trendlines` | "Two people, ten people of output." |
| `solo` | `botreply` | "A chief of staff that never sleeps." |

One illustration per use-case page, at the top. These pages are short; two
would bury the copy.

### Resources — `/resources/[slug]`

| Slug | Illustration | Benefit it proves |
| --- | --- | --- |
| `getting-started` | `onboarding-steps` | "Signup to first agent online, under ten minutes." |
| `connect-an-agent` | `apirequest` | "One endpoint, one key, done." |
| `agent-playbooks` | `agentresearch` | "Teach it your process once." |
| `changelog` | `timeline` | Reuse the Home treatment — same component, same meaning. |

### Plugins — `/plugins`

| Illustration | Benefit it proves |
| --- | --- |
| `integrationwall` | "It meets the tools you already pay for." |

### Forms

`animated-form` is the candidate for any contact / waitlist / demo-request
form. It is **not** for `/sign-up` — that route is Clerk-hosted and must stay
Clerk-hosted.

---

## 5. Hold — downloaded, not placed

Placed only when there is a real claim to carry. Putting these on the site
today would be stuffing.

| Illustration | Why it is held |
| --- | --- |
| `revenuechart` | We do not sell revenue analytics. Using it would promise a dashboard we do not ship. |
| `spaminbox` | Closest fit is the villain section, which is deliberately quiet and text-only. Revisit only if `sections/problem.tsx` is ever redesigned. |
| `recordimport` | Maps to workspace data export/import, which has no marketing surface yet. Pair it with one when it gets a section. |
| `chatthread` | Chat is a real surface, but Home already spends its conversation beat on `agentcursors`. Hold for a dedicated Chat feature section. |
| `emptyproject` | Genuinely good empty-state art — but it belongs to the **logged-in** first-run experience, not the logged-out site. |

---

## 6. Definition of done

- [ ] Every adopted component rewritten into the tokens in §3 — no stray
      `react-icons`, no `@gsap/react`, no CDN font, no literal hex.
- [ ] Copy lives in `marketing-content.ts`; new routes registered in
      `marketing-nav.ts` so nav, footer and `sitemap.ts` pick them up.
- [ ] Any illustration still awaiting a real asset renders `<Placeholder />`,
      never a fake screenshot or an empty div.
- [ ] Checked at 360 / 768 / 1280, in the real browser, both themes.
- [ ] `npm run lint`, `npm run typecheck`, `npm test` clean.
- [ ] Looked at the result — `npm run shots:marketing` — rather than trusting
      that it compiled.
