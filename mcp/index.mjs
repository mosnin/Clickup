#!/usr/bin/env node
// stdio ↔ Streamable-HTTP proxy for the hosted MCP server at /api/mcp.
//
// For MCP clients that only speak stdio. Clients that support remote
// servers should connect straight to the URL instead.
//
// Usage (e.g. in an MCP client config):
//   command: "npx"
//   args: ["clickup-clone-mcp"]           (or "node mcp/index.mjs")
//   env:
//     CLICKUP_CLONE_MCP_URL: "https://<your-app>/api/mcp"
//     CLICKUP_CLONE_API_KEY: "cua_..."
//
// Flags --url and --key override the environment variables.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const url = argValue("--url") ?? process.env.CLICKUP_CLONE_MCP_URL;
const apiKey = argValue("--key") ?? process.env.CLICKUP_CLONE_API_KEY;

if (!url || !apiKey) {
  console.error(
    "Set CLICKUP_CLONE_MCP_URL and CLICKUP_CLONE_API_KEY (or pass --url/--key).",
  );
  process.exit(1);
}

const upstream = new Client({ name: "clickup-clone-mcp-proxy", version: "1.0.0" });
await upstream.connect(
  new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  }),
);

const server = new Server(
  { name: "clickup-clone-agents", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () =>
  upstream.listTools(),
);
server.setRequestHandler(CallToolRequestSchema, async (req) =>
  upstream.callTool(req.params),
);

await server.connect(new StdioServerTransport());
