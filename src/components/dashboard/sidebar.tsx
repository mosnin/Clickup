"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { UserButton } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Columns3,
  FileText,
  Folder,
  FolderInput,
  FolderKanban,
  LayoutTemplate,
  Home,
  Inbox,
  LayoutGrid,
  List as ListIcon,
  ListTodo,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Picker } from "@/components/ui/picker";
import { InlineCreate } from "@/components/dashboard/inline-create";
import { Orb } from "@/components/dashboard/orb";
import { RunningTimerChip } from "@/components/dashboard/running-timer-chip";
import { TemplatePicker } from "@/components/dashboard/template-picker";
import { NewWorkspaceDialog } from "@/components/dashboard/new-workspace-dialog";
import { ThemeToggle } from "@/components/theme-toggle";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { useFolderExpanded } from "@/lib/folder-collapse";

type SidebarTree = NonNullable<ReturnType<typeof useTreeQuery>>;
type SpaceNode = SidebarTree["workspaces"][number]["spaces"][number];

function useTreeQuery() {
  return useQuery(api.sidebar.tree, {});
}

// (No local initial-of helper: every identity mark in this tree renders
// through <Orb label=…> / <Monogram>, which derive the initial and the
// color from the shared identity ramp themselves.)

// ── Root ─────────────────────────────────────────────────────────────────
//
// Rebuilt on the vendored Square dashboard-5 sidebar primitives
// (src/components/ui/sidebar.tsx). There is exactly ONE SidebarProvider for
// the whole dashboard shell — it lives in src/app/dashboard/layout.tsx and
// wraps both this sidebar and the SidebarInset. This component only renders
// the <Sidebar> itself and consumes the outer provider's context; it must
// never instantiate a second SidebarProvider (that would double the
// open/openMobile state and the ⌘/Ctrl+B keydown listener). Offcanvas-on-
// mobile (Sheet) + icon-rail-on-desktop collapse + cookie persistence all
// come from the primitive for free; the old hand-rolled drawer/backdrop/
// rail/localStorage logic is gone. The mobile "open navigation" affordance
// lives inside PageHeader (src/components/dashboard/page-header.tsx) rather
// than as a floating button here, so it never overlaps page content.

export function DashboardSidebar() {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();

  // Close the mobile drawer on every navigation — covers every link in the
  // tree (nav items, favorites, spaces/folders/lists, docs, whiteboards,
  // admin) without wiring each one individually.
  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeaderSwitcher />
      <SidebarContentBody />
      <SidebarFooterBody />
      <SidebarRail />
    </Sidebar>
  );
}

// ── Header: workspace switcher ──────────────────────────────────────────
//
// "Current" is content-derived: any /dashboard/w|s|l|d|wb/[id] URL is
// resolved against the tree to find which workspace (if any) owns that id,
// so opening a workspace-owned space/list/task/doc/whiteboard keeps the
// header switcher and content tree pinned to that workspace instead of
// silently collapsing to the personal space. Picking a different entry in
// the switcher just navigates — there is no separate client-side "selected
// workspace" state.

// `wb` must be tried before `w` so `/dashboard/wb/:id` doesn't get cut short
// at the `w` alternative (JS regex alternation backtracks, but ordering the
// longer alternative first keeps this obviously correct without relying on
// it).
const CONTENT_ID_RE = /^\/dashboard\/(?:wb|w|s|l|d)\/([^/]+)/;

