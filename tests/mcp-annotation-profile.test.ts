import { describe, expect, it } from "vitest";
import {
  toolAnnotationsForProfile,
  toolAvailableForProfile,
  toolDescriptionForProfile,
} from "../src/lib/mcp-annotation-profile";

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

  it("removes financial-transaction tools from both public directory profiles", () => {
    expect(toolAvailableForProfile("get_wallet", "anthropic")).toBe(true);
    expect(toolAvailableForProfile("buy_credits", "anthropic")).toBe(false);
    expect(toolAvailableForProfile("settle_payment", "anthropic")).toBe(false);
    expect(toolAvailableForProfile("get_wallet", "chatgpt")).toBe(true);
    expect(toolAvailableForProfile("buy_credits", "chatgpt")).toBe(false);
    expect(toolAvailableForProfile("settle_payment", "chatgpt")).toBe(false);
    expect(toolAvailableForProfile("settle_payment", "openai")).toBe(true);
    expect(toolAvailableForProfile("create_task", "anthropic")).toBe(true);
    expect(toolAvailableForProfile("create_task", "chatgpt")).toBe(true);
  });

  it("describes the Anthropic wallet tool as read-only billing visibility", () => {
    const description = toolDescriptionForProfile(
      "get_wallet",
      "Top up with buy_credits and settle_payment.",
      "anthropic",
    );

    expect(description).toContain("billing visibility only");
    expect(description).not.toContain("buy_credits");
    expect(description).not.toContain("settle_payment");
    expect(
      toolDescriptionForProfile("get_wallet", "Original description", "openai"),
    ).toBe("Original description");
    expect(
      toolDescriptionForProfile(
        "get_wallet",
        "Top up with buy_credits and settle_payment.",
        "chatgpt",
      ),
    ).toContain("billing visibility only");
  });
});
