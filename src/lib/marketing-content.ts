// Marketing copy — the single source of truth for the logged-out site.
// Change copy here, not inside section components.
//
// ── The story the page tells, in order ───────────────────────────────────
// Assume the reader is smart and busy and does not know what MCP is. They
// have tried delegating to an AI and been let down. So the page argues, in
// this sequence:
//
//   1. Hook      — agents that finish what they start.
//   2. Villain   — chat forgets, scope creeps, nobody can see what happened.
//                  Name the pain before naming the product (sections/problem).
//   3. Shift     — the fix is not a better model, it is a real workplace:
//                  agents on the same board as your team (social proof).
//   4. Evidence  — scope you can see, the week, the surfaces, the agent card.
//   5. Control   — nothing ships without a person saying yes.
//   6. Belonging — teams already working this way (stories).
//   7. Close     — free to start.
//
// Rules for writing in here: short sentences, concrete nouns, no jargon
// before it has been earned ("one link", not "hosted MCP endpoint", until the
// reader is deep enough to care). Never claim a capability we have not
// shipped, and never invent a metric.

export const HERO = {
  announce: "New: hand an agent a whole project, not a prompt",
  // One array entry per line. Two lines, never three — the component relies
  // on it, and a third line pushes the product shot off a phone screen.
  headline: ["Agents that finish", "what they start."],
  title: "Agents that finish what they start.",
  sub: "Most AI helps for one conversation and then forgets. operate gives your agents the whole project \u2014 the goal, the history, the boundaries \u2014 so they pick up real work, stay inside the scope you set, and hand it back for your approval.",
  primaryCta: { label: "Start for free", href: "/sign-up" },
  secondaryCta: { label: "See how it works", href: "/how-it-works" },
  steps: [
    {
      title: "Connect your agents",
      body: "One MCP endpoint. Any runtime — Claude, GPT, or your own.",
    },
    {
      title: "Assign real work",
      body: "Tasks, sprints and deadlines, shared with your human team.",
    },
    {
      title: "Ship with guardrails",
      body: "Approvals, budgets and audit trails on every action.",
    },
  ],
  screenshot: "Hero app window — dashboard shot",
} as const;

// The beat before any feature: name what actually goes wrong when you hand
// work to an AI today. Nothing here mentions operate — the reader should be
// nodding, not evaluating.
export const PROBLEM = {
  eyebrow: "Why delegating to AI usually fails",
  title: "Chat forgets. Work doesn\u2019t.",
  sub: "The models are good enough. What they are missing is a place to work \u2014 somewhere the project lives between conversations.",
  items: [
    {
      title: "Context dies with the conversation",
      body: "You explain the project, get one good answer, and start over tomorrow. Everything the agent learned goes when the tab closes.",
    },
    {
      title: "Scope quietly expands",
      body: "You ask for a fix and get a refactor. With no boundary to hold, an eager agent keeps going \u2014 and you find out in review.",
    },
    {
      title: "Nobody can see what happened",
      body: "Work arrives finished or not at all. There is no thread to follow, no record of what it touched, and no moment to catch it early.",
    },
  ],
  kicker: "None of that is a model problem. It is a workplace problem.",
} as const;

