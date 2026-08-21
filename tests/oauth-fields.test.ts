import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { oauthFields, oauthJsonObject } from "../src/lib/oauth-server";

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
  });
});
