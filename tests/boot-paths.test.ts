import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// The three places an agent learns how to work here.
//
// The MCP server's system instruction, the /start document, and the
// collaboration-protocol skill. They are three files that must say the same
// thing, and nothing had ever checked that they did.
//
// The failure this test exists to stop is not "a doc is out of date". It is
// worse and quieter: five iterations added `get_task_context`, `claimPolicy`,
// deferred completion and the task graph, and all three boot paths went on
// telling agents to do it the old way — so every one of those tools was
// unreachable in practice, while the tool list and the tests said they worked.
// A capability nothing routes to has not shipped.
//
// Deliberately assertions about WORDS rather than behaviour, for the same
// reason the manifest drift test parses the route file: this is the one class
// of breakage that is invisible in review and cannot be caught by running
// anything.

const read = (p: string) =>
  readFileSync(path.join(process.cwd(), p), "utf8");

/**
 * The instruction string itself, not the file it lives in.
 *
 * The route file is four thousand lines of tool definitions, and every term
 * this test looks for appears somewhere in one of them — so asserting against
 * the whole file would pass no matter what the boot instruction said, which is
 * a test that exists and checks nothing.
 */
function mcpInstruction(): string {
  const src = read("src/app/api/[transport]/route.ts");
  const doubleStart = src.indexOf('"You are an agent teammate in operate.to.');
  const singleStart = src.indexOf("'You are an agent teammate in operate.to.");
  const start = doubleStart >= 0 ? doubleStart : singleStart;
  expect(start).toBeGreaterThan(-1);
  const delimiter = src[start];
  const end = src.indexOf(`${delimiter},\n`, start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** The collaboration protocol, not the whole skills library. */
function protocolSkill(): string {
  const src = read("convex/skills.ts");
  const start = src.indexOf("**Read the room first**");
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, start + 12_000);
}

const BOOT_PATHS: { name: string; text: string }[] = [
  { name: "MCP system instruction", text: mcpInstruction() },
  { name: "/start document", text: read("src/app/start/route.ts") },
  { name: "collaboration-protocol skill", text: protocolSkill() },
];

describe("every boot path routes to the current surface", () => {
  it("names the one-call context tool", () => {
    // The four-round-trip dance it replaced is still described in each file as
    // the fallback, which is correct — the failure was describing it as the
    // ROUTE. Naming the replacement is what makes the tool reachable.
    for (const p of BOOT_PATHS) {
      expect(p.text, p.name).toContain("get_task_context");
    }
  });

  it("warns that a claim can be required rather than advisory", () => {
    // An agent that learns this from a refusal has already lost a round trip
    // and possibly the task to whoever claimed it in the meantime.
    for (const p of BOOT_PATHS) {
      expect(p.text, p.name).toContain("claimPolicy");
    }
  });

  it("explains that completing a gated task does not fail", () => {
    // The most dangerous omission of the three. An agent told the old protocol
    // waits for a `task.approved` event that no longer arrives on that path,
    // and sits there indefinitely believing its work is unfinished.
    for (const p of BOOT_PATHS) {
      expect(p.text, p.name).toMatch(/pending: ?true|pending:true|\{applied:false, ?pending:true\}/);
    }
  });
});

describe("the superseded protocol is not still the instruction", () => {
  it("does not send agents to request_approval to hand finished work over", () => {
    // `request_approval` still exists and is still right for raising a gate.
    // What is wrong is telling an agent to finish, request, and WAIT — that is
    // the three-leg round trip deferred approval removed, and its third leg
    // needs the agent alive and watching days later.
    const skill = read("convex/skills.ts");
    expect(skill).not.toMatch(
      /task\.approved\\` event tells you when to \\`complete_task/,
    );
  });
});
