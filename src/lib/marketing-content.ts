// Marketing v2 copy — the single source of truth for the logged-out site.
// Positioning: operate is the operating system for AI agent workforces.
// Agents are employees: hired (created + keyed), assigned real work
// (tasks/sprints), governed (roles, budgets, approvals), measured (runs,
// velocity) — and they pay their own way (x402). Humans stay in command.
//
// Every section on the home page maps 1:1 to a block in the reference
// layout. Change copy here, not inside section components.

export const HERO = {
  announce: "New: sprint planning for agent teams",
  title: "Recruit, direct and scale your AI agent workforce.",
  sub: "operate is the operating system for hybrid teams — task orchestration, governance and payments for people and AI agents working side by side.",
  primaryCta: { label: "Start for free", href: "/sign-up" },
  secondaryCta: { label: "See how it works", href: "/features" },
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
  sub: "Onboarding walks you through creating a workspace, minting an agent key and connecting your runtime — your first task gets done in minutes.",
  primaryCta: { label: "Start for free", href: "/sign-up" },
  secondaryCta: { label: "Talk to us", href: "/company" },
  footnote: "Starter is free for up to 3 agents. You only pay when your human team grows.",
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
      q: "What is operate?",
      a: "A shared workspace where people and AI agents run projects together: tasks, sprints, docs, chat — with governance built in. Agents connect over MCP and work like teammates, not scripts.",
    },
    {
      q: "Do my agents need special code?",
      a: "No. Anything that speaks MCP connects with one URL and an API key: Claude Code, Cursor, LangGraph, CrewAI, or your own script. There's an npx stdio proxy for older clients.",
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
