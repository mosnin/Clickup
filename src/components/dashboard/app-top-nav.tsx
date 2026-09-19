"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { UserButton } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import {
  Bell,
  Check,
  ChevronDown,
  LayoutGrid,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import { cn } from "@/lib/utils";
import { useModeTransition } from "@/components/chat/mode-transition";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NewWorkspaceDialog } from "@/components/dashboard/new-workspace-dialog";
import {
  MORE_NAV,
  TOP_NAV,
  WORK_SUB_NAV,
  activeSubNavHref,
  activeTopNavId,
  isExactActive,
  showsWorkSubNav,
} from "@/lib/deel-nav";
import { useCurrentContext, useTreeQuery } from "@/lib/workspace-context";

/**
 * Deel's 2025 top bar, tailored to operate.
 *
 * From Mobbin (Deel web home / people / payroll / settings):
 * pale lavender strip, black circular `d.` mark, org name + "All groups"
 * subtitle, white pill on the active module, icon buttons then avatar
 * on the right. No left rail on Home. Operate keeps the same chrome and
 * swaps People/Payroll/Finance for Work/Inbox/Agents/Chat.
 */
export function AppTopNav() {
  const pathname = usePathname();
  const active = activeTopNavId(pathname);
  const onModeClick = useModeTransition();

  return (
    <header className="app-top-nav">
      <div className="flex h-[var(--app-top-nav-height)] items-center gap-3 px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <Link
            href="/dashboard"
            aria-label="Home"
            className="app-mark shrink-0"
          >
            o.
          </Link>
          <WorkspaceSwitcher />
        </div>

        <nav
          aria-label="Application"
          className="hidden min-w-0 flex-1 items-center justify-center gap-0.5 md:flex"
        >
          {TOP_NAV.map((item) => {
            const on = active === item.id;
            const Icon = item.icon;
            return (
              <Link
                key={item.id}
                href={item.href}
                aria-current={on ? "page" : undefined}
                onClick={
                  item.id === "chat" || item.id === "home"
                    ? (event) => onModeClick(event, item.href)
                    : undefined
                }
                className={cn("app-top-pill", on && "app-top-pill-on")}
              >
                <Icon aria-hidden className="size-3.5" />
                {item.label}
              </Link>
            );
          })}
          <MoreMenu active={active === "more"} />
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-0.5 md:ml-0">
          <MobileNav />
          <TopIcon
            label="Search"
            onClick={() => window.dispatchEvent(new CustomEvent("open-command-palette"))}
          >
            <Search aria-hidden className="size-4" />
          </TopIcon>
          <TopIcon href="/dashboard/appearance" label="Settings">
            <Settings aria-hidden className="size-4" />
          </TopIcon>
          <InboxBell />
          <div className="pl-1 [&_.cl-avatarBox]:size-7 [&_.cl-userButtonTrigger]:rounded-full">
            <UserButton afterSignOutUrl="/" />
          </div>
        </div>
      </div>
      {showsWorkSubNav(pathname) ? <WorkSubNav pathname={pathname} /> : null}
    </header>
  );
}

