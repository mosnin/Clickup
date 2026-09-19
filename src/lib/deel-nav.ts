import type { LucideIcon } from "lucide-react";
import {
  Bot,
  FolderKanban,
  Home,
  Inbox,
  LayoutGrid,
  MessagesSquare,
} from "lucide-react";

/**
 * Deel's 2025 product chrome, as operate destinations.
 *
 * Taken from Mobbin web screens of Deel (home, people, payroll, settings):
 * a top pill bar, not a left rail. Home / People / Payroll / Finance / Engage
 * / More maps onto the things operate actually has. Chat is a first-class
 * pill the way Engage is — not a second application hiding behind a switcher.
 */
export type TopNavId = "home" | "work" | "inbox" | "agents" | "chat" | "more";

export type TopNavItem = {
  id: TopNavId;
  label: string;
  href: string;
  icon: LucideIcon;
  exact?: boolean;
};

export const TOP_NAV: TopNavItem[] = [
  { id: "home", label: "Home", href: "/dashboard", icon: Home, exact: true },
  { id: "work", label: "Work", href: "/dashboard/spaces", icon: FolderKanban },
  { id: "inbox", label: "Inbox", href: "/dashboard/inbox", icon: Inbox },
  { id: "agents", label: "Agents", href: "/dashboard/agents", icon: Bot },
  { id: "chat", label: "Chat", href: "/chat", icon: MessagesSquare },
];

export type MoreNavItem = {
  id: string;
  label: string;
  href: string;
};

export const MORE_NAV: MoreNavItem[] = [
  { id: "pages", label: "Pages", href: "/dashboard/pages" },
  { id: "my-work", label: "My work", href: "/dashboard/my-work" },
  { id: "projects", label: "Projects", href: "/dashboard/projects" },
  { id: "templates", label: "Templates", href: "/dashboard/templates" },
  { id: "search", label: "Search", href: "/dashboard/search" },
  { id: "appearance", label: "Appearance", href: "/dashboard/appearance" },
];

/** Secondary strip under the top bar — Deel's People / Org chart / Time off. */
export type SubNavItem = {
  id: string;
  label: string;
  href: string;
  exact?: boolean;
};

export const WORK_SUB_NAV: SubNavItem[] = [
  { id: "spaces", label: "Spaces", href: "/dashboard/spaces", exact: true },
  { id: "projects", label: "Projects", href: "/dashboard/projects", exact: true },
  { id: "pages", label: "Pages", href: "/dashboard/pages" },
  { id: "my-work", label: "My work", href: "/dashboard/my-work", exact: true },
];

function pathOf(href: string): string {
  return href.split("?")[0] ?? href;
}

export function isExactActive(pathname: string, href: string, exact?: boolean): boolean {
  const target = pathOf(href);
  if (exact) return pathname === target;
  return pathname === target || pathname.startsWith(`${target}/`);
}

/**
 * Which top-nav pill is current.
 *
 * Work wins for every nested list/task/space/project/page/whiteboard URL,
 * because those are Deel's "People" — the module you are in, not Home.
 * Chat is segment-exact (`/chat`, `/chat/…`) so `/chatter` cannot steal it.
 */
export function activeTopNavId(pathname: string): TopNavId | null {
  if (pathname === "/chat" || pathname.startsWith("/chat/")) return "chat";
  if (pathname === "/dashboard" || pathname === "/dashboard/") return "home";
  if (pathname === "/dashboard/inbox" || pathname.startsWith("/dashboard/inbox/")) {
    return "inbox";
  }
  if (pathname === "/dashboard/agents" || pathname.startsWith("/dashboard/agents/")) {
    return "agents";
  }
  if (
    pathname.startsWith("/dashboard/spaces") ||
    pathname.startsWith("/dashboard/projects") ||
    pathname.startsWith("/dashboard/pages") ||
    pathname.startsWith("/dashboard/my-work") ||
    pathname.startsWith("/dashboard/personal") ||
    pathname.startsWith("/dashboard/templates") ||
    pathname.startsWith("/dashboard/w/") ||
    pathname.startsWith("/dashboard/s/") ||
    pathname.startsWith("/dashboard/p/") ||
    pathname.startsWith("/dashboard/l/") ||
    pathname.startsWith("/dashboard/d/") ||
    pathname.startsWith("/dashboard/wb/")
  ) {
    return "work";
  }
  if (
    pathname.startsWith("/dashboard/appearance") ||
    pathname.startsWith("/dashboard/settings") ||
    pathname.startsWith("/dashboard/search") ||
    pathname.startsWith("/dashboard/admin")
  ) {
    return "more";
  }
  return null;
}

/** Home is the one Deel screen with no left rail and no secondary strip. */
export function isHomePath(pathname: string): boolean {
  return pathname === "/dashboard" || pathname === "/dashboard/";
}

export function showsWorkSubNav(pathname: string): boolean {
  return activeTopNavId(pathname) === "work";
}

export function activeSubNavHref(pathname: string, items: readonly SubNavItem[]): string | null {
  const exact = items.find((item) => item.exact && pathname === pathOf(item.href));
  if (exact) return exact.href;
  const prefix = items.find(
    (item) => !item.exact && isExactActive(pathname, item.href, false),
  );
  return prefix?.href ?? null;
}

export { LayoutGrid as MoreIcon };
