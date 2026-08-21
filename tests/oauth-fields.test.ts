import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalGrantType,
  DEVICE_GRANT,
  inferGrantType,
  oauthBasicClientId,
  oauthBearer,
  oauthCorsHeaders,
  oauthError,
  oauthFields,
  oauthJson,
  oauthJsonObject,
  oauthPostOnly,
} from "../src/lib/oauth-server";
import {
  applyMcpCors,
  applyOperateAuthorization,
  canonicalCodeChallengeMethod,
  extractOperateCredential,
  isAuthorizePath,
  isHumanOAuthPath,
  isMachineOAuthPath,
  isMcpBrowserOrigin,
  isOAuthOptionsPath,
  canonicalOAuthKey,
  firstFolded,
  oauthParamGet,
  oauthQueryValue,
  readAuthorizeParams,
  stripOAuthTrailingSlash,
} from "../src/lib/oauth-slash";
import { GET as getDevice } from "../src/app/oauth/device/route";

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
    const hyphenated = await oauthFields(
      new Request("https://www.operate.to/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          "client-id": "opc_hyphen",
          "redirect-uri": "https://chatgpt.com/connector_platform_oauth_redirect",
        }),
      }),
    );
    expect(hyphenated("client_id")).toBe("opc_hyphen");
    expect(hyphenated("redirect_uri")).toBe(
      "https://chatgpt.com/connector_platform_oauth_redirect",
    );
    const moreHyphens = await oauthFields(
      new Request("https://www.operate.to/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          "code-verifier": "pkce_hyphen",
          "device-code": "opd_hyphen",
          "user-code": "ABCD-EFGH",
          "client-name": "claude-code",
        }),
      }),
    );
    expect(moreHyphens("code_verifier")).toBe("pkce_hyphen");
    expect(moreHyphens("device_code")).toBe("opd_hyphen");
    expect(moreHyphens("user_code")).toBe("ABCD-EFGH");
    expect(moreHyphens("client_name")).toBe("claude-code");
    expect(canonicalOAuthKey("code-verifier")).toBe("code_verifier");
    expect(canonicalOAuthKey("user-code")).toBe("user_code");
    expect(canonicalOAuthKey("redirect-url")).toBe("redirect_uri");
    expect(canonicalOAuthKey("CLIENT_ID")).toBe("client_id");
    expect(canonicalOAuthKey("Client-Id")).toBe("client_id");
    const headerCase = await oauthFields(
      new Request("https://www.operate.to/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          "Client-Id": "opc_header_case",
          CLIENT_ID: "opc_screaming",
        }),
      }),
    );
    expect(headerCase("client_id")).toBe("opc_header_case");
    const audience = await oauthFields(
      new Request("https://www.operate.to/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audience: "https://operate.to/api/mcp" }),
      }),
    );
    expect(audience("resource")).toBe("https://operate.to/api/mcp");
    const aud = await oauthFields(
      new Request("https://www.operate.to/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aud: "https://operate.to/api/mcp" }),
      }),
    );
    expect(aud("resource")).toBe("https://operate.to/api/mcp");
    const grantAlias = await oauthFields(
      new Request("https://www.operate.to/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant: "code" }),
      }),
    );
    expect(grantAlias("grant_type")).toBe("code");
    const hyphenGrant = await oauthFields(
      new Request("https://www.operate.to/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ "grant-type": "authorizationCode" }),
      }),
    );
    expect(hyphenGrant("grant_type")).toBe("authorizationCode");
    expect(canonicalGrantType(hyphenGrant("grant_type"))).toBe(
      "authorization_code",
    );
    const scopeArray = await oauthFields(
      new Request("https://www.operate.to/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: ["openid", "email", "operate:read"],
          redirect_url: "https://chatgpt.com/connector_platform_oauth_redirect",
        }),
      }),
    );
    expect(scopeArray("scope")).toBe("openid email operate:read");
    expect(scopeArray("redirect_uri")).toBe(
      "https://chatgpt.com/connector_platform_oauth_redirect",
    );
    const commaScope = await oauthFields(
      new Request("https://www.operate.to/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "scope=openid,email,operate:read&verifier=pkce_verifier",
      }),
    );
    expect(commaScope("scope")).toBe("openid email operate:read");
    expect(commaScope("code_verifier")).toBe("pkce_verifier");
    const repeatedScope = await oauthFields(
      new Request("https://www.operate.to/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "scope[]=openid&scope[]=email&scope[]=operate:read&code-verifier=pkce_form_hyphen",
      }),
    );
    expect(repeatedScope("scope")).toBe("openid email operate:read");
    expect(repeatedScope("code_verifier")).toBe("pkce_form_hyphen");
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

  it("reads Token / Api-Key / raw cua_ and query apiKey", () => {
    expect(
      extractOperateCredential("Token cua_raw", undefined),
    ).toBe("cua_raw");
    expect(
      extractOperateCredential("Api-Key cua_key", undefined),
    ).toBe("cua_key");
    expect(extractOperateCredential("cua_bare", undefined)).toBe("cua_bare");
    expect(extractOperateCredential("Basic abc", undefined)).toBe("");
    expect(extractOperateCredential("Token: cua_colon", undefined)).toBe(
      "cua_colon",
    );
    expect(extractOperateCredential("Bearer: cua_colon_bearer", undefined)).toBe(
      "cua_colon_bearer",
    );
    expect(extractOperateCredential("Api-Key: cua_colon_key", undefined)).toBe(
      "cua_colon_key",
    );
    expect(extractOperateCredential("Token:cua_nospace", undefined)).toBe(
      "cua_nospace",
    );
    expect(extractOperateCredential("Token : cua_spaced_colon", undefined)).toBe(
      "cua_spaced_colon",
    );
    expect(extractOperateCredential("Bearer :cua_spaced_bearer", undefined)).toBe(
      "cua_spaced_bearer",
    );
    expect(
      extractOperateCredential("Api-Key : cua_spaced_key", undefined),
    ).toBe("cua_spaced_key");
    expect(
      extractOperateCredential(
        "Basic : opc_public:, Token : cua_after_spaced_basic",
      ),
    ).toBe("cua_after_spaced_basic");
    expect(extractOperateCredential("Bearer:cua_nospace_bearer", undefined)).toBe(
      "cua_nospace_bearer",
    );
    expect(extractOperateCredential("Api-Key:cua_nospace_key", undefined)).toBe(
      "cua_nospace_key",
    );
    expect(extractOperateCredential("Tokencua_glued", undefined)).toBe("");
    expect(
      extractOperateCredential("Basic:opc_public:, Token:cua_after_basic_colon"),
    ).toBe("cua_after_basic_colon");
    expect(
      extractOperateCredential("Basic opc_public:, Bearer cua_after_basic"),
    ).toBe("cua_after_basic");
    expect(
      extractOperateCredential("Bearer cua_first, Bearer cua_second"),
    ).toBe("cua_first");
    expect(
      extractOperateCredential("Bearer cua_keep, Basic opc_public:"),
    ).toBe("cua_keep");
    expect(extractOperateCredential('Bearer "cua_quoted"', undefined)).toBe(
      "cua_quoted",
    );
    expect(extractOperateCredential("Token token=cua_named", undefined)).toBe(
      "cua_named",
    );
    expect(
      extractOperateCredential("Bearer Bearer cua_double", undefined),
    ).toBe("cua_double");
    expect(
      extractOperateCredential("Token Token cua_double_token", undefined),
    ).toBe("cua_double_token");
    const rewritten = applyOperateAuthorization(
      new Headers({ Authorization: "Bearer Bearer cua_rewritten" }),
      "https://www.operate.to/api/mcp",
    );
    expect(rewritten.get("Authorization")).toBe("Bearer cua_rewritten");
    expect(
      extractOperateCredential(undefined, undefined, { apiKey: "cua_header" }),
    ).toBe("cua_header");
    expect(
      extractOperateCredential("Basic abc", undefined, {
        apiKey: "cua_from_x",
      }),
    ).toBe("cua_from_x");
    expect(
      extractOperateCredential(undefined, undefined, {
        apiKey: "Basic abc",
      }),
    ).toBe("");
    expect(
      oauthBearer(
        new Request("https://www.operate.to/api/mcp?apiKey=cua_query"),
      ),
    ).toBe("cua_query");
    expect(
      oauthBearer(
        new Request("https://www.operate.to/api/mcp?api-key=cua_hyphen_query"),
      ),
    ).toBe("cua_hyphen_query");
    expect(
      oauthBearer(
        new Request("https://www.operate.to/api/mcp?token=cua_token_query"),
      ),
    ).toBe("cua_token_query");
    expect(
      oauthBearer(
        new Request("https://www.operate.to/api/mcp?Token=cua_token_cased"),
      ),
    ).toBe("cua_token_cased");
    expect(
      oauthBearer(
        new Request("https://www.operate.to/api/mcp?Api-Key=cua_api_cased"),
      ),
    ).toBe("cua_api_cased");
    expect(
      oauthBearer(
        new Request(
          "https://www.operate.to/api/mcp?access_token[]=cua_array_query",
        ),
      ),
    ).toBe("cua_array_query");
    const folded = firstFolded(
      new URLSearchParams("Token=cua_folded_a&token=cua_folded_b"),
      "token",
    );
    expect(folded).toBe("cua_folded_a");
    expect(typeof folded).toBe("string");
    expect(
      typeof oauthBearer(
        new Request("https://www.operate.to/api/mcp?Token=cua_type"),
      ),
    ).toBe("string");
    expect(
      oauthBearer(
        new Request(
          "https://www.operate.to/api/mcp?authorization=Bearer%20cua_query_auth",
        ),
      ),
    ).toBe("cua_query_auth");
    expect(
      oauthBearer(
        new Request(
          "https://www.operate.to/api/mcp?Authorization=Token:cua_query_colon",
        ),
      ),
    ).toBe("cua_query_colon");
    expect(
      oauthBearer(
        new Request(
          "https://www.operate.to/api/mcp?authorization=Basic%20opc_public:",
        ),
      ),
    ).toBe("");
    expect(
      oauthBearer(
        new Request("https://www.operate.to/api/mcp", {
          headers: { "X-Api-Key": "cua_x" },
        }),
      ),
    ).toBe("cua_x");
    expect(
      oauthBearer(
        new Request("https://www.operate.to/api/mcp", {
          headers: { Token: "cua_token_header" },
        }),
      ),
    ).toBe("cua_token_header");
    expect(
      oauthBearer(
        new Request("https://www.operate.to/api/mcp", {
          headers: { "X-Token": "cua_x_token" },
        }),
      ),
    ).toBe("cua_x_token");
    expect(
      oauthBearer(
        new Request("https://www.operate.to/api/mcp?x-api-key=cua_x_api_query"),
      ),
    ).toBe("cua_x_api_query");
    expect(
      oauthBearer(
        new Request("https://www.operate.to/api/mcp?x-token=cua_x_token_query"),
      ),
    ).toBe("cua_x_token_query");
    expect(
      oauthBearer(
        new Request(
          "https://www.operate.to/api/mcp?x-authorization=Bearer%20cua_x_auth_query",
        ),
      ),
    ).toBe("cua_x_auth_query");
    expect(
      oauthBearer(
        new Request(
          "https://www.operate.to/api/mcp?access_token=Bearer%20cua_query_peel",
        ),
      ),
    ).toBe("cua_query_peel");
    expect(
      extractOperateCredential(undefined, undefined, {
        bodyToken: "Bearer cua_body_peel",
      }),
    ).toBe("cua_body_peel");
    expect(
      oauthBearer(
        new Request("https://www.operate.to/api/mcp", {
          headers: { "X-Authorization": "Bearer cua_x_authorization" },
        }),
      ),
    ).toBe("cua_x_authorization");
    expect(
      oauthBearer(
        new Request("https://www.operate.to/api/mcp", {
          headers: { "Proxy-Authorization": "Bearer cua_proxy" },
        }),
      ),
    ).toBe("cua_proxy");
    expect(
      oauthBearer(
        new Request("https://www.operate.to/api/mcp", {
          headers: {
            Authorization: "Bearer eyJhbG.not-cua",
            "X-Token": "cua_real",
          },
        }),
      ),
    ).toBe("cua_real");
    expect(
      oauthBearer(
        new Request("https://www.operate.to/api/mcp", {
          headers: {
            Authorization: "Bearer cua_first",
            "X-Token": "cua_other",
          },
        }),
      ),
    ).toBe("cua_first");
    expect(
      extractOperateCredential("Bearer eyJhbG.not-cua", undefined, {
        bodyToken: "cua_from_body",
      }),
    ).toBe("cua_from_body");
    expect(
      extractOperateCredential("Bearer cua_header", undefined, {
        bodyToken: "eyJhbG.not-cua",
      }),
    ).toBe("cua_header");
    expect(
      oauthBearer(
        new Request("https://www.operate.to/api/mcp", {
          headers: { "X-Api-Token": "cua_x_api_token" },
        }),
      ),
    ).toBe("cua_x_api_token");
    expect(
      oauthBearer(
        new Request("https://www.operate.to/api/mcp?x-api-token=cua_x_api_token_query"),
      ),
    ).toBe("cua_x_api_token_query");
    expect(
      oauthBearer(
        new Request("https://www.operate.to/api/mcp", {
          headers: { "Authorization-Alias": "Bearer cua_alias" },
        }),
      ),
    ).toBe("cua_alias");
    expect(
      oauthBearer(
        new Request("https://www.operate.to/api/mcp", {
          headers: { Cookie: "access_token=cua_cookie" },
        }),
      ),
    ).toBe("");
    expect(
      oauthBearer(
        new Request("https://www.operate.to/api/mcp", {
          headers: { "Sec-WebSocket-Protocol": "mcp, cua_ws" },
        }),
      ),
    ).toBe("");
    expect(
      oauthBearer(
        new Request("https://www.operate.to/api/mcp", {
          headers: { "X-Unknown": "cua_unknown_header" },
        }),
      ),
    ).toBe("");
    expect(canonicalGrantType("device_code")).toBe(DEVICE_GRANT);
    expect(canonicalGrantType("DEVICE_CODE")).toBe(DEVICE_GRANT);
    expect(canonicalGrantType("device")).toBe(DEVICE_GRANT);
    expect(canonicalGrantType("authorization-code")).toBe("authorization_code");
    expect(canonicalGrantType("Authorization_Code")).toBe("authorization_code");
    expect(canonicalGrantType("authorization")).toBe("authorization_code");
    expect(canonicalGrantType("auth_code")).toBe("authorization_code");
    expect(canonicalGrantType("authorizationCode")).toBe("authorization_code");
    expect(canonicalGrantType("authorization code")).toBe("authorization_code");
    expect(
      canonicalGrantType("urn:ietf:params:oauth:grant-type:authorization_code"),
    ).toBe("authorization_code");
    expect(
      canonicalGrantType("urn:ietf:params:oauth:grant-type:refresh_token"),
    ).toBe("refresh_token");
    expect(canonicalGrantType("code")).toBe("authorization_code");
    expect(
      canonicalGrantType("urn:ietf:params:oauth:grant-type:device-code"),
    ).toBe(DEVICE_GRANT);
    expect(canonicalGrantType("refresh")).toBe("refresh_token");
    expect(canonicalGrantType("refreshToken")).toBe("refresh_token");
    expect(canonicalGrantType("deviceCode")).toBe(DEVICE_GRANT);
    expect(canonicalGrantType("REFRESH-TOKEN")).toBe("refresh_token");
    expect(
      inferGrantType((name) => (name === "device_code" ? "opd_omit" : "")),
    ).toBe(DEVICE_GRANT);
    expect(
      inferGrantType((name) => (name === "code" ? "opc_omit" : "")),
    ).toBe("authorization_code");
    expect(
      inferGrantType((name) => (name === "refresh_token" ? "opr_omit" : "")),
    ).toBe("refresh_token");
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

describe("device GET 405", () => {
  it("returns Allow POST and verification_url so a GET probe is not a dead end", async () => {
    const response = getDevice(
      new Request("https://www.operate.to/oauth/device"),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    const body = await response.json();
    expect(body.verification_url).toBe("https://www.operate.to/link");
    expect(body.verification_uri).toBe("https://www.operate.to/link");
  });
});

describe("oauthQueryValue", () => {
  it("reads hyphenated authorize query keys through the same alias table as POST", () => {
    const query = new URLSearchParams({
      "client-id": "opc_hyphen",
      "redirect-uri": "https://chatgpt.com/connector_platform_oauth_redirect",
      "code-challenge": "abc",
      "code-challenge-method": "sha256",
      aud: "https://operate.to/api/mcp",
    });
    const get = (name: string) => query.get(name);
    expect(oauthQueryValue(get, "client_id")).toBe("opc_hyphen");
    expect(oauthQueryValue(get, "redirect_uri")).toBe(
      "https://chatgpt.com/connector_platform_oauth_redirect",
    );
    expect(oauthQueryValue(get, "code_challenge")).toBe("abc");
    expect(oauthQueryValue(get, "code_challenge_method")).toBe("sha256");
    expect(oauthQueryValue(get, "resource")).toBe("https://operate.to/api/mcp");
    expect(
      oauthQueryValue(
        (name) => (name === "user-code" ? "WXYZ-1234" : null),
        "user_code",
      ),
    ).toBe("WXYZ-1234");
    expect(
      oauthQueryValue(
        oauthParamGet({ "Client-Id": "opc_folded", AUD: "https://operate.to/api/mcp" }),
        "client_id",
      ),
    ).toBe("opc_folded");
    expect(
      oauthQueryValue(
        oauthParamGet({ "Client-Id": "opc_folded", AUD: "https://operate.to/api/mcp" }),
        "resource",
      ),
    ).toBe("https://operate.to/api/mcp");
    expect(
      oauthQueryValue(
        (name) => (name === "scope" ? "openid,email,operate:read" : null),
        "scope",
      ),
    ).toBe("openid email operate:read");
    expect(
      oauthQueryValue(
        (name) =>
          name === "scope[]" ? ["openid", "email", "operate:read"] : null,
        "scope",
      ),
    ).toBe("openid email operate:read");
    expect(
      oauthQueryValue(
        (name) => (name === "user_code" ? ["WXYZ-1234"] : null),
        "user_code",
      ),
    ).toBe("WXYZ-1234");
  });
});

describe("PKCE method aliases", () => {
  it("maps s256 / sha256 / hyphenated forms to S256 and leaves unknown methods", () => {
    expect(canonicalCodeChallengeMethod("")).toBe("S256");
    expect(canonicalCodeChallengeMethod("s256")).toBe("S256");
    expect(canonicalCodeChallengeMethod("S256")).toBe("S256");
    expect(canonicalCodeChallengeMethod("sha256")).toBe("S256");
    expect(canonicalCodeChallengeMethod("SHA-256")).toBe("S256");
    expect(canonicalCodeChallengeMethod("plain")).toBe("plain");
  });
});

describe("oauth CORS", () => {
  it("puts WWW-Authenticate on 401 OAuth JSON so browsers can read the challenge", () => {
    const response = oauthError("invalid_client", "client_id is required", 401);
    expect(response.headers.get("WWW-Authenticate")).toMatch(/invalid_client/);
    expect(response.headers.get("WWW-Authenticate")).toMatch(/resource_metadata=/);
    expect(response.headers.get("WWW-Authenticate")).toMatch(/as_uri=/);
    expect(response.headers.get("Access-Control-Expose-Headers")).toMatch(
      /WWW-Authenticate/,
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toMatch(/HEAD/);
    expect(response.headers.get("WWW-Authenticate")).toMatch(/realm=/);
    const postOnly = oauthPostOnly();
    expect(postOnly.status).toBe(405);
    expect(postOnly.headers.get("Allow")).toBe("POST");
    const credentialed = oauthCorsHeaders(
      new Request("https://www.operate.to/oauth/token", {
        headers: { Origin: "https://chatgpt.com" },
      }),
    );
    expect(credentialed["Access-Control-Allow-Origin"]).toBe(
      "https://chatgpt.com",
    );
    expect(credentialed["Access-Control-Allow-Credentials"]).toBe("true");
  });

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
      /Accept|If-None-Match|X-PAYMENT|Mcp-Protocol-Version|X-Api-Key|X-Token|X-Authorization|Proxy-Authorization|X-Api-Token|Authorization-Alias/,
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
    const scopes = await readAuthorizeParams(
      new Request("https://www.operate.to/oauth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scopes: "openid email operate:read",
          responseType: "authorization_code",
        }),
      }),
    );
    expect(scopes.get("scope")).toBe("openid email operate:read");
    expect(scopes.get("response_type")).toBe("authorization_code");
    const scopeArray = await readAuthorizeParams(
      new Request("https://www.operate.to/oauth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scopes: ["openid", "email", "operate:read"],
        }),
      }),
    );
    expect(scopeArray.get("scope")).toBe("openid email operate:read");
    const commaScope = await readAuthorizeParams(
      new Request("https://www.operate.to/oauth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "openid,email" }),
      }),
    );
    expect(commaScope.get("scope")).toBe("openid email");
    const repeatedScope = await readAuthorizeParams(
      new Request("https://www.operate.to/oauth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "scope[]=openid&scope[]=email&scope[]=operate:read",
      }),
    );
    expect(repeatedScope.get("scope")).toBe("openid email operate:read");
    const redirectUrl = await readAuthorizeParams(
      new Request("https://www.operate.to/oauth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_url:
            "https://chatgpt.com/connector_platform_oauth_redirect",
        }),
      }),
    );
    expect(redirectUrl.get("redirect_uri")).toBe(
      "https://chatgpt.com/connector_platform_oauth_redirect",
    );
    const hyphenated = await readAuthorizeParams(
      new Request("https://www.operate.to/oauth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          "client-id": "opc_hyphen",
          "code-challenge": "abc",
          "user-code": "ignored-on-authorize",
        }),
      }),
    );
    expect(hyphenated.get("client_id")).toBe("opc_hyphen");
    expect(hyphenated.get("code_challenge")).toBe("abc");
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
    expect(
      stripOAuthTrailingSlash(
        "/mcp/.well-known/oauth-protected-resource/api/mcp",
      ),
    ).toBe("/api/mcp/.well-known/oauth-protected-resource/api/mcp");
    expect(
      stripOAuthTrailingSlash(
        "/mcp/.well-known/oauth-authorization-server/api/mcp",
      ),
    ).toBe("/api/mcp/.well-known/oauth-authorization-server/api/mcp");
    expect(stripOAuthTrailingSlash("/mcp/.well-known/mcp")).toBe(
      "/.well-known/mcp",
    );
    expect(stripOAuthTrailingSlash("/mcp/.well-known/webfinger")).toBe(
      "/.well-known/webfinger",
    );
    expect(stripOAuthTrailingSlash("/api/mcp/.well-known/mcp")).toBe(
      "/.well-known/mcp",
    );
    expect(stripOAuthTrailingSlash("/.well-known/host-meta.json")).toBe(
      "/.well-known/host-meta",
    );
    expect(stripOAuthTrailingSlash("/mcp/.well-known/host-meta")).toBe(
      "/.well-known/host-meta",
    );
    expect(stripOAuthTrailingSlash("/mcp/.well-known/host-meta.json")).toBe(
      "/.well-known/host-meta",
    );
    expect(stripOAuthTrailingSlash("/api/mcp/.well-known/host-meta")).toBe(
      "/.well-known/host-meta",
    );
    expect(stripOAuthTrailingSlash("/mcp/.well-known/mcp.json")).toBe(
      "/.well-known/mcp",
    );
    expect(stripOAuthTrailingSlash("/mcp/.well-known/webfinger.json")).toBe(
      "/.well-known/webfinger",
    );
    expect(stripOAuthTrailingSlash("/mcp.json")).toBe("/api/mcp");
    expect(stripOAuthTrailingSlash("/oauth/token.json")).toBe("/oauth/token");
    expect(stripOAuthTrailingSlash("/oauth/device.json")).toBe("/oauth/device");
    expect(stripOAuthTrailingSlash("/oauth/userinfo.json")).toBe(
      "/oauth/userinfo",
    );
    expect(stripOAuthTrailingSlash("/oauth.json")).toBe("/oauth");
    expect(stripOAuthTrailingSlash("/oauth/")).toBe("/oauth");
    expect(
      stripOAuthTrailingSlash(
        "/oauth/.well-known/oauth-authorization-server",
      ),
    ).toBe("/.well-known/oauth-authorization-server");
    expect(
      stripOAuthTrailingSlash(
        "/oauth/.well-known/oauth-protected-resource/api/mcp",
      ),
    ).toBe("/.well-known/oauth-protected-resource/api/mcp");
    expect(
      stripOAuthTrailingSlash(
        "/oauth/.well-known/oauth-authorization-server.json",
      ),
    ).toBe("/.well-known/oauth-authorization-server");
    expect(stripOAuthTrailingSlash("/oauth/.well-known")).toBe(
      "/.well-known/oauth-authorization-server",
    );
    expect(stripOAuthTrailingSlash("/link.json")).toBe("/link");
    expect(stripOAuthTrailingSlash("/dashboard.json")).toBeNull();
    expect(stripOAuthTrailingSlash("/api/mcp.json")).toBe("/api/mcp");
    expect(stripOAuthTrailingSlash("/.well-known/mcp.json")).toBe(
      "/.well-known/mcp",
    );
    expect(
      stripOAuthTrailingSlash("/.well-known/oauth-protected-resource.json"),
    ).toBe("/.well-known/oauth-protected-resource");
    expect(
      stripOAuthTrailingSlash(
        "/.well-known/oauth-protected-resource/api/mcp.json",
      ),
    ).toBe("/.well-known/oauth-protected-resource/api/mcp");
    expect(
      stripOAuthTrailingSlash(
        "/mcp/.well-known/oauth-protected-resource.json",
      ),
    ).toBe("/api/mcp/.well-known/oauth-protected-resource");
    expect(isMachineOAuthPath("/mcp")).toBe(true);
    expect(isMachineOAuthPath("/oauth")).toBe(true);
    expect(isMachineOAuthPath("/oauth/.well-known/oauth-authorization-server")).toBe(
      true,
    );
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
    expect(revoke).toContain("operateRequestCredential");
    expect(revoke).toContain('field("token")');
    const token = read("src/app/oauth/token/route.ts");
    expect(token).toContain("oauthBasicClientId");
    expect(token).toContain(
      'field("client_id") || oauthBasicClientId(request)',
    );
    expect(token).toContain(
      'field("resource") || field("audience") || undefined',
    );
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
    expect(middleware).toContain('"/mcp/:path*"');
    expect(middleware).toContain('"/mcp.json"');
    expect(middleware).toContain('"/oauth.json"');
    expect(middleware).toContain('"/oauth/:path*"');
    expect(middleware).toContain('"/link.json"');
    expect(read("src/app/oauth/device/route.ts")).toContain("verification_url");
    expect(read("src/app/oauth/device/route.ts")).toMatch(
      /export function GET[\s\S]*verification_url/,
    );
    expect(read("src/app/oauth/register/route.ts")).not.toContain(
      "client_secret_basic",
    );
    expect(read("src/app/oauth/authorize/oauth-authorize.tsx")).toContain(
      "oauthQueryValue",
    );
    expect(read("src/app/oauth/authorize/oauth-authorize.tsx")).toContain(
      "foldSearchAll",
    );
    expect(read("src/app/oauth/authorize/page.tsx")).toContain(
      "Array.isArray(value)",
    );
    expect(read("src/app/oauth/authorize/page.tsx")).toContain("oauthParamGet");
    expect(read("src/app/oauth/authorize/oauth-authorize.tsx")).toContain(
      "canonicalCodeChallengeMethod",
    );
    expect(read("src/app/oauth/authorize/page.tsx")).toContain(
      'oauthQueryValue(oauthParamGet(params), "resource")',
    );
    expect(read("src/app/link/page.tsx")).toContain(
      'oauthQueryValue(param, "user_code")',
    );
    expect(read("src/app/link/page.tsx")).toContain("oauthParamGet");
    expect(read("src/app/api/x402/route.ts")).toContain(
      "operateRequestCredential",
    );
    expect(read("src/app/api/x402/route.ts")).toContain("oauthWwwAuthenticate");
    expect(read("src/app/api/x402/route.ts")).toMatch(
      /status === 401 \|\| status === 403/,
    );
    expect(read("src/app/.well-known/webfinger/route.ts")).toContain(
      "oauthOptions",
    );
    expect(read("src/app/.well-known/webfinger/route.ts")).toContain(
      "firstFolded",
    );
    expect(read("src/app/api/x402/route.ts")).toContain("firstFolded");
    expect(read("src/lib/oauth-slash.ts")).toContain("(?:\\s*:\\s*|\\s+)");
    expect(read("src/lib/oauth-server.ts")).toContain(
      "export function oauthBearer(request: Request): string",
    );
    expect(read("src/lib/oauth-slash.ts")).toContain(
      'firstFolded(query, "authorization")',
    );
    expect(read("src/lib/oauth-slash.ts")).toContain(
      'firstFolded(query, "x-api-key")',
    );
    expect(read("src/lib/oauth-slash.ts")).toContain(
      'firstFolded(query, "x-token")',
    );
    expect(read("src/lib/oauth-slash.ts")).toContain(
      'firstFolded(query, "x-authorization")',
    );
    expect(read("src/lib/oauth-slash.ts")).toContain(
      'firstFolded(query, "x-api-token")',
    );
    expect(read("src/lib/oauth-slash.ts")).toContain('headers.get("x-token")');
    expect(read("src/lib/oauth-slash.ts")).toContain(
      'headers.get("x-authorization")',
    );
    expect(read("src/lib/oauth-slash.ts")).toContain(
      'headers.get("proxy-authorization")',
    );
    expect(read("src/lib/oauth-slash.ts")).toContain(
      'headers.get("x-api-token")',
    );
    expect(read("src/lib/oauth-slash.ts")).toContain(
      'headers.get("authorization-alias")',
    );
    expect(read("src/lib/oauth-slash.ts")).toContain("peelOperateCredential");
    expect(read("src/lib/oauth-slash.ts")).toContain("operateRequestCredential");
    expect(read("src/app/oauth/userinfo/route.ts")).toContain(
      "operateRequestCredential",
    );
    expect(read("src/app/api/x402/route.ts")).toContain(
      "operateRequestCredential",
    );
    expect(read("src/app/.well-known/host-meta/route.ts")).toContain(
      "export function GET(request: Request)",
    );
    expect(read("src/app/.well-known/host-meta/route.ts")).not.toContain(
      "request?: Request",
    );
    expect(read("src/app/api/mcp/.well-known/mcp/route.ts")).toContain(
      ".well-known/mcp/route",
    );
    expect(read("src/app/api/mcp/.well-known/host-meta/route.ts")).toContain(
      ".well-known/host-meta/route",
    );
    expect(
      read(
        "src/app/api/mcp/.well-known/oauth-protected-resource/[...path]/route.ts",
      ),
    ).toContain('from "../route"');
    expect(
      read(
        "src/app/api/mcp/.well-known/oauth-authorization-server/[...path]/route.ts",
      ),
    ).toContain('from "../route"');
    expect(read("src/lib/oauth-slash.ts")).toContain("oauthQueryValue");
    expect(read("src/app/oauth/token/route.ts")).toMatch(
      /oauthError\(\s*error,\s*DEVICE_ERROR_HELP\[error\]\(result\.interval\),\s*400,\s*request,/,
    );
    expect(read("src/app/oauth/route.ts")).toContain(
      "export function GET(request: Request)",
    );
    expect(read("src/app/oauth/route.ts")).not.toContain("request?: Request");
    expect(read("src/app/.well-known/webfinger/route.ts")).toContain(
      "export function GET(request: Request)",
    );
    expect(read("src/app/oauth/route.ts")).toContain("oauthDiscoveryMetadata");
    expect(read("src/app/oauth/route.ts")).toContain("oauthPostOnly");
    expect(read("src/app/oauth/token/route.ts")).toContain("inferGrantType");
    expect(read("src/app/oauth/token/route.ts")).toContain("access_token: key");
    expect(read("src/app/.well-known/mcp/route.ts")).toContain("oauthJson");
    expect(read("src/app/connect/route.ts")).toContain(
      "json_str access_token",
    );
    expect(read("src/app/api/[transport]/route.ts")).toContain(
      "applyOperateAuthorization",
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
    expect(read("src/app/oauth/userinfo/route.ts")).toContain("oauthWwwAuthenticate");
    expect(read("src/app/oauth/authorize/oauth-authorize.tsx")).toContain(
      'responseTypeRaw === "authorization_code"',
    );
    expect(read("src/app/oauth/userinfo/route.ts")).toContain("export async function POST");
    expect(read("src/app/api/[transport]/route.ts")).toContain("guarded as HEAD");
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
