"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { UserButton } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import {
  Activity,
  BarChart3,
  BookOpen,
  Bot,
  Calendar,
  ChevronDown,
  ChevronRight,
  Columns3,
  FileText,
  Folder,
  GanttChart,
  Home,
  Inbox,
  LayoutDashboard,
  LayoutGrid,
  List as ListIcon,
  ListTodo,
  Menu,
  MessageSquare,
  PanelLeft,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
  Wallet,
  Webhook,
  X,
  Zap,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { AnimatePresence, motion, SPRING } from "@/components/motion";
import { InlineCreate } from "@/components/dashboard/inline-create";
import { RunningTimerChip } from "@/components/dashboard/running-timer-chip";
import { TemplatePicker } from "@/components/dashboard/template-picker";
import { NewWorkspaceDialog } from "@/components/dashboard/new-workspace-dialog";
import { ThemeToggle } from "@/components/theme-toggle";

type SidebarTree = NonNullable<ReturnType<typeof useTreeQuery>>;
type SpaceNode = SidebarTree["workspaces"][number]["spaces"][number];

function useTreeQuery() {
  return useQuery(api.sidebar.tree, {});
}

// Desktop collapse state, persisted so the choice survives reloads.
function useCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("sidebar-collapsed") === "1");
    } catch {
      /* private mode — default expanded */
    }
  }, []);
  const toggle = () =>
    setCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem("sidebar-collapsed", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  return [collapsed, toggle];
}

// Right-anchored hover tooltip for the collapsed icon rail.
function RailTip({ label }: { label: string }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 translate-x-1 whitespace-nowrap rounded-lg bg-foreground px-2 py-1 text-xs font-medium text-background opacity-0 shadow-lg transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-100"
    >
      {label}
    </span>
  );
}

// ── Root ────────────────────────────────────────────────────────────────────

export function DashboardSidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, toggleCollapsed] = useCollapsed();
  const tree = useTreeQuery();
  const close = () => setMobileOpen(false);

  return (
    <>
      <button
        type="button"
        aria-label="Open navigation"
        onClick={() => setMobileOpen(true)}
        className="bento-sm fixed left-3 top-3 z-40 inline-flex h-10 w-10 items-center justify-center rounded-full bg-background md:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            aria-hidden
            onClick={close}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-foreground/40 backdrop-blur-sm md:hidden"
          />
        )}
      </AnimatePresence>

      <aside
        data-collapsed={collapsed || undefined}
        className={cn(
          "group/side fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-background shadow-[1px_0_0_rgb(16_16_18/0.04),8px_0_24px_-20px_rgb(16_16_18/0.10)] transition-[transform,width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] md:static md:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
          collapsed && "md:w-[4.75rem]",
        )}
        aria-label="Sidebar"
      >
        {/* Header */}
        <div
          className={cn(
            "flex shrink-0 items-center px-4 pb-2 pt-4",
            collapsed ? "md:justify-center md:px-0" : "justify-between",
          )}
        >
          <Link
            href="/dashboard"
            className="flex items-center gap-2.5 overflow-hidden pl-1"
            onClick={close}
          >
            <span
              aria-hidden
              className="inline-block h-3.5 w-3.5 flex-shrink-0 rounded-[4px] bg-foreground"
            />
            <span
              className={cn(
                "text-[13px] font-extrabold uppercase tracking-[0.22em] transition-all",
                collapsed && "md:hidden",
              )}
            >
              operate.to
            </span>
          </Link>
          <button
            type="button"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={toggleCollapsed}
            className={cn(
              "hidden h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:inline-flex",
              collapsed && "md:absolute md:right-2",
            )}
          >
            <motion.span
              animate={{ rotate: collapsed ? 180 : 0 }}
              transition={SPRING}
              className="inline-flex"
            >
              <PanelLeft className="h-4 w-4" />
            </motion.span>
          </button>
          <button
            type="button"
            aria-label="Close navigation"
            onClick={close}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full hover:bg-muted md:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Fixed nav band, stays put while the tree scrolls. */}
        <div className={cn("shrink-0 px-3 pt-3", collapsed && "md:px-2")}>
          {!collapsed && <RunningTimerChip />}
          <button
            type="button"
            onClick={() => {
              close();
              window.dispatchEvent(new CustomEvent("open-command-palette"));
            }}
            className={cn(
              "soft-field group relative mb-2 flex w-full items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground",
              collapsed
                ? "md:justify-center md:px-0 md:py-2 px-2.5 py-1.5"
                : "px-2.5 py-1.5",
            )}
          >
            <Search className="h-4 w-4 flex-shrink-0" />
            <span className={cn("flex-1 text-left", collapsed && "md:hidden")}>
              Search
            </span>
            <kbd
              className={cn(
                "rounded-md bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground",
                collapsed && "md:hidden",
              )}
            >
              ⌘K
            </kbd>
            {collapsed && <RailTip label="Search  ⌘K" />}
          </button>

          <HomeLink onNavigate={close} collapsed={collapsed} />
          <MyWorkLink onNavigate={close} collapsed={collapsed} />
          <InboxLink onNavigate={close} collapsed={collapsed} />
          <BrainLink onNavigate={close} collapsed={collapsed} />
          <AgentsGroup onNavigate={close} collapsed={collapsed} />

          <div className="mt-1">
            <NewButton
              tree={tree}
              collapsed={collapsed}
              onNavigate={close}
            />
          </div>
        </div>

        {/* Scrolling tree */}
        <nav
          className={cn(
            "mt-2 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-3",
            collapsed && "md:px-2",
          )}
        >
          {collapsed ? (
            <CollapsedWorkspaceTiles tree={tree} onNavigate={close} />
          ) : tree === undefined ? (
            <SidebarLoading />
          ) : tree === null ? (
            <p className="px-2 text-sm text-muted-foreground">
              Sign in to see your spaces.
            </p>
          ) : (
            <SidebarTreeView tree={tree} onNavigate={close} />
          )}
        </nav>

        <AdminLink onNavigate={close} collapsed={collapsed} />

        <div
          className={cn(
            "shrink-0 px-3 pb-4 pt-2",
            collapsed && "md:px-2",
          )}
        >
          {collapsed ? (
            <div className="flex flex-col items-center gap-2">
              <ThemeToggle collapsed />
              <UserButton afterSignOutUrl="/" />
            </div>
          ) : (
            <div className="space-y-2.5">
              <ThemeToggle />
              <div className="flex items-center gap-3 px-1">
                <UserButton afterSignOutUrl="/" />
                <span className="text-xs text-muted-foreground">Account</span>
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

// ── Fixed-band nav rows ──────────────────────────────────────────────────────

function NavLink({
  href,
  label,
  icon: Icon,
  active,
  collapsed,
  onNavigate,
  badge,
  className,
}: {
  href: string;
  label: string;
  icon: typeof Bot;
  active: boolean;
  collapsed: boolean;
  onNavigate: () => void;
  badge?: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative mb-1 flex items-center gap-2 rounded-lg text-sm transition-colors",
        collapsed
          ? "md:justify-center md:px-0 md:py-2 px-2.5 py-1.5"
          : "px-2.5 py-1.5",
        active
          ? "text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      {active && (
        <motion.span
          layoutId="sidebar-active"
          className="absolute inset-0 rounded-lg bg-muted"
          transition={SPRING}
        />
      )}
      <motion.span
        whileHover={{ scale: 1.12 }}
        whileTap={{ scale: 0.9 }}
        transition={SPRING}
        className="relative z-10 inline-flex"
      >
        <Icon className="h-4 w-4" />
      </motion.span>
      <span className={cn("relative z-10 flex-1", collapsed && "md:hidden")}>
        {label}
      </span>
      {badge}
      {collapsed && <RailTip label={label} />}
    </Link>
  );
}

