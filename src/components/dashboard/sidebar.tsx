"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { UserButton } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import {
  Bot,
  ChevronRight,
  FileText,
  Inbox,
  LayoutGrid,
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

// Desktop collapse state, persisted so the choice survives reloads. On < md
// the sidebar is a drawer and this is ignored.
function useCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("sidebar-collapsed") === "1");
    } catch {
      /* private mode / no storage — default expanded */
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

// A right-anchored tooltip that appears on hover, used for the icon rail so
// collapsed nav items stay legible. Pure CSS group-hover — no JS per item.
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
import { InlineCreate } from "@/components/dashboard/inline-create";
import { RunningTimerChip } from "@/components/dashboard/running-timer-chip";
import { TemplatePicker } from "@/components/dashboard/template-picker";

type SidebarTree = NonNullable<ReturnType<typeof useTreeQuery>>;
type SpaceNode = SidebarTree["workspaces"][number]["spaces"][number];

function useTreeQuery() {
  return useQuery(api.sidebar.tree, {});
}

export function DashboardSidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, toggleCollapsed] = useCollapsed();
  const tree = useTreeQuery();
  // Collapse only applies on desktop; the mobile drawer always shows full.
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
          "group/side fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-border bg-background transition-[transform,width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] md:static md:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
          collapsed && "md:w-[4.75rem]",
        )}
        aria-label="Sidebar"
      >
        <div
          className={cn(
            "flex items-center border-b border-border px-3 py-3",
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
          {/* Desktop collapse toggle. */}
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

        <nav
          className={cn(
            "flex-1 overflow-y-auto overflow-x-hidden p-3",
            collapsed && "md:px-2",
          )}
        >
          {!collapsed && <RunningTimerChip />}
          <button
            type="button"
            onClick={() => {
              close();
              window.dispatchEvent(new CustomEvent("open-command-palette"));
            }}
            className={cn(
              "group relative mb-2 flex w-full items-center gap-2 rounded-lg border border-border text-sm text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground",
              collapsed ? "md:justify-center md:px-0 md:py-2 px-2.5 py-1.5" : "px-2.5 py-1.5",
            )}
          >
            <Search className="h-4 w-4 flex-shrink-0" />
            <span className={cn("flex-1 text-left", collapsed && "md:hidden")}>
              Search
            </span>
            <kbd
              className={cn(
                "rounded-md border border-border px-1.5 py-0.5 text-[10px]",
                collapsed && "md:hidden",
              )}
            >
              ⌘K
            </kbd>
            {collapsed && <RailTip label="Search  ⌘K" />}
          </button>
          <BrainLink onNavigate={close} collapsed={collapsed} />
          <AgentsLink onNavigate={close} collapsed={collapsed} />
          <InboxLink onNavigate={close} collapsed={collapsed} />
          {/* The workspace tree only renders in the expanded rail. */}
          {!collapsed &&
            (tree === undefined ? (
              <SidebarLoading />
            ) : tree === null ? (
              <p className="px-2 text-sm text-muted-foreground">
                Sign in to see your spaces.
              </p>
            ) : (
              <SidebarTreeView tree={tree} onNavigate={close} />
            ))}
        </nav>

        <AdminLink onNavigate={close} collapsed={collapsed} />

        <div
          className={cn(
            "flex items-center gap-3 border-t border-border px-4 py-3",
            collapsed && "md:justify-center md:px-0",
          )}
        >
          <UserButton afterSignOutUrl="/" />
          <span className={cn("text-xs text-muted-foreground", collapsed && "md:hidden")}>
            Account
          </span>
        </div>
      </aside>
    </>
  );
}

// Only rendered for platform admins (api.admin.me returns null otherwise).
// The link lives above the account footer, visually separated.
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
    <div className={cn("border-t border-border p-3", collapsed && "md:px-2")}>
      <Link
        href="/dashboard/admin"
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          "group relative flex items-center gap-2 rounded-lg text-sm transition-colors",
          collapsed ? "md:justify-center md:px-0 md:py-2 px-2.5 py-1.5" : "px-2.5 py-1.5",
          active
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <motion.span
          whileHover={{ scale: 1.12 }}
          whileTap={{ scale: 0.9 }}
          transition={SPRING}
          className="inline-flex"
        >
          <ShieldCheck className="h-4 w-4" />
        </motion.span>
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

// Shared primary-nav row. Handles the active-pill morph (layoutId), the
// collapsed icon-rail layout + tooltip, and icon press/hover micro-motion.
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
        collapsed ? "md:justify-center md:px-0 md:py-2 px-2.5 py-1.5" : "px-2.5 py-1.5",
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

