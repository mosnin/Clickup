import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { DashboardSidebar } from "@/components/dashboard/sidebar";
import { EnsureUser } from "@/components/dashboard/ensure-user";

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
    <div className="min-h-dvh bg-page p-0 md:p-4">
      <EnsureUser />
      <div className="mx-auto flex min-h-dvh max-w-[1400px] overflow-hidden bg-background shadow-sm md:min-h-[calc(100dvh-2rem)] md:rounded-2xl md:border md:border-border">
        <DashboardSidebar />
        <main className="flex-1 overflow-x-hidden">
          <div className="mx-auto max-w-5xl px-4 py-8 pt-16 sm:px-8 md:pt-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
