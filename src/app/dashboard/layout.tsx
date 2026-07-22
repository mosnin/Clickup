import { auth } from "@clerk/nextjs/server";
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

  // Square UI dashboard-5 shell: SidebarProvider wraps the sidebar (its own
  // bg-sidebar) and SidebarInset (bg-background), full height, edge to edge —
  // no outer app-frame/page-canvas chrome. Pages own their own sticky headers
  // and content padding; this shell only owns the scroll container.
  return (
    <RequireBackend>
      <ToastProvider>
        <SidebarProvider className="min-h-dvh">
          <EnsureUser />
          <CommandPalette />
          <AgentOnlineWatcher />
          <DashboardSidebar />
          <SidebarInset className="min-w-0 overflow-y-auto">
            <div className="w-full px-4 py-6 sm:px-6">{children}</div>
          </SidebarInset>
        </SidebarProvider>
      </ToastProvider>
    </RequireBackend>
  );
}
