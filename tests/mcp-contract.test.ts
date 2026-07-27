import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Contract tests between the MCP tool catalog and the functions it claims to
// call.
//
// This exists because of a specific, expensive failure: the connector
// advertised `create_execution_plan` while the server answered "tool not
// found", because a bad merge deleted the implementation and left the tool
// entry behind. Agents discovered a capability that did not exist and built
// plans around it. Nothing caught it — the route still compiled, because a
// missing property on the generated `api` object is `undefined` at runtime,
// not a type error at the call site.
//
// Both sides are read as source. The route can't be imported (it pulls in
// the whole Next/MCP stack), and — more importantly — the generated `api`
// object is a Proxy that answers to ANY property name, so checking
// `api.agentApi[name] !== undefined` at runtime silently passes for
// functions that were deleted. The exports have to be read from the module
// that defines them.

const ROUTE = join(process.cwd(), "src/app/api/[transport]/route.ts");
const source = readFileSync(ROUTE, "utf8");
const agentApiSource = readFileSync(
  join(process.cwd(), "convex/agentApi.ts"),
  "utf8",
);

/** Every function agentApi.ts actually exports as a Convex endpoint. */
function exportedAgentApiFunctions(): Set<string> {
  return new Set(
    [
      ...agentApiSource.matchAll(
        /^export const ([A-Za-z0-9_]+) = (?:query|mutation|action|internalQuery|internalMutation|internalAction)\(/gm,
      ),
    ].map((m) => m[1]),
  );
}

/** Every `api.agentApi.<name>` referenced anywhere in the route. */
function referencedAgentApiFunctions(): string[] {
  return [
    ...new Set(
      [...source.matchAll(/api\.agentApi\.([A-Za-z0-9_]+)/g)].map((m) => m[1]),
    ),
  ];
}

/** Every advertised tool name, in definition order. */
function declaredToolNames(): string[] {
  return [...source.matchAll(/^\s{4}name: "([a-z0-9_]+)",$/gm)].map(
    (m) => m[1],
  );
}

describe("MCP tool catalog", () => {
  it("only calls agentApi functions that actually exist", () => {
    const exported = exportedAgentApiFunctions();
    // Guard the guard: if the export scan breaks, this test would pass
    // vacuously for every tool.
    expect(exported.size).toBeGreaterThan(80);
    const missing = referencedAgentApiFunctions().filter(
      (name) => !exported.has(name),
    );
    expect(
      missing,
      `The route calls api.agentApi.<name> for functions that do not exist. ` +
        `This is exactly the create_execution_plan drift: the tool stays in ` +
        `the catalog and fails at call time. Missing: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("advertises every tool exactly once", () => {
    const names = declaredToolNames();
    const seen = new Set<string>();
    const duplicates = names.filter((n) => {
      if (seen.has(n)) return true;
      seen.add(n);
      return false;
    });
    expect(duplicates, `Duplicate tool names: ${duplicates.join(", ")}`).toEqual(
      [],
    );
    // A sanity floor: if this collapses, something deleted the catalog.
    expect(names.length).toBeGreaterThan(80);
  });

  it("classifies every tool it advertises", () => {
    // READ_TOOLS / IDEMPOTENT_TOOLS drive the request guard. A tool missing
    // from both isn't wrong — it's simply a non-idempotent write — but a
    // name in either set that no longer exists IS wrong, because it means a
    // rename left the classification pointing at nothing.
    const declared = new Set(declaredToolNames());
    const classified = new Set<string>();
    for (const block of ["READ_TOOLS", "IDEMPOTENT_TOOLS", "OPEN_WORLD_TOOLS"]) {
      const start = source.indexOf(`const ${block} = new Set([`);
      if (start === -1) continue;
      const end = source.indexOf("]);", start);
      for (const m of source
        .slice(start, end)
        .matchAll(/"([a-z0-9_]+)"/g)) {
        classified.add(m[1]);
      }
    }
    // Deprecated aliases are registered dynamically and are legitimately
    // absent from the literal catalog.
    const aliasBlock = source.slice(
      source.indexOf("const DEPRECATED_TOOL_ALIASES"),
      source.indexOf("const ALIAS_TOOLS"),
    );
    for (const m of aliasBlock.matchAll(/^\s+([a-z0-9_]+):/gm)) {
      declared.add(m[1]);
    }

    const orphaned = [...classified].filter((n) => !declared.has(n));
    expect(
      orphaned,
      `These names are classified as read-only/idempotent/open-world but no ` +
        `tool by that name is advertised — a rename left the classification ` +
        `behind: ${orphaned.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps every deprecated alias pointing at a live tool", () => {
    const declared = new Set(declaredToolNames());
    const aliasBlock = source.slice(
      source.indexOf("const DEPRECATED_TOOL_ALIASES"),
      source.indexOf("const ALIAS_TOOLS"),
    );
    const pairs = [
      ...aliasBlock.matchAll(/^\s+([a-z0-9_]+):\s*"([a-z0-9_]+)"/gm),
    ].map((m) => [m[1], m[2]] as const);
    expect(pairs.length).toBeGreaterThan(0);
    for (const [legacy, canonical] of pairs) {
      expect(
        declared.has(canonical),
        `Alias ${legacy} forwards to ${canonical}, which is no longer advertised.`,
      ).toBe(true);
    }
  });
});
