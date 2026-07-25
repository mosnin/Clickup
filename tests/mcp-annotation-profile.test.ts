import { describe, expect, it } from "vitest";
import { toolAnnotationsForProfile } from "../src/lib/mcp-annotation-profile";

const createFacts = {
  title: "Create task",
  readOnly: false,
  destructive: false,
  openWorld: false,
  idempotent: false,
};

describe("MCP platform annotation profiles", () => {
  it("keeps harmless private creates non-destructive for OpenAI", () => {
    expect(toolAnnotationsForProfile(createFacts, "openai")).toEqual({
      title: "Create task",
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    });
  });

  it("marks every mutation destructive for Anthropic directory review", () => {
    expect(toolAnnotationsForProfile(createFacts, "anthropic")).toEqual({
      title: "Create task",
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: true,
    });
  });

  it("preserves explicit read, external-side-effect, and retry hints", () => {
    const annotations = toolAnnotationsForProfile(
      {
        title: "List tasks",
        readOnly: true,
        destructive: false,
        openWorld: true,
        idempotent: true,
      },
      "anthropic",
    );
    expect(annotations).toEqual({
      title: "List tasks",
      readOnlyHint: true,
      openWorldHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
  });
});
