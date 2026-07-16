"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Bell, Check } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time";
import { AnimatePresence, motion } from "@/components/motion";

// The in-app notification center: a bell in the sidebar nav band with an
// unread count, opening a dropdown of recent notifications. Rows are written
// in-transaction with the thing they announce (assignment, mention, approval,
// invite, due-soon, overdue), so this is always consistent. Clicking a row
// marks it read and follows its deep link.

// Right-anchored hover tooltip mirroring the sidebar's RailTip.
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

export function NotificationBell({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const unread = useQuery(api.notificationCenter.unreadCount, {});
  const items = useQuery(
    api.notificationCenter.listForCurrent,
    open ? {} : "skip",
  );
  const markRead = useMutation(api.notificationCenter.markRead);
  const markAllRead = useMutation(api.notificationCenter.markAllRead);
  const router = useRouter();

  const count = typeof unread === "number" ? unread : 0;
  const hasUnread = count > 0;

  function activate(n: Doc<"notifications">) {
    if (n.readAt === undefined) void markRead({ notificationId: n._id });
    setOpen(false);
    if (n.href) {
      onNavigate();
      router.push(n.href);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={
          hasUnread ? `Notifications, ${count} unread` : "Notifications"
        }
        className={cn(
          "group relative mb-1 flex w-full items-center gap-2 rounded-lg text-sm transition-colors",
          collapsed
            ? "md:justify-center md:px-0 md:py-2 px-2.5 py-1.5"
            : "px-2.5 py-1.5",
          open
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <span className="relative z-10 inline-flex">
          <Bell className="h-4 w-4" />
          {hasUnread && (
            <span className="absolute -right-1 -top-1 inline-flex h-2 w-2 rounded-full bg-brand-600 ring-2 ring-background" />
          )}
        </span>
        <span className={cn("flex-1 text-left", collapsed && "md:hidden")}>
          Notifications
        </span>
        {hasUnread && (
          <span
            className={cn(
              "rounded-full bg-foreground px-1.5 py-0.5 text-[10px] font-medium text-background",
              collapsed && "md:hidden",
            )}
          >
            {count > 99 ? "99+" : count}
          </span>
        )}
        {collapsed && <RailTip label="Notifications" />}
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
              className={cn(
                "absolute z-50 mt-1 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-background shadow-lg",
                collapsed ? "left-full ml-2 top-0" : "left-0 top-full",
              )}
            >
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Notifications
                </span>
                {hasUnread && (
                  <button
                    type="button"
                    onClick={() => void markAllRead({})}
                    className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Check className="h-3 w-3" /> Mark all read
                  </button>
                )}
              </div>

              <div className="max-h-96 overflow-y-auto">
                {items === undefined ? (
                  <div className="space-y-2 p-3">
                    {[0, 1, 2].map((i) => (
                      <div
                        key={i}
                        className="h-10 animate-pulse rounded-lg bg-muted"
                      />
                    ))}
                  </div>
                ) : items.length === 0 ? (
                  <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                    You&apos;re all caught up.
                  </p>
                ) : (
                  <ul className="p-1">
                    {items.map((n) => (
                      <li key={n._id}>
                        <NotificationRow
                          n={n}
                          onActivate={() => activate(n)}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function NotificationRow({
  n,
  onActivate,
}: {
  n: Doc<"notifications"> & { _id: Id<"notifications"> };
  onActivate: () => void;
}) {
  const unread = n.readAt === undefined;
  const body = (
    <>
      <span
        aria-hidden
        className={cn(
          "mt-1.5 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full",
          unread ? "bg-brand-600" : "bg-transparent",
        )}
      />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-sm",
            unread ? "font-medium text-foreground" : "text-foreground/80",
          )}
        >
          {n.title}
        </span>
        {n.body && (
          <span className="block truncate text-xs text-muted-foreground">
            {n.body}
          </span>
        )}
        <span className="mt-0.5 block text-[11px] text-muted-foreground">
          {timeAgo(n.createdAt)}
        </span>
      </span>
    </>
  );

  const cls =
    "flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted";

  return (
    <button type="button" onClick={onActivate} className={cls}>
      {body}
    </button>
  );
}
