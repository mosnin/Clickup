import Link from "next/link";
import { SITE_TAGLINE } from "@/lib/marketing-nav";
import { AuroraShell } from "./aurora-shell";

// Split-screen auth shell: the left half is one sentence (the same
// tagline as the marketing site), the right half signs you in.
// Below lg the brand half collapses to a compact header so the form is
// the first thing on screen. Raw <video> HTML keeps muted/playsinline in
// the served markup so the ambient loop autoplays on mobile Safari too.
// The whole shell sits inside <AuroraShell> — the WebGL Aurora Glow frame
// that lights up when the page opens (see aurora-shell.tsx); the ripple
// radiates from the auth card, which carries data-aura-origin.

const AMBIENT_CLIP = `<video src="/screenshots/cta-ascii.mp4" autoplay muted loop playsinline preload="auto" aria-hidden="true" class="h-full w-full object-cover opacity-35"></video>`;

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuroraShell>
      <aside className="relative z-[1] hidden w-[46%] flex-col justify-between overflow-hidden p-10 lg:flex xl:p-14">
        <div
          aria-hidden
          className="absolute inset-0"
          dangerouslySetInnerHTML={{ __html: AMBIENT_CLIP }}
        />
        {/* Veil so the copy stays legible over the moving backdrop. */}
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-t from-[#0a0a0a] via-[#0a0a0a]/80 to-[#0a0a0a]/40"
        />

        <Link
          href="/"
          aria-label="operate.to"
          className="relative inline-flex w-fit items-center"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/operate-logo-white.svg"
            alt="operate.to"
            className="h-7 w-auto"
          />
        </Link>

        <div className="relative max-w-md">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight xl:text-4xl">
            {SITE_TAGLINE}
          </h1>
        </div>

        <p className="relative text-xs uppercase tracking-widest text-white/40">
          Built for humans and agents
        </p>
      </aside>

      <main className="relative z-[1] flex min-h-dvh w-full flex-col lg:w-[54%]">
        <header className="flex justify-center px-4 pt-8 lg:hidden">
          <Link href="/" aria-label="operate.to" className="inline-flex">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/operate-logo-white.svg"
              alt="operate.to"
              className="h-6 w-auto"
            />
          </Link>
        </header>
        {/* data-aura-origin: the ripple radiates from the auth card. */}
        <div
          data-aura-origin
          className="flex w-full flex-1 flex-col items-center justify-center gap-6 px-4 py-10"
        >
          {children}
          <p className="max-w-xs text-center text-xs text-white/50">
            By continuing you agree to the{" "}
            <Link
              href="/legal/terms"
              className="text-white/75 underline underline-offset-2 hover:text-white"
            >
              Terms
            </Link>{" "}
            and{" "}
            <Link
              href="/legal/privacy"
              className="text-white/75 underline underline-offset-2 hover:text-white"
            >
              Privacy Policy
            </Link>
            .
          </p>
        </div>
      </main>
    </AuroraShell>
  );
}
