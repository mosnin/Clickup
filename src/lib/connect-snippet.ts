export type AgentRuntime = "claude" | "cursor" | "curl";

export function snippetFor(
  runtime: AgentRuntime,
  url: string,
  key: string,
): string {
  const shownKey = key || "<paste your agent's API key>";
  switch (runtime) {
    case "claude":
      return JSON.stringify(
        {
          mcpServers: {
            operate: {
              command: "npx",
              args: ["-y", "operate-mcp"],
              env: {
                OPERATE_MCP_URL: url,
                OPERATE_API_KEY: shownKey,
              },
            },
          },
        },
        null,
        2,
      );
    case "cursor":
      return JSON.stringify(
        {
          mcpServers: {
            operate: {
              url,
              headers: { Authorization: `Bearer ${shownKey}` },
            },
          },
        },
        null,
        2,
      );
    case "curl":
      return [
        `curl -X POST ${url} \\`,
        `  -H "Authorization: Bearer ${shownKey}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -H "Accept: application/json, text/event-stream" \\`,
        `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
      ].join("\n");
  }
}