function WorkSubNav({ pathname }: { pathname: string }) {
  const current = activeSubNavHref(pathname, WORK_SUB_NAV);
  return (
    <nav
      aria-label="Work"
      className="flex items-center gap-1 overflow-x-auto px-3 pb-2 sm:px-4"
    >
      {WORK_SUB_NAV.map((item) => {
        const on = current === item.href || isExactActive(pathname, item.href, item.exact);
        return (
          <Link
            key={item.id}
            href={item.href}
            aria-current={on ? "page" : undefined}
            className={cn(
              "shrink-0 rounded-full px-2.5 py-1 text-xs font-medium",
              on
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function WorkspaceSwitcher() {
  const tree = useTreeQuery();
  const ctx = useCurrentContext(tree);
  const [wsDialogOpen, setWsDialogOpen] = useState(false);
  const currentName =
    ctx.kind === "workspace" ? ctx.workspace.name : "My workspace";
  const subtitle = ctx.kind === "workspace" ? "All spaces" : "Personal";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex min-w-0 max-w-[11rem] flex-col items-start rounded-[var(--ui-radius-control)] px-1 py-0.5 text-left outline-none hover:bg-black/5 dark:hover:bg-white/5 sm:max-w-[16rem]">
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate text-sm font-semibold leading-tight text-foreground">
              {currentName}
            </span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </span>
          <span className="truncate text-[11px] leading-tight text-muted-foreground">
            {subtitle}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
            Workspaces
          </DropdownMenuLabel>
          {tree?.personal && (
            <DropdownMenuItem asChild>
              <Link href="/dashboard/personal">
                <span className="truncate">My workspace</span>
                {ctx.kind === "personal" && <Check className="ml-auto size-4" />}
              </Link>
            </DropdownMenuItem>
          )}
          {tree?.workspaces.map((ws) => (
            <DropdownMenuItem key={ws._id} asChild>
              <Link href={`/dashboard/w/${ws._id}`}>
                <span className="min-w-0 flex-1 truncate">{ws.name}</span>
                <span className="flex-shrink-0 text-micro uppercase tracking-wider text-muted-foreground">
                  {ws.role}
                </span>
                {ctx.kind === "workspace" && ctx.workspace._id === ws._id && (
                  <Check className="ml-1 size-4 flex-shrink-0" />
                )}
              </Link>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setWsDialogOpen(true)}>
            <Plus className="size-4" />
            New workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {wsDialogOpen ? (
        <NewWorkspaceDialog open onClose={() => setWsDialogOpen(false)} />
      ) : null}
    </>
  );
}

function MoreMenu({ active }: { active: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn("app-top-pill", active && "app-top-pill-on")}
        aria-label="More"
      >
        <LayoutGrid aria-hidden className="size-3.5" />
        More
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-48">
        {MORE_NAV.map((item) => (
          <DropdownMenuItem key={item.id} asChild>
            <Link href={item.href}>{item.label}</Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MobileNav() {
  const pathname = usePathname();
  const active = activeTopNavId(pathname);
  const onModeClick = useModeTransition();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Open navigation"
        className="tap-target flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-black/5 hover:text-foreground md:hidden dark:hover:bg-white/10"
      >
        <LayoutGrid aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {TOP_NAV.map((item) => (
          <DropdownMenuItem key={item.id} asChild>
            <Link
              href={item.href}
              aria-current={active === item.id ? "page" : undefined}
              onClick={
                item.id === "chat" || item.id === "home"
                  ? (event) => onModeClick(event, item.href)
                  : undefined
              }
            >
              {item.label}
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {MORE_NAV.map((item) => (
          <DropdownMenuItem key={item.id} asChild>
            <Link href={item.href}>{item.label}</Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TopIcon({
  label,
  href,
  onClick,
  children,
}: {
  label: string;
  href?: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const className =
    "tap-target relative flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10";
  if (href) {
    return (
      <Link href={href} aria-label={label} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" aria-label={label} onClick={onClick} className={className}>
      {children}
    </button>
  );
}

function InboxBell() {
  const unreadMentions = useQuery(api.mentions.unreadCountForCurrent, {});
  const unreadUpdates = useQuery(api.notificationCenter.unreadCount, {});
  const waitingOnYou = useQuery(api.obligations.countForCurrentUser, {});
  const unread =
    (unreadMentions ?? 0) + (unreadUpdates ?? 0) + (waitingOnYou ?? 0);
  return (
    <TopIcon
      href="/dashboard/inbox"
      label={unread > 0 ? `Inbox, ${unread} unread` : "Inbox"}
    >
      <Bell aria-hidden className="size-4" />
      {unread > 0 && (
        <span
          aria-hidden
          className="absolute right-1.5 top-1.5 size-2 rounded-full bg-[var(--color-unread)] ring-2 ring-[var(--color-top-nav)]"
        />
      )}
    </TopIcon>
  );
}
