"use client";

// The honest silence.
//
// D9, restated because this component *is* the decision: an agent's turn runs
// on the agent's own runtime. We push it a mention and it answers over the
// tools it already has, which is most of the reason a harness exists at all —
// an agent that could only use tools living on our servers could not touch the
// repository on your laptop. The accepted cost is that a newly created agent
// **does nothing whatsoever** until somebody runs a harness for it.
//
// From the room, that state is indistinguishable from a broken product. You
// added a teammate, you addressed it, and nothing happened. Every instinct
// says bug. So the room says it in place, in words, with the next action —
// because the alternative is not "a quieter UI", it is a support ticket and a
// person concluding the agents do not work.
//
// Three rules this notice keeps:
//
//   • It appears **where the silence is**, next to the agent that is silent,
//     not on a settings page somebody would have to already suspect.
//   • It names the cause and the fix in the same breath. "Offline" would be
//     true and useless; the useful half is that nothing was ever started.
//   • It is not an error. No destructive colour, no alarm — this is a setup
//     step that has not happened yet, and dressing it as a failure teaches
//     people to distrust a system that is working exactly as designed.

import Link from "next/link";
import { cn } from "@/lib/utils";

/** `a`, `a and b`, `a, b and c` — the list voice the transcript already uses. */
function nameList(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The full notice: what is happening, why, and what to do.
 *
 * Rendered for the agents in a room that have **never** been connected. An
 * agent that has run before and is quiet now gets `SilenceNote` instead — that
 * is a different sentence with a different action (start it again, or wait),
 * and merging the two would put setup instructions in front of somebody whose
 * agent is merely asleep.
 */
export function HarnessSilence({
  names,
  className,
}: {
  names: readonly string[];
  className?: string;
}) {
  if (names.length === 0) return null;
  const subject = nameList([...names]);
  const plural = names.length > 1;

  return (
    <div
      data-testid="harness-silence"
      className={cn(
        "bento rounded-xl bg-[var(--chat-hover)] p-3 text-xs leading-relaxed",
        className,
      )}
    >
      <p className="font-semibold">
        Nothing is running {subject} yet.
      </p>
      <p className="chat-quiet mt-1">
        {plural ? "Their turns run" : "Its turn runs"} on{" "}
        {plural ? "their own runtimes" : "its own runtime"}, not on ours — which
        is what lets {plural ? "them" : "it"} use the tools on your machine. So{" "}
        {plural ? "they will" : "it will"} sit here and stay silent until a
        runtime is pointed at this workspace. That is expected, not a fault.
      </p>
      <p className="chat-quiet mt-2">
        Give an MCP-capable runtime{" "}
        <code className="rounded bg-[var(--chat-active)] px-1 py-0.5">/api/mcp</code>{" "}
        and{" "}
        {plural ? "each agent's" : "the agent's"} API key as{" "}
        <code className="rounded bg-[var(--chat-active)] px-1 py-0.5">
          Authorization: Bearer
        </code>
        .
      </p>
      <Link
        href="/dashboard/agents"
        className="mt-2 inline-block font-medium underline underline-offset-2"
      >
        Manage keys in Agents
      </Link>
    </div>
  );
}

// There is deliberately no second component here for an agent that has
// connected before and is quiet now. That is `Idle`, drawn as one line on the
// member row itself — somebody whose agent has answered them once already knows
// what a runtime is, and re-teaching it every time the process is asleep is the
// tone that makes people stop reading anything a product says.
