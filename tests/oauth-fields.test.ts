import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  oauthBasicClientId,
  oauthBearer,
  oauthCorsHeaders,
  oauthFields,
  oauthJson,
  oauthJsonObject,
} from "../src/lib/oauth-server";
import {
  applyMcpCors,
  isAuthorizePath,
  isHumanOAuthPath,
  isMachineOAuthPath,
  isMcpBrowserOrigin,
  isOAuthOptionsPath,
  readAuthorizeParams,
  stripOAuthTrailingSlash,
} from "../src/lib/oauth-slash";

const read = (file: string) =>
  readFileSync(path.join(process.cwd(), file), "utf8");

describe("oauthFields", () => {
  it("reads a JSON revoke/token body so logout is not form-only", async () => {
    const field = await oauthFields(
      new Request("https://www.operate.to/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "opr_spent_refresh" }),
      }),
    );
    expect(field("token")).toBe("opr_spent_refresh");
  });

  it("reads an RFC form body", async () => {
    const field = await oauthFields(
      new Request("https://www.operate.to/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "token=opr_form_refresh",
      }),
    );
    expect(field("token")).toBe("opr_form_refresh");
  });

  it("does not throw on a JSON content-type with a broken body", async () => {
    const field = await oauthFields(
      new Request("https://www.operate.to/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
    );
    expect(field("token")).toBe("");
  });

  it("reads JSON with no Content-Type, the body curl -d actually sends", async () => {
    const field = await oauthFields(
      new Request("https://www.operate.to/oauth/revoke", {
        method: "POST",
        body: JSON.stringify({ token: "opr_bare_json" }),
      }),
    );
    expect(field("token")).toBe("opr_bare_json");
  });

  it("reads JSON labelled as form-urlencoded, curl -d's default", async () => {
    const field = await oauthFields(
      new Request("https://www.operate.to/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: "opr_mislabelled",
          client_id: "opc_test",
        }),
      }),
    );
    expect(field("grant_type")).toBe("refresh_token");
    expect(field("refresh_token")).toBe("opr_mislabelled");
    expect(field("client_id")).toBe("opc_test");
  });

  it("reads the device-grant client alias", async () => {
    const field = await oauthFields(
      new Request("https://www.operate.to/oauth/device", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: "claude-code" }),
      }),
    );
    expect(field("client_name")).toBe("");
    expect(field("client")).toBe("claude-code");
  });

  it("reads a form body that was labelled application/json", async () => {
    const field = await oauthFields(
      new Request("https://www.operate.to/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "token=opr_form_under_json_type",
      }),
    );
    expect(field("token")).toBe("opr_form_under_json_type");
  });

  it("reads JSON that starts with a UTF-8 BOM", async () => {
    const field = await oauthFields(
      new Request("https://www.operate.to/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: `\uFEFF${JSON.stringify({ token: "opr_bom" })}`,
      }),
    );
    expect(field("token")).toBe("opr_bom");
  });

  it("reads a query-string token when the body is empty", async () => {
    const field = await oauthFields(
      new Request("https://www.operate.to/oauth/revoke?token=opr_query", {
        method: "POST",
      }),
    );
    expect(field("token")).toBe("opr_query");
  });

  it("lets the body win over a conflicting query string", async () => {
    const field = await oauthFields(
      new Request("https://www.operate.to/oauth/revoke?token=opr_query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "opr_body" }),
      }),
    );
    expect(field("token")).toBe("opr_body");
  });

  it("unwraps a one-object JSON array so revoke is not empty", async () => {
    const field = await oauthFields(
      new Request("https://www.operate.to/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([{ token: "opr_array" }]),
      }),
    );
    expect(field("token")).toBe("opr_array");
  });

  it("reads camelCase JSON and a double-encoded JSON string", async () => {
    const camel = await oauthFields(
      new Request("https://www.operate.to/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grantType: "refresh_token",
          refreshToken: "opr_camel",
          clientId: "opc_js",
        }),
      }),
    );
    expect(camel("grant_type")).toBe("refresh_token");
    expect(camel("refresh_token")).toBe("opr_camel");
    expect(camel("client_id")).toBe("opc_js");
    const doubled = await oauthFields(
      new Request("https://www.operate.to/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(JSON.stringify({ token: "opr_double" })),
      }),
    );
    expect(doubled("token")).toBe("opr_double");
    const aliased = await oauthFields(
      new Request("https://www.operate.to/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: "opr_access" }),
      }),
    );
    expect(aliased("token")).toBe("opr_access");
  });

  it("reads PHP-style token[] and a one-element JSON array value", async () => {
    const form = await oauthFields(
      new Request("https://www.operate.to/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "token[]=opr_php",
      }),
    );
    expect(form("token")).toBe("opr_php");
    const json = await oauthFields(
      new Request("https://www.operate.to/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "text/json" },
        body: JSON.stringify({ token: ["opr_json_array"] }),
      }),
    );
    expect(json("token")).toBe("opr_json_array");
  });

  it("reads a multipart revoke body", async () => {
    const form = new FormData();
    form.set("token", "opr_multipart");
    const field = await oauthFields(
      new Request("https://www.operate.to/oauth/revoke", {
        method: "POST",
        body: form,
      }),
    );
    expect(field("token")).toBe("opr_multipart");
  });
});

