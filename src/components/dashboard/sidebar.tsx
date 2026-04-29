"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { UserButton } from "@clerk/nextjs";
import { Menu, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { mockPersonalSpaces, mockTeamWorkspaces } from "@/lib/mock-data";

export function DashboardSidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();

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
            className="flex items-center gap-2 text-sm font-semibold"
            onClick={() => setMobileOpen(false)}
          >
            <span
              aria-hidden
              className="inline-block h-6 w-6 rounded-full bg-brand-600"
            />
            ClickUp Clone
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
          <SectionHeader label="Personal" />
          <ul className="mt-1 space-y-0.5">
            {mockPersonalSpaces.map((space) => {
              const href = `/dashboard/personal`;
              return (
                <li key={space.id}>
                  <SidebarLink
                    href={href}
                    active={pathname === href}
                    onNavigate={() => setMobileOpen(false)}
                  >
                    <Dot color={space.color} />
                    {space.name}
                  </SidebarLink>
                </li>
              );
            })}
          </ul>

          <div className="mt-6 flex items-center justify-between">
            <SectionHeader label="Team workspaces" />
            <Link
              href="/onboarding"
              className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Create workspace"
              onClick={() => setMobileOpen(false)}
            >
              <Plus className="h-4 w-4" />
            </Link>
          </div>
          <ul className="mt-1 space-y-3">
            {mockTeamWorkspaces.map((ws) => {
              const wsHref = `/dashboard/w/${ws.id}`;
              return (
                <li key={ws.id}>
                  <SidebarLink
                    href={wsHref}
                    active={pathname === wsHref}
                    onNavigate={() => setMobileOpen(false)}
                  >
                    <Dot color="#6366f1" />
                    <span className="truncate">{ws.name}</span>
                    <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">
                      {ws.role}
                    </span>
                  </SidebarLink>
                  {ws.spaces.length > 0 && (
                    <ul className="ml-6 mt-1 space-y-0.5 border-l border-border pl-2">
                      {ws.spaces.map((space) => (
                        <li key={space.id}>
                          <SidebarLink
                            href={`/dashboard/w/${ws.id}#${space.id}`}
                            active={false}
                            onNavigate={() => setMobileOpen(false)}
                          >
                            <Dot color={space.color} />
                            {space.name}
                          </SidebarLink>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="flex items-center gap-3 border-t border-border px-4 py-3">
          <UserButton afterSignOutUrl="/" />
          <span className="text-xs text-muted-foreground">Account</span>
        </div>
      </aside>
    </>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <h3 className="px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {label}
    </h3>
  );
}

function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

function SidebarLink({
  href,
  active,
  onNavigate,
  children,
}: {
  href: string;
  active: boolean;
  onNavigate: () => void;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-2 rounded-2xl px-2 py-1.5 text-sm transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </Link>
  );
}
