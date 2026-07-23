"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

// Paste-ready connection config for an agent, with the API key filled in.
// This is the moment the product's promise ("agent online in minutes") gets
// kept: pick your runtime, copy one block, done. No protocol knowledge
// required to succeed.

type Runtime = "claude" | "cursor" | "curl";

const RUNTIMES: { key: Runtime; label: string }[] = [
  { key: "claude", label: "Claude Desktop / Code" },
  { key: "cursor", label: "Cursor" },
  { key: "curl", label: "Any HTTP client" },
];

function snippetFor(runtime: Runtime, url: string, key: string): string {
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
        `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
      ].join("\n");
  }
}

const RUNTIME_HINT: Record<Runtime, string> = {
  claude:
    "Add this to your MCP settings (Claude Desktop: Settings, Developer, Edit Config). Restart, and the agent is connected.",
  cursor:
    "Add this to .cursor/mcp.json in your project. Cursor picks it up automatically.",
  curl: "Any tool that can send HTTP can drive the agent. This call lists everything it can do.",
};

export function ConnectSnippet({
  apiKey,
  className,
}: {
  /** The freshly minted key; omit to render with a placeholder. */
  apiKey?: string;
  className?: string;
}) {
  const [runtime, setRuntime] = useState<Runtime>("claude");
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState("https://operate.to/api/mcp");
  useEffect(() => {
    setUrl(`${window.location.origin}/api/mcp`);
  }, []);

  const snippet = snippetFor(runtime, url, apiKey ?? "");

  return (
    <div className={cn("space-y-2.5", className)}>
      <div className="flex items-center gap-1 text-sm">
        {RUNTIMES.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => setRuntime(r.key)}
            className={cn(
              "rounded-md px-3 py-1.5 transition-colors",
              runtime === r.key
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="relative">
        <pre className="overflow-x-auto rounded-xl bg-muted p-3.5 text-xs leading-relaxed">
          <code>{snippet}</code>
        </pre>
        <button
          type="button"
          aria-label="Copy configuration"
          onClick={async () => {
            await navigator.clipboard.writeText(snippet);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-lg bg-background/80 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-positive" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        {RUNTIME_HINT[runtime]}
      </p>
    </div>
  );
}
