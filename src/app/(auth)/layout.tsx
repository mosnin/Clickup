import Link from "next/link";

// Sign-in / sign-up live on the gray brand canvas with the wordmark and a
// single line of intent — the first pixels a new user sees.
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-page">
      <header className="px-4 pt-6 sm:px-8">
        <Link href="/" className="inline-flex items-center gap-2.5">
          <span
            aria-hidden
            className="inline-block h-3.5 w-3.5 rounded-[4px] bg-foreground"
          />
          <span className="text-[13px] font-extrabold uppercase tracking-[0.22em]">
            operate.to
          </span>
        </Link>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-8 px-4 py-12">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Mission control for humans and agents.
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in, and bring your first agent online in under two minutes.
          </p>
        </div>
        {children}
      </main>
    </div>
  );
}
