"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { AnimatePresence, motion } from "motion/react";
import {
  Bot,
  FileText,
  FolderKanban,
  Home,
  Inbox,
  LayoutGrid,
  MessageSquare,
  Search,
  SquareCheck,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import { EASE, SPRING } from "@/components/motion";
import { createAnimatable, scaled, type AnimatableObject } from "@/lib/anime";
import { hoveredIndex, normalizeLayout } from "@/lib/screen-layout";
import { cn } from "@/lib/utils";

// The dock.
//
// Dragging the sidebar to the bottom of the screen doesn't rotate it — a column
// of labels lying on its side is a worse column. It becomes a different thing:
// a row of glyphs that magnify under the cursor, with everything the sidebar
// said in words moving into panels that rise from the item you press.
//
// The magnification is the signature and it has to be done properly. Scale is a
// function of horizontal distance from the cursor, applied per frame to every
// item, which is what makes the row feel like a surface being deformed rather
// than a set of buttons with hover states. `createAnimatable` exists for
// exactly this: a value driven by a pointer rather than by a timeline, easing
// toward each new target so the deformation has weight.
//
// Item order is stored as an ordinary screen layout under the key "nav", so
// rearranging the dock uses the same store, the same mutation and the same
// normalization as rearranging a project screen. There is no second concept.

const NAV_KEY = "nav";

type DockItem = {
  id: string;
  label: string;
  href: string;
  icon: typeof Home;
  /** Rendered in the panel that rises from this item. */
  panel?: "inbox" | "agents" | "search";
};

const DOCK_ITEMS: DockItem[] = [
  { id: "home", label: "Home", href: "/dashboard", icon: Home },
  { id: "my-work", label: "My work", href: "/dashboard/my-work", icon: SquareCheck },
  { id: "spaces", label: "Spaces", href: "/dashboard/spaces", icon: LayoutGrid },
  { id: "projects", label: "Projects", href: "/dashboard/projects", icon: FolderKanban },
  { id: "pages", label: "Pages", href: "/dashboard/pages", icon: FileText },
  { id: "chat", label: "Chat", href: "/dashboard/chat", icon: MessageSquare },
  {
    id: "inbox",
    label: "Inbox",
    href: "/dashboard/inbox",
    icon: Inbox,
    panel: "inbox",
  },
  {
    id: "agents",
    label: "Agents",
    href: "/dashboard/agents",
    icon: Bot,
    panel: "agents",
  },
  {
    id: "search",
    label: "Search",
    href: "/dashboard/search",
    icon: Search,
    panel: "search",
  },
];

const ITEM_BY_ID = new Map(DOCK_ITEMS.map((i) => [i.id, i]));
const DEFAULT_ORDER = DOCK_ITEMS.map((i) => i.id);

/** How far the cursor's influence reaches, in px. */
const REACH = 130;
/** Peak scale directly under the cursor. */
const PEAK = 0.85;
/** How long a press has to last before an item can be dragged. */
const HOLD_MS = 400;

export function AppDock() {
  const pathname = usePathname();
  const stored = useQuery(api.screens.layoutFor, { screenKey: NAV_KEY });
  const saveLayout = useMutation(api.screens.saveLayout);
  const unread = useQuery(api.mentions.unreadCountForCurrent, {});

  const [openPanel, setOpenPanel] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const animatables = useRef<Map<string, AnimatableObject>>(new Map());

  const order = useMemo<string[]>(() => {
    if (!stored) return DEFAULT_ORDER;
    const normalized = normalizeLayout(stored.layout, DEFAULT_ORDER);
    // An empty dock is a dock you cannot navigate out of, which is the one
    // customisation that has to be refused rather than honoured.
    return normalized.widgets.length > 0
      ? normalized.widgets.map((w) => w.id)
      : DEFAULT_ORDER;
  }, [stored]);

  const orderRef = useRef(order);
  orderRef.current = order;

  const persist = useCallback(
    (next: string[]) => {
      void saveLayout({
        screenKey: NAV_KEY,
        layout: { widgets: next.map((id) => ({ id, span: 1 })) },
      }).catch(() => {
        // A dock that didn't save its order is still a working dock.
      });
    },
    [saveLayout],
  );

  // ── Magnification ──
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const map = animatables.current;
    map.clear();
    for (const el of rail.querySelectorAll<HTMLElement>("[data-dock-item]")) {
      map.set(
        el.dataset.dockItem!,
        createAnimatable(el, {
          scale: scaled(180),
          y: scaled(180),
          ease: "outQuad",
        }),
      );
    }

    const apply = (cursorX: number | null) => {
      for (const el of rail.querySelectorAll<HTMLElement>("[data-dock-item]")) {
        const anim = map.get(el.dataset.dockItem!);
        if (!anim) continue;
        if (cursorX === null) {
          anim.scale(1);
          anim.y(0);
          continue;
        }
        const box = el.getBoundingClientRect();
        const distance = Math.abs(cursorX - (box.left + box.width / 2));
        if (distance > REACH) {
          anim.scale(1);
          anim.y(0);
          continue;
        }
        // Cosine falloff rather than linear: linear gives the row a visible
        // kink at the edge of the influence zone, where cosine arrives at rest
        // with zero slope and the surface reads as continuous.
        const t = Math.cos((distance / REACH) * (Math.PI / 2));
        anim.scale(1 + PEAK * t);
        // Lift with the scale, so items grow upward out of the dock instead of
        // pushing their own bottom edge off the screen.
        anim.y(-14 * t);
      }
    };

    const onMove = (e: PointerEvent) => apply(e.clientX);
    const onLeave = () => apply(null);
    rail.addEventListener("pointermove", onMove);
    rail.addEventListener("pointerleave", onLeave);
    return () => {
      rail.removeEventListener("pointermove", onMove);
      rail.removeEventListener("pointerleave", onLeave);
      for (const anim of map.values()) anim.revert();
      map.clear();
    };
  }, [order]);

  // ── Reordering ──
  const hold = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    id: string | null;
  }>({ timer: null, id: null });

  useEffect(() => {
    if (!dragging) return;
    const rail = railRef.current;
    if (!rail) return;

    const onMove = (e: PointerEvent) => {
      const items = Array.from(
        rail.querySelectorAll<HTMLElement>("[data-dock-item]"),
      );
      const boxes = items.map((el) => el.getBoundingClientRect());
      const current = orderRef.current.indexOf(dragging);
      const over = hoveredIndex(
        boxes,
        { x: e.clientX, y: e.clientY },
        current,
      );
      if (over < 0 || over === current) return;
      const next = [...orderRef.current];
      next.splice(current, 1);
      next.splice(over, 0, dragging);
      orderRef.current = next;
      persist(next);
    };
    const onUp = () => setDragging(null);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, persist]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenPanel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      {/* The panel rises from the item, and clicking anywhere else dismisses
          it — a dock panel is a glance, not a place you navigate into. */}
      <AnimatePresence>
        {openPanel && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: EASE }}
              onClick={() => setOpenPanel(null)}
              className="fixed inset-0 z-40 bg-foreground/5 backdrop-blur-[2px]"
            />
            <motion.div
              initial={{ opacity: 0, y: 28, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.96 }}
              transition={SPRING}
              role="dialog"
              aria-label={ITEM_BY_ID.get(openPanel)?.label}
              className="fixed bottom-28 left-1/2 z-50 max-h-[60vh] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 overflow-y-auto rounded-2xl bg-card p-5 shadow-2xl"
            >
              <DockPanel id={openPanel} onClose={() => setOpenPanel(null)} />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
        <div
          ref={railRef}
          className="pointer-events-auto flex items-end gap-1 rounded-2xl bg-card/90 px-3 py-2 shadow-2xl backdrop-blur-xl"
        >
          {order.map((id) => {
            const item = ITEM_BY_ID.get(id);
            if (!item) return null;
            const Icon = item.icon;
            const active =
              item.href === "/dashboard"
                ? pathname === "/dashboard"
                : pathname.startsWith(item.href);
            const badge = item.id === "inbox" ? (unread ?? 0) : 0;

            const body = (
              <>
                <Icon className="h-5 w-5" />
                {badge > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-[9px] font-medium text-background">
                    {badge > 9 ? "9+" : badge}
                  </span>
                )}
                {active && (
                  <span
                    aria-hidden
                    className="absolute -bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-foreground"
                  />
                )}
              </>
            );

            const shared = {
              "data-dock-item": item.id,
              title: item.label,
              onPointerDown: () => {
                hold.current.id = item.id;
                hold.current.timer = setTimeout(() => {
                  setDragging(item.id);
                  if (typeof navigator !== "undefined" && navigator.vibrate) {
                    navigator.vibrate(6);
                  }
                }, HOLD_MS);
              },
              onPointerUp: () => {
                if (hold.current.timer) clearTimeout(hold.current.timer);
                hold.current.timer = null;
              },
              onPointerLeave: () => {
                if (hold.current.timer) clearTimeout(hold.current.timer);
                hold.current.timer = null;
              },
              className: cn(
                "relative flex h-11 w-11 items-center justify-center rounded-xl transition-colors",
                active
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
                dragging === item.id && "opacity-60",
              ),
            };

            // Items with a panel open it in place; the rest navigate. Both are
            // one press — the difference is whether the answer fits in a panel.
            return item.panel ? (
              <button
                key={item.id}
                type="button"
                aria-label={item.label}
                aria-expanded={openPanel === item.id}
                onClick={() =>
                  setOpenPanel((cur) => (cur === item.id ? null : item.id))
                }
                {...shared}
              >
                {body}
              </button>
            ) : (
              <Link
                key={item.id}
                href={item.href}
                aria-label={item.label}
                aria-current={active ? "page" : undefined}
                {...shared}
              >
                {body}
              </Link>
            );
          })}
        </div>
      </div>
    </>
  );
}