function useCurrentContext(tree: SidebarTree | null | undefined) {
  const pathname = usePathname();
  const id = CONTENT_ID_RE.exec(pathname)?.[1];

  // Reverse lookup from every id a workspace subtree owns (the workspace
  // itself, its spaces, folders, space-direct + folder-nested lists, docs,
  // whiteboards) back to that workspace. Built once per tree/pathname
  // change rather than walked on every render.
  const idToWorkspace = useMemo(() => {
    const map = new Map<string, SidebarTree["workspaces"][number]>();
    for (const workspace of tree?.workspaces ?? []) {
      map.set(workspace._id, workspace);
      for (const space of workspace.spaces) {
        map.set(space._id, workspace);
        for (const list of space.lists) map.set(list._id, workspace);
        for (const doc of space.docs) map.set(doc._id, workspace);
        for (const wb of space.whiteboards) map.set(wb._id, workspace);
        for (const folder of space.folders) {
          map.set(folder._id, workspace);
          for (const list of folder.lists) map.set(list._id, workspace);
        }
      }
    }
    return map;
  }, [tree]);

  const workspace = id ? idToWorkspace.get(id) : undefined;
  if (workspace) return { kind: "workspace" as const, workspace };
  return { kind: "personal" as const };
}

function SidebarHeaderSwitcher() {
  const tree = useTreeQuery();
  const [wsDialogOpen, setWsDialogOpen] = useState(false);
  const ctx = useCurrentContext(tree);

  const currentName =
    ctx.kind === "workspace" ? ctx.workspace.name : (tree?.personal?.name ?? "Personal");
  // Identity marks are seeded by the entity's stable id, never by its name
  // or a flat brand fill, so a workspace/space is the same color here, in
  // the tree, and everywhere else it appears (lib/identity-color).
  const currentSeed =
    ctx.kind === "workspace"
      ? ctx.workspace._id
      : (tree?.personal?._id ?? tree?.currentClerkId ?? "personal");

  return (
    <SidebarHeader>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex w-full min-w-0 items-center gap-2 rounded-lg p-1 text-left outline-none hover:bg-sidebar-accent group-data-[collapsible=icon]:justify-center">
          <Orb seed={currentSeed} label={currentName} shape="squircle" size="sm" />
          <span className="min-w-0 flex-1 truncate font-semibold text-sidebar-foreground group-data-[collapsible=icon]:hidden">
            {currentName}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
            Spaces
          </DropdownMenuLabel>
          {tree?.personal && (
            <DropdownMenuItem asChild>
              <Link href="/dashboard/personal">
                <Orb
                  seed={tree.personal._id}
                  label={tree.personal.name}
                  shape="squircle"
                  size="xs"
                  className="mr-1 h-5 w-5 text-[9px]"
                />
                <span className="truncate">{tree.personal.name}</span>
                {ctx.kind === "personal" && <Check className="ml-auto size-4" />}
              </Link>
            </DropdownMenuItem>
          )}
          {tree?.workspaces.map((ws) => (
            <DropdownMenuItem key={ws._id} asChild>
              <Link href={`/dashboard/w/${ws._id}`}>
                <Orb
                  seed={ws._id}
                  label={ws.name}
                  shape="squircle"
                  size="xs"
                  className="mr-1 h-5 w-5 text-[9px]"
                />
                <span className="min-w-0 flex-1 truncate">{ws.name}</span>
                <span className="flex-shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
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
      <NewWorkspaceDialog open={wsDialogOpen} onClose={() => setWsDialogOpen(false)} />
    </SidebarHeader>
  );
}

// ── Content ──────────────────────────────────────────────────────────────

function SidebarContentBody() {
  const tree = useTreeQuery();
  const ctx = useCurrentContext(tree);

  return (
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SearchMenuItem />
            <NavMenuItem
              href="/dashboard"
              label="Home"
              icon={Home}
              iconColor="text-sky-500"
              exact
            />
            <InboxMenuItem />
            <NavMenuItem
              href="/dashboard/my-work"
              label="My work"
              icon={ListTodo}
              iconColor="text-emerald-500"
              exact
            />
            <NavMenuItem
              href="/dashboard/spaces"
              label="Spaces"
              icon={FolderKanban}
              iconColor="text-amber-500"
              exact
            />
            <NavMenuItem
              href="/dashboard/agents"
              label="Agents"
              icon={Bot}
              iconColor="text-violet-500"
            />
            <NavMenuItem
              href="/dashboard/templates"
              label="Templates"
              icon={LayoutTemplate}
              iconColor="text-sky-500"
            />
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <FavoritesGroup />

      {tree === undefined ? (
        <TreeLoadingGroup />
      ) : tree === null ? (
        <p className="px-4 text-sm text-muted-foreground">Sign in to see your spaces.</p>
      ) : ctx.kind === "workspace" ? (
        <WorkspaceTreeGroup workspace={ctx.workspace} />
      ) : (
        <PersonalTreeGroup personal={tree.personal} />
      )}
    </SidebarContent>
  );
}

function SearchMenuItem() {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent("open-command-palette"))}
        tooltip="Search  ⌘K"
      >
        <Search className="text-muted-foreground" />
        <span>Search</span>
      </SidebarMenuButton>
      <SidebarMenuBadge>⌘K</SidebarMenuBadge>
    </SidebarMenuItem>
  );
}

