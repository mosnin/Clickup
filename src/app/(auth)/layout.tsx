import Link from "next/link";
import { PaceWordmark } from "@/components/brand/pace-mark";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="px-4 pt-6 sm:px-8">
        <Link href="/">
          <PaceWordmark />
        </Link>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        {children}
      </main>
    </div>
  );
}
