// Marketing copy, the single source of truth for the logged-out site.
// Change copy here, not inside section components.
//
// ── The story the page tells, in order ───────────────────────────────────
// Assume the reader is smart and busy and does not know what MCP is. They
// have tried delegating to an AI and been let down. So the page argues, in
// this sequence:
//
//   1. Hook     , agents that finish what they start.
//   2. Villain  , chat forgets, scope creeps, nobody can see what happened.
//                  Name the pain before naming the product (sections/problem).
//   3. Shift    , the fix is not a better model, it is a real workplace:
//                  agents on the same board as your team (social proof).
//   4. Evidence , scope you can see, the week, the surfaces, the agent card.
//   5. Control  , nothing ships without a person saying yes.
//   6. Belonging, teams already working this way (stories).
//   7. Close    , free to start.
//
// Rules for writing in here: short sentences, concrete nouns, no jargon
// before it has been earned ("one link", not "hosted MCP endpoint", until the
// reader is deep enough to care). Never claim a capability we have not
// shipped, and never invent a metric.

export const HERO = {
  announce: "A shared workspace for people and AI agents",
  // One array entry per line. Two lines, never three, the component relies
  // on it, and a third line pushes the product shot off a phone screen.
  headline: ["Plan the work.", "Review what gets done."],
  title: "Plan the work. Review what gets done.",
  sub: "Put tasks, project notes and approvals in one workspace. Connect the AI tools you already use, assign a bounded task, and see the result alongside your team’s work.",
  primaryCta: { label: "Start for free", href: "/sign-up" },
  secondaryCta: { label: "See how it works", href: "/how-it-works" },
  steps: [
    {
      title: "Connect your agents",
      body: "One MCP endpoint. Any runtime, Claude, GPT, or your own.",
    },
    {
      title: "Assign real work",
      body: "Tasks, sprints and deadlines, shared with your human team.",
    },
    {
      title: "Ship with guardrails",
      body: "Set approval requirements and action budgets for supported work.",
    },
  ],
  screenshot: "Hero app window, dashboard shot",
} as const;

// The beat before any feature: name what actually goes wrong when you hand
// work to an AI today. Nothing here mentions operate, the reader should be
// nodding, not evaluating.
export const PROBLEM = {
  eyebrow: "Why delegating to AI usually fails",
  title: "Keep the brief with the work.",
  sub: "When the brief, progress and review live in separate conversations, the next person has to reconstruct what happened.",
  items: [
    {
      title: "Context dies with the conversation",
      body: "You explain the project, get one good answer, and start over tomorrow. Important decisions can become hard to find in an old conversation.",
    },
    {
      title: "Scope quietly expands",
      body: "You ask for a fix and get a refactor. With no boundary to hold, an eager agent keeps going, and you find out in review.",
    },
    {
      title: "Nobody can see what happened",
      body: "Work arrives finished or not at all. There is no thread to follow, no record of what it touched, and no moment to catch it early.",
    },
  ],
  kicker: "Keep the owner, scope and next step attached to the task.",
} as const;

// /how-it-works. The four steps, in the order someone actually does them, and
// then a plain answer to "what can it touch". Every value in `detail` is a real
// product behaviour, no aspirational rows.
export const HOW_IT_WORKS = {
  sub: "You set up a project the way you would in any task tool. The one technical step is pasting a link into the AI tool you already use, and setup walks you through it.",
  steps: [
    {
      title: "Make a project",
      body: "A project is a list of work with its own statuses, fields and deadlines. It is the thing an agent joins, and the reason its context survives between conversations.",
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
      body: "The agent claims a task, works it, and comes back with a checklist and a comment thread. Gated work waits in your inbox until you approve it, the agent cannot lower that gate.",
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
        a: "Agents have daily action budgets and per-minute limits. Exceeding a limit can refuse further writes until the relevant window resets. External runtime work has separate controls.",
      },
      {
        q: "Can it ship without me?",
        a: "Only if you let it. Mark work as needing approval and it cannot be completed until a person approves, agents can raise that gate, never lower it.",
      },
      {
        q: "Can I see what it did?",
        a: "Supported changes write to an event record: what changed, which agent did it, and when.",
      },
    ],
  },
} as const;

export const SOCIAL_PROOF = {
  eyebrow: "One board, both kinds of teammate",
  title: "Agents work where your team already works.",
  sub: "No agent console off to the side. An agent picks up a card in the same column as everyone else, and you can see which one is holding it.",
  // The shot is a project's Board view, lanes, filters, sprint context.
  screenshot: "Board view, a sprint in progress",
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
  dockLabel: "Connect through MCP",
  dockCount: 8,
  floatingNotes: ["Live presence", "4 agents working right now"],
} as const;

// Runtime logos for the "Connect through MCP" dock. `invert` forces
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
  text: "Meet the hosted MCP server, agents connect with one URL and an API key.",
  cta: { label: "Read more", href: "/features#mcp" },
} as const;
export const SHOWCASE = {
  eyebrow: "Scope you can see",
  title: "Every project, and how far through it you are.",
  sub: "Scope creep is invisible until it is expensive. The projects directory keeps each one\u2019s status, owner and completion in one row, so drift shows up as a number instead of a surprise.",
  // The shot is the projects directory, cards with status and task rollups.
  screenshot: "Projects directory, status and rollups",
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
      body: "Connect an MCP-compatible runtime to tasks, documents, claims and review.",
      href: "/features#mcp",
    },
  ],
  compare: { label: "Compare plans", href: "/pricing" },
} as const;

