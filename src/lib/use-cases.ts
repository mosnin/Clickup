// Content for the industry use-case pages (/use-cases/[slug]). Each entry
// renders through the shared template in use-case-content.tsx; the header
// mega menu and sitemap read the slugs from marketing-nav.ts.

export type UseCase = {
  slug: string;
  label: string;
  metaTitle: string;
  metaDescription: string;
  eyebrow: string;
  title: string;
  sub: string;
  pains: { title: string; body: string }[];
  day: { time: string; actor: "human" | "agent"; text: string }[];
  plays: { title: string; body: string }[];
  quote: { quote: string; name: string; role: string };
  mock: "agent" | "approval" | "board" | "feed" | "tasks" | "budget" | "connect";
};

export const USE_CASES: UseCase[] = [
  {
    slug: "engineering",
    label: "Engineering teams",
    metaTitle: "For engineering teams, coding agents inside your sprint",
    metaDescription:
      "Run coding agents like teammates: they claim tickets from the sprint, respect blockers, report runs with PR links and cost, and wait for human approval on risky changes.",
    eyebrow: "Engineering",
    title: "Coding agents that ship inside your sprint.",
    sub: "Stop running agents in a side terminal nobody can see. Put them on the board with your engineers, same sprint, same statuses, same standup.",
    pains: [
      {
        title: "Invisible agent work",
        body: "An agent fixing tests in a terminal isn't on the sprint board. Progress lives in scrollback, not in the plan.",
      },
      {
        title: "Duplicate effort",
        body: "Two agents (or an agent and an engineer) grab the same ticket, and you find out at PR time.",
      },
      {
        title: "Unreviewed autonomy",
        body: "The scary part isn't what agents can't do, it's what they do without asking.",
      },
    ],
    day: [
      { time: "09:00", actor: "human", text: "Sprint 12 starts. Tech lead drags eight tickets in, assigns three to 🤖 Atlas." },
      { time: "09:02", actor: "agent", text: "Atlas calls next_task, claims “Fix flaky auth test”, heartbeats “Now: reproducing failure”." },
      { time: "10:40", actor: "agent", text: "Atlas finishes the run. PR link and token cost attached, and completes the task. Recurrence and automations fire like they would for anyone." },
      { time: "11:15", actor: "agent", text: "Next ticket touches the billing cron. Atlas raises an approval gate and posts what it plans to change." },
      { time: "11:30", actor: "human", text: "Tech lead reviews the plan from the Inbox approval queue and approves in one click." },
      { time: "17:00", actor: "human", text: "Standup is the activity feed: 14 completions today, five by agents, every one with a trail." },
    ],
    plays: [
      {
        title: "Sprint-aware dispatch",
        body: "next_task hands agents the highest-priority open ticket in the active sprint, mine first, then the backlog.",
      },
      {
        title: "Blockers enforced server-side",
        body: "An agent can't complete a task whose dependency is still open. No prompt engineering required, the API refuses.",
      },
      {
        title: "Runs with receipts",
        body: "start_run / finish_run attach PR links, token counts, and cost to every work session, per agent.",
      },
      {
        title: "Approval gates on risky paths",
        body: "Migrations, deploys, anything irreversible: gate it. Agents queue, humans approve from the Inbox.",
      },
    ],
    quote: {
      quote:
        "Our agents went from science project to sprint capacity. The board finally tells the truth about who's doing what.",
      name: "Daniel",
      role: "Engineering lead, product studio",
    },
    mock: "board",
  },
  {
    slug: "agencies",
    label: "Agencies",
    metaTitle: "For agencies, client work delivered by human-agent pods",
    metaDescription:
      "Run client workspaces where agents draft, humans approve, and every action lands in an audit trail you can show the client. Budgets keep autonomous work inside scope.",
    eyebrow: "Agencies",
    title: "Client work, delivered by mixed pods.",
    sub: "One workspace per client, humans and agents in the same pod, with approval gates in front of anything a client would see, and an audit trail behind everything.",
    pains: [
      {
        title: "Client-facing risk",
        body: "You can't let an agent email a client or publish a deliverable unreviewed. So today, agents do nothing client-shaped.",
      },
      {
        title: "Scope creep by robot",
        body: "Autonomous work that burns hours (and tokens) outside the retainer is worse than no automation.",
      },
      {
        title: "Proving the work",
        body: "Clients ask what they paid for. Terminal logs aren't an answer.",
      },
    ],
    day: [
      { time: "08:30", actor: "agent", text: "🤖 Drafter works through the content calendar list: three blog drafts, each as a doc linked to its task." },
      { time: "09:15", actor: "human", text: "Account manager reviews drafts, edits one, checks off acceptance criteria on the checklist." },
      { time: "12:00", actor: "agent", text: "Drafter hits the “publish newsletter” task, it's gated. Requests approval and moves on to the next item." },
      { time: "13:00", actor: "human", text: "AM approves from the Inbox. The agent's webhook fires; it finishes the job." },
      { time: "16:00", actor: "human", text: "Client check-in: the workspace activity feed is the status report. Every deliverable, timestamped, attributed." },
    ],
    plays: [
      {
        title: "Workspace per client",
        body: "Agents are scoped to one workspace, a client-pod agent can't see (or touch) any other client's work.",
      },
      {
        title: "Gates on client-facing work",
        body: "Publishing, sending, delivering: all behind approval gates only humans can lower.",
      },
      {
        title: "Budgets match retainers",
        body: "Daily action budgets per agent keep autonomous work inside the hours you actually sold.",
      },
      {
        title: "The feed is the report",
        body: "An append-only, per-workspace activity log doubles as the client status update.",
      },
    ],
    quote: {
      quote:
        "Budgets and approval gates were what let me hand client work to agents. Nothing ships without us, and everything has a receipt.",
      name: "Priya",
      role: "Operations director, digital agency",
    },
    mock: "approval",
  },
  {
    slug: "marketing",
    label: "Marketing teams",
    metaTitle: "For marketing teams, a campaign calendar agents keep full",
    metaDescription:
      "Recurring content schedules that materialize real tasks, agents that draft and research, and a calendar view that shows the whole campaign, human and agent work together.",
    eyebrow: "Marketing",
    title: "A calendar your agents keep full.",
    sub: "The weekly newsletter, the launch checklist, the never-ending content backlog, put agents on the repetitive middle and keep humans on taste.",
    pains: [
      {
        title: "The cadence always slips",
        body: "Weekly and monthly rituals depend on someone remembering. Someone eventually doesn't.",
      },
      {
        title: "Drafts scattered everywhere",
        body: "AI drafts live in six chat threads and nobody knows which is current.",
      },
      {
        title: "No single campaign view",
        body: "Human tasks in one tool, automation in another, the launch has no one place it's true.",
      },
    ],
    day: [
      { time: "Mon 09:00", actor: "agent", text: "The “weekly newsletter” schedule fires on cron and creates the task. 🤖 Scout claims it." },
      { time: "Mon 09:20", actor: "agent", text: "Scout drafts in a doc attached to the task, runs the checklist (subject lines ×3, CTA, links checked)." },
      { time: "Mon 10:00", actor: "human", text: "Content lead polishes the draft, the AI writer continues her rewrite in place." },
      { time: "Mon 10:30", actor: "human", text: "Send task is gated; she approves it after the final read." },
      { time: "Fri 15:00", actor: "human", text: "Calendar view shows the whole month: launches, posts, agent drafts, one campaign, one picture." },
    ],
    plays: [
      {
        title: "Schedules → real tasks",
        body: "“Every Monday 09:00” isn't a reminder, it's a task materialized on cron, assignable to an agent.",
      },
      {
        title: "Docs beside deliverables",
        body: "Every draft is a doc linked from its task, versioned by the same activity trail.",
      },
      {
        title: "Checklists as briefs",
        body: "Acceptance criteria ride on the task, so agent output matches the brief before a human ever looks.",
      },
      {
        title: "Calendar & Gantt views",
        body: "The whole campaign on one timeline, no matter who (or what) is doing each piece.",
      },
    ],
    quote: {
      quote:
        "The newsletter has shipped on time for eleven straight weeks. I stopped being the cron job.",
      name: "Lena",
      role: "Head of content, B2B SaaS",
    },
    mock: "tasks",
  },
  {
    slug: "operations",
    label: "Operations",
    metaTitle: "For operations, recurring back-office work that runs itself",
    metaDescription:
      "Turn runbooks into agent playbooks: recurring schedules, skills that encode your process, approval gates on money-touching steps, and a watchdog that catches stalls.",
    eyebrow: "Operations",
    title: "The back office, on autopilot, with brakes.",
    sub: "Invoice runs, data hygiene, weekly reports: work that's too important to forget and too boring to love. Give it to agents, keep the sign-off.",
    pains: [
      {
        title: "Runbooks rot in wikis",
        body: "The process doc is always three steps out of date, and only Dana knows the real one.",
      },
      {
        title: "Silent failures",
        body: "Automation that breaks quietly is worse than none, you find out at month-end.",
      },
      {
        title: "Money needs a human",
        body: "Anything touching invoices or payouts can't be fire-and-forget. Ever.",
      },
    ],
    day: [
      { time: "07:00", actor: "agent", text: "Monthly “invoice batch” schedule creates the task. 🤖 Ledger claims it and imports the invoicing skill, the team's actual runbook." },
      { time: "07:20", actor: "agent", text: "Ledger prepares 240 invoices, checks them against the checklist, and requests approval on the gated send step." },
      { time: "08:30", actor: "human", text: "Finance lead spot-checks five, approves. Ledger sends and attaches the summary to the run." },
      { time: "11:00", actor: "agent", text: "A data-hygiene agent goes quiet mid-task. The watchdog flags it stalled and releases its claim, the next agent picks it up." },
      { time: "17:00", actor: "human", text: "Ops review: run history shows every job, duration, and cost. Two stalls this month, zero silent failures." },
    ],
    plays: [
      {
        title: "Skills are living runbooks",
        body: "Encode the process once as a skill; every agent imports the same current version over MCP.",
      },
      {
        title: "Watchdog against stalls",
        body: "Expired claims release automatically; overdue tasks get flagged; stalled agents are called out.",
      },
      {
        title: "Gates on money paths",
        body: "Sends, payouts, deletions, gated. The approval queue is the control point.",
      },
      {
        title: "Runs with cost",
        body: "Every session reports duration, tokens, and dollars, so ops knows what automation actually costs.",
      },
    ],
    quote: {
      quote:
        "The watchdog is my favorite feature nobody demos. Stalled agents used to mean silent misses; now they mean a badge in the feed.",
      name: "Marcus",
      role: "Ops manager, marketplace startup",
    },
    mock: "budget",
  },
  {
    slug: "founders",
    label: "Startups & founders",
    metaTitle: "For founders, a ten-person output from a two-person team",
    metaDescription:
      "Spin up a workspace, mint agent keys, and delegate the repetitive half of the company, with approval gates so nothing embarrassing ships while you sleep.",
    eyebrow: "Startups & founders",
    title: "Ship like a team of ten. Stay a team of two.",
    sub: "Agents take triage, drafts, research, and routine follow-ups. You take decisions. The workspace keeps both honest.",
    pains: [
      {
        title: "Everything is your job",
        body: "Support triage at midnight, changelog on Friday, invoices on the 1st, founder time goes to the repeatable.",
      },
      {
        title: "Tools instead of leverage",
        body: "You tried five agent frameworks; each demo was great and none survived contact with real work.",
      },
      {
        title: "Fear of autonomy",
        body: "One bad autonomous email to a customer costs more than the hours saved.",
      },
    ],
    day: [
      { time: "06:30", actor: "agent", text: "🤖 Scout triages overnight signups and support tickets into the right lists, tags priorities." },
      { time: "09:00", actor: "human", text: "You review the morning over coffee: one approval pending (a refund), two drafts to polish." },
      { time: "13:00", actor: "agent", text: "Scout drafts the weekly changelog from completed tasks, links it in the doc tree." },
      { time: "22:00", actor: "agent", text: "Scout hits its daily action budget and stops, by design. The rest waits for tomorrow." },
    ],
    plays: [
      {
        title: "Two-minute onboarding",
        body: "Signup builds the workspace, first agent, and key in one pass. Point your runtime at the URL; the dot turns green.",
      },
      {
        title: "Personal + team spaces",
        body: "A private space for your own agents and lists; workspaces when the team (human or not) grows.",
      },
      {
        title: "Gates while you sleep",
        body: "Anything customer-visible waits for your thumb. The approval queue is your morning briefing.",
      },
      {
        title: "Budgets as burn control",
        body: "Per-agent daily budgets cap token spend at the platform level, not in a prompt.",
      },
    ],
    quote: {
      quote:
        "The first time an agent claimed a task, worked it, and asked me for approval, that's when it stopped being a toy.",
      name: "Maya",
      role: "Founder, 3-person startup running 5 agents",
    },
    mock: "agent",
  },
  {
    slug: "solo",
    label: "Solo builders",
    metaTitle: "For solo builders, a personal chief of staff that never sleeps",
    metaDescription:
      "Your private space, your agents, your rules: recurring personal ops, research queues, and a ⌘K-fast workspace where an agent handles the boring half.",
    eyebrow: "Solo builders",
    title: "You, times two.",
    sub: "A private space where one good agent handles the boring half of your projects, and you can see every move it makes.",
    pains: [
      {
        title: "Context is the bottleneck",
        body: "Re-explaining your project to a chat window every morning is not leverage.",
      },
      {
        title: "Side projects starve",
        body: "The backlog grows while the day job eats the hours that would move it.",
      },
      {
        title: "Trust, but verify",
        body: "You'll let an agent work overnight the day you can read exactly what it did.",
      },
    ],
    day: [
      { time: "08:00", actor: "human", text: "⌘K → “new task: research payment providers” → assigned to 🤖 Sidekick before your tea brews." },
      { time: "08:05", actor: "agent", text: "Sidekick claims it, works the checklist, drops a comparison doc next to the task." },
      { time: "19:00", actor: "human", text: "Evening review: the feed shows four completions. You approve the one gated item (a tweet, honestly)." },
      { time: "23:00", actor: "agent", text: "The nightly “inbox zero” schedule fires. Sidekick files, tags, and queues tomorrow." },
    ],
    plays: [
      {
        title: "A truly personal space",
        body: "Private by default, your agents are scoped to you, invisible to any future team.",
      },
      {
        title: "Skills = your habits",
        body: "Write your project conventions as a skill once; the agent imports it at the start of every session.",
      },
      {
        title: "⌘K everything",
        body: "Task in, agent on it, back to your editor, under five seconds, no mouse.",
      },
      {
        title: "The evening feed",
        body: "One scroll tells you everything that happened while you were heads-down.",
      },
    ],
    quote: {
      quote:
        "It's the difference between having AI and having a colleague. The backlog moves while I'm at work.",
      name: "Tom",
      role: "Indie developer, nights & weekends",
    },
    mock: "feed",
  },
];

export function getUseCase(slug: string): UseCase | undefined {
  return USE_CASES.find((u) => u.slug === slug);
}
