"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Inbox, Plus, Sparkles, Trash2 } from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { useCommandPalette } from "@/components/dashboard/command-palette";
import { tapLight } from "@/lib/haptics";
import { cn } from "@/lib/utils";

// Fixed-bottom mobile nav. Five slots: Home / Inbox / + (palette) /
// Brain / Trash. Hidden on md+ where the sidebar is the primary nav.
//
// The center "+" doesn't navigate — it pops the command palette so the
// user can search or trigger any "create" command without leaving the
// thumb zone. Matches the ⌘K affordance everywhere else in the app.

type Tab = {
  href?: string;
  label: string;
  icon: typeof Home;
  match?: (pathname: string) => boolean;
};

const TABS: Tab[] = [
  {
    href: "/dashboard",
    label: "Home",
    icon: Home,
    match: (p) => p === "/dashboard" || p.startsWith("/dashboard/personal") || p.startsWith("/dashboard/w/") || p.startsWith("/dashboard/l/") || p.startsWith("/dashboard/d/") || p.startsWith("/dashboard/wb/"),
  },
  { href: "/dashboard/inbox", label: "Inbox", icon: Inbox },
  // Center action — no href; opens the command palette.
  { label: "Find", icon: Plus },
  { href: "/dashboard/brain", label: "Brain", icon: Sparkles },
  { href: "/dashboard/trash", label: "Trash", icon: Trash2 },
];

export function BottomTabs() {
  const pathname = usePathname() ?? "/dashboard";
  const { open } = useCommandPalette();
  const unread = useQuery(api.mentions.unreadCountForCurrent, {});

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const active = tab.href
          ? tab.match
            ? tab.match(pathname)
            : pathname === tab.href
          : false;
        const isCenter = !tab.href;

        if (isCenter) {
          return (
            <button
              key={tab.label}
              type="button"
              aria-label="Open command palette"
              onClick={() => {
                tapLight();
                open();
              }}
              className="flex flex-col items-center justify-center gap-0.5 py-2"
            >
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-brand-600 text-white shadow-lg shadow-brand-900/30">
                <Icon className="h-5 w-5" />
              </span>
            </button>
          );
        }

        return (
          <Link
            key={tab.label}
            href={tab.href!}
            onClick={() => tapLight()}
            className={cn(
              "relative flex flex-col items-center justify-center gap-0.5 py-2 text-[10px]",
              active ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <span className="relative">
              <Icon
                className={cn("h-5 w-5", active && "text-brand-600")}
              />
              {tab.href === "/dashboard/inbox" &&
                typeof unread === "number" &&
                unread > 0 && (
                  <span className="absolute -right-2 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[9px] font-medium text-white">
                    {unread > 9 ? "9+" : unread}
                  </span>
                )}
            </span>
            <span>{tab.label}</span>
            {active && (
              <span
                aria-hidden
                className="absolute top-0 h-0.5 w-8 rounded-b-full bg-brand-600"
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
