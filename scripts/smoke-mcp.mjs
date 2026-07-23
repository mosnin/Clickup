#!/usr/bin/env node
// End-to-end smoke test for the hosted MCP endpoint. Run against a real
// deployment (needs a live Convex backend, so it can't run in CI without
// one):
//
//   MCP_URL=https://<your-app>/api/mcp MCP_KEY=cua_... node scripts/smoke-mcp.mjs
//
// Exercises: initialize → tools/list → whoami → get_tree → resources/list.
// Exits non-zero on the first failure.

const url = process.env.MCP_URL;
const key = process.env.MCP_KEY;
if (!url || !key) {
  console.error("Set MCP_URL and MCP_KEY.");
  process.exit(1);
}

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
    // Take the first data: line of the SSE stream.
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
for (const required of ["whoami", "next_task", "claim_task", "get_skill"]) {
  if (!tools.tools.some((t) => t.name === required)) {
    throw new Error(`missing expected tool: ${required}`);
  }
}

const whoami = await rpc("tools/call", { name: "whoami", arguments: {} });
if (whoami.isError) throw new Error(`whoami errored: ${JSON.stringify(whoami)}`);
const me = JSON.parse(whoami.content[0].text);
console.log(`✓ whoami (${me.name} in ${me.scopeName})`);

const tree = await rpc("tools/call", { name: "get_tree", arguments: {} });
if (tree.isError) throw new Error(`get_tree errored`);
console.log(`✓ get_tree`);

const resources = await rpc("resources/list", {});
console.log(`✓ resources/list (${resources.resources.length} skills)`);

console.log("\nAll smoke checks passed.");