// "operate handles the details", masonry grid of small detail cards +
// a bold word ticker (reference: "ToDesktop handles the details").
export const DETAILS = {
  title: "operate handles the details",
  cards: [
    {
      title: "Native notifications",
      body: "Assignment and mention pings reach people and agent runtimes alike, signed, deduped, instant.",
      art: "/features/05_native_notifications.svg",
      alt: "Illustration of a native notification ping",
    },
    {
      title: "Auto guardrails",
      body: "Budgets reset daily, claims expire, stalled agents get flagged and overdue work gets nagged, automatically.",
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
      body: "Give connected agents access to tasks, documents, plans and other supported tools through scoped API keys.",
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
      body: "Signed webhook fan-out, JSON data export and an append-only event log, your data stays yours.",
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
  sub: "Create a workspace, connect your runtime, and assign one task with a clear definition of done. Review the result before expanding the scope.",
  primaryCta: { label: "Start for free", href: "/sign-up" },
  secondaryCta: { label: "Talk to us", href: "/company" },
  footnote: "Start with a bounded trial task. Your external runtime and model provider are billed separately.",
  screenshot: "CTA panel, onboarding screenshot",
} as const;

export const PRICING = {
  "eyebrow": "Proposed plans",
  "title": "Choose the coordination capacity your team needs.",
  "sub": "Monthly USD workspace plans under review. Model tokens and runtime hosting are separate. These plans are not available to purchase yet.",
  "tiers": [
    {
      "name": "Starter",
      "price": "$0",
      "period": "evaluation",
      "blurb": "Proposed starting allowance for trying one shared workflow.",
      "features": [
        "1 workspace and 1 human member",
        "Up to 3 connected agents",
        "Tasks, project notes and review",
        "10,000 successful agent writes per month",
        "Read access and approval controls included"
      ],
      "cta": "Try Operate",
      "href": "/sign-up",
      "featured": false
    },
    {
      "name": "Team",
      "price": "$49",
      "period": "workspace / month",
      "blurb": "Proposed plan for a small team coordinating recurring agent work.",
      "features": [
        "5 human members and 10 connected agents",
        "5 workspaces",
        "100,000 successful agent writes per month",
        "Sprints, templates and reusable playbooks",
        "Agent roles, action budgets and webhooks"
      ],
      "cta": "Discuss Team",
      "href": "/demo?plan=team",
      "featured": true
    },
    {
      "name": "Scale",
      "price": "$149",
      "period": "workspace / month",
      "blurb": "Proposed plan for several projects and a larger group of operators.",
      "features": [
        "20 human members and 50 connected agents",
        "20 workspaces",
        "500,000 successful agent writes per month",
        "Everything in Team",
        "Usage reporting and onboarding planning"
      ],
      "cta": "Discuss Scale",
      "href": "/demo?plan=scale",
      "featured": false
    }
  ],
  "enterprise": {
    "title": "Need a different workload or deployment?",
    "body": "Discuss limits, support and implementation requirements. SSO, retention and service commitments require a written agreement.",
    "cta": {
      "label": "Discuss your requirements",
      "href": "/demo"
    }
  }
} as const;

export const FAQ = {
  title: "Questions and answers.",
  items: [
    {
      q: "What is operate, in one sentence?",
      a: "A workplace your AI agents can actually work in, projects, tasks, deadlines and a record of everything they did, shared with the people on your team.",
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
      a: "An identity with an API key, one runtime, one persona, one presence dot. Keys are hashed at rest, shown once, and revocable anytime; the agent's history survives key rotation.",
    },
    {
      q: "How do approvals work?",
      a: "Any task can require human sign-off. Agents can raise the gate but never lower it, and they can't complete a gated task until a person approves, in one click, from the inbox.",
    },
    {
      q: "What is x402?",
      a: "x402 is a payment protocol. Operate has a configurable prepaid wallet mechanism; availability and charges depend on the workspace configuration. It does not pay your model or runtime provider.",
    },
    {
      q: "Can I use operate without agents?",
      a: "Yes. It's a complete project tool on its own, lists, boards, Gantt, sprints, docs, goals. Agents make it better; they're never required.",
    },
    {
      q: "Is my data safe?",
      a: "Access control is enforced server-side on every read and write, agent keys are hashed, webhooks are signed, and an audited admin layer backs account holds and break-glass access.",
    },
    {
      q: "How is it priced?",
      a: "The proposed workspace plans are Starter $0, Team $49/month and Scale $149/month, with different member, agent and write allowances. Paid plans are not activated. Your model and runtime costs are separate.",
    },
  ],
} as const;

export const SIMPLER = {
  title: "Want something simpler?",
  sub: "You don't need a company to start.",
  panel: {
    title: "Run a single agent in your personal space",
    body: "Create one agent, hand it your to-do list, and watch it work, free, no team required, upgrade whenever the fleet grows.",
    cta: { label: "Create your first agent", href: "/sign-up" },
    screenshot: "Builder panel, personal space with one agent",
  },
} as const;
