import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  oauthBasicClientId,
  oauthBearer,
  oauthFields,
  oauthJsonObject,
} from "../src/lib/oauth-server";
import { stripOAuthTrailingSlash } from "../src/lib/oauth-slash";

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
    const middleware = read("src/middleware.ts");
    expect(middleware).toContain("stripOAuthTrailingSlash");
    expect(middleware).toContain("NextResponse.rewrite");
  });
});
