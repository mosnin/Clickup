"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { UserButton } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  Inbox,
  LayoutGrid,
  Menu,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { PaceWordmark } from "@/components/brand/pace-mark";
import { RunningTimerChip } from "@/components/dashboard/running-timer-chip";
import { TemplatePicker } from "@/components/dashboard/template-picker";
import { useCommandPalette } from "@/components/dashboard/command-palette";

type SidebarTree = NonNullable<ReturnType<typeof useTreeQuery>>;
type SpaceNode = SidebarTree["workspaces"][number]["spaces"][number];

function useTreeQuery() {
  return useQuery(api.sidebar.tree, {});
}

export function DashboardSidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const tree = useTreeQuery();

  return (
    <>
      <button
        type="button"
        aria-label="Open navigation"
        onClick={() => setMobileOpen(true)}
        className="fixed left-3 top-3 z-40 inline-flex h-10 w-10 items-center justify-center rounded-full border border-border bg-background shadow-sm md:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      {mobileOpen && (
        <div
          aria-hidden
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-40 bg-foreground/40 backdrop-blur-sm md:hidden"
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-border bg-background transition-transform md:static md:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        )}
        aria-label="Sidebar"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <Link
            href="/dashboard"
            onClick={() => setMobileOpen(false)}
          >
            <PaceWordmark />
          </Link>
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full hover:bg-muted md:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-3">
          <RunningTimerChip />
          <SearchButton onNavigate={() => setMobileOpen(false)} />
          <BrainLink onNavigate={() => setMobileOpen(false)} />
          <InboxLink onNavigate={() => setMobileOpen(false)} />
          <TimeLink onNavigate={() => setMobileOpen(false)} />
          <TrashLink onNavigate={() => setMobileOpen(false)} />
          {tree === undefined ? (
            <SidebarLoading />
          ) : tree === null ? (
            <p className="px-2 text-sm text-muted-foreground">
              Sign in.
            </p>
          ) : (
            <SidebarTreeView
              tree={tree}
              onNavigate={() => setMobileOpen(false)}
            />
          )}
        </nav>

        <div className="flex items-center gap-3 border-t border-border px-4 py-3">
          <UserButton afterSignOutUrl="/" />
          <span className="text-xs text-muted-foreground">Account</span>
        </div>
      </aside>
    </>
  );
}

function SearchButton({ onNavigate }: { onNavigate: () => void }) {
  const { open } = useCommandPalette();
  return (
    <button
      type="button"
      onClick={() => {
        onNavigate();
        open();
      }}
      className="mb-1 flex w-full items-center gap-2 rounded-2xl px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <Search className="h-4 w-4" />
      <span className="flex-1 text-left">Search</span>
      <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
        ⌘K
      </kbd>
    </button>
  );
}