function NavMenuItem({
  href,
  label,
  icon: Icon,
  iconColor,
  exact = false,
}: {
  href: string;
  label: string;
  icon: typeof Bot;
  iconColor: string;
  exact?: boolean;
}) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname.startsWith(href);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={label}>
        <Link href={href} aria-current={active ? "page" : undefined}>
          <Icon className={iconColor} />
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function InboxMenuItem() {
  const pathname = usePathname();
  // The badge counts everything the Inbox page shows: mentions + updates.
  const unreadMentions = useQuery(api.mentions.unreadCountForCurrent, {});
  const unreadUpdates = useQuery(api.notificationCenter.unreadCount, {});
  const unread = (unreadMentions ?? 0) + (unreadUpdates ?? 0);
  const active = pathname === "/dashboard/inbox";

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip="Inbox">
        <Link href="/dashboard/inbox" aria-current={active ? "page" : undefined}>
          <Inbox className="text-cyan-500" />
          <span>Inbox</span>
        </Link>
      </SidebarMenuButton>
      {unread > 0 && (
        <SidebarMenuBadge>{unread > 99 ? "99+" : unread}</SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  );
}

// ── Favorites ────────────────────────────────────────────────────────────

function FavoritesGroup() {
  const pathname = usePathname();
  const favorites = useQuery(api.favorites.listForCurrentUser, {});
  const toggleFavorite = useMutation(api.favorites.toggle);
  const { toast } = useToast();

  if (!favorites || favorites.length === 0) return null;

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Favorites</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {favorites.map((f) => {
            const active = pathname === f.href;
            return (
              <SidebarMenuItem key={`${f.entityType}:${f.entityId}`}>
                <SidebarMenuButton asChild isActive={active} tooltip={f.name}>
                  <Link href={f.href} aria-current={active ? "page" : undefined}>
                    {/* A favorited Space carries the same identity orb it
                        has in the tree; lists/docs keep their own mark. */}
                    {f.entityType === "space" ? (
                      <Orb
                        seed={f.entityId}
                        label={f.name}
                        shape="squircle"
                        size="xs"
                        className="h-4 w-4 text-[8px]"
                      />
                    ) : f.color ? (
                      <span
                        aria-hidden
                        className="inline-block size-2 flex-shrink-0 rounded-full"
                        style={{ backgroundColor: f.color }}
                      />
                    ) : (
                      <Star className="size-3.5" aria-hidden />
                    )}
                    <span className="truncate">{f.name}</span>
                  </Link>
                </SidebarMenuButton>
                <SidebarMenuAction
                  showOnHover
                  aria-label={`Remove ${f.name} from favorites`}
                  title="Remove from favorites"
                  onClick={async () => {
                    try {
                      await toggleFavorite({
                        entityType: f.entityType,
                        entityId: f.entityId,
                      });
                      toast("Removed from favorites");
                    } catch {
                      toast("Couldn't update favorites", { kind: "error" });
                    }
                  }}
                >
                  <Star className="fill-current" aria-hidden />
                </SidebarMenuAction>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

// ── Tree loading state ───────────────────────────────────────────────────

function TreeLoadingGroup() {
  return (
    <SidebarGroup>
      <div className="space-y-2 p-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-6 animate-pulse rounded-lg bg-sidebar-accent"
            style={{ width: `${60 + i * 10}%` }}
          />
        ))}
      </div>
    </SidebarGroup>
  );
}

// ── Personal tree ────────────────────────────────────────────────────────

function PersonalTreeGroup({ personal }: { personal: SpaceNode | null | undefined }) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Personal</SidebarGroupLabel>
      <SidebarGroupContent>
        {personal ? (
          <SidebarMenu>
            <SpaceTree space={personal} linkHref="/dashboard/personal" />
          </SidebarMenu>
        ) : (
          <p className="px-2 py-1 text-xs text-muted-foreground">Setting up…</p>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

// ── Workspace tree (current workspace context) ──────────────────────────
//
// Switching workspaces now happens in the header switcher, so this group
// only ever renders the ONE current workspace's spaces — no more nested
// "Workspaces" list with a row per workspace.

function WorkspaceTreeGroup({
  workspace,
}: {
  workspace: SidebarTree["workspaces"][number];
}) {
  const [addingSpace, setAddingSpace] = useState(false);
  const createSpace = useMutation(api.spaces.create);
  const { toast } = useToast();

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Spaces</SidebarGroupLabel>
      <SidebarGroupAction aria-label="New space" onClick={() => setAddingSpace(true)}>
        <Plus />
      </SidebarGroupAction>
      <SidebarGroupContent>
        <SidebarMenu>
          {addingSpace && (
            <SidebarMenuItem className="px-1 py-1">
              <InlineCreate
                placeholder="Space name…"
                onCancel={() => setAddingSpace(false)}
                onSubmit={async (name) => {
                  try {
                    await createSpace({
                      name,
                      parentType: "workspace",
                      parentId: workspace._id,
                    });
                    setAddingSpace(false);
                  } catch (e) {
                    toast(errorMessage(e, "Couldn't create space"), {
                      kind: "error",
                    });
                    setAddingSpace(false);
                  }
                }}
              />
            </SidebarMenuItem>
          )}
          {workspace.spaces.length === 0 && !addingSpace && (
            <SidebarMenuItem>
              <SidebarMenuButton type="button" onClick={() => setAddingSpace(true)}>
                <Plus />
                <span className="text-muted-foreground">New space</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {workspace.spaces.map((space) => (
            <SpaceTree
              key={space._id}
              space={space}
              linkHref={`/dashboard/s/${space._id}`}
            />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

// ── Space → folder → list tree ───────────────────────────────────────────
//
// The per-space "+" popover (list/doc/whiteboard/template/folder) now rides
// a Radix DropdownMenu instead of the old hand-rolled AnchoredMenu portal —
// Radix already handles positioning/escape/outside-click for us.

const ADD_LABEL: Record<string, string> = {
  folder: "folder",
  list: "list",
  doc: "doc",
  board: "whiteboard",
};

const SPACE_CREATE_ITEMS = [
  { k: "list" as const, icon: ListIcon, label: "List" },
  { k: "doc" as const, icon: FileText, label: "Doc" },
  { k: "board" as const, icon: LayoutGrid, label: "Whiteboard" },
  { k: "template" as const, icon: Columns3, label: "Use a template" },
  { k: "folder" as const, icon: Folder, label: "Folder" },
];

function SpaceCreateMenu({
  onPick,
}: {
  onPick: (kind: "list" | "doc" | "board" | "template" | "folder") => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Add to space"
          title="Add"
          // Always visible on touch (no hover to reveal it), hover-revealed
          // from `sm:` up — this is the only path to "new folder"/"new
          // list" for a space, so it must never be hover-gated on mobile.
          className="tap-target flex size-5 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 data-[state=open]:opacity-100 group-data-[collapsible=icon]:hidden sm:opacity-0 sm:group-hover/space:opacity-100"
        >
          <Plus className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {SPACE_CREATE_ITEMS.map(({ k, icon: Icon, label }) => (
          <DropdownMenuItem key={k} onSelect={() => onPick(k)}>
            <Icon className="text-muted-foreground" />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SpaceTree({ space, linkHref }: { space: SpaceNode; linkHref: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [expanded, setExpanded] = useState(true);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [adding, setAdding] = useState<"folder" | "list" | "doc" | "board" | null>(null);
  const createFolder = useMutation(api.folders.create);
  const createList = useMutation(api.lists.create);
  const createDoc = useMutation(api.docs.create);
  const createWhiteboard = useMutation(api.whiteboards.create);
  const { toast } = useToast();

  async function submitAdd(name: string) {
    try {
      if (adding === "folder") {
        await createFolder({ spaceId: space._id, name });
      } else if (adding === "list") {
        const listId = await createList({ name, parentType: "space", parentId: space._id });
        router.push(`/dashboard/l/${listId}`);
      } else if (adding === "doc") {
        const docId = await createDoc({ parentType: "space", parentId: space._id, title: name });
        router.push(`/dashboard/d/${docId}`);
      } else if (adding === "board") {
        const wbId = await createWhiteboard({
          parentType: "space",
          parentId: space._id,
          title: name,
        });
        router.push(`/dashboard/wb/${wbId}`);
      }
      setAdding(null);
    } catch (e) {
      toast(errorMessage(e, `Couldn't create ${ADD_LABEL[adding ?? ""] ?? "item"}`), {
        kind: "error",
      });
      setAdding(null);
    }
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

  const active = pathname === linkHref;

  return (
    <SidebarMenuItem>
      <div className="group/space flex min-w-0 items-center gap-0.5">
        <button
          type="button"
          aria-label={expanded ? "Collapse" : "Expand"}
          onClick={() => setExpanded((v) => !v)}
          className="flex size-5 flex-shrink-0 items-center justify-center text-muted-foreground group-data-[collapsible=icon]:hidden"
        >
          <ChevronRight
            className={cn("size-3.5 transition-transform duration-200", expanded && "rotate-90")}
          />
        </button>
        <SidebarMenuButton asChild isActive={active} tooltip={space.name} className="min-w-0 flex-1">
          <Link href={linkHref} aria-current={active ? "page" : undefined}>
            {/* Sized down to the 16px icon slot the sibling rows use, so
                swapping the old color dot for the orb doesn't change the
                row's rhythm or height (the button is a fixed h-8 with
                overflow-hidden — a full 24px xs orb would be clipped). */}
            <Orb
              seed={space._id}
              label={space.name}
              color={space.color}
              shape="squircle"
              size="xs"
              className="h-4 w-4 text-[8px]"
            />
            <span className="truncate">{space.name}</span>
            {space.private && <Lock className="ml-auto size-3 flex-shrink-0" aria-hidden />}
          </Link>
        </SidebarMenuButton>
        <SpaceCreateMenu
          onPick={(kind) => {
            setExpanded(true);
            if (kind === "template") setTemplateOpen(true);
            else setAdding(kind);
          }}
        />
      </div>

      {expanded && (
        <SidebarMenuSub>
          {adding && (
            <SidebarMenuSubItem className="py-1">
              <InlineCreate
                placeholder={ADD_PLACEHOLDER[adding]}
                onCancel={() => setAdding(null)}
                onSubmit={submitAdd}
              />
            </SidebarMenuSubItem>
          )}
          {isEmpty && !adding && (
            <SidebarMenuSubItem className="px-1 py-1">
              <p className="px-1 pb-1 text-xs text-muted-foreground">Nothing here yet.</p>
              <SidebarMenuSubButton asChild size="sm">
                <button type="button" onClick={() => setAdding("list")}>
                  <Plus />
                  <span>Add a list</span>
                </button>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          )}
          {/* Ordering rule (mirrored on the Space page): folders first,
              then space-direct lists — the server already sorts each by
              position with a createdAt tiebreak. */}
          {space.folders.map((folder) => (
            <FolderTree key={folder._id} folder={folder} space={space} />
          ))}
          {space.lists.map((list) => (
            <ListSubItem
              key={list._id}
              listId={list._id}
              name={list.name}
              space={space}
              parent={{ type: "space", id: space._id }}
            />
          ))}
          {space.docs.map((doc) => (
            <DocSubItem key={doc._id} docId={doc._id} title={doc.title} />
          ))}
          {space.whiteboards.map((wb) => (
            <WhiteboardSubItem key={wb._id} whiteboardId={wb._id} title={wb.title} />
          ))}
        </SidebarMenuSub>
      )}

      <TemplatePicker
        open={templateOpen}
        parent={{ kind: "space", spaceId: space._id }}
        onClose={() => setTemplateOpen(false)}
        onCreated={(listId) => {
          setTemplateOpen(false);
          router.push(`/dashboard/l/${listId}`);
        }}
      />
    </SidebarMenuItem>
  );
}

// A row's overflow menu. One "⋯" trigger instead of a strip of inline
// icon buttons keeps folder and list rows the same width at 360px — the
// row can never widen past the name, which truncates.
function RowMenu({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          // Visible by default, hover-revealed from `sm:` up — a touch
          // device has no hover, so an opacity-0 trigger would make these
          // actions unreachable on mobile entirely.
          className="tap-target flex size-5 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 data-[state=open]:opacity-100 sm:opacity-0 sm:group-hover/row:opacity-100"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Destinations for "move a list": the Space itself plus each of its
// folders, minus wherever the list already lives. Crossing into another
// Space is deliberately not offered — the server refuses it too, because a
// Space is a visibility boundary.
function moveDestinations(
  space: SpaceNode,
  parent: { type: "space" | "folder"; id: string },
): { id: string; label: string; hint: string }[] {
  const out: { id: string; label: string; hint: string }[] = [];
  if (parent.type !== "space") {
    out.push({ id: `space:${space._id}`, label: space.name, hint: "space" });
  }
  for (const f of space.folders) {
    if (parent.type === "folder" && parent.id === f._id) continue;
    out.push({ id: `folder:${f._id}`, label: f.name, hint: "folder" });
  }
  return out;
}

function FolderTree({
  folder,
  space,
}: {
  folder: SpaceNode["folders"][number];
  space: SpaceNode;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useFolderExpanded(folder._id);
  const [addingList, setAddingList] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [hidden, setHidden] = useState(false);
  const createList = useMutation(api.lists.create);
  const renameFolder = useMutation(api.folders.rename);
  const removeFolder = useMutation(api.folders.remove);
  const { toast } = useToast();

  // Deferred delete: hide the row immediately, only actually removing the
  // folder once the undo window closes — same pattern as every other
  // delete in the app (grep `onExpire`). Deleting a folder keeps its
  // lists: the server moves them up to the Space.
  if (hidden) return null;

  return (
    <SidebarMenuSubItem>
      <div className="group/row flex min-w-0 items-center gap-0.5">
        <button
          type="button"
          aria-label={expanded ? "Collapse" : "Expand"}
          aria-expanded={expanded}
          onClick={() => setExpanded()}
          className="flex size-4 flex-shrink-0 items-center justify-center text-muted-foreground"
        >
          <ChevronRight
            className={cn("size-3 transition-transform duration-200", expanded && "rotate-90")}
          />
        </button>
        {renaming ? (
          <InlineCreate
            placeholder="Folder name…"
            initialValue={folder.name}
            className="min-w-0 flex-1"
            onCancel={() => setRenaming(false)}
            onSubmit={async (name) => {
              try {
                await renameFolder({ folderId: folder._id, name });
                setRenaming(false);
              } catch (e) {
                toast(errorMessage(e, "Couldn't rename folder"), {
                  kind: "error",
                });
                setRenaming(false);
              }
            }}
          />
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-2 px-1 text-sm text-sidebar-foreground/80">
            <Folder className="size-3.5 flex-shrink-0" aria-hidden />
            <span className="truncate">{folder.name}</span>
          </span>
        )}
        {!renaming && (
          <RowMenu label={`Folder actions for ${folder.name}`}>
            <DropdownMenuItem
              onSelect={() => {
                setExpanded(true);
                setAddingList(true);
              }}
            >
              <Plus className="text-muted-foreground" />
              New list
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setRenaming(true)}>
              <Pencil className="text-muted-foreground" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                setHidden(true);
                toast(
                  folder.lists.length > 0
                    ? `"${folder.name}" deleted — its lists moved to ${space.name}`
                    : `"${folder.name}" deleted`,
                  {
                    action: { label: "Undo", onClick: () => setHidden(false) },
                    onExpire: () => void removeFolder({ folderId: folder._id }),
                  },
                );
              }}
            >
              <Trash2 className="text-muted-foreground" />
              Delete folder
            </DropdownMenuItem>
          </RowMenu>
        )}
      </div>
      {expanded && (
        <SidebarMenuSub>
          {addingList && (
            <SidebarMenuSubItem className="py-1">
              <InlineCreate
                placeholder="List name…"
                onCancel={() => setAddingList(false)}
                onSubmit={async (name) => {
                  try {
                    const listId = await createList({
                      name,
                      parentType: "folder",
                      parentId: folder._id,
                    });
                    setAddingList(false);
                    router.push(`/dashboard/l/${listId}`);
                  } catch (e) {
                    toast(errorMessage(e, "Couldn't create list"), {
                      kind: "error",
                    });
                    setAddingList(false);
                  }
                }}
              />
            </SidebarMenuSubItem>
          )}
          {folder.lists.map((list) => (
            <ListSubItem
              key={list._id}
              listId={list._id}
              name={list.name}
              space={space}
              parent={{ type: "folder", id: folder._id }}
            />
          ))}
          {folder.lists.length === 0 && !addingList && (
            <SidebarMenuSubItem className="px-1 py-1">
              <p className="px-1 pb-1 text-xs text-muted-foreground">
                This folder is empty.
              </p>
              <SidebarMenuSubButton asChild size="sm">
                <button type="button" onClick={() => setAddingList(true)}>
                  <Plus />
                  <span>Add a list</span>
                </button>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          )}
        </SidebarMenuSub>
      )}
    </SidebarMenuSubItem>
  );
}

function ListSubItem({
  listId,
  name,
  space,
  parent,
}: {
  listId: Id<"lists">;
  name: string;
  space: SpaceNode;
  parent: { type: "space" | "folder"; id: string };
}) {
  const pathname = usePathname();
  const [renaming, setRenaming] = useState(false);
  const [moving, setMoving] = useState(false);
  const [hidden, setHidden] = useState(false);
  const renameList = useMutation(api.lists.rename);
  const moveList = useMutation(api.lists.move);
  const removeList = useMutation(api.lists.remove);
  const { toast } = useToast();

  // Active on the list page and its sub-routes (settings, task detail).
  const active = pathname.startsWith(`/dashboard/l/${listId}`);
  const destinations = moveDestinations(space, parent);

  if (hidden) return null;

  if (renaming) {
    return (
      <SidebarMenuSubItem className="py-1">
        <InlineCreate
          placeholder="List name…"
          initialValue={name}
          onCancel={() => setRenaming(false)}
          onSubmit={async (next) => {
            try {
              await renameList({ listId, name: next });
              setRenaming(false);
            } catch (e) {
              toast(errorMessage(e, "Couldn't rename list"), { kind: "error" });
              setRenaming(false);
            }
          }}
        />
      </SidebarMenuSubItem>
    );
  }

  if (moving) {
    return (
      <SidebarMenuSubItem className="py-1">
        <div className="flex min-w-0 items-center gap-1">
          <Picker
            dashed
            className="min-w-0 flex-1"
            label="Move to…"
            options={destinations}
            onSelect={async (value) => {
              const [type, id] = value.split(":");
              setMoving(false);
              try {
                await moveList({
                  listId,
                  parentType: type === "folder" ? "folder" : "space",
                  parentId: id,
                });
                toast(`"${name}" moved`);
              } catch (e) {
                toast(errorMessage(e, "Couldn't move list"), { kind: "error" });
              }
            }}
          />
          <button
            type="button"
            aria-label="Cancel move"
            onClick={() => setMoving(false)}
            className="tap-target flex size-5 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-sidebar-accent-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </SidebarMenuSubItem>
    );
  }

  return (
    <SidebarMenuSubItem>
      <div className="group/row flex min-w-0 items-center gap-0.5">
        <SidebarMenuSubButton asChild isActive={active} className="min-w-0 flex-1">
          <Link href={`/dashboard/l/${listId}`} aria-current={active ? "page" : undefined}>
            <ListIcon aria-hidden />
            <span className="truncate">{name}</span>
          </Link>
        </SidebarMenuSubButton>
        <RowMenu label={`List actions for ${name}`}>
          <DropdownMenuItem
            disabled={destinations.length === 0}
            onSelect={() => setMoving(true)}
          >
            <FolderInput className="text-muted-foreground" />
            Move…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <Pencil className="text-muted-foreground" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              setHidden(true);
              toast(`"${name}" deleted`, {
                action: { label: "Undo", onClick: () => setHidden(false) },
                onExpire: () => void removeList({ listId }),
              });
            }}
          >
            <Trash2 className="text-muted-foreground" />
            Delete list
          </DropdownMenuItem>
        </RowMenu>
      </div>
    </SidebarMenuSubItem>
  );
}

function DocSubItem({ docId, title }: { docId: Id<"docs">; title: string }) {
  const pathname = usePathname();
  const active = pathname === `/dashboard/d/${docId}`;
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={active}>
        <Link href={`/dashboard/d/${docId}`} aria-current={active ? "page" : undefined}>
          <FileText aria-hidden />
          <span className="truncate">{title}</span>
        </Link>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

function WhiteboardSubItem({
  whiteboardId,
  title,
}: {
  whiteboardId: Id<"whiteboards">;
  title: string;
}) {
  const pathname = usePathname();
  const active = pathname === `/dashboard/wb/${whiteboardId}`;
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={active}>
        <Link href={`/dashboard/wb/${whiteboardId}`} aria-current={active ? "page" : undefined}>
          <LayoutGrid aria-hidden />
          <span className="truncate">{title}</span>
        </Link>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

// ── Footer: timer + admin + theme + user ─────────────────────────────────

function SidebarFooterBody() {
  // Collapsed icon rail: fall back to ThemeToggle's own compact single-
  // button variant instead of hiding the control outright (mobile always
  // renders the full sheet, so it never reports "collapsed").
  const { state, isMobile } = useSidebar();
  const collapsed = !isMobile && state === "collapsed";

  return (
    <SidebarFooter>
      <div className="group-data-[collapsible=icon]:hidden">
        <RunningTimerChip />
      </div>
      <AdminMenuItem />
      <div className="px-1">
        <ThemeToggle collapsed={collapsed} />
      </div>
      <div className="flex items-center gap-2 px-1 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-1 group-data-[collapsible=icon]:px-0">
        <UserButton afterSignOutUrl="/" />
        <span className="flex-1 truncate text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
          Account
        </span>
        {/* Desktop collapse/expand affordance — stays visible on the icon
            rail too, otherwise a collapsed sidebar has no obvious way back.
            Mobile gets its own trigger inside PageHeader. */}
        <SidebarTrigger
          aria-label="Toggle sidebar"
          className="hidden shrink-0 text-muted-foreground md:inline-flex"
        />
      </div>
    </SidebarFooter>
  );
}

function AdminMenuItem() {
  const pathname = usePathname();
  const me = useQuery(api.admin.me, {});
  if (!me) return null;
  const active = pathname.startsWith("/dashboard/admin");

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton asChild isActive={active} tooltip="Admin console">
          <Link href="/dashboard/admin" aria-current={active ? "page" : undefined}>
            <ShieldCheck className="text-muted-foreground" />
            <span className="flex-1 truncate">Admin console</span>
            <span className="rounded-full bg-sidebar-primary px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-sidebar-primary-foreground group-data-[collapsible=icon]:hidden">
              {me.role === "superadmin" ? "Super" : "Admin"}
            </span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
