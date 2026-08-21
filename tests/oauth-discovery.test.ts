import { beforeEach, describe, expect, it } from "vitest";
import { GET as getOAuthMetadata } from "../src/app/.well-known/oauth-authorization-server/route";
import { GET as getOpenIdMetadata } from "../src/app/.well-known/openid-configuration/route";
import { GET as getProtectedResource } from "../src/app/.well-known/oauth-protected-resource/route";
import {
  CANONICAL_PRODUCTION_MCP_RESOURCE,
  canonicalMcpResource,
  sameMcpResource,
  validateMcpResource,
} from "../src/lib/oauth-resource";
import {
  isOfficialMcpResource,
  normalizeOfficialMcpResource,
} from "../convex/_oauthResource";

describe("public MCP OAuth discovery", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://operate.to";
  });

  it("publishes matching OAuth and OpenID metadata with UserInfo", async () => {
    const oauth = await getOAuthMetadata().json();
    const openid = await getOpenIdMetadata().json();
    expect(openid).toEqual(oauth);
    expect(oauth).toMatchObject({
      issuer: "https://operate.to",
      authorization_endpoint: "https://operate.to/oauth/authorize",
      token_endpoint: "https://operate.to/oauth/token",
      registration_endpoint: "https://operate.to/oauth/register",
      userinfo_endpoint: "https://operate.to/oauth/userinfo",
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      resource_parameter_supported: true,
    });
    expect(oauth.scopes_supported).toEqual(
      expect.arrayContaining([
        "openid",
        "email",
        "operate:read",
        "operate:write",
      ]),
    );
  });

  it("publishes one canonical protected resource and rejects lookalikes", async () => {
    const metadata = await getProtectedResource().json();
    expect(metadata).toMatchObject({
      resource: "https://operate.to/api/mcp",
      bearer_methods_supported: ["header"],
    });
    expect(metadata.authorization_servers[0]).toBe("https://operate.to");
    expect(metadata.authorization_servers).toContain("https://www.operate.to");
    expect(canonicalMcpResource("https://operate.to")).toBe(
      "https://operate.to/api/mcp",
    );
    expect(() =>
      validateMcpResource(
        "https://attacker.example/api/mcp",
        "https://operate.to",
      ),
    ).toThrow(/official/i);
    expect(() =>
      validateMcpResource(
        "https://operate.to/api/mcp?profile=chatgpt",
        "https://operate.to",
      ),
    ).toThrow(/official/i);
  });

  it("treats the apex and www hosts as one official audience", async () => {
    expect(
      validateMcpResource(
        "https://www.operate.to/api/mcp",
        "https://operate.to",
      ),
    ).toBe(CANONICAL_PRODUCTION_MCP_RESOURCE);
    expect(
      normalizeOfficialMcpResource("https://www.operate.to/api/mcp"),
    ).toBe(CANONICAL_PRODUCTION_MCP_RESOURCE);
    expect(
      sameMcpResource(
        "https://operate.to/api/mcp",
        "https://www.operate.to/api/mcp",
      ),
    ).toBe(true);
    expect(isOfficialMcpResource("https://clickup-phi.vercel.app/api/mcp")).toBe(
      false,
    );
    expect(isOfficialMcpResource("http://localhost:3000/api/mcp")).toBe(true);
  });

  it("publishes the request origin as issuer so token POSTs do not follow a 308", async () => {
    const request = new Request(
      "https://www.operate.to/.well-known/oauth-authorization-server",
    );
    const oauth = await getOAuthMetadata(request).json();
    const resource = await getProtectedResource(request).json();
    expect(oauth.issuer).toBe("https://www.operate.to");
    expect(oauth.token_endpoint).toBe("https://www.operate.to/oauth/token");
    expect(resource.authorization_servers[0]).toBe("https://www.operate.to");
    expect(resource.resource).toBe(CANONICAL_PRODUCTION_MCP_RESOURCE);
  });
});