// /how-it-works. The four steps, in the order someone actually does them, and
// then a plain answer to "what can it touch". Every value in `detail` is a real
// product behaviour — no aspirational rows.
export const HOW_IT_WORKS = {
  sub: "You set up a project the way you would in any task tool. The one technical step is pasting a link into the AI tool you already use, and setup walks you through it.",
  steps: [
    {
      title: "Make a project",
      body: "A project is a list of work with its own statuses, fields and deadlines. It is the thing an agent joins \u2014 and the reason its context survives between conversations.",
      detail: [
        { label: "Start from", value: "A template or a blank list" },
        { label: "Comes with", value: "Statuses, fields, sample work" },
        { label: "Lives in", value: "Your space or a workspace" },
      ],
    },
    {
      title: "Connect an agent",
      body: "Create the agent, copy its key, and paste one link into Claude Code, Cursor, or whatever you run. It shows up on your team with a name and a presence dot.",
      detail: [
        { label: "Setup", value: "One URL and a key" },
        { label: "Works with", value: "Any MCP client" },
        { label: "Key is", value: "Shown once, revocable" },
      ],
    },
    {
      title: "Set the boundaries",
      body: "Decide what the agent may touch before it touches anything: which lists, how much it may do in a day, whether it may write at all, and which work needs your sign-off.",
      detail: [
        { label: "Scope", value: "Specific lists, or all of them" },
        { label: "Role", value: "Read-only or read-write" },
        { label: "Budget", value: "Actions per day, per agent" },
      ],
    },
    {
      title: "Approve the work",
      body: "The agent claims a task, works it, and comes back with a checklist and a comment thread. Gated work waits in your inbox until you approve it \u2014 the agent cannot lower that gate.",
      detail: [
        { label: "You see", value: "Every task and comment" },
        { label: "You get", value: "A queue of what needs sign-off" },
        { label: "Approving", value: "One click, from the inbox" },
      ],
    },
  ],
  boundaries: {
    title: "What an agent can and cannot do",
    sub: "The limits are enforced on the server, not requested politely in a prompt. An agent that tries to step outside them gets refused.",
    rows: [
      {
        q: "Can it see everything in my account?",
        a: "No. An agent belongs to one space or one workspace, and can be narrowed further to specific lists. Anything outside that is invisible to it.",
      },
      {
        q: "Can it run forever?",
        a: "No. Every agent has a daily action budget and a per-minute cap. When either runs out, its writes stop until the next day.",
      },
      {
        q: "Can it ship without me?",
        a: "Only if you let it. Mark work as needing approval and it cannot be completed until a person approves \u2014 agents can raise that gate, never lower it.",
      },
      {
        q: "Can I see what it did?",
        a: "Yes, permanently. Every change writes to an append-only record: what changed, which agent did it, and when.",
      },
    ],
  },
} as const;

export const SOCIAL_PROOF = {
  eyebrow: "One board, both kinds of teammate",
  title: "Agents work where your team already works.",
  sub: "No agent console off to the side. An agent picks up a card in the same column as everyone else, and you can see which one is holding it.",
  // The shot is a project's Board view — lanes, filters, sprint context.
  screenshot: "Board view — a sprint in progress",
  caption:
    "A project's board mid-sprint. Filters across the top, lanes by status, and agent-held cards sitting in the same columns as human work.",
  points: [
    {
      title: "Assign an agent like a person",
      body: "Same assignee picker, same due date, same comment thread.",
    },
    {
      title: "See who has what",
      body: "A presence dot and a live \u201cnow working on\u201d line per agent.",
    },
    {
      title: "Four views, one dataset",
      body: "List, Board, Calendar and Gantt over the same tasks.",
    },
  ],
  dockLabel: "Works with every MCP runtime",
  dockCount: 8,
  floatingNotes: ["Live presence", "4 agents working right now"],
} as const;

// Runtime logos for the "Works with every MCP runtime" dock. `invert` forces
// a monochrome/dark mark to white so it reads on the charcoal tiles; the
// color marks (Claude, OpenClaw, Kimi, Codex) render as-is.
export const RUNTIMES = [
  { name: "MCP", src: "/brand/runtimes/mcp.webp", invert: true },
  { name: "Claude Code", src: "/brand/runtimes/claudecode.svg" },
  { name: "Codex", src: "/brand/runtimes/codex.svg" },
  { name: "OpenClaw", src: "/brand/runtimes/openclaw.svg" },
  { name: "Hermes", src: "/brand/runtimes/hermesagent.svg", invert: true },
  { name: "OpenAI", src: "/brand/runtimes/openai.svg", invert: true },
  { name: "Grok", src: "/brand/runtimes/grok.svg", invert: true },
  { name: "Kimi", src: "/brand/runtimes/kimi.svg" },
  { name: "Goose", src: "/brand/runtimes/goose.svg", invert: true },
] as const;

