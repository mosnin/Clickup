import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildManifest,
  manifestEtag,
  toolSurfaceHash,
} from "../src/lib/agent-manifest";
import {
  CORE_MCP_TOOL_NAMES,
  MCP_TOOL_NAMES,
} from "../src/lib/mcp-tool-names";
import { INSTALLABLE_SKILLS, skillDigests } from "../src/lib/agent-skills";

const ISSUER = "https://operate.to";

// The load-bearing test in this file.
//
// CORE_MCP_TOOL_NAMES is a transcription of the tool definitions in
// src/app/api/[transport]/route.ts, and it exists only because a Next route
// file may not export anything but HTTP handlers. A transcription that
// nobody checks is exactly the failure /start was written to avoid: the
// propose_screen tool describes its panels in a hardcoded string that
// drifted from PROJECT_WIDGETS and now understates them by two.
//
// So the route file is the source of truth and this parses it. Add a tool
// without adding it here and CI says so, by name.
describe("the tool registry cannot drift from the route", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src/app/api/[transport]/route.ts"),
    "utf8",
  );

  const declared = (() => {
    const start = source.indexOf("const TOOLS: ToolDef[] = [");
    expect(start).toBeGreaterThan(-1);
    return [
      ...source.slice(start).matchAll(/^\s{2}\{\s*\n\s{4}name: "([a-z0-9_]+)",/gm),
    ].map((match) => match[1]);
  })();

  it("finds a plausible number of tools in the route", () => {
    // Guards the regex itself: if a refactor changes the formatting of the
    // definitions, this test must fail loudly rather than silently matching
    // nothing and declaring the registry correct.
    expect(declared.length).toBeGreaterThan(100);
  });

  it("lists exactly the tools the route defines", () => {
    expect(new Set(CORE_MCP_TOOL_NAMES)).toEqual(new Set(declared));
  });

  it("has no duplicates", () => {
    expect(new Set(MCP_TOOL_NAMES).size).toBe(MCP_TOOL_NAMES.length);
  });

  it("omits the deprecated aliases", () => {
    // They are old names for tools already listed. An agent discovering
    // them from the manifest would be learning a vocabulary we are retiring.
    const aliases = [
      ...source.matchAll(/^\s{2}([a-z_]+): "([a-z_]+)",$/gm),
    ].map((match) => match[1]);
    const legacy = aliases.filter((name) => name.endsWith("_folder") || name.endsWith("_folders"));
    expect(legacy.length).toBeGreaterThan(0);
    for (const name of legacy) expect(MCP_TOOL_NAMES).not.toContain(name);
  });

  it("includes the Chat tools, which are read live rather than transcribed", () => {
    expect(MCP_TOOL_NAMES).toContain("chat_post_message");
    expect(MCP_TOOL_NAMES.length).toBeGreaterThan(CORE_MCP_TOOL_NAMES.length);
  });
});

describe("the surface hash", () => {
  it("changes when a tool is added or removed, and not when order changes", () => {
    const base = toolSurfaceHash(["b", "a", "c"]);
    // Sorted before hashing: the claim is "these tools exist", not "they
    // are declared in this order", so a reshuffle must not read as a change.
    expect(toolSurfaceHash(["a", "b", "c"])).toBe(base);
    expect(toolSurfaceHash(["a", "b", "c", "d"])).not.toBe(base);
    expect(toolSurfaceHash(["a", "b"])).not.toBe(base);
    // The case a count alone cannot catch, and the reason names are
    // published alongside the hash: one added, one removed.
    expect(toolSurfaceHash(["a", "b", "d"])).not.toBe(base);
  });

  it("is stable across calls", () => {
    expect(toolSurfaceHash()).toBe(toolSurfaceHash());
  });
});

describe("skills", () => {
  it("digests every published skill and the files exist", async () => {
    const digests = await skillDigests();
    expect(digests).toHaveLength(INSTALLABLE_SKILLS.length);
    for (const skill of digests) {
      expect(skill.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(skill.summary.length).toBeGreaterThan(20);
    }
  });

  it("digests differ between skills", async () => {
    const digests = await skillDigests();
    expect(new Set(digests.map((s) => s.sha256)).size).toBe(digests.length);
  });
});

describe("the manifest", () => {
  it("carries everything /start tells an agent to check", async () => {
    const manifest = await buildManifest(ISSUER);
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.mcpUrl).toBe(`${ISSUER}/api/mcp`);
    expect(manifest.tools.count).toBe(MCP_TOOL_NAMES.length);
    expect(manifest.tools.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.tools.names).toEqual([...MCP_TOOL_NAMES].sort());
    expect(manifest.skills.items).toHaveLength(INSTALLABLE_SKILLS.length);
    expect(manifest.skills.install).toBe(`${ISSUER}/install/skills`);
    for (const skill of manifest.skills.items) {
      expect(skill.url).toBe(`${ISSUER}/skills/operate/${skill.slug}`);
    }
  });

  it("names brief among its tools", async () => {
    // /start tells every arriving agent that its first call is `brief`. If
    // the tool ever goes away, the document is lying to everyone who reads
    // it, and the manifest is where that is detectable.
    const manifest = await buildManifest(ISSUER);
    expect(manifest.tools.names).toContain("brief");
  });

  it("produces a stable etag that moves with the content", async () => {
    const manifest = await buildManifest(ISSUER);
    const etag = manifestEtag(manifest);
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(manifestEtag(await buildManifest(ISSUER))).toBe(etag);
    // A different deployment is a different manifest — otherwise an agent
    // that talked to staging would think production had nothing new.
    expect(manifestEtag(await buildManifest("https://other.example"))).not.toBe(
      etag,
    );
  });
});