describe("oauthBearer", () => {
  it("reads a Bearer access or refresh token from Authorization", () => {
    const request = new Request("https://www.operate.to/oauth/revoke", {
      method: "POST",
      headers: { Authorization: "Bearer opr_header_only" },
    });
    expect(oauthBearer(request)).toBe("opr_header_only");
    expect(oauthBearer(new Request("https://www.operate.to/oauth/revoke"))).toBe(
      "",
    );
  });
});

describe("oauthJsonObject", () => {
  it("accepts a BOM-prefixed DCR body that request.json would reject", async () => {
    const body = await oauthJsonObject(
      new Request("https://www.operate.to/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: `\uFEFF${JSON.stringify({
          client_name: "Claude",
          redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        })}`,
      }),
    );
    expect(body).toMatchObject({ client_name: "Claude" });
  });

  it("accepts camelCase DCR clientName and redirectUris", async () => {
    const body = await oauthJsonObject(
      new Request("https://www.operate.to/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName: "Cursor",
          redirectUris: ["https://cursor.com/oauth/callback"],
        }),
      }),
    );
    expect(body).toMatchObject({
      client_name: "Cursor",
      redirect_uris: ["https://cursor.com/oauth/callback"],
    });
  });

  it("treats redirect_uris[] and redirect_uri as redirect_uris", async () => {
    const body = await oauthJsonObject(
      new Request("https://www.operate.to/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "client_name=ChatGPT&redirect_uris[]=https://chatgpt.com/connector_platform_oauth_redirect",
      }),
    );
    expect(body).toMatchObject({
      client_name: "ChatGPT",
      redirect_uris: [
        "https://chatgpt.com/connector_platform_oauth_redirect",
      ],
    });
    const singular = await oauthJsonObject(
      new Request("https://www.operate.to/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Claude",
          redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        }),
      }),
    );
    expect(singular).toMatchObject({
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    });
  });

  it("unwraps a one-object JSON array for DCR", async () => {
    const body = await oauthJsonObject(
      new Request("https://www.operate.to/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          {
            client_name: "Claude",
            redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
          },
        ]),
      }),
    );
    expect(body).toMatchObject({ client_name: "Claude" });
  });

  it("accepts form-urlencoded DCR so a non-JSON register is not empty", async () => {
    const body = await oauthJsonObject(
      new Request("https://www.operate.to/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_name: "ChatGPT",
          redirect_uris: "https://chatgpt.com/connector_platform_oauth_redirect",
        }).toString(),
      }),
    );
    expect(body).toMatchObject({
      client_name: "ChatGPT",
      redirect_uris: [
        "https://chatgpt.com/connector_platform_oauth_redirect",
      ],
    });
  });

  it("coerces a JSON string redirect_uris into an array", async () => {
    const body = await oauthJsonObject(
      new Request("https://www.operate.to/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "ChatGPT",
          redirect_uris:
            "https://chatgpt.com/connector_platform_oauth_redirect",
        }),
      }),
    );
    expect(body).toMatchObject({
      client_name: "ChatGPT",
      redirect_uris: [
        "https://chatgpt.com/connector_platform_oauth_redirect",
      ],
    });
  });

  it("reads a multipart DCR body", async () => {
    const form = new FormData();
    form.set("client_name", "ChatGPT");
    form.set(
      "redirect_uris",
      "https://chatgpt.com/connector_platform_oauth_redirect",
    );
    const body = await oauthJsonObject(
      new Request("https://www.operate.to/oauth/register", {
        method: "POST",
        body: form,
      }),
    );
    expect(body).toMatchObject({
      client_name: "ChatGPT",
      redirect_uris: [
        "https://chatgpt.com/connector_platform_oauth_redirect",
      ],
    });
  });

  it("parses a JSON array stuffed into a form redirect_uris field", async () => {
    const body = await oauthJsonObject(
      new Request("https://www.operate.to/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "client_name=Claude&redirect_uris=%5B%22https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback%22%5D",
      }),
    );
    expect(body).toMatchObject({
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    });
  });
});

describe("oauth CORS", () => {
  it("advertises CORS on OAuth JSON so a browser client can read discovery", () => {
    const response = oauthJson({ issuer: "https://www.operate.to" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
      "POST",
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
      "DELETE",
    );
    expect(response.headers.get("Access-Control-Allow-Headers")).toMatch(
      /Accept|If-None-Match|X-PAYMENT|Mcp-Protocol-Version/,
    );
    expect(response.headers.get("Access-Control-Expose-Headers")).toMatch(
      /WWW-Authenticate/,
    );
    const headers = oauthCorsHeaders();
    expect(headers["Access-Control-Expose-Headers"]).toContain(
      "WWW-Authenticate",
    );
  });
});

describe("MCP browser CORS", () => {
  it("allows ChatGPT/Claude/Cursor/localhost and opens 401 + OPTIONS", () => {
    expect(isMcpBrowserOrigin("https://www.chatgpt.com")).toBe(true);
    expect(isMcpBrowserOrigin("https://chat.openai.com")).toBe(true);
    expect(isMcpBrowserOrigin("https://chatgpt.com")).toBe(true);
    expect(isMcpBrowserOrigin("http://localhost:6274")).toBe(true);
    expect(isMcpBrowserOrigin("http://127.0.0.1:3000")).toBe(true);
    expect(isMcpBrowserOrigin("https://workspace.claude.ai")).toBe(true);
    expect(isMcpBrowserOrigin("https://www.cursor.com")).toBe(true);
    expect(isMcpBrowserOrigin("https://platform.openai.com")).toBe(true);
    expect(isMcpBrowserOrigin("https://cursor.sh")).toBe(true);
    expect(isMcpBrowserOrigin("https://evil.example")).toBe(false);
    expect(isMcpBrowserOrigin("https://api.openai.com")).toBe(false);
    expect(isOAuthOptionsPath("/oauth/authorize")).toBe(true);
    expect(isOAuthOptionsPath("/oauth/token")).toBe(true);
    expect(isOAuthOptionsPath("/dashboard")).toBe(false);

    const challenge = applyMcpCors(
      new Request("https://www.operate.to/api/mcp", {
        headers: { Origin: "https://www.chatgpt.com" },
      }),
      new Response("unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://www.operate.to/.well-known/oauth-protected-resource/api/mcp"' },
      }),
    );
    expect(challenge.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://www.chatgpt.com",
    );
    expect(challenge.headers.get("Access-Control-Expose-Headers")).toMatch(
      /WWW-Authenticate/,
    );

    const unknown401 = applyMcpCors(
      new Request("https://www.operate.to/api/mcp", {
        headers: { Origin: "https://unknown-inspector.example" },
      }),
      new Response(null, { status: 401 }),
    );
    expect(unknown401.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://unknown-inspector.example",
    );
    expect(unknown401.headers.get("Access-Control-Expose-Headers")).toMatch(
      /WWW-Authenticate/,
    );
    expect(unknown401.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true",
    );

    const forbidden = applyMcpCors(
      new Request("https://www.operate.to/api/mcp", {
        method: "OPTIONS",
        headers: {
          Origin: "https://www.chatgpt.com",
          "Access-Control-Request-Headers": "X-Client-Extra, Authorization",
        },
      }),
      new Response(null, {
        status: 403,
        headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope"' },
      }),
    );
    expect(forbidden.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://www.chatgpt.com",
    );
    expect(forbidden.headers.get("Access-Control-Expose-Headers")).toMatch(
      /WWW-Authenticate/,
    );
    expect(forbidden.headers.get("Access-Control-Allow-Headers")).toMatch(
      /X-Client-Extra/i,
    );

    const blocked200 = applyMcpCors(
      new Request("https://www.operate.to/api/mcp", {
        headers: { Origin: "https://evil.example" },
      }),
      new Response("ok", { status: 200 }),
    );
    expect(blocked200.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("readAuthorizeParams", () => {
  it("lifts a POST authorize body onto query params for a 303", async () => {
    const params = await readAuthorizeParams(
      new Request("https://www.operate.to/oauth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: "opc_test",
          redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
          code_challenge: "abc",
          code_challenge_method: "S256",
        }),
      }),
    );
    expect(params.get("client_id")).toBe("opc_test");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(isAuthorizePath("/oauth/authorize/")).toBe(true);
    const camel = await readAuthorizeParams(
      new Request("https://www.operate.to/oauth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: "opc_js",
          redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
          codeChallenge: "abc",
          codeChallengeMethod: "S256",
        }),
      }),
    );
    expect(camel.get("client_id")).toBe("opc_js");
    expect(camel.get("code_challenge_method")).toBe("S256");
  });
});

describe("oauthBasicClientId", () => {
  it("reads client_id from Basic with an empty secret", () => {
    const request = new Request("https://www.operate.to/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from("opc_public:").toString("base64")}`,
      },
    });
    expect(oauthBasicClientId(request)).toBe("opc_public");
  });
});

