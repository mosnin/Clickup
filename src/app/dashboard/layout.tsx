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

  return (
    <div className="flex min-h-dvh">
      <EnsureUser />
      <DashboardSidebar />
      <main className="flex-1 overflow-x-hidden">
        <div className="mx-auto max-w-5xl px-4 py-8 pt-16 sm:px-8 md:pt-8">
          {children}
        </div>
      </main>
    </div>
  );
}
