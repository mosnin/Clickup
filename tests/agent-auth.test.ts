import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../convex/_agentAuth";

// The pure-JS SHA-256 in _agentAuth.ts must match Node's crypto exactly —
// keys are minted (hashed) with Node crypto in agentKeys.ts and verified
// with this implementation in the default Convex runtime.
describe("sha256Hex", () => {
  const KNOWN: [string, string][] = [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ];

  it("matches known NIST vectors", () => {
    for (const [input, expected] of KNOWN) {
      expect(sha256Hex(input)).toBe(expected);
    }
  });

  it("matches node:crypto across block boundaries and unicode", () => {
    const inputs = [
      "cua_0123456789abcdef0123456789abcdef01234567",
      "x".repeat(55), // 1 block, max single-block payload
      "x".repeat(56), // forces a second block
      "x".repeat(64),
      "x".repeat(1000),
      "emoji 🤖 and ünïcode ✓",
    ];
    for (const input of inputs) {
      const ref = createHash("sha256").update(input).digest("hex");
      expect(sha256Hex(input)).toBe(ref);
    }
  });
});