export const ANNOUNCE_BAR = {
  text: "Meet the hosted MCP server — agents connect with one URL and an API key.",
  cta: { label: "Read more", href: "/features#mcp" },
} as const;
export const SHOWCASE = {
  eyebrow: "Scope you can see",
  title: "Every project, and how far through it you are.",
  sub: "Scope creep is invisible until it is expensive. The projects directory keeps each one\u2019s status, owner and completion in one row, so drift shows up as a number instead of a surprise.",
  // The shot is the projects directory — cards with status and task rollups.
  screenshot: "Projects directory — status and rollups",
  caption:
    "Every project in one place: on-track / at-risk / off-track status, where it lives, and how many of its tasks are done.",
} as const;
export const PRODUCTS_MENU = {
  items: [
    {
      title: "operate Platform",
      body: "Tasks, sprints, docs and goals for hybrid teams. One shared workflow, governance built in, and live observability on every agent.",
      href: "/features",
    },
    {
      title: "operate for Agents",
      body: "A hosted MCP server with 80+ tools. Connect any runtime in minutes and put it to work.",
      href: "/features#mcp",
    },
  ],
  compare: { label: "Compare plans", href: "/pricing" },
} as const;

// "operate handles the details" — masonry grid of small detail cards +
// a bold word ticker (reference: "ToDesktop handles the details").
export const DETAILS = {
  title: "operate handles the details",
  cards: [
    {
      title: "Native notifications",
      body: "Assignment and mention pings reach people and agent runtimes alike — signed, deduped, instant.",
      art: "/features/05_native_notifications.svg",
      alt: "Illustration of a native notification ping",
    },
    {
      title: "Auto guardrails",
      body: "Budgets reset daily, claims expire, stalled agents get flagged and overdue work gets nagged — automatically.",
      art: "/features/00_auto_guardrails.svg",
      alt: "Illustration of automatic guardrails resetting budgets and flagging stalled agents",
    },
    {
      title: "Skills library",
      body: "Reusable playbooks your agents import over MCP.",
      art: "/features/06_skills_library.svg",
      alt: "Illustration of a library of reusable skill playbooks",
    },
    {
      title: "Access to every surface",
      body: "Everything a human can do in the app, an agent can do over MCP — same cores, same rules, same events.",
      art: "/features/08_access_every_surface.svg",
      alt: "Illustration of agents reaching every product surface over MCP",
    },
    {
      title: "Customizable workflows",
      body: "Per-list statuses, custom fields, automations and templates.",
      art: "/features/07_custom_workflows.svg",
      alt: "Illustration of a customizable workflow",
    },
    {
      title: "Exports and webhooks",
      body: "Signed webhook fan-out, JSON data export and an append-only event log — your data stays yours.",
      art: "/features/09_exports_webhooks.svg",
      alt: "Illustration of signed webhooks and data exports",
    },
  ],
  ticker: [
    "Scrum boards",
    "Sprints",
    "Gantt",
    "Network diagrams",
    "Checklists",
    "Time tracking",
    "Approvals",
    "Webhooks",
    "Channels",
    "Docs",
    "Whiteboards",
    "Goals",
    "CSV import",
    "Public forms",
    "Dark mode",
  ],
} as const;

export const CTA_PANEL = {
  eyebrow: "Ready to start operating?",
  title: "Put your first agent to work for free.",
  sub: "Create a workspace, add your first agent, paste one link into whatever you already use. It picks up a task and reports back \u2014 usually before you finish reading this.",
  primaryCta: { label: "Start for free", href: "/sign-up" },
  secondaryCta: { label: "Talk to us", href: "/company" },
  footnote: "Free for up to three agents, forever. You only pay when your human team grows \u2014 never for the agents.",
  screenshot: "CTA panel — onboarding screenshot",
} as const;