describe("stripOAuthTrailingSlash", () => {
  it("rewrites POST and well-known trailing slashes that would 308", () => {
    expect(stripOAuthTrailingSlash("/oauth/token/")).toBe("/oauth/token");
    expect(stripOAuthTrailingSlash("/oauth/device/")).toBe("/oauth/device");
    expect(stripOAuthTrailingSlash("/oauth/revoke/")).toBe("/oauth/revoke");
    expect(stripOAuthTrailingSlash("/oauth/register/")).toBe("/oauth/register");
    expect(stripOAuthTrailingSlash("/api/mcp/")).toBe("/api/mcp");
    expect(
      stripOAuthTrailingSlash(
        "/.well-known/oauth-protected-resource/api/mcp/",
      ),
    ).toBe("/.well-known/oauth-protected-resource/api/mcp");
    expect(stripOAuthTrailingSlash("/oauth/token")).toBeNull();
    expect(stripOAuthTrailingSlash("/dashboard/")).toBeNull();
    expect(stripOAuthTrailingSlash("/link/")).toBe("/link");
    expect(stripOAuthTrailingSlash("/start/")).toBe("/start");
    expect(stripOAuthTrailingSlash("/api/x402/")).toBe("/api/x402");
    expect(stripOAuthTrailingSlash("/oauth//token/")).toBe("/oauth/token");
    expect(
      stripOAuthTrailingSlash(
        "/.well-known/oauth-protected-resource/api/mcp//",
      ),
    ).toBe("/.well-known/oauth-protected-resource/api/mcp");
    expect(stripOAuthTrailingSlash("/api/agent/manifest/")).toBe(
      "/api/agent/manifest",
    );
    expect(stripOAuthTrailingSlash("/mcp")).toBe("/api/mcp");
    expect(stripOAuthTrailingSlash("/mcp/")).toBe("/api/mcp");
    expect(
      stripOAuthTrailingSlash("/mcp/.well-known/oauth-protected-resource"),
    ).toBe("/api/mcp/.well-known/oauth-protected-resource");
    expect(isMachineOAuthPath("/mcp")).toBe(true);
    expect(isMachineOAuthPath("/oauth/token")).toBe(true);
    expect(isMachineOAuthPath("/oauth/authorize")).toBe(false);
    expect(isHumanOAuthPath("/oauth/authorize")).toBe(true);
    expect(isHumanOAuthPath("/link")).toBe(true);
    expect(isMachineOAuthPath("/link")).toBe(false);
  });
});

