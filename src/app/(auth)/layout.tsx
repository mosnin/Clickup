import Link from "next/link";

// Sign-in / sign-up live on the azure→navy marketing band — the same
// gradient as the site hero — so the first pixels a new user sees already
// look like operate.to, not a bare auth screen.
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center bg-[linear-gradient(180deg,var(--color-azure-500)_0%,var(--color-azure-700)_50%,var(--color-navy-900)_100%)] px-4 py-8">
      <header className="w-full max-w-6xl">
        <Link href="/" className="inline-flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full bg-azure-200"
          />
          <span className="text-sm font-semibold text-white">operate</span>
        </Link>
      </header>
      <main className="flex w-full flex-1 flex-col items-center justify-center gap-6 py-10">
        {children}
        <p className="max-w-xs text-center text-xs text-white/70">
          By continuing you agree to the{" "}
          <Link
            href="/legal/terms"
            className="text-white/90 underline underline-offset-2"
          >
            Terms
          </Link>{" "}
          and{" "}
          <Link
            href="/legal/privacy"
            className="text-white/90 underline underline-offset-2"
          >
            Privacy Policy
          </Link>
          .
        </p>
      </main>
    </div>
  );
}