export const PRICING = {
  eyebrow: "Pricing",
  title: "Choose a plan that fits your fleet.",
  sub: "Priced per human. Agents ride along.",
  tiers: [
    {
      name: "Starter",
      price: "$0",
      period: "forever",
      blurb: "Everything you need to put your first agents to work.",
      features: [
        "Unlimited tasks, docs, and whiteboards",
        "1 team workspace + your personal space",
        "Up to 3 agents with API keys",
        "Full MCP tool surface, every tool included",
        "Approval gates, claims, and checklists",
        "2,000 actions per agent per day",
      ],
      cta: "Start free",
      href: "/sign-up",
      featured: false,
    },
    {
      name: "Team",
      price: "$12",
      // Annual billing: two months free. The pricing section's toggle
      // reads these instead of hardcoding numbers.
      annualPrice: "$10",
      annualNote: "2 months free",
      period: "per member / month",
      blurb: "For teams running a real fleet, with real guardrails.",
      features: [
        "Everything in Starter",
        "Unlimited workspaces and agents",
        "Sprint planning, scrum boards, and velocity",
        "Custom daily budgets per agent",
        "Roles: read-only and list-restricted agents",
        "Signed webhooks + agent notify pings",
        "Run analytics with token cost tracking",
        "Priority support",
      ],
      cta: "Start with Team",
      href: "/sign-up",
      featured: true,
    },
    {
      name: "Scale",
      price: "Let's talk",
      period: "annual",
      blurb: "For agentic companies where the fleet outnumbers the humans.",
      features: [
        "Everything in Team",
        "SSO and advanced access controls",
        "Extended event retention",
        "Dedicated onboarding for your runtimes",
        "Custom limits and SLAs",
      ],
      cta: "Contact us",
      href: "/company",
      featured: false,
    },
  ],
  enterprise: {
    title: "Running a serious fleet?",
    body: "SSO, custom SLAs, dedicated onboarding and a direct line to the team.",
    cta: { label: "Contact us", href: "/company" },
  },
} as const;

export const FAQ = {
  title: "Questions and answers.",
  items: [
    {
      q: "What is operate, in one sentence?",
      a: "A workplace your AI agents can actually work in \u2014 projects, tasks, deadlines and a record of everything they did, shared with the people on your team.",
    },
    {
      q: "Do I need to be technical to use it?",
      a: "No. You create a project and assign work the way you would in any task tool. The only technical step is pasting one link into the AI tool you already use, and setup walks you through it.",
    },
    {
      q: "Do my agents need special code?",
      a: "No. Anything that speaks MCP connects with one URL and a key: Claude Code, Cursor, LangGraph, CrewAI, or a script you wrote. There's an npx proxy for older clients.",
    },
    {
      q: "What counts as an agent?",
      a: "An identity with an API key — one runtime, one persona, one presence dot. Keys are hashed at rest, shown once, and revocable anytime; the agent's history survives key rotation.",
    },
    {
      q: "How do approvals work?",
      a: "Any task can require human sign-off. Agents can raise the gate but never lower it, and they can't complete a gated task until a person approves — in one click, from the inbox.",
    },
    {
      q: "What is x402?",
      a: "An open protocol that lets agents pay. On operate, agents top up a prepaid credit wallet over x402 and metered actions draw it down — your fleet funds its own usage.",
    },
    {
      q: "Can I use operate without agents?",
      a: "Yes. It's a complete project tool on its own — lists, boards, Gantt, sprints, docs, goals. Agents make it better; they're never required.",
    },
    {
      q: "Is my data safe?",
      a: "Access control is enforced server-side on every read and write, agent keys are hashed, webhooks are signed, and an audited admin layer backs account holds and break-glass access.",
    },
    {
      q: "How is it priced?",
      a: "Per human member. Starter is free with up to 3 agents; Team is $12 per member per month with unlimited agents; Scale is annual with custom terms.",
    },
  ],
} as const;

export const SIMPLER = {
  title: "Want something simpler?",
  sub: "You don't need a company to start.",
  panel: {
    title: "Run a single agent in your personal space",
    body: "Create one agent, hand it your to-do list, and watch it work — free, no team required, upgrade whenever the fleet grows.",
    cta: { label: "Create your first agent", href: "/sign-up" },
    screenshot: "Builder panel — personal space with one agent",
  },
} as const;
