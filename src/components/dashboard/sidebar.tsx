"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatedBadge } from "@/components/beui/animated-badge";
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
  Inbox,
  LayoutGrid,
  List as ListIcon,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  X,
  Boxes,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { useCustomize } from "@/components/appearance/customize-provider";
import {
  Branch,
  Disclosure,
  TreeHighlight,
  useTreeHover,
} from "@/components/dashboard/sidebar-tree-motion";
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
import { ModeSwitcher } from "@/components/chat/mode-switcher";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { useProjectExpanded } from "@/lib/project-collapse";
import { useNav } from "@/lib/use-nav";
import { userSpacesFromTree } from "@/lib/user-spaces";

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
  // tree (nav items, favorites, spaces/projects/lists, docs, whiteboards,
  // admin) without wiring each one individually.
  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);

  return (
    // data-mode-surface="nav" pairs with the Chat shell's rail: same
    // view-transition-name on both, so crossing between the dashboards morphs
    // this into that rather than cross-fading the viewport. See the Work ⇄ Chat
    // block in globals.css.
    <Sidebar collapsible="icon" data-mode-surface="nav">
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
  // itself, its spaces, projects, space-direct + project-nested lists, docs,
  // whiteboards) back to that workspace. Built once per tree/pathname
  // change rather than walked on every render.
  const idToWorkspace = useMemo(() => {
    const map = new Map<string, SidebarTree["workspaces"][number]>();
    for (const workspace of tree?.workspaces ?? []) {
      map.set(workspace._id, workspace);
      for (const space of workspace.spaces) {
        map.set(space._id, workspace);
        for (const list of space.lists) map.set(list._id, workspace);
        for (const page of space.pages) map.set(page._id, workspace);
        for (const wb of space.whiteboards) map.set(wb._id, workspace);
        for (const project of space.projects) {
          map.set(project._id, workspace);
          for (const list of project.lists) map.set(list._id, workspace);
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
    ctx.kind === "workspace" ? ctx.workspace.name : "My workspace";
  // Identity marks are seeded by the entity's stable id, never by its name
  // or a flat brand fill, so a workspace/space is the same color here, in
  // the tree, and everywhere else it appears (lib/identity-color).
  const currentSeed =
    ctx.kind === "workspace"
      ? ctx.workspace._id
      : (tree?.personal?._id ?? tree?.currentClerkId ?? "personal");

  return (
    <SidebarHeader>
      {/* Work or Chat. Above the workspace switcher because it is the coarser
          question — which application you are in, before which workspace. */}
      <ModeSwitcher collapsible className="mb-1" />
      {/* The grab handle for the whole navigation.
          Holding the sidebar body still works — it has to, because that is the
          gesture the dock teaches — but a hold is undiscoverable and easy to
          fumble, so there is also a target that says what it does and starts
          dragging on contact. Handled in components/appearance/sidebar-dock.tsx,
          which listens on the container and looks for this attribute. */}
      <span
        data-nav-grab
        title="Drag to move the navigation"
        aria-hidden
        className="mx-auto mb-1 hidden h-3 w-8 cursor-grab touch-none items-center justify-center rounded-full text-muted-foreground/40 transition-colors hover:bg-sidebar-accent hover:text-foreground active:cursor-grabbing md:flex"
      >
        <svg viewBox="0 0 16 4" className="h-1 w-4" aria-hidden>
          {[2, 8, 14].map((x) => (
            <circle key={x} cx={x} cy="2" r="1" fill="currentColor" />
          ))}
        </svg>
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex w-full min-w-0 items-center gap-2 rounded-full py-1 pl-1 pr-2 text-left outline-none hover:bg-sidebar-accent group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:pr-1">
          <Orb seed={currentSeed} label={currentName} shape="squircle" size="sm" />
          <span className="min-w-0 flex-1 truncate font-semibold text-sidebar-foreground group-data-[collapsible=icon]:hidden">
            {currentName}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
            Workspaces
          </DropdownMenuLabel>
          {tree?.personal && (
            <DropdownMenuItem asChild>
              <Link href="/dashboard/personal">
                <Orb
                  seed={tree.personal._id}
                  label="My workspace"
                  shape="squircle"
                  size="xs"
                  className="mr-1 h-5 w-5 text-micro"
                />
                <span className="truncate">My workspace</span>
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
                  className="mr-1 h-5 w-5 text-micro"
                />
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
      <NewWorkspaceDialog open={wsDialogOpen} onClose={() => setWsDialogOpen(false)} />
    </SidebarHeader>
  );
}

// ── Content ──────────────────────────────────────────────────────────────

function SidebarContentBody() {
  const tree = useTreeQuery();
  const ctx = useCurrentContext(tree);
  // Whose default applies. A personal space answers for itself; inside a
  // workspace, the workspace's curated nav is the layer under yours.
  const navScope = useMemo(
    () =>
      ctx.kind === "workspace"
        ? { parentType: "workspace" as const, parentId: ctx.workspace._id as string }
        : tree?.currentClerkId
          ? { parentType: "user" as const, parentId: tree.currentClerkId }
          : undefined,
    [ctx, tree?.currentClerkId],
  );
  const { items: navItems } = useNav(navScope);

  return (
    <SidebarContent>
      {/* One box for the travelling highlight to be positioned against. It
          sits inside the scroller rather than around it, so a row's offset is
          measured against content that scrolls with it. */}
      <TreeHighlight className="flex min-h-0 flex-1 flex-col gap-2">
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SearchMenuItem />
            {/* The navigation, rendered from data.
                Was ten hardcoded rows, identical for a solo founder and a
                400-person agency — the one surface everybody reads all day
                and the only thing in the product nobody could shape. The
                registry, the layering and the "you can always get Home"
                guarantee all live in src/lib/nav-items.ts, shared with the
                dock so the two surfaces cannot disagree about what the
                product contains. */}
            {navItems.map((item) =>
              item.id === "inbox" ? (
                <InboxMenuItem key={item.id} />

              ) : (
                <NavMenuItem
                  key={item.id}
                  href={item.href}
                  label={item.label}
                  icon={item.icon}
                  exact={item.exact}
                />
              ),
            )}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      {/* The tree folds away, and the rail opens SPARSE.

          Both references are a short rail of icon-chip rows — neither has a
          tree against the window. Ours cannot delete its tree (lists and
          projects are the product), so the tree becomes one press away and
          the press is remembered per machine: first sight is the reference
          rail, and anyone who lives in the tree opens it once and keeps it. */}
      <SpacesDisclosure>
        <FavoritesGroup />

        {tree === undefined ? (
          <TreeLoadingGroup />
        ) : tree === null ? (
          <p className="px-4 text-sm text-muted-foreground">Sign in to see your spaces.</p>
        ) : ctx.kind === "workspace" ? (
          <WorkspaceTreeGroup workspace={ctx.workspace} />
        ) : (
          <PersonalTreeGroup
            personal={tree.personal}
            personalSpaces={tree.personalSpaces}
          />
        )}
      </SpacesDisclosure>
      </TreeHighlight>
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
  exact = false,
}: {
  href: string;
  label: string;
  icon: typeof Bot;
  exact?: boolean;
}) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname.startsWith(href);
  return (
    <SidebarMenuItem>
      {/* No per-destination icon colour. It read as a code and was not one —
          Home and Templates were both sky-500 — so it was decoration in the
          one place this design system reserves for affordance. The glyphs are
          already distinct from each other, the label sits beside them, and the
          collapsed rail keeps `tooltip`, so nothing was identifying a
          destination by hue that cannot identify it without one. */}
      <SidebarMenuButton asChild isActive={active} tooltip={label}>
        <Link href={href} aria-current={active ? "page" : undefined}>
          <Icon />
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
  // Obligations count too. A badge that showed only mentions taught people
  // that a quiet Inbox meant nothing was waiting — while four kinds of
  // "your turn" sat behind it unread.
  const waitingOnYou = useQuery(api.obligations.countForCurrentUser, {});
  const unread =
    (unreadMentions ?? 0) + (unreadUpdates ?? 0) + (waitingOnYou ?? 0);
  const active = pathname === "/dashboard/inbox";

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip="Inbox">
        <Link href="/dashboard/inbox" aria-current={active ? "page" : undefined}>
          {/* No per-destination hue — the chip rules colour every glyph the
              same way, and cyan here was the one leftover breaking that. */}
          <Inbox />
          <span>Inbox</span>
        </Link>
      </SidebarMenuButton>
      {unread > 0 && (
        // SidebarMenuBadge keeps the rail positioning; inside it, the beui
        // badge makes a CHANGING count roll to its new value with a blur
        // instead of teleporting — arriving work is visible arriving.
        <SidebarMenuBadge className="p-0">
          <AnimatedBadge
            status="neutral"
            size="sm"
            showIcon={false}
            contentKey={unread}
            className="ink-coin h-5 border-0 px-1.5"
          >
            {unread > 99 ? "99+" : unread}
          </AnimatedBadge>
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  );
}

// (No ChatMenuItem: Chat is the other half of the mode switcher at the top of
// the rail. A second door to the same place, three rows below the first, was
// navigation clutter wearing a feature's clothes.)

// ── Favorites ────────────────────────────────────────────────────────────

/**
 * The disclosure the tree lives behind.
 *
 * localStorage rather than Convex, deliberately: which machine you are on is
 * exactly what this should vary by — the laptop where you work the tree keeps
 * it open, the phone where you glance at Home keeps the rail sparse. The
 * default (closed) is what a new account sees, which is the reference.
 */
const SPACES_OPEN_KEY = "sidebar_spaces_open";

function SpacesDisclosure({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      setOpen(localStorage.getItem(SPACES_OPEN_KEY) === "true");
    } catch {
      // Storage denied = the default, which is fine.
    }
  }, []);
  const toggle = () => {
    setOpen((cur) => {
      const next = !cur;
      try {
        localStorage.setItem(SPACES_OPEN_KEY, String(next));
      } catch {}
      return next;
    });
  };
  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                type="button"
                onClick={toggle}
                aria-expanded={open}
                tooltip="Spaces"
              >
                <Boxes />
                <span className="flex-1">Spaces</span>
                <ChevronRight
                  aria-hidden
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground transition-transform",
                    open && "rotate-90",
                  )}
                />
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      {open && children}
    </>
  );
}

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
                        className="h-4 w-4 text-micro"
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

function PersonalTreeGroup({
  personal,
  personalSpaces,
}: {
  personal: SpaceNode | null | undefined;
  personalSpaces?: SpaceNode[] | null;
}) {
  const spaces = userSpacesFromTree({ personal, personalSpaces });
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Spaces</SidebarGroupLabel>
      <SidebarGroupContent>
        {spaces.length > 0 ? (
          <SidebarMenu>
            {spaces.map((space) => (
              <SpaceTree
                key={space._id}
                space={space}
                linkHref={
                  space._id === personal?._id
                    ? "/dashboard/personal"
                    : `/dashboard/s/${space._id}`
                }
                displayName={
                  space.name === "Personal" ? "Personal space" : space.name
                }
              />
            ))}
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
  // A just-created space, still empty, being offered its templates. This is
  // where the template gallery lives now — a blueprint is a way to START a
  // space, not a destination in the nav (the /dashboard/templates row is
  // gone). Closing the picker keeps the empty space; nothing is forced.
  const [templateForSpace, setTemplateForSpace] = useState<Id<"spaces"> | null>(
    null,
  );
  const router = useRouter();
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
                    const spaceId = await createSpace({
                      name,
                      parentType: "workspace",
                      parentId: workspace._id,
                    });
                    setAddingSpace(false);
                    if (spaceId) setTemplateForSpace(spaceId);
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
      <TemplatePicker
        open={templateForSpace !== null}
        parent={
          templateForSpace !== null
            ? { kind: "space", spaceId: templateForSpace }
            : null
        }
        onClose={() => setTemplateForSpace(null)}
        onCreated={(listId) => {
          setTemplateForSpace(null);
          router.push(`/dashboard/l/${listId}`);
        }}
      />
    </SidebarGroup>
  );
}

// ── Space → project → list tree ───────────────────────────────────────────
//
// The per-space "+" popover (list/doc/whiteboard/template/project) now rides
// a Radix DropdownMenu instead of the old hand-rolled AnchoredMenu portal —
// Radix already handles positioning/escape/outside-click for us.

const ADD_LABEL: Record<string, string> = {
  project: "project",
  list: "list",
  page: "page",
  board: "whiteboard",
};

const SPACE_CREATE_ITEMS = [
  { k: "list" as const, icon: ListIcon, label: "List" },
  { k: "page" as const, icon: FileText, label: "Page" },
  { k: "board" as const, icon: LayoutGrid, label: "Whiteboard" },
  {
    k: "template" as const,
    icon: Columns3,
    label: "New list from template",
  },
  { k: "project" as const, icon: Folder, label: "Project" },
];

function SpaceCreateMenu({
  spaceName,
  onPick,
}: {
  spaceName: string;
  onPick: (kind: "list" | "page" | "board" | "template" | "project") => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Add to ${spaceName}`}
          title={`Add to ${spaceName}`}
          // Always visible on touch (no hover to reveal it), hover-revealed
          // from `sm:` up — this is the only path to "new project"/"new
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

function SpaceTree({
  space,
  linkHref,
  displayName,
}: {
  space: SpaceNode;
  linkHref: string;
  displayName?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [expanded, setExpanded] = useState(true);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [adding, setAdding] = useState<
    "project" | "list" | "page" | "board" | null
  >(null);
  const createProject = useMutation(api.projects.create);
  const createList = useMutation(api.lists.create);
  const createPage = useMutation(api.pages.create);
  const createWhiteboard = useMutation(api.whiteboards.create);
  const { toast } = useToast();

  async function submitAdd(name: string) {
    try {
      if (adding === "project") {
        await createProject({ spaceId: space._id, name });
      } else if (adding === "list") {
        const listId = await createList({ name, parentType: "space", parentId: space._id });
        router.push(`/dashboard/l/${listId}`);
      } else if (adding === "page") {
        // Started from this space, so it belongs to this space — the place
        // you started decides, and there is no second choice to get wrong.
        const pageId = await createPage({
          scopeType: space.scopeType,
          scopeId: space.scopeId,
          title: name,
          attachTo: { targetType: "space", targetId: space._id },
        });
        router.push(`/dashboard/pages/${pageId}`);
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
    project: "Project name…",
    list: "List name…",
    page: "Page title…",
    board: "Whiteboard title…",
  };

  const isEmpty =
    space.projects.length === 0 &&
    space.lists.length === 0 &&
    space.pages.length === 0 &&
    space.whiteboards.length === 0;

  const active = pathname === linkHref;
  const visibleName = displayName ?? space.name;

  return (
    <SidebarMenuItem>
      <TreeRow className="group/space">
        <Disclosure
          className="group-data-[collapsible=icon]:hidden"
          label={visibleName}
          onToggle={() => setExpanded((v) => !v)}
          open={expanded}
        />
        <SidebarMenuButton
          asChild
          isActive={active}
          tooltip={visibleName}
          className="min-w-0 flex-1"
        >
          <Link href={linkHref} aria-current={active ? "page" : undefined}>
            {/* Sized down to the 16px icon slot the sibling rows use, so
                swapping the old color dot for the orb doesn't change the
                row's rhythm or height (the button is a fixed h-8 with
                overflow-hidden — a full 24px xs orb would be clipped). */}
            <Orb
              seed={space._id}
              label={visibleName}
              color={space.color}
              shape="squircle"
              size="xs"
              className="h-4 w-4 text-micro"
            />
            <span className="truncate">{visibleName}</span>
            {space.private && <Lock className="ml-auto size-3 flex-shrink-0" aria-hidden />}
          </Link>
        </SidebarMenuButton>
        <SpaceCreateMenu
          spaceName={visibleName}
          onPick={(kind) => {
            setExpanded(true);
            if (kind === "template") setTemplateOpen(true);
            else setAdding(kind);
          }}
        />
      </TreeRow>

      <Branch open={expanded}>
        <SidebarMenuSub>
          {adding && (
            <SidebarMenuSubItem className="py-1">
              <p className="mb-1 px-1 text-micro font-medium uppercase tracking-wider text-muted-foreground">
                New {ADD_LABEL[adding]} in {visibleName}
              </p>
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
          {/* Ordering rule (mirrored on the Space page): projects first,
              then space-direct lists — the server already sorts each by
              position with a createdAt tiebreak. */}
          {space.projects.map((project) => (
            <ProjectTree key={project._id} project={project} space={space} />
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
          {space.pages.map((page) => (
            <PageSubItem
              key={page._id}
              pageId={page._id}
              title={page.title}
              pinned={page.pinned}
            />
          ))}
          {space.whiteboards.map((wb) => (
            <WhiteboardSubItem key={wb._id} whiteboardId={wb._id} title={wb.title} />
          ))}
        </SidebarMenuSub>
      </Branch>

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

/**
 * A tree row the travelling highlight can follow.
 *
 * `z-10` because the highlight is drawn at `z-0` behind the whole tree — a row
 * without it disappears under its own hover state.
 */
function TreeRow({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const hover = useTreeHover();
  return (
    <div
      className={cn("relative z-10 flex min-w-0 items-center gap-0.5", className)}
      onMouseEnter={hover.onMouseEnter}
      ref={hover.ref}
    >
      {children}
    </div>
  );
}

// A row's overflow menu. One "⋯" trigger instead of a strip of inline
// icon buttons keeps project and list rows the same width at 360px — the
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
// projects, minus wherever the list already lives. Crossing into another
// Space is deliberately not offered — the server refuses it too, because a
// Space is a visibility boundary.
function moveDestinations(
  space: SpaceNode,
  parent: { type: "space" | "project"; id: string },
): { id: string; label: string; hint: string }[] {
  const out: { id: string; label: string; hint: string }[] = [];
  if (parent.type !== "space") {
    out.push({ id: `space:${space._id}`, label: space.name, hint: "space" });
  }
  for (const f of space.projects) {
    if (parent.type === "project" && parent.id === f._id) continue;
    out.push({ id: `project:${f._id}`, label: f.name, hint: "project" });
  }
  return out;
}

function ProjectTree({
  project,
  space,
}: {
  project: SpaceNode["projects"][number];
  space: SpaceNode;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useProjectExpanded(project._id);
  const [addingList, setAddingList] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [hidden, setHidden] = useState(false);
  const createList = useMutation(api.lists.create);
  const renameProject = useMutation(api.projects.rename);
  const removeProject = useMutation(api.projects.remove);
  const { toast } = useToast();

  // Deferred delete: hide the row immediately, only actually removing the
  // project once the undo window closes — same pattern as every other
  // delete in the app (grep `onExpire`). Deleting a project keeps its
  // lists: the server moves them up to the Space.
  if (hidden) return null;

  return (
    <SidebarMenuSubItem>
      <TreeRow className="group/row">
        <Disclosure
          className="size-4"
          label={project.name}
          onToggle={() => setExpanded()}
          open={expanded}
        />
        {renaming ? (
          <InlineCreate
            placeholder="Project name…"
            initialValue={project.name}
            className="min-w-0 flex-1"
            onCancel={() => setRenaming(false)}
            onSubmit={async (name) => {
              try {
                await renameProject({ projectId: project._id, name });
                setRenaming(false);
              } catch (e) {
                toast(errorMessage(e, "Couldn't rename project"), {
                  kind: "error",
                });
                setRenaming(false);
              }
            }}
          />
        ) : (
          // A project has its own page now (overview, health, owner, its
          // lists), so the row navigates instead of only expanding.
          <Link
            href={`/dashboard/p/${project._id}`}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-sm text-sidebar-foreground/80 hover:text-sidebar-foreground"
          >
            <Folder className="size-3.5 flex-shrink-0" aria-hidden />
            <span className="truncate">{project.name}</span>
          </Link>
        )}
        {!renaming && (
          <RowMenu label={`Project actions for ${project.name}`}>
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
                  project.lists.length > 0
                    ? `"${project.name}" deleted — its lists moved to ${space.name}`
                    : `"${project.name}" deleted`,
                  {
                    action: { label: "Undo", onClick: () => setHidden(false) },
                    onExpire: () => void removeProject({ projectId: project._id }),
                  },
                );
              }}
            >
              <Trash2 className="text-muted-foreground" />
              Delete project
            </DropdownMenuItem>
          </RowMenu>
        )}
      </TreeRow>
      <Branch open={expanded}>
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
                      parentType: "project",
                      parentId: project._id,
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
          {project.lists.map((list) => (
            <ListSubItem
              key={list._id}
              listId={list._id}
              name={list.name}
              space={space}
              parent={{ type: "project", id: project._id }}
            />
          ))}
          {project.lists.length === 0 && !addingList && (
            <SidebarMenuSubItem className="px-1 py-1">
              <p className="px-1 pb-1 text-xs text-muted-foreground">
                This project is empty.
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
      </Branch>
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
  parent: { type: "space" | "project"; id: string };
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
                  parentType: type === "project" ? "project" : "space",
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
      <TreeRow className="group/row">
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
      </TreeRow>
    </SidebarMenuSubItem>
  );
}

function PageSubItem({
  pageId,
  title,
  pinned,
}: {
  pageId: Id<"pages">;
  title: string;
  pinned: boolean;
}) {
  const pathname = usePathname();
  const active = pathname === `/dashboard/pages/${pageId}`;
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={active}>
        <Link
          href={`/dashboard/pages/${pageId}`}
          aria-current={active ? "page" : undefined}
          // The one thing worth signifying about a page: whether an agent is
          // handed it with the work.
          title={pinned ? `${title} — agents get this with the work` : title}
        >
          <FileText aria-hidden />
          <span className="truncate">{title}</span>
          {pinned && (
            <span className="ml-auto flex-shrink-0 text-micro uppercase tracking-wider text-muted-foreground">
              context
            </span>
          )}
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
    // The hairline closes the rail the way the capsule opens the page: the
    // utility cluster is chrome about the app, not part of the tree, and a
    // rule above it is what keeps it from reading as four more nav rows.
    <SidebarFooter className="border-t border-sidebar-border pt-2">
      <div className="group-data-[collapsible=icon]:hidden">
        <RunningTimerChip />
      </div>
      <AdminMenuItem />
      <AppearanceMenuItem />
      <div className="px-1">
        <ThemeToggle collapsed={collapsed} />
      </div>
      <div className="flex items-center gap-2 rounded-full px-1 py-0.5 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-1 group-data-[collapsible=icon]:px-0">
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

/**
 * The way into customise mode.
 *
 * A button rather than a link, because customising is not somewhere you go.
 * It turns the screen you are already on into its own editor — your projects,
 * your tasks, your numbers stay exactly where they are and gain an inspector.
 * Nobody has to imagine the result of a change or judge a look against
 * somebody else's sample data.
 *
 * The full studio still exists for the wider settings (typefaces, navigation,
 * motion) and is one click further in, from the inspector.
 */
function AppearanceMenuItem() {
  const { active, setActive } = useCustomize();
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={active}
          tooltip="Customise this screen"
          onClick={() => {
            const next = !active;
            setActive(next);
            // On a phone the sidebar is a full-screen drawer, so turning the
            // mode on from inside it left the inspector and the whole canvas
            // behind an opaque sheet — the one surface the mode exists to let
            // you edit in place was the one thing you could not see. Entering
            // the mode has to get out of its own way.
            //
            // Only on entry: leaving the mode from inside the drawer is an
            // ordinary menu action, and closing the nav underneath somebody
            // who was using it would be its own small rudeness.
            if (next && isMobile) setOpenMobile(false);
          }}
        >
          <Sparkles className="text-muted-foreground" />
          <span className="flex-1 truncate">
            {active ? "Done customising" : "Customise"}
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
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
            <span className="rounded-full bg-sidebar-primary px-1.5 py-0.5 text-micro font-medium uppercase tracking-wider text-sidebar-primary-foreground group-data-[collapsible=icon]:hidden">
              {me.role === "superadmin" ? "Super" : "Admin"}
            </span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
