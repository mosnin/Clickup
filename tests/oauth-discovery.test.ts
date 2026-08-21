import { beforeEach, describe, expect, it } from "vitest";
import { GET as getOAuthMetadata } from "../src/app/.well-known/oauth-authorization-server/route";
import { GET as getOAuthMetadataByPath } from "../src/app/.well-known/oauth-authorization-server/[...path]/route";
import { GET as getOpenIdMetadata } from "../src/app/.well-known/openid-configuration/route";
import { GET as getOpenIdMetadataByPath } from "../src/app/.well-known/openid-configuration/[...path]/route";
import { GET as getProtectedResource } from "../src/app/.well-known/oauth-protected-resource/route";
import { GET as getProtectedResourceByPath } from "../src/app/.well-known/oauth-protected-resource/[...path]/route";
import { GET as getProtectedResourceUnderMcp } from "../src/app/api/mcp/.well-known/oauth-protected-resource/route";
import { GET as getOAuthMetadataUnderMcp } from "../src/app/api/mcp/.well-known/oauth-authorization-server/route";
import { GET as getStart } from "../src/app/start/route";
import {
  CANONICAL_PRODUCTION_MCP_RESOURCE,
  canonicalMcpResource,
  sameMcpResource,
  servingMcpUrl,
  servingOrigin,
  validateMcpResource,
} from "../src/lib/oauth-resource";
import {
  isOfficialMcpResource,
  normalizeOfficialMcpResource,
  officialAuthorizationServers,
} from "../convex/_oauthResource";
import {
  mcpWwwAuthenticate,
  oauthIssuer,
  protectedResourceMetadataUrl,
} from "../src/lib/oauth-server";
import { publicOrigin } from "../src/lib/public-origin";

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
      device_authorization_endpoint: "https://www.operate.to/oauth/device",
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
    expect(metadata.authorization_servers).toEqual(["https://www.operate.to"]);
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
    expect(resource.authorization_servers).toEqual(["https://www.operate.to"]);
    expect(resource.resource).toBe(CANONICAL_PRODUCTION_MCP_RESOURCE);
  });

  it("uses the official request origin for MCP 401 challenges too", () => {
    const www = new Request("https://www.operate.to/api/mcp?profile=chatgpt");
    expect(oauthIssuer(www)).toBe("https://www.operate.to");
    expect(protectedResourceMetadataUrl("https://www.operate.to")).toBe(
      "https://www.operate.to/.well-known/oauth-protected-resource/api/mcp",
    );
    expect(mcpWwwAuthenticate(www)).toBe(
      'Bearer resource_metadata="https://www.operate.to/.well-known/oauth-protected-resource/api/mcp", scope="operate:read"',
    );
    const apexChallenge = new Request("https://operate.to/api/mcp");
    expect(mcpWwwAuthenticate(apexChallenge)).toBe(
      'Bearer resource_metadata="https://www.operate.to/.well-known/oauth-protected-resource/api/mcp", scope="operate:read"',
    );
  });

  it("serves RFC 9728 path-inserted protected-resource metadata on www", async () => {
    const request = new Request(
      "https://www.operate.to/.well-known/oauth-protected-resource/api/mcp",
    );
    const root = await getProtectedResource(request).json();
    const byPath = await getProtectedResourceByPath(request).json();
    const underMcp = await getProtectedResourceUnderMcp(request).json();
    expect(byPath).toEqual(root);
    expect(underMcp).toEqual(root);
    expect(byPath.authorization_servers).toEqual(["https://www.operate.to"]);
    expect(byPath.resource).toBe(CANONICAL_PRODUCTION_MCP_RESOURCE);
  });

  it("serves AS and OpenID metadata at the resource path so those GETs are not 404", async () => {
    const request = new Request(
      "https://www.operate.to/.well-known/oauth-authorization-server/api/mcp",
    );
    const asRoot = await getOAuthMetadata(request).json();
    const asPath = await getOAuthMetadataByPath(request).json();
    const asUnderMcp = await getOAuthMetadataUnderMcp(request).json();
    const oidcRoot = await getOpenIdMetadata(request).json();
    const oidcPath = await getOpenIdMetadataByPath(request).json();
    expect(asPath).toEqual(asRoot);
    expect(asUnderMcp).toEqual(asRoot);
    expect(oidcPath).toEqual(oidcRoot);
    expect(asPath.token_endpoint).toBe("https://www.operate.to/oauth/token");
    expect(asPath.issuer).toBe("https://www.operate.to");
  });

  it("never tells a client to POST MCP to the apex host", () => {
    expect(servingMcpUrl("https://operate.to")).toBe(
      "https://www.operate.to/api/mcp",
    );
    expect(servingMcpUrl("https://www.operate.to")).toBe(
      "https://www.operate.to/api/mcp",
    );
    expect(servingMcpUrl("http://localhost:3000")).toBe(
      "http://localhost:3000/api/mcp",
    );
  });

  it("rewrites the apex origin to www for every client POST, including scripts", () => {
    expect(servingOrigin("https://operate.to")).toBe("https://www.operate.to");
    expect(servingOrigin("https://www.operate.to")).toBe(
      "https://www.operate.to",
    );
    expect(servingOrigin("http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
    expect(servingOrigin("https://operate.to/oauth/token")).toBe(
      "https://www.operate.to",
    );
    expect(officialAuthorizationServers("https://operate.to")).toEqual([
      "https://www.operate.to",
    ]);
    expect(officialAuthorizationServers("https://www.operate.to")).toEqual([
      "https://www.operate.to",
    ]);
    expect(officialAuthorizationServers("http://localhost:3000")).toEqual([
      "http://localhost:3000",
    ]);

    const previous = process.env.OPERATE_PUBLIC_URL;
    process.env.OPERATE_PUBLIC_URL = "https://operate.to";
    expect(publicOrigin()).toBe("https://www.operate.to");
    if (previous === undefined) delete process.env.OPERATE_PUBLIC_URL;
    else process.env.OPERATE_PUBLIC_URL = previous;

    const apex = new Request("https://operate.to/.well-known/oauth-authorization-server");
    expect(oauthIssuer(apex)).toBe("https://www.operate.to");
    expect(oauthIssuer()).toBe("https://www.operate.to");
  });

  it("tells /start readers to POST device and token grants to www", async () => {
    const doc = await (
      await getStart(new Request("https://operate.to/start"))
    ).text();
    expect(doc).toContain("POST https://www.operate.to/oauth/device");
    expect(doc).toContain("POST https://www.operate.to/oauth/token");
    expect(doc).toContain("https://www.operate.to/api/mcp");
    expect(doc).not.toMatch(/POST https:\/\/operate\.to\//);
  });
});