function AgentsLink({
  onNavigate,
  collapsed,
}: {
  onNavigate: () => void;
  collapsed: boolean;
}) {
  const pathname = usePathname();
  return (
    <NavLink
      href="/dashboard/agents"
      label="Agents"
      icon={Bot}
      active={pathname === "/dashboard/agents"}
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
  const unread = useQuery(api.mentions.unreadCountForCurrent, {});
  const hasUnread = typeof unread === "number" && unread > 0;

  return (
    <NavLink
      href="/dashboard/inbox"
      label="Inbox"
      icon={Inbox}
      active={pathname === "/dashboard/inbox"}
      collapsed={collapsed}
      onNavigate={onNavigate}
      className="mb-3"
      badge={
        hasUnread ? (
          <span
            className={cn(
              "relative z-10 rounded-full bg-brand-600 px-1.5 py-0.5 text-[10px] font-medium text-white",
              // In the rail the count rides the top-right of the icon.
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

function SidebarLoading() {
  return (
    <div className="space-y-2 p-2">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-6 animate-pulse rounded-2xl bg-muted"
          style={{ width: `${60 + i * 10}%` }}
        />
      ))}
    </div>
  );
}

function SidebarTreeView({
  tree,
  onNavigate,
}: {
  tree: SidebarTree;
  onNavigate: () => void;
}) {
  return (
    <>
      <SectionHeader label="Personal" />
      {tree.personal ? (
        <SpaceBranch space={tree.personal} onNavigate={onNavigate} />
      ) : (
        <p className="px-2 py-1 text-xs text-muted-foreground">Setting up…</p>
      )}

      <div className="mt-6 flex items-center justify-between">
        <SectionHeader label="Team workspaces" />
        <Link
          href="/onboarding"
          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Create workspace"
          onClick={onNavigate}
        >
          <Plus className="h-4 w-4" />
        </Link>
      </div>
      <ul className="mt-1 space-y-2">
        {tree.workspaces.length === 0 && (
          <li className="px-2 py-1 text-xs text-muted-foreground">
            No team workspaces yet.
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

function WorkspaceBranch({
  workspace,
  onNavigate,
}: {
  workspace: SidebarTree["workspaces"][number];
  onNavigate: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [addingSpace, setAddingSpace] = useState(false);
  const createSpace = useMutation(api.spaces.create);

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
          className="tap-target inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {expanded && (
        <ul className="ml-4 mt-1 space-y-2 border-l border-border pl-2">
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
            <li className="px-2 py-1 text-xs text-muted-foreground">
              No spaces yet.
            </li>
          )}
          {workspace.spaces.map((space) => (
            <li key={space._id}>
              <SpaceBranch space={space} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SpaceBranch({
  space,
  onNavigate,
}: {
  space: SpaceNode;
  onNavigate: () => void;
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

  const dot = useMemo(
    () => (
      <span
        aria-hidden
        className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
        style={{ backgroundColor: space.color ?? "#a9c6f2" }}
      />
    ),
    [space.color],
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
        <span className="flex flex-1 items-center gap-2 truncate rounded-lg px-2.5 py-1 text-sm">
          {dot}
          <span className="truncate">{space.name}</span>
        </span>
        <button
          type="button"
          onClick={() => {
            setExpanded(true);
            setAdding("folder");
          }}
          aria-label="Add folder"
          title="Add folder"
          className="tap-target inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {expanded && (
        <ul className="ml-4 mt-0.5 space-y-0.5 border-l border-border pl-2">
          {adding && (
            <li className="py-1">
              <InlineCreate
                placeholder={ADD_PLACEHOLDER[adding]}
                onCancel={() => setAdding(null)}
                onSubmit={submitAdd}
              />
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
                active={pathname === `/dashboard/l/${list._id}`}
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
          <li className="mt-1 flex flex-wrap gap-1">
            <AddButton onClick={() => setAdding("list")}>list</AddButton>
            <AddButton onClick={() => setTemplateOpen(true)}>
              from template
            </AddButton>
            <AddButton onClick={() => setAdding("doc")}>doc</AddButton>
            <AddButton onClick={() => setAdding("board")}>board</AddButton>
          </li>
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

function AddButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <Plus className="h-3 w-3" /> {children}
    </button>
  );
}

function FolderBranch({
  folder,
  onNavigate,
}: {
  folder: SpaceNode["folders"][number];
  onNavigate: () => void;
}) {
  const pathname = usePathname();
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
        <ul className="ml-4 mt-0.5 space-y-0.5 border-l border-border pl-2">
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
                active={pathname === `/dashboard/l/${list._id}`}
                onNavigate={onNavigate}
              />
            </li>
          ))}
          {folder.lists.length === 0 && !addingList && (
            <li className="px-2 py-1 text-xs text-muted-foreground">Empty</li>
          )}
        </ul>
      )}
    </div>
  );
}

function ListLink({
  listId,
  name,
  active,
  onNavigate,
}: {
  listId: Id<"lists">;
  name: string;
  active: boolean;
  onNavigate: () => void;
}) {
  return (
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
      <span aria-hidden>›</span>
      <span className="truncate">{name}</span>
    </Link>
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

function SectionHeader({ label }: { label: string }) {
  return (
    <h3 className="px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {label}
    </h3>
  );
}