function BrainLink({ onNavigate }: { onNavigate: () => void }) {
  const pathname = usePathname();
  const active = pathname === "/dashboard/brain";
  return (
    <Link
      href="/dashboard/brain"
      onClick={onNavigate}
      className={cn(
        "mb-1 flex items-center gap-2 rounded-2xl px-2 py-1.5 text-sm transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Sparkles className="h-4 w-4" />
      <span>Brain</span>
    </Link>
  );
}

function TimeLink({ onNavigate }: { onNavigate: () => void }) {
  const pathname = usePathname();
  const active = pathname === "/dashboard/time" || pathname?.startsWith("/dashboard/time?");
  return (
    <Link
      href="/dashboard/time"
      onClick={onNavigate}
      className={cn(
        "mb-1 flex items-center gap-2 rounded-2xl px-2 py-1.5 text-sm transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Clock className="h-4 w-4" />
      <span>Time</span>
    </Link>
  );
}

function TrashLink({ onNavigate }: { onNavigate: () => void }) {
  const pathname = usePathname();
  const active = pathname === "/dashboard/trash";
  return (
    <Link
      href="/dashboard/trash"
      onClick={onNavigate}
      className={cn(
        "mb-3 flex items-center gap-2 rounded-2xl px-2 py-1.5 text-sm transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Trash2 className="h-4 w-4" />
      <span>Trash</span>
    </Link>
  );
}

function InboxLink({ onNavigate }: { onNavigate: () => void }) {
  const pathname = usePathname();
  const unread = useQuery(api.mentions.unreadCountForCurrent, {});
  const active = pathname === "/dashboard/inbox";

  return (
    <Link
      href="/dashboard/inbox"
      onClick={onNavigate}
      className={cn(
        "mb-1 flex items-center gap-2 rounded-2xl px-2 py-1.5 text-sm transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Inbox className="h-4 w-4" />
      <span className="flex-1">Inbox</span>
      {typeof unread === "number" && unread > 0 && (
        <span className="rounded-full bg-brand-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
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
  const createSpace = useMutation(api.spaces.create);

  async function onAddSpace() {
    const name = window.prompt("Space name");
    if (!name) return;
    await createSpace({
      name,
      parentType: "workspace",
      parentId: workspace._id,
    });
  }

  return (
    <div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={expanded ? "Collapse" : "Expand"}
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center text-muted-foreground"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        <Link
          href={`/dashboard/w/${workspace._id}`}
          onClick={onNavigate}
          className="flex flex-1 items-center gap-1 truncate rounded-2xl px-2 py-1 text-sm font-medium hover:bg-muted"
        >
          <span className="truncate">{workspace.name}</span>
          <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">
            {workspace.role}
          </span>
        </Link>
        <button
          type="button"
          onClick={onAddSpace}
          aria-label="Add space"
          className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {expanded && (
        <ul className="ml-4 mt-1 space-y-2 border-l border-border pl-2">
          {workspace.spaces.length === 0 && (
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
  const createFolder = useMutation(api.folders.create);
  const createList = useMutation(api.lists.create);
  const createDoc = useMutation(api.docs.create);
  const createWhiteboard = useMutation(api.whiteboards.create);

  async function onAddFolder() {
    const name = window.prompt("Folder name");
    if (!name) return;
    await createFolder({ spaceId: space._id, name });
  }
  async function onAddList() {
    const name = window.prompt("List name");
    if (!name) return;
    await createList({ name, parentType: "space", parentId: space._id });
  }
  async function onAddDoc() {
    const title = window.prompt("Doc title", "Untitled");
    if (title === null) return;
    const docId = await createDoc({
      parentType: "space",
      parentId: space._id,
      title,
    });
    onNavigate();
    router.push(`/dashboard/d/${docId}`);
  }
  async function onAddWhiteboard() {
    const title = window.prompt("Whiteboard title", "Untitled board");
    if (title === null) return;
    const wbId = await createWhiteboard({
      parentType: "space",
      parentId: space._id,
      title,
    });
    onNavigate();
    router.push(`/dashboard/wb/${wbId}`);
  }

  const dot = useMemo(
    () => (
      <span
        aria-hidden
        className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
        style={{ backgroundColor: space.color ?? "#6366f1" }}
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
          className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center text-muted-foreground"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        <span className="flex flex-1 items-center gap-2 truncate rounded-2xl px-2 py-1 text-sm">
          {dot}
          <span className="truncate">{space.name}</span>
        </span>
        <button
          type="button"
          onClick={onAddFolder}
          aria-label="Add folder"
          title="Add folder"
          className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {expanded && (
        <ul className="ml-4 mt-0.5 space-y-0.5 border-l border-border pl-2">
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
            <AddButton onClick={onAddList}>list</AddButton>
            <AddButton onClick={() => setTemplateOpen(true)}>
              from template
            </AddButton>
            <AddButton onClick={onAddDoc}>doc</AddButton>
            <AddButton onClick={onAddWhiteboard}>board</AddButton>
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
      className="inline-flex items-center gap-1 rounded-2xl px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
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
  const createList = useMutation(api.lists.create);

  async function onAddList() {
    const name = window.prompt("List name");
    if (!name) return;
    await createList({ name, parentType: "folder", parentId: folder._id });
  }

  return (
    <div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={expanded ? "Collapse" : "Expand"}
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center text-muted-foreground"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        <span className="flex flex-1 items-center truncate rounded-2xl px-2 py-1 text-sm text-muted-foreground">
          {folder.name}
        </span>
        <button
          type="button"
          onClick={onAddList}
          aria-label="Add list"
          title="Add list"
          className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {expanded && (
        <ul className="ml-4 mt-0.5 space-y-0.5 border-l border-border pl-2">
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
          {folder.lists.length === 0 && (
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
        "flex items-center gap-2 rounded-2xl px-2 py-1 text-sm transition-colors",
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
        "flex items-center gap-2 rounded-2xl px-2 py-1 text-sm transition-colors",
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
        "flex items-center gap-2 rounded-2xl px-2 py-1 text-sm transition-colors",
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
