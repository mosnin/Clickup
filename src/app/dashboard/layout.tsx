import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { DashboardSidebar } from "@/components/dashboard/sidebar";
import { EnsureUser } from "@/components/dashboard/ensure-user";
import { CommandPaletteProvider } from "@/components/dashboard/command-palette";
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
            <div className="mx-auto max-w-5xl px-4 py-8 pt-16 sm:px-8 md:pt-8">
              {children}
            </div>
          </main>
          <KeyboardShortcuts />
        </div>
      </CommandPaletteProvider>
    </ToastProvider>
  );
}
