import { describe, expect, it } from "vitest";
import { oauthFields } from "../src/lib/oauth-server";

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
});
