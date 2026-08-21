import { createHash } from "node:crypto";
import { MCP_TOOL_NAMES } from "@/lib/mcp-tool-names";
import { skillDigests } from "@/lib/agent-skills";
import { servingMcpUrl, servingOrigin } from "@/lib/oauth-resource";

// The one number an agent checks to know whether anything it learned has
// changed. Everything here is derived; nothing is hand-maintained.

export const AGENT_API_VERSION = 1;

// A hash over the sorted tool names, not a version number.
//
// A version number is bumped by a person and therefore forgotten, and a
// forgotten bump is worse than no version at all: every agent concludes it
// is current and stops asking. A digest of the surface changes exactly when
// the surface changes, and there is no step anybody can skip.
//
// Sorted, so reordering the definitions does not read as a change — the
// claim being made is "these tools exist", not "they are declared in this
// order".
export function toolSurfaceHash(names: string[] = MCP_TOOL_NAMES) {
  return `sha256:${createHash("sha256")
    .update([...names].sort().join("\n"))
    .digest("hex")}`;
}

export type AgentManifest = {
  apiVersion: number;
  mcpUrl: string;
  tools: { count: number; hash: string; names: string[] };
  skills: {
    install: string;
    items: { slug: string; summary: string; sha256: string; url: string }[];
  };
  docs: { start: string; connect: string };
};

export async function buildManifest(issuer: string): Promise<AgentManifest> {
  const origin = servingOrigin(issuer);
  const digests = await skillDigests();
  return {
    apiVersion: AGENT_API_VERSION,
    mcpUrl: servingMcpUrl(issuer),
    tools: {
      count: MCP_TOOL_NAMES.length,
      hash: toolSurfaceHash(),
      // The names, not just the count. An agent that sees the hash move
      // should be able to find out WHAT moved without reconnecting, and a
      // count alone cannot distinguish "one tool added" from "one added and
      // one removed" — which is the case where its stored instructions are
      // actively wrong rather than merely incomplete.
      names: [...MCP_TOOL_NAMES].sort(),
    },
    skills: {
      install: `${origin}/install/skills`,
      items: digests.map((skill) => ({
        ...skill,
        url: `${origin}/skills/operate/${skill.slug}`,
      })),
    },
    docs: {
      start: `${origin}/start`,
      connect: `${origin}/.well-known/oauth-authorization-server`,
    },
  };
}

// One ETag over the whole manifest: an agent storing a single string and
// sending If-None-Match gets a 304 in the common case, which is the only
// way "check for updates on every boot" is cheap enough to actually do.
export function manifestEtag(manifest: AgentManifest) {
  return `"${createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex")
    .slice(0, 32)}"`;
}
