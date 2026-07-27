export type AgentRuntime = "claude" | "cursor" | "curl";

export function snippetFor(
  runtime: AgentRuntime,
  url: string,
  key: string,
): string {
  const shownKey = key || "<paste your agent's API key>";
  switch (runtime) {
    case "claude":
      // mcp-remote, not our own proxy package. `npx -y operate-mcp` used to
      // be here and is a straight 404 on npm — the package in mcp/ has never
      // been published, so everyone who followed this block failed before
      // reaching us. mcp-remote is a published, maintained stdio<->HTTP
      // bridge that does the same job, so the instructions work today rather
      // than after a release. If you ever do publish mcp/, this is the one
      // place to change; nothing else names a bridge.
      return JSON.stringify(
        {
          mcpServers: {
            operate: {
              command: "npx",
              args: [
                "-y",
                "mcp-remote",
                url,
                "--header",
                `Authorization: Bearer ${shownKey}`,
              ],
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
