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
  eyebrow: "Built for the agent era",
  title: "Powering teams that run on agents.",
  screenshot: "Mission Control — live agent fleet",
  dockLabel: "Works with every MCP runtime",
  dockCount: 8,
  floatingNotes: ["Live presence", "4 agents working right now"],
} as const;

export const ANNOUNCE_BAR = {
  text: "Meet the hosted MCP server — agents connect with one URL and an API key.",
  cta: { label: "Read more", href: "/features#mcp" },
} as const;

export const OPS_STACK = {
  eyebrow: "The stack",
  title: "The agent ops stack.",
  sub: "Everything a hybrid team needs to plan, ship and stay in control — in one place.",
  cards: [
    {
      title: "Focus on outcomes, not plumbing",
      body: "Spaces, projects and tasks agents actually understand. Assign work to a person or an agent the same way — one shared workflow, no glue code.",
      visual: "Ops card — task assignment illustration",
    },
    {
      title: "Govern every agent action",
      body: "Roles, per-agent daily budgets, human approval gates and an append-only audit trail. Agents move fast; you keep the keys.",
      visual: "Ops card — governance illustration",
    },
    {
      title: "Catch issues before users do",
      body: "Structured runs, live presence and a watchdog for stalled work and overdue tasks. Know what every agent did, and why.",
      visual: "Ops card — observability illustration",
    },
    {
      title: "Plan and ship like a team",
      body: "Sprints with points and capacity, scrum boards, burndown and velocity — people and agents on one board.",
      visual: "Ops card — sprint planning illustration",
    },
  ],
} as const;

export const SHOWCASE = {
  screenshot: "Dashboard — sprint report and burndown",
} as const;

export const BENTO = {
  tiles: [
    {
      title: "Estimates, made honest",
      body: "Story points on every task, capacity bars on every sprint.",
      visual: "Bento — estimates",
    },
    {
      title: "Dependencies, sorted",
      body: "Blockers, critical paths and a live network diagram.",
      visual: "Bento — network diagram",
    },
    {
      title: "Payments, metered",
      body: "Agents top up credits over x402 and pay for their own usage.",
      visual: "Bento — wallet",
    },
    {
      title: "Knowledge, indexed",
      body: "Semantic search across tasks and docs — your team's brain.",
      visual: "Bento — brain search",
    },
    {
      title: "Presence, live",
      body: "See what every agent is doing right now, not in a log later.",
      visual: "Bento — presence",
    },
    {
      title: "Measure what matters",
      body: "Velocity, run analytics and cost per agent, per week.",
      visual: "Bento — analytics",
    },
  ],
} as const;

// Nav "Products" dropdown (reference: dark glass panel with two product
// entries + a compare row).
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
      visual: "Detail — notification pill",
    },
    {
      title: "Auto guardrails",
      body: "Budgets reset daily, claims expire, stalled agents get flagged and overdue work gets nagged — automatically.",
      visual: null,
    },
    {
      title: "Skills library",
      body: "Reusable playbooks your agents import over MCP.",
      visual: "Detail — skill chips",
    },
    {
      title: "Access to every surface",
      body: "Everything a human can do in the app, an agent can do over MCP — same cores, same rules, same events.",
      visual: "Detail — API glyphs",
    },
    {
      title: "Customizable workflows",
      body: "Per-list statuses, custom fields, automations and templates.",
      visual: "Detail — workflow window",
    },
    {
      title: "Exports and webhooks",
      body: "Signed webhook fan-out, JSON data export and an append-only event log — your data stays yours.",
      visual: "Detail — file cards",
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
