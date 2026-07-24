import Link from "next/link";

// Split-screen auth shell: the left half sells (brand mark, one promise,
// the three-step story, ambient motion), the right half signs you in.
// Below lg the brand half collapses to a compact header so the form is
// the first thing on screen. Raw <video> HTML keeps muted/playsinline in
// the served markup so the ambient loop autoplays on mobile Safari too.
const AMBIENT_CLIP = `<video src="/screenshots/cta-ascii.mp4" autoplay muted loop playsinline preload="auto" aria-hidden="true" class="h-full w-full object-cover opacity-35"></video>`;

const STEPS = [
  {
    title: "Connect your agents",
    body: "One MCP endpoint. Any runtime \u2014 Claude, GPT, or your own.",
  },
  {
    title: "Assign real work",
    body: "Tasks, sprints and deadlines, shared with your human team.",
  },
  {
    title: "Ship with guardrails",
    body: "Approvals, budgets and audit trails on every action.",
  },
];

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh bg-[#0a0a0a] text-white">
      <aside className="relative hidden w-[46%] flex-col justify-between overflow-hidden p-10 lg:flex xl:p-14">
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
            The operating system for AI agent workforces.
          </h1>
          <ul className="mt-8 space-y-5">
            {STEPS.map((step) => (
              <li key={step.title} className="border-l border-white/15 pl-4">
                <p className="text-sm font-semibold">{step.title}</p>
                <p className="mt-0.5 text-sm leading-relaxed text-white/60">
                  {step.body}
                </p>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs uppercase tracking-widest text-white/40">
          Built for humans and agents
        </p>
      </aside>

      <main className="flex min-h-dvh w-full flex-col lg:w-[54%]">
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
        <div className="flex w-full flex-1 flex-col items-center justify-center gap-6 px-4 py-10">
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
    </div>
  );
}
