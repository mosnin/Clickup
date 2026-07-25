import { describe, expect, it } from "vitest";
import { snippetFor } from "../src/lib/connect-snippet";

describe("ConnectSnippet", () => {
  it("includes the Streamable HTTP accept types in the curl example", () => {
    const snippet = snippetFor(
      "curl",
      "https://www.operate.to/api/mcp",
      "cua_test",
    );

    expect(snippet).toContain(
      '-H "Accept: application/json, text/event-stream"',
    );
    expect(snippet).toContain(
      `-d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    );
  });
});
