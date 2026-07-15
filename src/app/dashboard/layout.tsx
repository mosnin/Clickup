import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { DashboardSidebar } from "@/components/dashboard/sidebar";
import { EnsureUser } from "@/components/dashboard/ensure-user";
import { ToastProvider } from "@/components/toast";
import { CommandPalette } from "@/components/command-palette";
import { AgentOnlineWatcher } from "@/components/dashboard/agent-online-watcher";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  // The app renders as a white sheet floating on the gray page canvas —
  // sidebar and content live inside one rounded, hairline-bordered frame.
  return (
    <ToastProvider>
      <div className="min-h-dvh bg-page p-0 md:p-4">
        <EnsureUser />
        <CommandPalette />
        <AgentOnlineWatcher />
        <div className="app-frame mx-auto flex min-h-dvh max-w-[1400px] overflow-hidden bg-background md:min-h-[calc(100dvh-2rem)] md:rounded-[1.75rem]">
          <DashboardSidebar />
          <main className="flex-1 overflow-x-hidden">
            <div className="mx-auto max-w-5xl px-4 py-8 pt-16 sm:px-8 md:pt-8">
              {children}
            </div>
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
