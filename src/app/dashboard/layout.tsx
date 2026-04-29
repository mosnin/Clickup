import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { DashboardSidebar } from "@/components/dashboard/sidebar";
import { EnsureUser } from "@/components/dashboard/ensure-user";
import { BottomTabs } from "@/components/dashboard/bottom-tabs";
import { CommandPaletteProvider } from "@/components/dashboard/command-palette";
import { FirstRunDialog } from "@/components/dashboard/first-run-dialog";
import { KeyboardShortcuts } from "@/components/dashboard/keyboard-shortcuts";
import { ToastProvider } from "@/components/dashboard/toast";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  return (
    <ToastProvider>
      <CommandPaletteProvider>
        <div className="flex min-h-dvh">
          <EnsureUser />
          <DashboardSidebar />
          <main className="flex-1 overflow-x-hidden">
            {/* pb-20 on mobile to clear the bottom tab bar. */}
            <div className="mx-auto max-w-5xl px-4 py-8 pb-20 pt-16 sm:px-8 md:pb-8 md:pt-8">
              {children}
            </div>
          </main>
          <BottomTabs />
          <KeyboardShortcuts />
          <FirstRunDialog />
        </div>
      </CommandPaletteProvider>
    </ToastProvider>
  );
}
