#!/usr/bin/env node
// stdio ↔ Streamable-HTTP proxy for the hosted MCP server at /api/mcp.
// Forwards tools (tools/list, tools/call) and resources (resources/list,
// resources/templates/list, resources/read — the skill:// playbooks).
//
// NOT PUBLISHED TO NPM. This is a local development tool, run from a
// checkout. `npx operate-mcp` does not work and never did — that name was
// documented before the package existed, which sent everyone who followed
// the instructions to an npm 404. If you need a stdio bridge and do not
// have this repo, use the published `mcp-remote` instead:
//
//   command: "npx"
//   args: ["-y", "mcp-remote", "https://<your-app>/api/mcp",
//          "--header", "Authorization: Bearer cua_..."]
//
// Clients that speak Streamable HTTP should skip the bridge entirely and
// point at the URL with an Authorization header.
//
// Usage from a checkout:
//   command: "node"
//   args: ["mcp/index.mjs"]
//   env:
//     OPERATE_MCP_URL: "https://<your-app>/api/mcp"
//     OPERATE_API_KEY: "cua_..."
//
// Flags --url and --key override the environment variables.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const url = argValue("--url") ?? process.env.OPERATE_MCP_URL;
const apiKey = argValue("--key") ?? process.env.OPERATE_API_KEY;

if (!url || !apiKey) {
  console.error(
    "Set OPERATE_MCP_URL and OPERATE_API_KEY (or pass --url/--key).",
  );
  process.exit(1);
}

const upstream = new Client({ name: "operate-mcp-stdio-proxy", version: "1.0.0" });
await upstream.connect(
  new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  }),
);

const server = new Server(
  { name: "operate-agents", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () =>
  upstream.listTools(),
);
server.setRequestHandler(CallToolRequestSchema, async (req) =>
  upstream.callTool(req.params),
);
server.setRequestHandler(ListResourcesRequestSchema, async (req) =>
  upstream.listResources(req.params),
);
server.setRequestHandler(ListResourceTemplatesRequestSchema, async (req) =>
  upstream.listResourceTemplates(req.params),
);
server.setRequestHandler(ReadResourceRequestSchema, async (req) =>
  upstream.readResource(req.params),
);

await server.connect(new StdioServerTransport());
