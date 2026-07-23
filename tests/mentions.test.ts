import { describe, expect, it } from "vitest";
import {
  extractMentionedClerkIds,
  formatMentionToken,
  parseMentionBody,
} from "../src/lib/mentions";

describe("mention tokens", () => {
  it("round-trips format → parse", () => {
    const token = formatMentionToken("Scout", "agent_123");
    const parts = parseMentionBody(`hey ${token}, look at this`);
    expect(parts).toEqual([
      { kind: "text", text: "hey " },
      { kind: "mention", name: "Scout", clerkId: "agent_123" },
      { kind: "text", text: ", look at this" },
    ]);
  });

  it("extracts every mentioned id", () => {
    const body = `${formatMentionToken("A", "id_a")} and ${formatMentionToken("B", "id_b")}`;
    expect(extractMentionedClerkIds(body).sort()).toEqual(["id_a", "id_b"]);
  });

  it("leaves plain text untouched", () => {
    expect(parseMentionBody("no mentions here")).toEqual([
      { kind: "text", text: "no mentions here" },
    ]);
  });
});
