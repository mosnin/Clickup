import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Operate plugins and skills",
  description:
    "Connect Operate to ChatGPT, Claude, Codex, and any remote-MCP client, or install its project skills with one curl command.",
};

const SKILLS = [
  ["Plan", "Compile a confirmed brief into an auditable workstream graph."],
  ["Dispatch", "Release capability- and capacity-safe execution waves."],
  ["Worker", "Claim, execute, heartbeat, attach evidence, and finish work."],
  ["Daily ops", "Turn live work into a factual operating brief."],
  ["Recovery", "Recover failed or abandoned work without erasing history."],
  [
    "Assurance",
    "Verify every original success criterion against independent evidence.",
  ],
  [
    "Decisions",
    "Version policy changes and revalidate every affected task.",
  ],
] as const;

const EXAMPLES = [
  "Turn this confirmed brief into an auditable multi-workstream execution plan.",
  "Show me the next safe execution wave and explain what is blocked.",
  "Summarize running, failed, retryable, and completed work for this plan.",
  "Verify this plan's original success criteria with independent evidence.",
] as const;

export default function PluginsPage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
      <div className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-600 dark:text-brand-500">
          Native AI integrations
        </p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-6xl">
          Bring Operate into the conversation.
        </h1>
        <p className="mt-5 text-lg leading-8 text-muted-foreground">
          One production remote-MCP connection for ChatGPT, Claude, Codex,
          and standards-compatible clients—plus focused project skills you can
          install without NPX.
        </p>
      </div>

      <section className="mt-12 grid gap-5 lg:grid-cols-2">
        <div className="min-w-0 rounded-3xl bg-card p-6 sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Project skill pack
          </p>
          <h2 className="mt-2 text-2xl font-semibold">
            Install with one URL
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Run this from a project root. It writes seven readable
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-xs">
              SKILL.md
            </code>
            files into
            <code className="ml-1 rounded bg-muted px-1.5 py-0.5 text-xs">
              .agents/skills
            </code>
            .
          </p>
          <pre className="mt-5 max-w-full overflow-x-auto rounded-2xl bg-neutral-950 p-4 text-sm text-white">
            <code>
              curl -fsSL https://operate.to/install/skills | sh
            </code>
          </pre>
          <p className="mt-3 break-words text-xs text-muted-foreground">
            Claude-specific path:{" "}
            <code className="break-all">
              curl -fsSL https://operate.to/install/skills | OPERATE_SKILLS_DIR=.claude/skills sh
            </code>
          </p>
        </div>

        <div className="min-w-0 rounded-3xl bg-card p-6 sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Remote MCP
          </p>
          <h2 className="mt-2 text-2xl font-semibold">
            Secure account connection
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            After directory approval, users install Operate from the Plugins
            tab and connect once. Developers and standards-compatible clients can use
            the same endpoint below. OAuth asks you to choose an authorized
            Operate agent and inherits its permissions, budgets, and approval
            gates; only a workspace owner can link a workspace-wide agent.
          </p>
          <pre className="mt-5 max-w-full overflow-x-auto rounded-2xl bg-neutral-950 p-4 text-sm text-white">
            <code>https://www.operate.to/api/mcp</code>
          </pre>
          <p className="mt-3 text-xs text-muted-foreground">
            Existing developer API keys continue to work for server-to-server
            and custom-runtime connections.
          </p>
        </div>
      </section>

      <section className="mt-12">
        <h2 className="text-2xl font-semibold">Included skills</h2>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {SKILLS.map(([name, description]) => (
            <article
              key={name}
              className="rounded-2xl bg-card p-5"
            >
              <h3 className="font-semibold">{name}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {description}
              </p>
            </article>
          ))}
        </div>
      </section>

      <section className="mt-12 rounded-3xl bg-brand-500/[0.07] p-6 sm:p-8">
        <h2 className="text-2xl font-semibold">Try these prompts</h2>
        <ul className="mt-5 space-y-3">
          {EXAMPLES.map((example) => (
            <li
              key={example}
              className="rounded-2xl border border-brand-500/15 bg-background/70 px-4 py-3 text-sm"
            >
              “{example}”
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-12 border-t border-border pt-8 text-sm text-muted-foreground">
        <p>
          Need help connecting or preparing a review account? Email{" "}
          <a
            className="font-medium text-foreground hover:underline"
            href="mailto:support@operate.to"
          >
            support@operate.to
          </a>
          .
        </p>
        <p className="mt-2">
          Review the{" "}
          <Link className="text-foreground hover:underline" href="/legal/privacy">
            Privacy Policy
          </Link>{" "}
          and{" "}
          <Link className="text-foreground hover:underline" href="/legal/terms">
            Terms of Service
          </Link>
          .
        </p>
      </section>
    </main>
  );
}
