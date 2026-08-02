// The Work ⇄ Chat classification.
//
// Small surface, and every case here is one where being wrong is invisible:
// a mis-classified path does not throw, it just animates the wrong way or
// animates when it should not, and nobody files that as a bug — they file it
// as "the app feels janky sometimes".

import { describe, expect, it } from "vitest";
import {
  MODE_TRANSITION_MS,
  directionFor,
  modeOf,
} from "@/lib/mode-transition";

describe("modeOf", () => {
  it("claims the Chat root and its descendants", () => {
    expect(modeOf("/chat")).toBe("chat");
    expect(modeOf("/chat/")).toBe("chat");
    expect(modeOf("/chat/c/general")).toBe("chat");
    expect(modeOf("/chat/dm/abc123")).toBe("chat");
  });

  it("treats everything else as Work, including routes that do not exist yet", () => {
    expect(modeOf("/dashboard")).toBe("work");
    expect(modeOf("/dashboard/agents")).toBe("work");
    expect(modeOf("/onboarding")).toBe("work");
    expect(modeOf("/")).toBe("work");
  });

  // The reason this is segment-exact rather than startsWith("/chat"). There is
  // no /chatter route today; the point is that adding one must not silently
  // start routing it through the Chat shell's transition.
  it("does not claim a path that merely begins with the letters", () => {
    expect(modeOf("/chatter")).toBe("work");
    expect(modeOf("/chat-export")).toBe("work");
    expect(modeOf("/chats")).toBe("work");
  });
});

describe("directionFor", () => {
  it("names the destination", () => {
    expect(directionFor("/dashboard", "/chat")).toBe("to-chat");
    expect(directionFor("/chat", "/dashboard")).toBe("to-work");
    expect(directionFor("/dashboard/agents", "/chat/c/general")).toBe("to-chat");
  });

  // The common case, and the one that matters most: every ordinary link in the
  // product must come back null so it stays on the browser's plain navigation.
  it("is null within a single dashboard", () => {
    expect(directionFor("/dashboard", "/dashboard/agents")).toBeNull();
    expect(directionFor("/chat", "/chat/c/general")).toBeNull();
    expect(directionFor("/chat/c/a", "/chat/c/b")).toBeNull();
    expect(directionFor("/dashboard", "/dashboard")).toBeNull();
  });

  it("is symmetric — the same pair reversed reverses the direction", () => {
    const pairs: [string, string][] = [
      ["/dashboard", "/chat"],
      ["/dashboard/l/abc", "/chat/dm/xyz"],
      ["/onboarding", "/chat"],
    ];
    for (const [work, chat] of pairs) {
      expect(directionFor(work, chat)).toBe("to-chat");
      expect(directionFor(chat, work)).toBe("to-work");
    }
  });
});

describe("MODE_TRANSITION_MS", () => {
  // Not a style opinion: under ~200ms a directional move does not read as
  // motion at all, and over ~500ms somebody switching back and forth is
  // waiting on the animation rather than using the product.
  it("is in the range where a directional move is legible but not slow", () => {
    expect(MODE_TRANSITION_MS).toBeGreaterThanOrEqual(200);
    expect(MODE_TRANSITION_MS).toBeLessThanOrEqual(500);
  });
});