function HomeLink({
  onNavigate,
  collapsed,
}: {
  onNavigate: () => void;
  collapsed: boolean;
}) {
  const pathname = usePathname();
  return (
    <NavLink
      href="/dashboard"
      label="Home"
      icon={Home}
      active={pathname === "/dashboard"}
      collapsed={collapsed}
      onNavigate={onNavigate}
    />
  );
}

function MyWorkLink({
  onNavigate,
  collapsed,
}: {
  onNavigate: () => void;
  collapsed: boolean;
}) {
  const pathname = usePathname();
  return (
    <NavLink
      href="/dashboard/my-work"
      label="My work"
      icon={ListTodo}
      active={pathname === "/dashboard/my-work"}
      collapsed={collapsed}
      onNavigate={onNavigate}
    />
  );
}

function BrainLink({
  onNavigate,
  collapsed,
}: {
  onNavigate: () => void;
  collapsed: boolean;
}) {
  const pathname = usePathname();
  return (
    <NavLink
      href="/dashboard/brain"
      label="Brain"
      icon={Sparkles}
      active={pathname === "/dashboard/brain"}
      collapsed={collapsed}
      onNavigate={onNavigate}
    />
  );
}

function InboxLink({
  onNavigate,
  collapsed,
}: {
  onNavigate: () => void;
  collapsed: boolean;
}) {
  const pathname = usePathname();
  // The badge counts everything the Inbox page shows: mentions + updates.
  const unreadMentions = useQuery(api.mentions.unreadCountForCurrent, {});
  const unreadUpdates = useQuery(api.notificationCenter.unreadCount, {});
  const unread = (unreadMentions ?? 0) + (unreadUpdates ?? 0);
  const hasUnread = unread > 0;

  return (
    <NavLink
      href="/dashboard/inbox"
      label="Inbox"
      icon={Inbox}
      active={pathname === "/dashboard/inbox"}
      collapsed={collapsed}
      onNavigate={onNavigate}
      badge={
        hasUnread ? (
          <span
            className={cn(
              "relative z-10 rounded-full bg-foreground px-1.5 py-0.5 text-[10px] font-medium text-background",
              collapsed &&
                "md:absolute md:right-1.5 md:top-1 md:px-1 md:py-0 md:leading-tight",
            )}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        ) : undefined
      }
    />
  );
}

