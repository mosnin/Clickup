import Link from "next/link";
import { TerminalSurface } from "@/components/terminal-surface";

// 404: the one page where the faulty terminal IS the concept. Full-bleed
// glyph static, a plain statement, one way home.

export default function NotFound() {
  return (
    <TerminalSurface
      intensity="live"
      className="min-h-dvh"
      contentClassName="flex min-h-dvh flex-col items-center justify-center px-6 text-center"
    >
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-white/50">
        Error 404
      </p>
      <h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">
        This page glitched out of existence.
      </h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-white/60">
        The address may be mistyped, or whatever lived here has been moved or
        deleted.
      </p>
      <div className="mt-8 flex items-center gap-4">
        <Link
          href="/"
          className="rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black transition-transform active:scale-[0.98]"
        >
          Back to safety
        </Link>
        <Link
          href="/dashboard"
          className="text-sm font-medium text-white/70 transition-colors hover:text-white"
        >
          Open the app
        </Link>
      </div>
    </TerminalSurface>
  );
}