describe("OAuth POST routes share oauthFields", () => {
  it("does not leave a formData-only parser on token, device, or revoke", () => {
    for (const file of [
      "src/app/oauth/token/route.ts",
      "src/app/oauth/device/route.ts",
      "src/app/oauth/revoke/route.ts",
    ]) {
      const source = read(file);
      expect(source, file).toContain("oauthFields");
      expect(source, file).not.toMatch(/formData\(/);
    }
    const register = read("src/app/oauth/register/route.ts");
    expect(register).toContain("oauthJsonObject");
    expect(register).not.toMatch(/request\.json\(/);
    const revoke = read("src/app/oauth/revoke/route.ts");
    expect(revoke).toContain("oauthBearer");
    expect(revoke).toContain('field("token") || oauthBearer(request)');
    const token = read("src/app/oauth/token/route.ts");
    expect(token).toContain("oauthBasicClientId");
    expect(token).toContain(
      'field("client_id") || oauthBasicClientId(request)',
    );
    expect(token).toContain("field(\"resource\") || undefined");
    expect(token).not.toContain("resource is required");
    expect(token).toContain("oauthPostOnly");
    expect(read("src/app/oauth/register/route.ts")).toContain("oauthPostOnly");
    expect(revoke).toContain("oauthPostOnly");
    const middleware = read("src/middleware.ts");
    expect(middleware).toContain("stripOAuthTrailingSlash");
    expect(middleware).toContain("NextResponse.rewrite");
    expect(middleware).toContain("isMachineOAuthPath");
    expect(middleware).toContain("return clerk(req, event)");
    expect(middleware).toContain("readAuthorizeParams");
    expect(middleware).toContain("303");
    expect(middleware).toContain("isOAuthOptionsPath");
    expect(middleware).toContain('req.method === "OPTIONS"');
    expect(middleware).toContain("oauthCorsHeaders(req)");
    expect(middleware.indexOf("isOAuthOptionsPath")).toBeLessThan(
      middleware.indexOf("return clerk(req, event)"),
    );
    expect(read("next.config.mjs")).toContain("skipTrailingSlashRedirect: true");
    expect(read("src/app/oauth/token/route.ts")).toContain("oauthOptions");
    expect(
      read("src/app/.well-known/oauth-protected-resource/route.ts"),
    ).toContain("oauthOptions");
    expect(read("src/app/api/agent/manifest/route.ts")).toContain(
      "oauthOptions",
    );
    expect(read("src/app/api/x402/route.ts")).toContain("oauthOptions");
    expect(read("src/app/api/x402/route.ts")).toContain("oauthFields");
    expect(read("src/app/api/x402/route.ts")).not.toMatch(/req\.json\(/);
    expect(
      read("src/app/.well-known/openai-apps-challenge/route.ts"),
    ).toContain("oauthOptions");
    expect(read("src/app/oauth/userinfo/route.ts")).toContain("export async function POST");
    expect(read("src/app/api/[transport]/route.ts")).toContain("applyMcpCors");
    expect(read("src/app/api/[transport]/route.ts")).toContain(
      "response.status === 403",
    );
    expect(read("src/app/api/[transport]/route.ts")).not.toContain(
      "MCP_BROWSER_ORIGINS",
    );
    expect(read("src/lib/oauth-slash.ts")).not.toMatch(
      /from ["']node:crypto["']/,
    );
    expect(read("src/lib/oauth-slash.ts")).not.toMatch(/from "\.\/oauth-server"/);
  });
});
