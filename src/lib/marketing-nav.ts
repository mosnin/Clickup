// Single source of truth for the logged-out site's information
// architecture. The pill header's mega menus, the footer columns, the
// index pages, and sitemap.ts all render from these lists — add a page
// here and every surface picks it up.

export type NavLeaf = {
  href: string;
  label: string;
  description: string;
};

export const FEATURE_LINKS: NavLeaf[] = [
  {
    href: "/features#agents",
    label: "Agents HQ",
    description: "Live presence, keys, and a feed of everything agents do",
  },
  {
    href: "/features#mcp",
    label: "MCP server",
    description: "63 tools your agents call over one hosted endpoint",
  },
  {
    href: "/features#governance",
    label: "Governance",
    description: "Approval gates, roles, budgets, and audit trails",
  },
  {
    href: "/features#collaboration",
    label: "Claims & handoffs",
    description: "Soft locks, blockers, and checklists agents respect",
  },
  {
    href: "/features#tasks",
    label: "Tasks & views",
    description: "List, Board, Calendar, and Gantt on custom statuses",
  },
  {
    href: "/features#sprints",
    label: "Sprints & automation",
    description: "Timeboxes, recurring schedules, and list rules",
  },
  {
    href: "/features#docs",
    label: "Docs & whiteboards",
    description: "Rich text and tldraw boards next to the work",
  },
  {
    href: "/features#webhooks",
    label: "Events & webhooks",
    description: "A signed, real-time record of every change",
  },
];

export const USE_CASE_LINKS: NavLeaf[] = [
  {
    href: "/use-cases/engineering",
    label: "Engineering teams",
    description: "Coding agents that ship inside your sprint",
  },
  {
    href: "/use-cases/agencies",
    label: "Agencies",
    description: "Client work delivered by mixed human-agent pods",
  },
  {
    href: "/use-cases/marketing",
    label: "Marketing teams",
    description: "Campaign calendars agents keep full and on time",
  },
  {
    href: "/use-cases/operations",
    label: "Operations",
    description: "Recurring back-office work that runs itself",
  },
  {
    href: "/use-cases/founders",
    label: "Startups & founders",
    description: "A ten-person output from a two-person team",
  },
  {
    href: "/use-cases/solo",
    label: "Solo builders",
    description: "A personal chief of staff that never sleeps",
  },
];

export const RESOURCE_LINKS: NavLeaf[] = [
  {
    href: "/resources/getting-started",
    label: "Getting started",
    description: "Signup to first agent online, in under ten minutes",
  },
  {
    href: "/resources/connect-an-agent",
    label: "Connect an agent",
    description: "The MCP endpoint, keys, and the collaboration protocol",
  },
  {
    href: "/resources/agent-playbooks",
    label: "Agent playbooks",
    description: "Teach agents your process with the skills library",
  },
  {
    href: "/resources/changelog",
    label: "Changelog",
    description: "Everything we've shipped, phase by phase",
  },
];

export const MEGA_MENUS = [
  { key: "features", label: "Features", links: FEATURE_LINKS, columns: 2 },
  { key: "use-cases", label: "Use cases", links: USE_CASE_LINKS, columns: 2 },
  { key: "resources", label: "Resources", links: RESOURCE_LINKS, columns: 1 },
] as const;

export const PLAIN_LINKS: { href: string; label: string }[] = [
  { href: "/pricing", label: "Pricing" },
  { href: "/company", label: "Company" },
];

export const SITE_NAME = "ClickUp Clone";
export const SITE_TAGLINE = "Mission control for humans and AI agents";
export const SITE_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://clickup-clone.app";
