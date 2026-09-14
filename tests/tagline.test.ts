import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SITE_TAGLINE } from "../src/lib/marketing-nav";

// One positioning. A stranger who reads the tab title, the hero, the
// sign-in panel, and the footer must hear the same sentence.

const SENTENCE = "Agents that finish what they start.";

describe("one tagline", () => {
  it("is the shared marketing constant", () => {
    expect(SITE_TAGLINE).toBe(SENTENCE);
  });

  it("is the root metadata default", () => {
    const src = readFileSync(
      resolve(__dirname, "../src/app/layout.tsx"),
      "utf8",
    );
    expect(src).toContain(SENTENCE);
    expect(src).not.toMatch(/recruit, direct and scale/i);
  });

  it("is the sign-in promise", () => {
    const src = readFileSync(
      resolve(__dirname, "../src/app/(auth)/layout.tsx"),
      "utf8",
    );
    expect(src).toContain("SITE_TAGLINE");
    expect(src).not.toMatch(/operating system for AI agent workforces/i);
  });
});
