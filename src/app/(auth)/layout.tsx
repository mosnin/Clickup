import Link from "next/link";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="px-4 pt-6 sm:px-8">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm font-semibold tracking-tight"
        >
          <span
            aria-hidden
            className="inline-block h-4 w-4 rounded-[5px] bg-foreground"
          />
          ClickUp Clone
        </Link>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        {children}
      </main>
    </div>
  );
}
