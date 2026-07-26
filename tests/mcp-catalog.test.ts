import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { api } from "../convex/_generated/api";

// The MCP endpoint advertises a tool catalog; each tool is a thin adapter over
// a function in convex/agentApi.ts. When the two drift, an agent gets a tool
// that exists in the listing and fails when called — which reads as "the
// platform is broken" rather than "one adapter points at nothing".
//
// This is the source-level half of that guarantee. The deploy-level half is
// package.json's `vercel-build`, which runs `convex deploy` before `next build`
// so a shipped catalog can never be ahead of the shipped functions.

const ROUTE = fileURLToPath(
  new URL("../src/app/api/[transport]/route.ts", import.meta.url),
);

const source = readFileSync(ROUTE, "utf8");

function referencedConvexFunctions(): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/api\.(\w+)\.(\w+)/g)) {
    names.add(`${match[1]}.${match[2]}`);
  }
  return [...names].sort();
}

function toolNames(): string[] {
  return [...source.matchAll(/^\s{4}name: "([a-z0-9_]+)",$/gm)].map(
    (m) => m[1],
  );
}

describe("MCP tool catalog", () => {
  it("only calls Convex functions that exist", () => {
    const generated = api as unknown as Record<
      string,
      Record<string, unknown> | undefined
    >;
    const missing = referencedConvexFunctions().filter((ref) => {
      const [module, fn] = ref.split(".");
      return generated[module]?.[fn] === undefined;
    });
    expect(missing).toEqual([]);
  });

  it("advertises at least the documented surface", () => {
    // A floor, not an exact count: the number grows, and a test that pins it
    // exactly would fail on every new tool for no reason. What matters is that
    // a refactor can't silently drop most of the catalog.
    expect(toolNames().length).toBeGreaterThan(90);
  });

  it("has no duplicate tool names", () => {
    const names = toolNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it("names the tools an agent's first turn depends on", () => {
    // These four are what the server instructions tell an agent to call before
    // anything else. If any of them disappears the whole protocol stalls on the
    // first turn, so they are worth pinning by name.
    for (const required of [
      "whoami",
      "get_skill",
      "next_task",
      "claim_task",
    ]) {
      expect(toolNames()).toContain(required);
    }
  });

  it("declares the Vercel function limits the transport needs", () => {
    // The 502s that started this: mcp-handler's own `maxDuration` option only
    // governs its SSE keepalive. Without a route-level export, Vercel used the
    // account default and killed cold-start reads mid-flight.
    expect(source).toMatch(/export const maxDuration = \d+/);
    expect(source).toMatch(/export const runtime = "nodejs"/);
  });
});
