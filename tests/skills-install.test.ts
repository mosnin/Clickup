import { afterEach, describe, expect, it } from "vitest";
import { GET as connect } from "../src/app/connect/route";
import { GET as installer } from "../src/app/install/skills/route";
import { GET as skillFile } from "../src/app/skills/operate/[skill]/route";

describe("curl-installable Operate skills", () => {
  afterEach(() => {
    delete process.env.OPERATE_PUBLIC_URL;
  });

  it("pins every official download to the published content checksum", async () => {
    const response = await installer();
    const script = await response.text();

    expect(response.headers.get("content-type")).toContain("text/x-shellscript");
    expect(script).toContain("set -eu");
    expect(script).toContain("mktemp -d");
    expect(script).toContain("verify_sha256");
    expect(script.match(/curl -fsSL --retry 3/g)).toHaveLength(7);
    expect(script.match(/verify_sha256 "[a-f0-9]{64}"/g)).toHaveLength(7);
    expect(script).toContain(
      "https://www.operate.to/skills/operate/operate-worker",
    );
  });

  it("does not let an invalid public URL poison curl-piped installs", async () => {
    process.env.OPERATE_PUBLIC_URL =
      "https://evil.example/'$(touch should-not-run)'";
    const script = await (await installer()).text();
    expect(script).not.toContain("evil.example");
    expect(script).toContain("https://www.operate.to/skills/operate/");
  });

  it("rewrites an apex OPERATE_PUBLIC_URL so device and token POSTs hit www", async () => {
    process.env.OPERATE_PUBLIC_URL = "https://operate.to";
    const skills = await (await installer()).text();
    expect(skills).toContain("https://www.operate.to/skills/operate/");
    expect(skills).not.toContain("https://operate.to/skills/");

    const script = await (await connect()).text();
    expect(script).toContain('POST "https://www.operate.to/oauth/device"');
    expect(script).toContain('POST "https://www.operate.to/oauth/token"');
    expect(script).not.toContain('POST "https://operate.to/oauth/');
  });

  it("serves importable skill markdown and rejects unknown names", async () => {
    const found = await skillFile(new Request("https://www.operate.to"), {
      params: Promise.resolve({ skill: "operate-worker" }),
    });
    expect(found.status).toBe(200);
    expect(found.headers.get("content-type")).toContain("text/markdown");
    expect(await found.text()).toMatch(/^---\nname: operate-worker/m);

    const missing = await skillFile(new Request("https://www.operate.to"), {
      params: Promise.resolve({ skill: "../secret" }),
    });
    expect(missing.status).toBe(404);
  });
});
