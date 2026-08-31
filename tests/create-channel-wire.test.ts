import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import {
  createChannelError,
  normalizeCreateChannelType,
  normalizeCreateVisibility,
  toCreateChannelArgs,
  wireChannelType,
  wireVisibility,
  type CreateChannelForm,
} from "@/lib/buzz/create-channel";

// The create form speaks `public` / `channel`. The store speaks `open` /
// `stream`. This file is what keeps a second copy of that translation from
// growing in a dialog and silently sending the word the validator refuses.

const SCOPE = { scopeType: "workspace" as const, scopeId: "ws1" };

function form(over: Partial<CreateChannelForm> = {}): CreateChannelForm {
  return {
    name: "release-notes",
    kind: "channel",
    visibility: "public",
    ...over,
  };
}

describe("toCreateChannelArgs", () => {
  it("cannot send visibility public or a kind field — those are the two words the validator refuses", () => {
    const wire = toCreateChannelArgs(SCOPE, form());
    expect(wire.visibility).toBe("open");
    expect(wire.channelType).toBe("stream");
    expect(wire).not.toHaveProperty("kind");
    expect(JSON.stringify(wire)).not.toContain("public");
    expect(JSON.stringify(wire)).not.toContain('"kind"');
  });

  it("carries the scope — a create with no community is the other validator refusal", () => {
    const wire = toCreateChannelArgs(SCOPE, form({ visibility: "private", kind: "forum" }));
    expect(wire).toMatchObject({
      scopeType: "workspace",
      scopeId: "ws1",
      name: "release-notes",
      visibility: "private",
      channelType: "forum",
    });
  });

  it("omits empty optional fields rather than sending undefined kind-shaped leftovers", () => {
    const wire = toCreateChannelArgs(SCOPE, form());
    expect(wire).not.toHaveProperty("description");
    expect(wire).not.toHaveProperty("ttlSeconds");
    expect(wire).not.toHaveProperty("templateId");
  });
});

describe("the aliases a leftover client might still send", () => {
  it("stores public as open and ignores any other word", () => {
    expect(normalizeCreateVisibility("public")).toBe("open");
    expect(normalizeCreateVisibility("open")).toBe("open");
    expect(normalizeCreateVisibility("private")).toBe("private");
    expect(normalizeCreateVisibility("secret")).toBeUndefined();
    expect(wireVisibility("public")).toBe("open");
    expect(wireVisibility("open")).toBe("open");
  });

  it("stores kind channel as stream", () => {
    expect(normalizeCreateChannelType(undefined, "channel")).toBe("stream");
    expect(normalizeCreateChannelType("forum")).toBe("forum");
    expect(normalizeCreateChannelType("secret")).toBeUndefined();
    expect(wireChannelType("channel")).toBe("stream");
  });
});

describe("createChannelError", () => {
  it("maps a validator refusal to a next action, never the dump", () => {
    expect(
      createChannelError(
        new Error("ArgumentValidationError: Value does not match validator"),
      ),
    ).toMatch(/refresh/i);
    expect(
      createChannelError(new Error("Uncaught Error: Value does not match validator")),
    ).not.toMatch(/ArgumentValidation|Uncaught|validator/i);
  });

  it("maps a missing table or index to refresh, not a schema sentence", () => {
    expect(
      createChannelError(new Error("Table buzzChannels does not exist")),
    ).toMatch(/still updating/i);
    expect(
      createChannelError(new Error("Index by_scope_name not found")),
    ).toMatch(/still updating/i);
  });

  it("maps a missing pubkey to try-again, not open Chat first", () => {
    const msg = createChannelError(
      new ConvexError("Ada has not opened Chat yet, so they have no signing identity"),
    );
    expect(msg).toMatch(/setting up your chat identity/i);
    expect(msg).not.toMatch(/opened chat first|open chat first/i);
  });

  it("maps a scope refusal to a permission sentence", () => {
    expect(createChannelError(new ConvexError("Forbidden"))).toMatch(/don't have access/i);
  });

  it("keeps a name clash — that one already says what to do", () => {
    expect(createChannelError(new ConvexError("#ops already exists in this community"))).toMatch(
      /#ops already exists/,
    );
  });

  it("never surfaces Server Error", () => {
    expect(createChannelError(new Error("Server Error"))).toBe(
      "Couldn't create the channel. Try again.",
    );
  });
});
