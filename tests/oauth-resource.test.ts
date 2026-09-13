import { describe, expect, it } from "vitest";
import { validateMcpResource } from "../src/lib/oauth-resource";

const issuer = "https://operate.to";
describe("MCP resource identity", () => {
  it.each(["chatgpt", "claude", "codex"])("canonicalizes the %s connection URL", (profile) => {
    expect(validateMcpResource(`https://www.operate.to/api/mcp?profile=${profile}`, issuer)).toBe(`${issuer}/api/mcp`);
  });
  it.each([
    "https://evil.example/api/mcp?profile=codex",
    "https://operate.to.evil.example/api/mcp",
    "http://operate.to/api/mcp",
    "https://operate.to:444/api/mcp",
    "https://operate.to/api/mcp/",
    "https://operate.to/api/mcp?profile=unknown",
    "https://operate.to/api/mcp?profile=codex&profile=codex",
    "https://operate.to/api/mcp?profile=codex&other=value",
    "https://operate.to/api/mcp#fragment",
    "https://user@operate.to/api/mcp",
  ])("rejects a different resource: %s", (candidate) => {
    expect(() => validateMcpResource(candidate, issuer)).toThrow();
  });
  it("does not apply production aliases to another issuer", () => {
    expect(() => validateMcpResource("https://operate.to/api/mcp", "https://preview.example")).toThrow();
  });
});
