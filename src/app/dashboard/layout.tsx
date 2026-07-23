import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DashboardSidebar } from "@/components/dashboard/sidebar";
import { EnsureUser } from "@/components/dashboard/ensure-user";
import { ToastProvider } from "@/components/toast";
import { CommandPalette } from "@/components/command-palette";
import { AgentOnlineWatcher } from "@/components/dashboard/agent-online-watcher";
import { RequireBackend } from "@/components/require-backend";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  // Read the vendored sidebar's own persistence cookie so the collapsed/
  // expanded state survives a full page load instead of flashing open every
  // time (M3). Name/values must match SIDEBAR_COOKIE_NAME in
  // src/components/ui/sidebar.tsx, which writes "true"/"false" strings.
  const cookieStore = await cookies();
  const sidebarCookie = cookieStore.get("sidebar_state")?.value;
  const defaultOpen = sidebarCookie !== "false";

  // Square UI dashboard-5 shell: exactly ONE SidebarProvider for the whole
  // dashboard (DashboardSidebar renders only the <Sidebar>, no provider of
  // its own — see its top comment). The provider wrapper is pinned to the
  // viewport height with overflow hidden so SidebarInset — not the document
  // — is the real scroll container; that's what lets PageHeader's
  // `sticky top-0` actually stick (M1). Pages own their own sticky headers
  // and content padding; this shell only owns the scroll container.
  return (
    <RequireBackend>
      <ToastProvider>
        <SidebarProvider defaultOpen={defaultOpen} className="h-svh overflow-hidden">
          <EnsureUser />
          <CommandPalette />
          <AgentOnlineWatcher />
          <DashboardSidebar />
          <SidebarInset className="h-full min-w-0 overflow-y-auto">
            <div className="w-full px-4 py-6 sm:px-6">{children}</div>
          </SidebarInset>
          {/* One continuous brand gradient across the entire viewport's bottom
              edge — the single strip of product flair, coherent by
              construction (unlike per-panel strips that restart at seams). */}
          <div
            aria-hidden
            className="gradient-strip pointer-events-none fixed inset-x-0 bottom-0 z-50"
          />
        </SidebarProvider>
      </ToastProvider>
    </RequireBackend>
  );
}