/** What rises out of a dock item. */
function DockPanel({ id, onClose }: { id: string; onClose: () => void }) {
  if (id === "inbox") return <InboxPanel onClose={onClose} />;
  if (id === "agents") return <AgentsPanel onClose={onClose} />;
  return <SearchPanel onClose={onClose} />;
}

function PanelHeader({ title, href, onClose }: { title: string; href: string; onClose: () => void }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </span>
      <Link
        href={href}
        onClick={onClose}
        className="text-xs text-muted-foreground hover:text-foreground hover:underline"
      >
        Open
      </Link>
    </div>
  );
}

function InboxPanel({ onClose }: { onClose: () => void }) {
  const mentions = useQuery(api.mentions.listForCurrent, { unreadOnly: true });
  return (
    <div>
      <PanelHeader title="Inbox" href="/dashboard/inbox" onClose={onClose} />
      {(mentions ?? []).length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Nothing waiting on you.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {(mentions ?? []).slice(0, 8).map((m) => (
            <li key={m._id} className="text-xs">
              <span className="text-foreground">{m.byName ?? "Someone"}</span>{" "}
              <span className="text-muted-foreground">{m.snippet ?? ""}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AgentsPanel({ onClose }: { onClose: () => void }) {
  const agents = useQuery(api.agents.listForCurrentUser, {});
  const all = agents
    ? [...agents.personal, ...agents.workspaces.flatMap((w) => w.agents)]
    : [];
  return (
    <div>
      <PanelHeader title="Agents" href="/dashboard/agents" onClose={onClose} />
      {all.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No agents yet.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {all.slice(0, 10).map((a) => (
            <li key={a._id} className="flex items-center gap-2 text-xs">
              <span
                aria-hidden
                className={cn(
                  "h-1.5 w-1.5 flex-shrink-0 rounded-full",
                  a.lastSeenAt && Date.now() - a.lastSeenAt < 120_000
                    ? "bg-foreground"
                    : "bg-muted-foreground/40",
                )}
              />
              <Link
                href={`/dashboard/agents/${a._id}`}
                onClick={onClose}
                className="min-w-0 flex-1 truncate hover:underline"
              >
                {a.name}
              </Link>
              {a.statusText && (
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {a.statusText}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SearchPanel({ onClose }: { onClose: () => void }) {
  return (
    <div>
      <PanelHeader title="Search" href="/dashboard/search" onClose={onClose} />
      <p className="mt-3 text-xs text-muted-foreground">
        Press{" "}
        <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
          ⌘K
        </kbd>{" "}
        anywhere to jump to a list, page, task or agent.
      </p>
      <button
        type="button"
        onClick={() => {
          onClose();
          window.dispatchEvent(new CustomEvent("open-command-palette"));
        }}
        className="mt-3 w-full rounded-full bg-foreground px-3 py-2 text-xs text-background"
      >
        Open the palette
      </button>
    </div>
  );
}
