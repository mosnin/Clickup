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
    <div className="flex min-h-dvh flex-col items-center bg-[radial-gradient(60rem_30rem_at_50%_-8%,rgba(255,138,61,0.16),transparent_60%),linear-gradient(180deg,#0f0f14_0%,#08080b_100%)] px-4 py-8">
      <header className="w-full max-w-6xl">
        <Link href="/" aria-label="operate.to" className="inline-flex items-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/operate-logo-white.svg"
            alt="operate.to"
            className="h-6 w-auto"
          />
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