// Agents: an expandable group whose sub-rows deep-link to the page tabs.
const AGENT_SUBLINKS = [
  { key: "", label: "Mission control", Icon: LayoutDashboard },
  { key: "activity", label: "Activity", Icon: Activity },
  { key: "billing", label: "Billing", Icon: Wallet },
  { key: "webhooks", label: "Webhooks", Icon: Webhook },
  { key: "skills", label: "Skills", Icon: BookOpen },
] as const;

function AgentsGroup({
  onNavigate,
  collapsed,
}: {
  onNavigate: () => void;
  collapsed: boolean;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const onAgents = pathname.startsWith("/dashboard/agents");
  const [expanded, setExpanded] = useState(onAgents);
  useEffect(() => {
    if (onAgents) setExpanded(true);
  }, [onAgents]);

  if (collapsed) {
    return (
      <NavLink
        href="/dashboard/agents"
        label="Agents"
        icon={Bot}
        active={onAgents}
        collapsed={collapsed}
        onNavigate={onNavigate}
      />
    );
  }

  const activeTab = pathname === "/dashboard/agents" ? searchParams.get("tab") : null;

  return (
    <div className="mb-1">
      <div className="flex items-center">
        <button
          type="button"
          aria-label={expanded ? "Collapse Agents" : "Expand Agents"}
          onClick={() => setExpanded((v) => !v)}
          className="tap-target inline-flex h-7 w-5 flex-shrink-0 items-center justify-center text-muted-foreground"
        >
          <motion.span
            animate={{ rotate: expanded ? 90 : 0 }}
            transition={SPRING}
            className="inline-flex"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </motion.span>
        </button>
        <Link
          href="/dashboard/agents"
          onClick={onNavigate}
          className={cn(
            "group relative flex flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors",
            pathname === "/dashboard/agents"
              ? "text-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {pathname === "/dashboard/agents" && (
            <motion.span
              layoutId="sidebar-active"
              className="absolute inset-0 rounded-lg bg-muted"
              transition={SPRING}
            />
          )}
          <span className="relative z-10 inline-flex">
            <Bot className="h-4 w-4" />
          </span>
          <span className="relative z-10 flex-1">Agents</span>
        </Link>
      </div>

      {expanded && (
        <ul className="ml-4 mt-0.5 space-y-0.5 border-l border-border/50 pl-2">
          {AGENT_SUBLINKS.map(({ key, label, Icon }) => {
            const isActive = onAgents && (activeTab ?? "") === key;
            return (
              <li key={key || "home"}>
                <Link
                  href={key ? `/dashboard/agents?tab=${key}` : "/dashboard/agents"}
                  onClick={onNavigate}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-2.5 py-1 text-sm transition-colors",
                    isActive
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <Icon className="h-3.5 w-3.5 flex-shrink-0" />
                  <span className="truncate">{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Create ("New") menu ──────────────────────────────────────────────────────

type NewStep =
  | { kind: "menu" }
  | { kind: "space"; action: "list" | "doc" | "board" | "template" }
  | { kind: "name"; spaceId: Id<"spaces"> };

function allSpaces(
  tree: SidebarTree,
): { id: Id<"spaces">; label: string; sub: string }[] {
  const out: { id: Id<"spaces">; label: string; sub: string }[] = [];
  if (tree.personal)
    out.push({ id: tree.personal._id, label: tree.personal.name, sub: "Personal" });
  for (const ws of tree.workspaces)
    for (const s of ws.spaces)
      out.push({ id: s._id, label: s.name, sub: ws.name });
  return out;
}

function NewButton({
  tree,
  collapsed,
  onNavigate,
}: {
  tree: SidebarTree | null | undefined;
  collapsed: boolean;
  onNavigate: () => void;
}) {
  const router = useRouter();
  const createList = useMutation(api.lists.create);
  const createDoc = useMutation(api.docs.create);
  const createWhiteboard = useMutation(api.whiteboards.create);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<NewStep>({ kind: "menu" });
  const [templateSpace, setTemplateSpace] = useState<Id<"spaces"> | null>(null);
  const [wsDialog, setWsDialog] = useState(false);

  const spaces = tree ? allSpaces(tree) : [];

  function reset() {
    setOpen(false);
    setStep({ kind: "menu" });
  }

  async function createIn(
    action: "doc" | "board",
    spaceId: Id<"spaces">,
  ) {
    if (action === "doc") {
      const docId = await createDoc({
        parentType: "space",
        parentId: spaceId,
        title: "Untitled",
      });
      onNavigate();
      router.push(`/dashboard/d/${docId}`);
    } else {
      const wbId = await createWhiteboard({
        parentType: "space",
        parentId: spaceId,
        title: "Untitled board",
      });
      onNavigate();
      router.push(`/dashboard/wb/${wbId}`);
    }
    reset();
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Create new"
        className={cn(
          "bento-sm group relative flex w-full items-center gap-2 rounded-lg bg-background text-sm font-medium transition-transform active:scale-[0.98]",
          collapsed
            ? "md:justify-center md:px-0 md:py-2 px-2.5 py-1.5"
            : "px-2.5 py-1.5",
        )}
      >
        <Plus className="h-4 w-4 flex-shrink-0" />
        <span className={cn("flex-1 text-left", collapsed && "md:hidden")}>
          New
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-muted-foreground transition-transform",
            collapsed && "md:hidden",
            open && "rotate-180",
          )}
        />
        {collapsed && <RailTip label="New" />}
      </button>

      <AnimatePresence>
        {open && (
          <>
            <div
              aria-hidden
              className="fixed inset-0 z-40"
              onClick={reset}
            />
            <motion.div
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.15 }}
              className={cn(
                "absolute z-50 mt-1 w-60 overflow-hidden rounded-xl border border-border bg-background p-1 shadow-lg",
                collapsed ? "left-full ml-2 top-0" : "left-0 top-full",
              )}
            >
              {step.kind === "menu" && (
                <MenuList>
                  <MenuItem
                    icon={ListIcon}
                    label="New task"
                    hint="⌘K"
                    onClick={() => {
                      reset();
                      window.dispatchEvent(
                        new CustomEvent("open-command-palette"),
                      );
                    }}
                  />
                  <MenuItem
                    icon={ListIcon}
                    label="New list"
                    onClick={() => setStep({ kind: "space", action: "list" })}
                  />
                  <MenuItem
                    icon={FileText}
                    label="New doc"
                    onClick={() => setStep({ kind: "space", action: "doc" })}
                  />
                  <MenuItem
                    icon={LayoutGrid}
                    label="New whiteboard"
                    onClick={() => setStep({ kind: "space", action: "board" })}
                  />
                  <MenuItem
                    icon={Columns3}
                    label="List from template"
                    onClick={() =>
                      setStep({ kind: "space", action: "template" })
                    }
                  />
                  <div className="my-1 h-px bg-border" />
                  <MenuItem
                    icon={Plus}
                    label="New workspace"
                    onClick={() => {
                      reset();
                      setWsDialog(true);
                    }}
                  />
                </MenuList>
              )}

              {step.kind === "space" && (
                <div>
                  <MenuHeader
                    label={`Create ${
                      step.action === "board"
                        ? "whiteboard"
                        : step.action === "template"
                          ? "list"
                          : step.action
                    } in…`}
                    onBack={() => setStep({ kind: "menu" })}
                  />
                  <MenuList>
                    {spaces.length === 0 && (
                      <p className="px-3 py-2 text-xs text-muted-foreground">
                        No spaces yet.
                      </p>
                    )}
                    {spaces.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => {
                          if (step.action === "list")
                            setStep({ kind: "name", spaceId: s.id });
                          else if (step.action === "template") {
                            setTemplateSpace(s.id);
                            reset();
                          } else createIn(step.action, s.id);
                        }}
                        className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-muted"
                      >
                        <span className="truncate">{s.label}</span>
                        <span className="flex-shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                          {s.sub}
                        </span>
                      </button>
                    ))}
                  </MenuList>
                </div>
              )}

              {step.kind === "name" && (
                <div className="p-1.5">
                  <MenuHeader
                    label="Name your list"
                    onBack={() => setStep({ kind: "space", action: "list" })}
                  />
                  <div className="px-1 pt-1">
                    <InlineCreate
                      placeholder="List name…"
                      onCancel={reset}
                      onSubmit={async (name) => {
                        const listId = await createList({
                          name,
                          parentType: "space",
                          parentId: step.spaceId,
                        });
                        onNavigate();
                        router.push(`/dashboard/l/${listId}`);
                        reset();
                      }}
                    />
                  </div>
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {templateSpace && (
        <TemplatePicker
          open
          parent={{ kind: "space", spaceId: templateSpace }}
          onClose={() => setTemplateSpace(null)}
          onCreated={(listId) => {
            setTemplateSpace(null);
            onNavigate();
            router.push(`/dashboard/l/${listId}`);
          }}
        />
      )}
      <NewWorkspaceDialog open={wsDialog} onClose={() => setWsDialog(false)} />
    </div>
  );
}

function MenuList({ children }: { children: React.ReactNode }) {
  return <div className="space-y-0.5">{children}</div>;
}

function MenuItem({
  icon: Icon,
  label,
  hint,
  onClick,
}: {
  icon: typeof Bot;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-foreground/90 hover:bg-muted"
    >
      <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
      <span className="flex-1">{label}</span>
      {hint && (
        <kbd className="rounded-md border border-border px-1 py-0.5 text-[10px] text-muted-foreground">
          {hint}
        </kbd>
      )}
    </button>
  );
}

function MenuHeader({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <div className="mb-1 flex items-center gap-1.5 px-1.5 py-1">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back"
        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <ChevronRight className="h-3.5 w-3.5 rotate-180" />
      </button>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
    </div>
  );
}

// ── Admin ────────────────────────────────────────────────────────────────────

function AdminLink({
  onNavigate,
  collapsed,
}: {
  onNavigate: () => void;
  collapsed: boolean;
}) {
  const pathname = usePathname();
  const me = useQuery(api.admin.me, {});
  if (!me) return null;
  const active = pathname.startsWith("/dashboard/admin");
  return (
    <div className={cn("shrink-0 px-3 pb-1 pt-2", collapsed && "md:px-2")}>
      <Link
        href="/dashboard/admin"
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          "group relative flex items-center gap-2 rounded-lg text-sm transition-colors",
          collapsed
            ? "md:justify-center md:px-0 md:py-2 px-2.5 py-1.5"
            : "px-2.5 py-1.5",
          active
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <span className="inline-flex">
          <ShieldCheck className="h-4 w-4" />
        </span>
        <span className={cn("flex-1", collapsed && "md:hidden")}>
          Admin console
        </span>
        <span
          className={cn(
            "rounded-full bg-foreground/90 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-background",
            collapsed && "md:hidden",
          )}
        >
          {me.role === "superadmin" ? "Super" : "Admin"}
        </span>
        {collapsed && <RailTip label="Admin console" />}
      </Link>
    </div>
  );
}

// ── Collapsed rail: workspace tiles ─────────────────────────────────────────

function CollapsedWorkspaceTiles({
  tree,
  onNavigate,
}: {
  tree: SidebarTree | null | undefined;
  onNavigate: () => void;
}) {
  const pathname = usePathname();
  if (!tree) return null;
  return (
    <div className="hidden flex-col items-center gap-1.5 md:flex">
      {tree.personal && (
        <Link
          href="/dashboard/personal"
          onClick={onNavigate}
          className={cn(
            "group relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-sm transition-colors",
            pathname === "/dashboard/personal"
              ? "bg-muted"
              : "hover:bg-muted",
          )}
        >
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: tree.personal.color ?? "#a9c6f2" }}
          />
          <RailTip label={tree.personal.name} />
        </Link>
      )}
      {tree.workspaces.map((ws) => {
        const active = pathname.startsWith(`/dashboard/w/${ws._id}`);
        const initials = ws.name
          .split(/\s+/)
          .map((w) => w[0])
          .join("")
          .slice(0, 2)
          .toUpperCase();
        return (
          <Link
            key={ws._id}
            href={`/dashboard/w/${ws._id}`}
            onClick={onNavigate}
            className={cn(
              "group relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-[11px] font-semibold transition-colors",
              active
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            {initials || "W"}
            <RailTip label={ws.name} />
          </Link>
        );
      })}
    </div>
  );
}

// ── Tree ────────────────────────────────────────────────────────────────────

function SidebarLoading() {
  return (
    <div className="space-y-2 p-2">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-6 animate-pulse rounded-lg bg-muted"
          style={{ width: `${60 + i * 10}%` }}
        />
      ))}
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <h3 className="px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {label}
    </h3>
  );
}

function SidebarTreeView({
  tree,
  onNavigate,
}: {
  tree: SidebarTree;
  onNavigate: () => void;
}) {
  const [wsDialog, setWsDialog] = useState(false);
  return (
    <>
      <NewWorkspaceDialog open={wsDialog} onClose={() => setWsDialog(false)} />
      <SectionHeader label="Personal" />
      {tree.personal ? (
        <SpaceBranch
          space={tree.personal}
          onNavigate={onNavigate}
          linkHref="/dashboard/personal"
        />
      ) : (
        <p className="px-2 py-1 text-xs text-muted-foreground">Setting up…</p>
      )}

      <div className="mt-6 flex items-center justify-between">
        <SectionHeader label="Team workspaces" />
        <button
          type="button"
          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Create workspace"
          onClick={() => setWsDialog(true)}
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      <ul className="mt-1 space-y-2">
        {tree.workspaces.length === 0 && (
          <li>
            <button
              type="button"
              onClick={() => setWsDialog(true)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" /> Create a workspace
            </button>
          </li>
        )}
        {tree.workspaces.map((ws) => (
          <li key={ws._id}>
            <WorkspaceBranch workspace={ws} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
    </>
  );
}

// Order + keys mirror workspace-view.tsx TABS exactly (load-bearing).
const WS_FEATURES = [
  { key: "overview", label: "Overview", Icon: LayoutDashboard },
  { key: "team", label: "Team", Icon: Users },
  { key: "chat", label: "Chat", Icon: MessageSquare },
  { key: "sprints", label: "Sprints", Icon: Zap },
  { key: "activity", label: "Activity", Icon: Activity },
  { key: "goals", label: "Goals", Icon: Target },
  { key: "reports", label: "Reports", Icon: BarChart3 },
  { key: "settings", label: "Settings", Icon: Settings },
] as const;

function WorkspaceFeatureGrid({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const onWs = pathname === `/dashboard/w/${workspaceId}`;
  const activeTab = onWs ? (searchParams.get("tab") ?? "overview") : null;

  return (
    <div className="mt-1 grid grid-cols-2 gap-0.5">
      {WS_FEATURES.map(({ key, label, Icon }) => {
        const active = activeTab === key;
        const href =
          key === "overview"
            ? `/dashboard/w/${workspaceId}`
            : `/dashboard/w/${workspaceId}?tab=${key}`;
        return (
          <Link
            key={key}
            href={href}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors",
              active
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="truncate">{label}</span>
          </Link>
        );
      })}
    </div>
  );
}

function useWorkspaceExpanded(
  workspaceId: string,
): [boolean, (v: boolean) => void] {
  const pathname = usePathname();
  const onThisWs = pathname.startsWith(`/dashboard/w/${workspaceId}`);
  const [expanded, setExpandedState] = useState(true);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`sidebar-ws-${workspaceId}`);
      if (saved !== null) setExpandedState(saved === "1");
      else if (onThisWs) setExpandedState(true);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);
  useEffect(() => {
    if (onThisWs) setExpandedState(true);
  }, [onThisWs]);
  const setExpanded = (v: boolean) => {
    setExpandedState(v);
    try {
      localStorage.setItem(`sidebar-ws-${workspaceId}`, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  };
  return [expanded, setExpanded];
}

function WorkspaceBranch({
  workspace,
  onNavigate,
}: {
  workspace: SidebarTree["workspaces"][number];
  onNavigate: () => void;
}) {
  const [expanded, setExpanded] = useWorkspaceExpanded(workspace._id);
  const [addingSpace, setAddingSpace] = useState(false);
  const createSpace = useMutation(api.spaces.create);

  return (
    <div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={expanded ? "Collapse" : "Expand"}
          onClick={() => setExpanded(!expanded)}
          className="tap-target inline-flex h-5 w-5 flex-shrink-0 items-center justify-center text-muted-foreground"
        >
          <motion.span
            animate={{ rotate: expanded ? 90 : 0 }}
            transition={SPRING}
            className="inline-flex"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </motion.span>
        </button>
        <Link
          href={`/dashboard/w/${workspace._id}`}
          onClick={onNavigate}
          className="flex flex-1 items-center gap-1 truncate rounded-lg px-2.5 py-1 text-sm font-medium hover:bg-muted"
        >
          <span className="truncate">{workspace.name}</span>
          <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">
            {workspace.role}
          </span>
        </Link>
        <button
          type="button"
          onClick={() => {
            setExpanded(true);
            setAddingSpace(true);
          }}
          aria-label="Add space"
          title="Add space"
          className="tap-target inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {expanded && (
        <div className="ml-4 mt-1 border-l border-border/50 pl-2">
          <WorkspaceFeatureGrid workspaceId={workspace._id} />

          <ul className="mt-1 space-y-2">
            {addingSpace && (
              <li>
                <InlineCreate
                  placeholder="Space name…"
                  onCancel={() => setAddingSpace(false)}
                  onSubmit={async (name) => {
                    await createSpace({
                      name,
                      parentType: "workspace",
                      parentId: workspace._id,
                    });
                    setAddingSpace(false);
                  }}
                />
              </li>
            )}
            {workspace.spaces.length === 0 && !addingSpace && (
              <li>
                <button
                  type="button"
                  onClick={() => setAddingSpace(true)}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Plus className="h-3.5 w-3.5" /> Add a space
                </button>
              </li>
            )}
            {workspace.spaces.map((space) => (
              <li key={space._id}>
                <SpaceBranch space={space} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Small dropdown menu for a space's "+" (create List/Doc/Whiteboard/…).
function SpaceCreateMenu({
  onPick,
}: {
  onPick: (kind: "list" | "doc" | "board" | "template" | "folder") => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Add to space"
        title="Add"
        className="tap-target inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      <AnimatePresence>
        {open && (
          <>
            <div
              aria-hidden
              className="fixed inset-0 z-40"
              onClick={() => setOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.15 }}
              className="absolute right-0 top-full z-50 mt-1 w-48 overflow-hidden rounded-xl border border-border bg-background p-1 shadow-lg"
            >
              {[
                { k: "list" as const, icon: ListIcon, label: "List" },
                { k: "doc" as const, icon: FileText, label: "Doc" },
                { k: "board" as const, icon: LayoutGrid, label: "Whiteboard" },
                {
                  k: "template" as const,
                  icon: Columns3,
                  label: "List from template",
                },
                { k: "folder" as const, icon: Folder, label: "Folder" },
              ].map(({ k, icon: Icon, label }) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onPick(k);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-muted"
                >
                  <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  {label}
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function SpaceBranch({
  space,
  onNavigate,
  linkHref,
}: {
  space: SpaceNode;
  onNavigate: () => void;
  linkHref?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [expanded, setExpanded] = useState(true);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [adding, setAdding] = useState<
    "folder" | "list" | "doc" | "board" | null
  >(null);
  const createFolder = useMutation(api.folders.create);
  const createList = useMutation(api.lists.create);
  const createDoc = useMutation(api.docs.create);
  const createWhiteboard = useMutation(api.whiteboards.create);

  async function submitAdd(name: string) {
    if (adding === "folder") {
      await createFolder({ spaceId: space._id, name });
    } else if (adding === "list") {
      await createList({ name, parentType: "space", parentId: space._id });
    } else if (adding === "doc") {
      const docId = await createDoc({
        parentType: "space",
        parentId: space._id,
        title: name,
      });
      onNavigate();
      router.push(`/dashboard/d/${docId}`);
    } else if (adding === "board") {
      const wbId = await createWhiteboard({
        parentType: "space",
        parentId: space._id,
        title: name,
      });
      onNavigate();
      router.push(`/dashboard/wb/${wbId}`);
    }
    setAdding(null);
  }

  const ADD_PLACEHOLDER: Record<string, string> = {
    folder: "Folder name…",
    list: "List name…",
    doc: "Doc title…",
    board: "Whiteboard title…",
  };

  const isEmpty =
    space.folders.length === 0 &&
    space.lists.length === 0 &&
    space.docs.length === 0 &&
    space.whiteboards.length === 0;

  const dot = (
    <span
      aria-hidden
      className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
      style={{ backgroundColor: space.color ?? "#a9c6f2" }}
    />
  );

  return (
    <div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={expanded ? "Collapse" : "Expand"}
          onClick={() => setExpanded((v) => !v)}
          className="tap-target inline-flex h-5 w-5 flex-shrink-0 items-center justify-center text-muted-foreground"
        >
          <motion.span
            animate={{ rotate: expanded ? 90 : 0 }}
            transition={SPRING}
            className="inline-flex"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </motion.span>
        </button>
        {linkHref ? (
          <Link
            href={linkHref}
            onClick={onNavigate}
            className={cn(
              "flex flex-1 items-center gap-2 truncate rounded-lg px-2.5 py-1 text-sm transition-colors",
              pathname === linkHref
                ? "bg-muted font-medium text-foreground"
                : "hover:bg-muted",
            )}
          >
            {dot}
            <span className="truncate">{space.name}</span>
          </Link>
        ) : (
          <span className="flex flex-1 items-center gap-2 truncate rounded-lg px-2.5 py-1 text-sm">
            {dot}
            <span className="truncate">{space.name}</span>
          </span>
        )}
        <SpaceCreateMenu
          onPick={(kind) => {
            setExpanded(true);
            if (kind === "template") setTemplateOpen(true);
            else setAdding(kind);
          }}
        />
      </div>

      {expanded && (
        <ul className="ml-4 mt-0.5 space-y-0.5 border-l border-border/50 pl-2">
          {adding && (
            <li className="py-1">
              <InlineCreate
                placeholder={ADD_PLACEHOLDER[adding]}
                onCancel={() => setAdding(null)}
                onSubmit={submitAdd}
              />
            </li>
          )}
          {isEmpty && !adding && (
            <li>
              <button
                type="button"
                onClick={() => setAdding("list")}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" /> Add a list
              </button>
            </li>
          )}
          {space.folders.map((folder) => (
            <li key={folder._id}>
              <FolderBranch folder={folder} onNavigate={onNavigate} />
            </li>
          ))}
          {space.lists.map((list) => (
            <li key={list._id}>
              <ListLink
                listId={list._id}
                name={list.name}
                onNavigate={onNavigate}
              />
            </li>
          ))}
          {space.docs.map((doc) => (
            <li key={doc._id}>
              <DocLink
                docId={doc._id}
                title={doc.title}
                active={pathname === `/dashboard/d/${doc._id}`}
                onNavigate={onNavigate}
              />
            </li>
          ))}
          {space.whiteboards.map((wb) => (
            <li key={wb._id}>
              <WhiteboardLink
                whiteboardId={wb._id}
                title={wb.title}
                active={pathname === `/dashboard/wb/${wb._id}`}
                onNavigate={onNavigate}
              />
            </li>
          ))}
        </ul>
      )}
      <TemplatePicker
        open={templateOpen}
        parent={{ kind: "space", spaceId: space._id }}
        onClose={() => setTemplateOpen(false)}
        onCreated={(listId) => {
          setTemplateOpen(false);
          onNavigate();
          router.push(`/dashboard/l/${listId}`);
        }}
      />
    </div>
  );
}

function FolderBranch({
  folder,
  onNavigate,
}: {
  folder: SpaceNode["folders"][number];
  onNavigate: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [addingList, setAddingList] = useState(false);
  const createList = useMutation(api.lists.create);

  return (
    <div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={expanded ? "Collapse" : "Expand"}
          onClick={() => setExpanded((v) => !v)}
          className="tap-target inline-flex h-5 w-5 flex-shrink-0 items-center justify-center text-muted-foreground"
        >
          <motion.span
            animate={{ rotate: expanded ? 90 : 0 }}
            transition={SPRING}
            className="inline-flex"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </motion.span>
        </button>
        <span className="flex flex-1 items-center truncate rounded-lg px-2.5 py-1 text-sm text-muted-foreground">
          {folder.name}
        </span>
        <button
          type="button"
          onClick={() => {
            setExpanded(true);
            setAddingList(true);
          }}
          aria-label="Add list"
          title="Add list"
          className="tap-target inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {expanded && (
        <ul className="ml-4 mt-0.5 space-y-0.5 border-l border-border/50 pl-2">
          {addingList && (
            <li className="py-1">
              <InlineCreate
                placeholder="List name…"
                onCancel={() => setAddingList(false)}
                onSubmit={async (name) => {
                  await createList({
                    name,
                    parentType: "folder",
                    parentId: folder._id,
                  });
                  setAddingList(false);
                }}
              />
            </li>
          )}
          {folder.lists.map((list) => (
            <li key={list._id}>
              <ListLink
                listId={list._id}
                name={list.name}
                onNavigate={onNavigate}
              />
            </li>
          ))}
          {folder.lists.length === 0 && !addingList && (
            <li>
              <button
                type="button"
                onClick={() => setAddingList(true)}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Plus className="h-3 w-3" /> Add list
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

// The four list views + settings, mirroring view-tabs.tsx. Shown inline under
// the active list so board/calendar/gantt are one click away.
const LIST_VIEWS = [
  { key: "list", label: "List", Icon: ListIcon },
  { key: "board", label: "Board", Icon: Columns3 },
  { key: "calendar", label: "Calendar", Icon: Calendar },
  { key: "gantt", label: "Gantt", Icon: GanttChart },
] as const;

function ListViewRail({ listId }: { listId: Id<"lists"> }) {
  const searchParams = useSearchParams();
  const activeView = searchParams.get("view") ?? "list";

  function href(key: string): string {
    const params = new URLSearchParams(searchParams.toString());
    if (key === "list") params.delete("view");
    else params.set("view", key);
    const qs = params.toString();
    return qs ? `/dashboard/l/${listId}?${qs}` : `/dashboard/l/${listId}`;
  }

  return (
    <div className="ml-6 mt-0.5 flex items-center gap-0.5">
      <div className="segmented p-0.5">
        {LIST_VIEWS.map(({ key, label, Icon }) => (
          <Link
            key={key}
            href={href(key)}
            aria-label={label}
            title={label}
            aria-current={activeView === key ? "page" : undefined}
            className={cn(
              "inline-flex h-6 w-6 items-center justify-center rounded-full transition-colors",
              activeView === key
                ? "segmented-on text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </Link>
        ))}
      </div>
      <Link
        href={`/dashboard/l/${listId}/settings`}
        aria-label="List settings"
        title="List settings"
        className="tap-target inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Settings className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}

function ListLink({
  listId,
  name,
  onNavigate,
}: {
  listId: Id<"lists">;
  name: string;
  onNavigate: () => void;
}) {
  const pathname = usePathname();
  // Active on the list page and its sub-routes (settings, task detail).
  const active = pathname.startsWith(`/dashboard/l/${listId}`);
  return (
    <div>
      <Link
        href={`/dashboard/l/${listId}`}
        onClick={onNavigate}
        className={cn(
          "flex items-center gap-2 rounded-lg px-2.5 py-1 text-sm transition-colors",
          active
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <ListIcon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
        <span className="truncate">{name}</span>
      </Link>
      {active && <ListViewRail listId={listId} />}
    </div>
  );
}

function DocLink({
  docId,
  title,
  active,
  onNavigate,
}: {
  docId: Id<"docs">;
  title: string;
  active: boolean;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={`/dashboard/d/${docId}`}
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-2 rounded-lg px-2.5 py-1 text-sm transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <FileText className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
      <span className="truncate">{title}</span>
    </Link>
  );
}

function WhiteboardLink({
  whiteboardId,
  title,
  active,
  onNavigate,
}: {
  whiteboardId: Id<"whiteboards">;
  title: string;
  active: boolean;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={`/dashboard/wb/${whiteboardId}`}
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-2 rounded-lg px-2.5 py-1 text-sm transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <LayoutGrid className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
      <span className="truncate">{title}</span>
    </Link>
  );
}
