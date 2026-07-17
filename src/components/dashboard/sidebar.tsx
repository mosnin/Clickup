"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { UserButton } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Columns3,
  FileText,
  Folder,
  Home,
  Inbox,
  LayoutGrid,
  List as ListIcon,
  ListTodo,
  Menu,
  PanelLeft,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  X,
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

// ── Anchored portal menu ─────────────────────────────────────────────────
//
// The sidebar's <aside> always carries a translate-x transform (mobile
// drawer + desktop resting state alike), which becomes the containing
// block for any descendant position:fixed element. Any dropdown that needs
// to escape the sidebar's clipping/scroll region — the New menu, the
// per-space "+" menu — portals to <body> and positions itself from the
// trigger's live bounding rect instead.

type MenuPlacement = "bottom-start" | "bottom-end" | "right-start";

function menuStyle(placement: MenuPlacement, rect: DOMRect): React.CSSProperties {
  if (placement === "right-start") {
    return { top: rect.top, left: rect.right + 8 };
  }
  if (placement === "bottom-end") {
    return {
      top: rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right),
    };
  }
  return { top: rect.bottom + 6, left: rect.left };
}

function AnchoredMenu({
  open,
  anchorRef,
  onClose,
  onEscape,
  placement = "bottom-start",
  widthClassName = "w-64",
  children,
}: {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onEscape?: () => void;
  placement?: MenuPlacement;
  widthClassName?: string;
  children: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!open) return;
    function update() {
      setRect(anchorRef.current?.getBoundingClientRect() ?? null);
    }
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        (onEscape ?? onClose)();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, onEscape]);

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && rect && (
        <>
          <div aria-hidden className="fixed inset-0 z-[60]" onClick={onClose} />
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            style={menuStyle(placement, rect)}
            className={cn(
              "fixed z-[61] overflow-hidden rounded-xl border border-border bg-background p-1 shadow-lg",
              widthClassName,
            )}
          >
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// ── Root ────────────────────────────────────────────────────────────────────

export function DashboardSidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, toggleCollapsed] = useCollapsed();
  const tree = useTreeQuery();
  const pathname = usePathname();
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
        {/* 1. Header */}
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

        {/* Fixed nav band: search, primary nav, New button. Stays put while
            the tree below scrolls. */}
        <div className={cn("shrink-0 px-3 pt-3", collapsed && "md:px-2")}>
          {/* 2. Search */}
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

          {/* 3. Primary nav */}
          <NavLink
            href="/dashboard"
            label="Home"
            icon={Home}
            active={pathname === "/dashboard"}
            collapsed={collapsed}
            onNavigate={close}
          />
          <NavLink
            href="/dashboard/my-work"
            label="My work"
            icon={ListTodo}
            active={pathname === "/dashboard/my-work"}
            collapsed={collapsed}
            onNavigate={close}
          />
          <InboxLink onNavigate={close} collapsed={collapsed} />
          <NavLink
            href="/dashboard/agents"
            label="Agents"
            icon={Bot}
            active={pathname.startsWith("/dashboard/agents")}
            collapsed={collapsed}
            onNavigate={close}
          />
          <NavLink
            href="/dashboard/brain"
            label="Brain"
            icon={Sparkles}
            active={pathname === "/dashboard/brain"}
            collapsed={collapsed}
            onNavigate={close}
          />

          {/* 4. New */}
          <div className="mt-1">
            <NewButton tree={tree} collapsed={collapsed} onNavigate={close} />
          </div>
        </div>

        {/* 5. Scrolling tree */}
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

        {/* 6. Footer */}
        <div
          className={cn(
            "shrink-0 space-y-2.5 px-3 pb-4 pt-2",
            collapsed && "md:px-2",
          )}
        >
          {collapsed ? (
            <div className="flex flex-col items-center gap-2">
              <ThemeToggle collapsed />
              <AdminLink onNavigate={close} collapsed />
              <UserButton afterSignOutUrl="/" />
            </div>
          ) : (
            <>
              <RunningTimerChip />
              <AdminLink onNavigate={close} collapsed={false} />
              <ThemeToggle />
              <div className="flex items-center gap-3 px-1">
                <UserButton afterSignOutUrl="/" />
                <span className="text-xs text-muted-foreground">Account</span>
              </div>
            </>
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
}: {
  href: string;
  label: string;
  icon: typeof Bot;
  active: boolean;
  collapsed: boolean;
  onNavigate: () => void;
  badge?: React.ReactNode;
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
      <span className={cn("relative z-10 flex-1 truncate", collapsed && "md:hidden")}>
        {label}
      </span>
      {badge}
      {collapsed && <RailTip label={label} />}
    </Link>
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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<NewStep>({ kind: "menu" });
  const [templateSpace, setTemplateSpace] = useState<Id<"spaces"> | null>(null);
  const [wsDialog, setWsDialog] = useState(false);

  // Always start fresh at the top of the menu whenever it (re)opens.
  useEffect(() => {
    if (open) setStep({ kind: "menu" });
  }, [open]);

  const spaces = tree ? allSpaces(tree) : [];

  function close() {
    setOpen(false);
  }

  function stepBackOrClose() {
    setStep((s) => {
      if (s.kind === "space") return { kind: "menu" };
      if (s.kind === "name") return { kind: "space", action: "list" };
      close();
      return s;
    });
  }

  async function createIn(action: "doc" | "board", spaceId: Id<"spaces">) {
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
    close();
  }

  return (
    <>
      <button
        ref={triggerRef}
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
        <span className={cn("flex-1 text-left", collapsed && "md:hidden")}>New</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-muted-foreground transition-transform",
            collapsed && "md:hidden",
            open && "rotate-180",
          )}
        />
        {collapsed && <RailTip label="New" />}
      </button>

      <AnchoredMenu
        open={open}
        anchorRef={triggerRef}
        onClose={close}
        onEscape={stepBackOrClose}
        placement={collapsed ? "right-start" : "bottom-start"}
        widthClassName="w-60"
      >
        {step.kind === "menu" && (
          <MenuList>
            <MenuItem
              icon={ListIcon}
              label="New task"
              hint="⌘K"
              onClick={() => {
                close();
                window.dispatchEvent(new CustomEvent("open-command-palette"));
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
              label="From template"
              onClick={() => setStep({ kind: "space", action: "template" })}
            />
            <div className="my-1 h-px bg-border" />
            <MenuItem
              icon={Plus}
              label="New workspace"
              onClick={() => {
                close();
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
                    ? "list from template"
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
                    if (step.action === "list") setStep({ kind: "name", spaceId: s.id });
                    else if (step.action === "template") {
                      setTemplateSpace(s.id);
                      close();
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
                onCancel={() => setStep({ kind: "space", action: "list" })}
                onSubmit={async (name) => {
                  const listId = await createList({
                    name,
                    parentType: "space",
                    parentId: step.spaceId,
                  });
                  onNavigate();
                  router.push(`/dashboard/l/${listId}`);
                  close();
                }}
              />
            </div>
          </div>
        )}
      </AnchoredMenu>

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
    </>
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

  if (collapsed) {
    return (
      <Link
        href="/dashboard/admin"
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          "group relative inline-flex h-9 w-9 items-center justify-center rounded-lg transition-colors",
          active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <ShieldCheck className="h-4 w-4" />
        <RailTip label="Admin console" />
      </Link>
    );
  }

  return (
    <Link
      href="/dashboard/admin"
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <ShieldCheck className="h-4 w-4 flex-shrink-0" />
      <span className="flex-1 truncate">Admin console</span>
      <span className="rounded-full bg-foreground/90 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-background">
        {me.role === "superadmin" ? "Super" : "Admin"}
      </span>
    </Link>
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
            pathname === "/dashboard/personal" ? "bg-muted" : "hover:bg-muted",
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
        <SpaceRow
          space={tree.personal}
          onNavigate={onNavigate}
          linkHref="/dashboard/personal"
        />
      ) : (
        <p className="px-2 py-1 text-xs text-muted-foreground">Setting up…</p>
      )}

      <div className="mt-6 flex items-center justify-between">
        <SectionHeader label="Workspaces" />
        <button
          type="button"
          className="tap-target inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Create workspace"
          onClick={() => setWsDialog(true)}
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      <ul className="mt-1 space-y-1">
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
            <WorkspaceRow workspace={ws} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
    </>
  );
}

function useWorkspaceExpanded(workspaceId: string): [boolean, (v: boolean) => void] {
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

// A workspace is a single row: chevron to expand, name links to its page.
// No feature-tab grid here — Overview/Team/Chat/Sprints/etc. are tabs on
// the workspace page itself.
function WorkspaceRow({
  workspace,
  onNavigate,
}: {
  workspace: SidebarTree["workspaces"][number];
  onNavigate: () => void;
}) {
  const pathname = usePathname();
  const [expanded, setExpanded] = useWorkspaceExpanded(workspace._id);
  const active = pathname === `/dashboard/w/${workspace._id}`;

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
          aria-current={active ? "page" : undefined}
          className={cn(
            "flex flex-1 items-center gap-1 truncate rounded-lg px-2.5 py-1 text-sm font-medium transition-colors",
            active ? "bg-muted text-foreground" : "hover:bg-muted",
          )}
        >
          <span className="truncate">{workspace.name}</span>
          <span className="ml-auto flex-shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
            {workspace.role}
          </span>
        </Link>
      </div>

      {expanded && (
        <div className="mt-1 space-y-1 pl-5">
          {workspace.spaces.length === 0 && (
            <p className="px-2.5 py-1 text-xs text-muted-foreground">No spaces yet.</p>
          )}
          {workspace.spaces.map((space) => (
            <SpaceRow key={space._id} space={space} onNavigate={onNavigate} />
          ))}
        </div>
      )}
    </div>
  );
}

// Small portaled menu for a space's "+" (create List/Doc/Whiteboard/Folder,
// or start From template). This plus the top-level New button are the only
// two create entry points anywhere in the sidebar.
const SPACE_CREATE_ITEMS = [
  { k: "list" as const, icon: ListIcon, label: "List" },
  { k: "doc" as const, icon: FileText, label: "Doc" },
  { k: "board" as const, icon: LayoutGrid, label: "Whiteboard" },
  { k: "template" as const, icon: Columns3, label: "From template" },
  { k: "folder" as const, icon: Folder, label: "Folder" },
];

function SpaceCreateMenu({
  onPick,
}: {
  onPick: (kind: "list" | "doc" | "board" | "template" | "folder") => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Add to space"
        aria-expanded={open}
        title="Add"
        className={cn(
          "tap-target inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100",
          open && "opacity-100",
        )}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      <AnchoredMenu
        open={open}
        anchorRef={triggerRef}
        onClose={() => setOpen(false)}
        placement="bottom-end"
        widthClassName="w-48"
      >
        <MenuList>
          {SPACE_CREATE_ITEMS.map(({ k, icon: Icon, label }) => (
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
        </MenuList>
      </AnchoredMenu>
    </>
  );
}

function SpaceRow({
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
  const [adding, setAdding] = useState<"folder" | "list" | "doc" | "board" | null>(
    null,
  );
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
      const docId = await createDoc({ parentType: "space", parentId: space._id, title: name });
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
      <div className="group flex items-center gap-1">
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
            aria-current={pathname === linkHref ? "page" : undefined}
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
        <div className="mt-0.5 space-y-0.5 pl-5">
          {adding && (
            <div className="py-1">
              <InlineCreate
                placeholder={ADD_PLACEHOLDER[adding]}
                onCancel={() => setAdding(null)}
                onSubmit={submitAdd}
              />
            </div>
          )}
          {isEmpty && !adding && (
            <p className="px-2.5 py-1 text-xs text-muted-foreground">Nothing here yet.</p>
          )}
          {space.folders.map((folder) => (
            <FolderRow key={folder._id} folder={folder} onNavigate={onNavigate} />
          ))}
          {space.lists.map((list) => (
            <ListRow key={list._id} listId={list._id} name={list.name} onNavigate={onNavigate} />
          ))}
          {space.docs.map((doc) => (
            <DocRow
              key={doc._id}
              docId={doc._id}
              title={doc.title}
              active={pathname === `/dashboard/d/${doc._id}`}
              onNavigate={onNavigate}
            />
          ))}
          {space.whiteboards.map((wb) => (
            <WhiteboardRow
              key={wb._id}
              whiteboardId={wb._id}
              title={wb.title}
              active={pathname === `/dashboard/wb/${wb._id}`}
              onNavigate={onNavigate}
            />
          ))}
        </div>
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

function FolderRow({
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
      <div className="group flex items-center gap-1">
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
        <span className="flex flex-1 items-center gap-2 truncate rounded-lg px-2.5 py-1 text-sm text-muted-foreground">
          <Folder className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
          <span className="truncate">{folder.name}</span>
        </span>
        <button
          type="button"
          onClick={() => {
            setExpanded(true);
            setAddingList(true);
          }}
          aria-label="Add list"
          title="Add list"
          className="tap-target inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {expanded && (
        <div className="mt-0.5 space-y-0.5 pl-5">
          {addingList && (
            <div className="py-1">
              <InlineCreate
                placeholder="List name…"
                onCancel={() => setAddingList(false)}
                onSubmit={async (name) => {
                  await createList({ name, parentType: "folder", parentId: folder._id });
                  setAddingList(false);
                }}
              />
            </div>
          )}
          {folder.lists.map((list) => (
            <ListRow key={list._id} listId={list._id} name={list.name} onNavigate={onNavigate} />
          ))}
          {folder.lists.length === 0 && !addingList && (
            <p className="px-2.5 py-1 text-xs text-muted-foreground">No lists yet.</p>
          )}
        </div>
      )}
    </div>
  );
}

function ListRow({
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
    <Link
      href={`/dashboard/l/${listId}`}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
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
  );
}

function DocRow({
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
      aria-current={active ? "page" : undefined}
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

function WhiteboardRow({
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
      aria-current={active ? "page" : undefined}
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
