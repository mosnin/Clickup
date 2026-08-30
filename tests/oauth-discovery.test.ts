import { beforeEach, describe, expect, it } from "vitest";
import { GET as getOAuthMetadata } from "../src/app/.well-known/oauth-authorization-server/route";
import { GET as getOpenIdMetadata } from "../src/app/.well-known/openid-configuration/route";
import { GET as getProtectedResource } from "../src/app/.well-known/oauth-protected-resource/route";
import {
  canonicalCompanyOsResource,
  canonicalMcpResource,
  validateMcpResource,
  validateOAuthResource,
} from "../src/lib/oauth-resource";
import { normalizeOAuthIssuer } from "../src/lib/oauth-server";

describe("public MCP OAuth discovery", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://operate.to";
  });

  it("publishes matching OAuth and OpenID metadata with UserInfo", async () => {
    const oauth = await getOAuthMetadata().json();
    const openid = await getOpenIdMetadata().json();
    expect(openid).toEqual(oauth);
    expect(oauth).toMatchObject({
      issuer: "https://www.operate.to",
      authorization_endpoint: "https://www.operate.to/oauth/authorize",
      token_endpoint: "https://www.operate.to/oauth/token",
      registration_endpoint: "https://www.operate.to/oauth/register",
      userinfo_endpoint: "https://www.operate.to/oauth/userinfo",
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
        "companyos:account:read",
        "companyos:data:read",
      ]),
    );
  });

  it("publishes one canonical protected resource and rejects lookalikes", async () => {
    const metadata = await getProtectedResource().json();
    expect(metadata).toMatchObject({
      resource: "https://www.operate.to/api/mcp",
      authorization_servers: ["https://www.operate.to"],
      bearer_methods_supported: ["header"],
    });
    expect(canonicalMcpResource("https://operate.to")).toBe(
      "https://operate.to/api/mcp",
    );
    expect(() =>
      validateMcpResource(
        "https://attacker.example/api/mcp",
        "https://operate.to",
      ),
    ).toThrow(/canonical/i);
    expect(() =>
      validateMcpResource(
        "https://operate.to/api/mcp?profile=chatgpt",
        "https://operate.to",
      ),
    ).toThrow(/canonical/i);
    expect(canonicalCompanyOsResource("https://www.operate.to")).toBe(
      "https://www.operate.to/api/companyos",
    );
    expect(
      validateOAuthResource(
        "https://www.operate.to/api/companyos",
        "https://www.operate.to",
      ),
    ).toBe("https://www.operate.to/api/companyos");
    expect(
      validateOAuthResource(
        "https://operate.to/api/mcp",
        "https://www.operate.to",
      ),
    ).toBe("https://www.operate.to/api/mcp");
  });

  it("canonicalizes production but preserves HTTPS preview origins", () => {
    expect(normalizeOAuthIssuer("https://operate.to/")).toBe(
      "https://www.operate.to",
    );
    expect(normalizeOAuthIssuer("https://www.operate.to")).toBe(
      "https://www.operate.to",
    );
    expect(
      normalizeOAuthIssuer("https://clickup-git-companyos.vercel.app"),
    ).toBe("https://clickup-git-companyos.vercel.app");
    expect(() => normalizeOAuthIssuer("http://attacker.example")).toThrow(
      /https/i,
    );
  });
});
