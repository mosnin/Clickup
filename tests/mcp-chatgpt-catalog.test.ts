import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CHAT_AGENT_TOOLS } from "../src/lib/buzz/agent-chat-tools";
import {
  DIRECTORY_EXCLUDED_TOOLS,
  toolAvailableForProfile,
} from "../src/lib/mcp-annotation-profile";
import {
  CHAT_TOOL_COUNT,
  CHATGPT_ADVERTISED_TOOL_COUNT,
  DIRECTORY_EXCLUDED_TOOL_COUNT,
  WORK_TOOL_COUNT,
  catalogBreakdown,
  toolsForProfile,
} from "../src/lib/mcp-catalog";
import { CORE_MCP_TOOL_NAMES } from "../src/lib/mcp-tool-names";
import {
  CHATGPT_ADVERTISED_TOOL_COUNT as SCAN_PIN,
  PRODUCTION_CHATGPT_MCP_URL,
  certifyChatgptCatalog,
  refuseApexMcpUrl,
} from "../scripts/mcp-catalog.mjs";

describe("ChatGPT directory catalog is pinned at 184", () => {
  it("is 174 work + 12 chat − 2 excluded", () => {
    expect(WORK_TOOL_COUNT).toBe(174);
    expect(CHAT_TOOL_COUNT).toBe(12);
    expect(DIRECTORY_EXCLUDED_TOOL_COUNT).toBe(2);
    expect(CHATGPT_ADVERTISED_TOOL_COUNT).toBe(184);
    expect(
      WORK_TOOL_COUNT + CHAT_TOOL_COUNT - DIRECTORY_EXCLUDED_TOOL_COUNT,
    ).toBe(184);
    expect(CORE_MCP_TOOL_NAMES).toHaveLength(WORK_TOOL_COUNT);
    expect(CHAT_AGENT_TOOLS).toHaveLength(CHAT_TOOL_COUNT);
    expect(DIRECTORY_EXCLUDED_TOOLS.size).toBe(DIRECTORY_EXCLUDED_TOOL_COUNT);
    expect([...DIRECTORY_EXCLUDED_TOOLS].sort()).toEqual([
      "buy_credits",
      "settle_payment",
    ]);
  });

  it("advertises exactly 184 tools on the chatgpt profile", () => {
    const advertised = toolsForProfile("chatgpt");
    const breakdown = catalogBreakdown();
    expect(breakdown).toEqual({
      work: 174,
      chat: 12,
      excluded: 2,
      advertised: 184,
    });
    expect(advertised).toHaveLength(CHATGPT_ADVERTISED_TOOL_COUNT);
    expect(advertised).toContain("chat_whoami");
    expect(advertised).toContain("chat_set_status");
    expect(advertised).toContain("whoami");
    expect(advertised).not.toContain("buy_credits");
    expect(advertised).not.toContain("settle_payment");
    expect(toolAvailableForProfile("buy_credits", "chatgpt")).toBe(false);
    expect(toolAvailableForProfile("buy_credits", "openai")).toBe(true);
  });

  it("keeps the source scan and the live registry on the same pin", () => {
    expect(SCAN_PIN).toBe(CHATGPT_ADVERTISED_TOOL_COUNT);
    const scanned = certifyChatgptCatalog();
    expect(scanned.work).toHaveLength(174);
    expect(scanned.chat).toHaveLength(12);
    expect(scanned.advertised).toHaveLength(184);
    expect(scanned.advertised.sort()).toEqual(toolsForProfile("chatgpt").sort());
  });

  it("refuses the apex MCP URL that 308s POSTs", () => {
    expect(PRODUCTION_CHATGPT_MCP_URL).toBe(
      "https://www.operate.to/api/mcp?profile=chatgpt",
    );
    expect(() =>
      refuseApexMcpUrl("https://operate.to/api/mcp?profile=chatgpt"),
    ).toThrow(/apex 308s/i);
    expect(refuseApexMcpUrl(PRODUCTION_CHATGPT_MCP_URL)).toBe(
      PRODUCTION_CHATGPT_MCP_URL,
    );
  });

  it("fails CI smoke without a key only when the catalog drifts — and passes at 184", () => {
    const result = spawnSync(process.execPath, ["scripts/smoke-mcp.mjs"], {
      encoding: "utf8",
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/174 work \+ 12 chat − 2 excluded = 184/);
    expect(result.stdout).toMatch(/live MCP skipped/);
  });

  it("refuses a live smoke pointed at apex even when a key is present", () => {
    const result = spawnSync(process.execPath, ["scripts/smoke-mcp.mjs"], {
      encoding: "utf8",
      env: {
        ...process.env,
        MCP_KEY: "cua_test_must_not_hit_network",
        MCP_URL: "https://operate.to/api/mcp?profile=chatgpt",
      },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/apex 308s/i);
  });
});
