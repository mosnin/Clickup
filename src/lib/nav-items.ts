import {
  Bot,
  Columns3,
  FileText,
  FolderKanban,
  Home,
  Inbox,
  LayoutTemplate,
  ListTodo,
  MessageSquare,
  Search,
  type LucideIcon,
} from "lucide-react";

// The navigation, as data.
//
// It was a hardcoded list of JSX rows in the sidebar and a second hardcoded
// list in the dock — so the most-looked-at surface in the product was the one
// thing nobody could shape, and the two surfaces could disagree about what the
// product even contains. Everything else here is already data: panels are
// definitions, screens are layouts, situations are conditions. The nav was the
// hole in the middle of that idea.
//
// One registry, both surfaces. Adding a destination is one entry.

export type NavItemId =
  | "home"
  | "inbox"
  | "chat"
  | "my-work"
  | "spaces"
  | "projects"
  | "pages"
  | "agents"
  | "templates"
  | "search";

export type NavItem = {
  id: NavItemId;
  label: string;
  href: string;
  icon: LucideIcon;
  /** Match the route exactly rather than by prefix. */
  exact?: boolean;
  /** Never hideable — without it there is no way back to the product. */
  required?: boolean;
  /** Present in the dock only; the sidebar has its own search row. */
  dockOnly?: boolean;
};

export const NAV_ITEMS: NavItem[] = [
  { id: "home", label: "Home", href: "/dashboard", icon: Home, exact: true, required: true },
  { id: "inbox", label: "Inbox", href: "/dashboard/inbox", icon: Inbox },
  { id: "chat", label: "Chat", href: "/dashboard/chat", icon: MessageSquare },
  { id: "my-work", label: "My work", href: "/dashboard/my-work", icon: ListTodo, exact: true },
  { id: "spaces", label: "Spaces", href: "/dashboard/spaces", icon: FolderKanban, exact: true },
  // Two different questions: Spaces answers "where does this live", Projects
  // answers "what am I running".
  { id: "projects", label: "Projects", href: "/dashboard/projects", icon: Columns3, exact: true },
  { id: "pages", label: "Pages", href: "/dashboard/pages", icon: FileText },
  { id: "agents", label: "Agents", href: "/dashboard/agents", icon: Bot },
  { id: "templates", label: "Templates", href: "/dashboard/templates", icon: LayoutTemplate },
  { id: "search", label: "Search", href: "/dashboard/search", icon: Search, dockOnly: true },
];

export const NAV_BY_ID = new Map(NAV_ITEMS.map((item) => [item.id, item]));

/** Everything, in shipped order. What somebody sees before anyone curates. */
export const DEFAULT_NAV_ORDER: NavItemId[] = NAV_ITEMS.map((i) => i.id);

/** The one screenLayouts key both the sidebar and the dock read. */
export const NAV_SCREEN_KEY = "nav";

function isNavItemId(value: unknown): value is NavItemId {
  return typeof value === "string" && NAV_BY_ID.has(value as NavItemId);
}

/**
 * A nav preference: what order, and what was deliberately put away.
 *
 * `hidden` is stored explicitly rather than inferred from absence, and that
 * is the whole design. An order list alone cannot tell "I hid Sprints" from
 * "Sprints did not exist when I arranged this" — so either every new feature
 * is invisible to everyone who ever customised, or hiding does not stick.
 * Naming both makes each answerable on its own.
 */
export type NavPref = { order: NavItemId[]; hidden: NavItemId[] };

/**
 * Read a preference out of whatever a layout row happens to hold.
 *
 * Layouts are `v.any()` by design — a row written by a newer build must
 * degrade rather than fail validation — so this accepts the widget shape the
 * screen layouts use, a bare array of ids, and null, and silently drops
 * anything it does not recognise.
 */
export function navPrefFrom(layout: unknown): NavPref | null {
  if (!layout || typeof layout !== "object") return null;
  const source = layout as { widgets?: unknown; hidden?: unknown };
  const raw = Array.isArray(layout)
    ? layout
    : Array.isArray(source.widgets)
      ? source.widgets
      : null;
  if (!raw) return null;
  const order = [
    ...new Set(
      raw
        .map((entry) =>
          typeof entry === "string" ? entry : (entry as { id?: unknown })?.id,
        )
        .filter(isNavItemId),
    ),
  ];
  const hidden = Array.isArray(source.hidden)
    ? [...new Set(source.hidden.filter(isNavItemId))]
    : [];
  // Nothing recognised is not "they chose nothing" — a row whose ids this
  // build has all renamed away should fall through to the layer beneath
  // rather than produce an empty nav.
  if (order.length === 0 && hidden.length === 0) return null;
  return { order, hidden };
}

/**
 * What this person's navigation is.
 *
 * Layered general → specific, the same precedence the appearance system uses
 * and for the same reason: a workspace curates what its people start with, a
 * person may always overrule it for themselves.
 *
 *   shipped default → workspace default → this person's own arrangement
 *
 * Three properties worth keeping:
 *
 * **A required item cannot be lost.** Home is how you get back, and a nav you
 * cannot navigate out of is a trap — the dock already refuses an empty
 * arrangement for exactly this reason. Required items are re-inserted rather
 * than the whole arrangement being rejected, because throwing away somebody's
 * deliberate ordering over one mistake is the worse failure.
 *
 * **A workspace default is a starting point, not a prohibition.** An admin
 * omitting Sprints means "most of us don't need this", not "you may not have
 * it" — so an unlisted item is still reachable, appended, until the person
 * themselves puts it away. Governance belongs in the Convex functions, never
 * in whether a link is drawn.
 *
 * **New destinations appear.** An id nobody has ruled on is appended, so
 * shipping a feature does not require every existing user to go hunting for
 * it. Hiding is always a decision somebody made, never a side effect of
 * having customised before the feature existed.
 */
export function resolveNav(
  personal: NavPref | null,
  workspace: NavPref | null,
  opts: { surface: "sidebar" | "dock" } = { surface: "sidebar" },
): NavItem[] {
  const active = personal ?? workspace ?? { order: DEFAULT_NAV_ORDER, hidden: [] };
  const hidden = new Set(active.hidden);

  const ordered = [...active.order];
  for (const id of DEFAULT_NAV_ORDER) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  for (const item of NAV_ITEMS) {
    if (item.required) hidden.delete(item.id);
    if (item.required && !ordered.includes(item.id)) ordered.unshift(item.id);
  }

  return ordered
    .map((id) => NAV_BY_ID.get(id))
    .filter((item): item is NavItem => item !== undefined)
    .filter((item) => !hidden.has(item.id))
    .filter((item) => (opts.surface === "dock" ? true : !item.dockOnly));
}

/** The shape `screens.saveLayout` stores. `hidden` rides alongside `widgets`. */
export function navLayoutFor(pref: NavPref) {
  return {
    widgets: pref.order.map((id) => ({ id, span: 1 })),
    hidden: pref.hidden,
  };
}
