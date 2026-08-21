import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHATGPT_ADVERTISED_TOOL_COUNT } from "../src/lib/mcp-catalog";

const ROOT = process.cwd();
const MANIFEST_PATH = join(
  ROOT,
  "plugins/operate/.codex-plugin/plugin.json",
);

describe("public Operate plugin package", () => {
  it("keeps the generated submission exactly aligned with the live profile", () => {
    const check = spawnSync(
      process.execPath,
      ["scripts/generate-chatgpt-submission.mjs", "--check"],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(
      check.status,
      `${check.stdout}\n${check.stderr}`,
    ).toBe(0);

    const submission = JSON.parse(
      readFileSync(join(ROOT, "chatgpt-app-submission.json"), "utf8"),
    ) as { tools: Record<string, unknown> };
    const names = Object.keys(submission.tools);
    expect(names).toHaveLength(CHATGPT_ADVERTISED_TOOL_COUNT);
    expect(CHATGPT_ADVERTISED_TOOL_COUNT).toBe(184);
    expect(names).toContain("chat_whoami");
    expect(names).toContain("chat_set_status");
    for (const hidden of [
      "buy_credits",
      "settle_payment",
      "create_folder",
      "rename_folder",
      "delete_folder",
      "reorder_folders",
    ]) {
      expect(names, `${hidden} must not be publicly advertised`).not.toContain(
        hidden,
      );
    }
  });

  it("meets packaged-manifest limits and keeps support in the portal dossier", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
      interface: {
        displayName: string;
        shortDescription: string;
        defaultPrompt: string[];
        websiteURL: string;
        supportURL: string;
        privacyPolicyURL: string;
        termsOfServiceURL: string;
        composerIcon: string;
        logo: string;
      };
    };
    expect(manifest.interface.displayName.length).toBeLessThanOrEqual(30);
    expect(manifest.interface.shortDescription.length).toBeLessThanOrEqual(30);
    expect(manifest.interface.defaultPrompt.length).toBeLessThanOrEqual(3);
    for (const prompt of manifest.interface.defaultPrompt) {
      expect(prompt.length).toBeLessThanOrEqual(128);
    }
    for (const field of [
      "websiteURL",
      "supportURL",
      "privacyPolicyURL",
      "termsOfServiceURL",
    ] as const) {
      expect(new URL(manifest.interface[field]).protocol).toBe("https:");
    }
    expect(manifest.interface.supportURL).toBe("https://operate.to/plugins");
    expect(
      readFileSync(join(ROOT, "docs/plugin-submission/openai.md"), "utf8"),
    ).toContain("| Support | `https://operate.to/plugins` |");

    for (const field of ["composerIcon", "logo"] as const) {
      const asset = resolve(
        dirname(dirname(MANIFEST_PATH)),
        manifest.interface[field],
      );
      expect(existsSync(asset), `${field} must exist`).toBe(true);
      const svg = readFileSync(asset, "utf8");
      const width = svg.match(/\bwidth="([0-9]+)"/)?.[1];
      const height = svg.match(/\bheight="([0-9]+)"/)?.[1];
      expect(width, `${field} must declare width`).toBeTruthy();
      expect(width, `${field} must be square`).toBe(height);
    }
  });

  it("points OAuth discovery at www, not apex", () => {
    const readme = readFileSync(
      join(ROOT, "docs/plugin-submission/README.md"),
      "utf8",
    );
    expect(readme).toContain(
      "https://www.operate.to/.well-known/oauth-authorization-server",
    );
    expect(readme).toContain(
      "https://www.operate.to/.well-known/openid-configuration",
    );
    expect(readme).toContain("https://www.operate.to/oauth/userinfo");
    expect(readme).not.toMatch(
      /https:\/\/operate\.to\/\.well-known\//,
    );
    expect(readme).not.toMatch(/https:\/\/operate\.to\/oauth\//);

    const openai = readFileSync(
      join(ROOT, "docs/plugin-submission/openai.md"),
      "utf8",
    );
    expect(openai).toContain(
      "https://www.operate.to/.well-known/openai-apps-challenge",
    );
    expect(openai).not.toMatch(/https:\/\/operate\.to\/\.well-known\//);
    expect(openai).not.toMatch(/https:\/\/operate\.to\/oauth\//);
  });

  it("never tells a client to POST MCP to the apex host", () => {
    const yaml = readFileSync(
      join(ROOT, "plugins/operate/agents/openai.yaml"),
      "utf8",
    );
    const mcp = readFileSync(join(ROOT, "plugins/operate/.mcp.json"), "utf8");
    expect(yaml).not.toMatch(/https:\/\/operate\.to\/api\/mcp/);
    expect(yaml).toContain(
      "https://www.operate.to/api/mcp?profile=chatgpt",
    );
    expect(mcp).not.toMatch(/https:\/\/operate\.to\/api\/mcp/);
    expect(mcp).toContain("https://www.operate.to/api/mcp?profile=chatgpt");
  });

  it("publishes OAuth linking metadata on every advertised tool", () => {
    const route = readFileSync(
      join(ROOT, "src/app/api/[transport]/route.ts"),
      "utf8",
    );
    expect(route).toContain("securitySchemes: securitySchemesFor(tool.name)");
    expect(route).toContain('type: "oauth2"');
    expect(route).toContain("mcpWwwAuthenticate(req)");
    const challenge = readFileSync(
      join(ROOT, "src/lib/oauth-server.ts"),
      "utf8",
    );
    expect(challenge).toContain('scope="operate:read"');
    expect(challenge).toContain("/.well-known/oauth-protected-resource");
  });
});
