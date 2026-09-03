import { beforeEach, describe, expect, it } from "vitest";
import { GET as getOAuthMetadata } from "../src/app/.well-known/oauth-authorization-server/route";
import { GET as getOpenIdMetadata } from "../src/app/.well-known/openid-configuration/route";
import { GET as getProtectedResource } from "../src/app/.well-known/oauth-protected-resource/route";
import {
  canonicalMcpResource,
  validateMcpResource,
} from "../src/lib/oauth-resource";

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

  it("declares the endpoints it actually has, including the ones a client cannot guess", async () => {
    const oauth = await getOAuthMetadata().json();
    // A revocation endpoint whose auth method is undeclared leaves a client
    // guessing whether to send credentials it does not have.
    expect(oauth.revocation_endpoint).toBe("https://operate.to/oauth/revoke");
    expect(oauth.revocation_endpoint_auth_methods_supported).toEqual(["none"]);
    // RFC 9207. The authorize page echoes `iss`, so the document has to say
    // so or no client will check it.
    expect(oauth.authorization_response_iss_parameter_supported).toBe(true);
    // The tenant claims /oauth/userinfo returns for a workspace-bound token.
    expect(oauth.claims_supported).toEqual(
      expect.arrayContaining(["sub", "email", "org_id", "org_name"]),
    );
    // Still exactly one PKCE method, and it is not plain.
    expect(oauth.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("publishes one canonical protected resource and rejects lookalikes", async () => {
    const metadata = await getProtectedResource().json();
    expect(metadata).toMatchObject({
      resource: "https://operate.to/api/mcp",
      authorization_servers: ["https://operate.to"],
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
  });
});
