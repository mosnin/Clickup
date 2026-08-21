#!/usr/bin/env node
// ChatGPT MCP catalog gate + optional live smoke.
//
// Offline (always, including CI without secrets):
//   node scripts/smoke-mcp.mjs
// Certifies the source catalog is exactly
// 174 work + 12 chat − 2 excluded = 184 advertised. A PR that drifts fails.
//
// Live (only when MCP_KEY is set):
//   MCP_KEY=cua_... node scripts/smoke-mcp.mjs
// Hits https://www.operate.to/api/mcp?profile=chatgpt — never apex.
// Apex 308s POSTs. An override MCP_URL on operate.to is refused.
//
// Custom profiles still work when both URL and key are supplied:
//   MCP_URL='https://www.operate.to/api/mcp?profile=claude' \
//     MCP_PROFILE=anthropic MCP_KEY=cua_... node scripts/smoke-mcp.mjs

import {
  CHATGPT_ADVERTISED_TOOL_COUNT,
  PRODUCTION_CHATGPT_MCP_URL,
  certifyChatgptCatalog,
  refuseApexMcpUrl,
} from "./mcp-catalog.mjs";

const key = (process.env.MCP_KEY ?? "").trim();
const profile = process.env.MCP_PROFILE ?? "chatgpt";
if (!["openai", "chatgpt", "anthropic"].includes(profile)) {
  console.error("MCP_PROFILE must be openai, chatgpt, or anthropic.");
  process.exit(1);
}

const catalog = certifyChatgptCatalog();
console.log(
  `✓ chatgpt catalog ${catalog.work.length} work + ${catalog.chat.length} chat − ${catalog.excluded.length} excluded = ${catalog.advertised.length} advertised`,
);
if (catalog.advertised.length !== CHATGPT_ADVERTISED_TOOL_COUNT) {
  throw new Error(
    `chatgpt profile tool count ${catalog.advertised.length} ≠ ${CHATGPT_ADVERTISED_TOOL_COUNT}`,
  );
}

if (!key) {
  console.log(
    "○ live MCP skipped (no MCP_KEY). Offline 184-tool assertion is mandatory and passed.",
  );
  console.log("\nAll smoke checks passed.");
  process.exit(0);
}

const url = refuseApexMcpUrl(process.env.MCP_URL ?? PRODUCTION_CHATGPT_MCP_URL);
if (url.includes("operate.to") && !url.includes("www.operate.to")) {
  throw new Error(`Refusing apex MCP URL: ${url}`);
}
console.log(`→ live ${url}`);

let nextId = 1;

async function rpc(method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  if (!res.ok) {
    throw new Error(`${method}: HTTP ${res.status} ${await res.text()}`);
  }
  const type = res.headers.get("content-type") ?? "";
  let payload;
  if (type.includes("text/event-stream")) {
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    if (!line) throw new Error(`${method}: empty SSE response`);
    payload = JSON.parse(line.slice(5));
  } else {
    payload = await res.json();
  }
  if (payload.error) {
    throw new Error(`${method}: ${JSON.stringify(payload.error)}`);
  }
  return payload.result;
}

const init = await rpc("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "smoke-test", version: "1.0.0" },
});
console.log(`✓ initialize (server: ${init.serverInfo?.name})`);

const tools = await rpc("tools/list", {});
console.log(`✓ tools/list (${tools.tools.length} tools)`);
if (profile === "chatgpt") {
  if (tools.tools.length !== CHATGPT_ADVERTISED_TOOL_COUNT) {
    throw new Error(
      `live chatgpt tools/list ${tools.tools.length} ≠ ${CHATGPT_ADVERTISED_TOOL_COUNT}`,
    );
  }
} else if (tools.tools.length < 150) {
  throw new Error(
    `expected at least 150 tools, received ${tools.tools.length}`,
  );
}
const REQUIRED = [
  "whoami",
  "next_task",
  "claim_task",
  "get_skill",
  "read_page",
  "get_wallet",
  "emit_run_event",
  "propose_screen",
  "propose_panel",
  "read_plan",
  "ask_question",
  "add_evidence",
  "decide",
];
for (const required of REQUIRED) {
  if (!tools.tools.some((t) => t.name === required)) {
    throw new Error(`missing expected tool: ${required}`);
  }
}
for (const tool of tools.tools) {
  for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"]) {
    if (typeof tool.annotations?.[hint] !== "boolean") {
      throw new Error(`${tool.name}: missing explicit ${hint}`);
    }
  }
  if (!tool.outputSchema) {
    throw new Error(`${tool.name}: missing outputSchema`);
  }
  if (
    profile === "anthropic" &&
    !tool.annotations.readOnlyHint &&
    !tool.annotations.destructiveHint
  ) {
    throw new Error(`${tool.name}: Anthropic mutations must be destructive`);
  }
}
if (
  profile !== "openai" &&
  tools.tools.some((tool) =>
    ["buy_credits", "settle_payment"].includes(tool.name),
  )
) {
  throw new Error(
    `${profile} directory profile must not expose financial-transaction tools`,
  );
}
const createTask = tools.tools.find((tool) => tool.name === "create_task");
const updateTask = tools.tools.find((tool) => tool.name === "update_task");
if (
  profile !== "anthropic" &&
  (createTask?.annotations.destructiveHint ||
    !updateTask?.annotations.destructiveHint)
) {
  throw new Error(
    "OpenAI destructive hints do not match create/update semantics",
  );
}
console.log(`✓ ${profile} annotations and output schemas`);

const whoami = await rpc("tools/call", { name: "whoami", arguments: {} });
if (whoami.isError)
  throw new Error(`whoami errored: ${JSON.stringify(whoami)}`);
const me = JSON.parse(whoami.content[0].text);
if (JSON.stringify(whoami.structuredContent?.result) !== JSON.stringify(me)) {
  throw new Error("whoami structuredContent does not match compact text");
}
console.log(`✓ whoami (${me.name} in ${me.scopeName})`);

const tree = await rpc("tools/call", { name: "get_tree", arguments: {} });
if (tree.isError) throw new Error(`get_tree errored`);
console.log(`✓ get_tree`);

const resources = await rpc("resources/list", {});
console.log(`✓ resources/list (${resources.resources.length} skills)`);

console.log("\nAll smoke checks passed.");
