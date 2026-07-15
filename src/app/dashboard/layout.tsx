import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { DashboardSidebar } from "@/components/dashboard/sidebar";
import { EnsureUser } from "@/components/dashboard/ensure-user";
import { ToastProvider } from "@/components/toast";
import { CommandPalette } from "@/components/command-palette";
import { AgentOnlineWatcher } from "@/components/dashboard/agent-online-watcher";
import { RequireBackend } from "@/components/require-backend";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  // Full-screen app: white sidebar + gray working canvas, edge to edge.
  // White .bento cards float on the canvas — no boxed outer frame.
  return (
    <RequireBackend>
    <ToastProvider>
      <div className="flex min-h-dvh bg-page">
        <EnsureUser />
        <CommandPalette />
        <AgentOnlineWatcher />
        <DashboardSidebar />
        <main className="min-w-0 flex-1 overflow-x-hidden">
          <div className="mx-auto w-full max-w-7xl px-4 py-8 pt-16 sm:px-8 md:pt-8">
            {children}
          </div>
        </main>
      </div>
    </ToastProvider>
    </RequireBackend>
  );
}
