import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PERSONAL_KEYS, resolveTokens, DEFAULT_APPEARANCE } from "../src/lib/appearance";

// The Chat dashboard re-skins itself with one attribute-scoped block at the end
// of globals.css. That is a cheap and reversible way to give a route subtree a
// different look — and it is exactly the mechanism by which a room could
// silently overrule a person.
//
// AppearanceProvider writes the personal accessibility settings as inline
// styles on :root. An inline style beats a stylesheet rule for the same
// property — but only if the stylesheet does not declare that property on a
// selector the element also matches. `:root[data-app="chat"]` matches :root.
// So a single line in the Chat block redeclaring --ui-font-scale would quietly
// undo someone's type size the moment they opened Chat, in a way no reviewer
// would spot and no visual test would catch.
//
// Hence a test on the stylesheet text itself.

const CSS = readFileSync(join(__dirname, "..", "src", "app", "globals.css"), "utf8");

/** Every `…[data-app="chat"]… { … }` block body in globals.css. */
function chatBlocks(): string[] {
  const blocks: string[] = [];
  const re = /([^}]*\[data-app="chat"\][^{]*)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(CSS)) !== null) blocks.push(match[2]);
  return blocks;
}

/** The CSS custom properties a block declares. */
function declaredVars(block: string): string[] {
  return [...block.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]);
}

describe("the Chat theme block", () => {
  it("exists and is scoped to the document root", () => {
    const blocks = chatBlocks();
    expect(blocks.length).toBeGreaterThan(0);
    // On :root, not a wrapper — portalled toasts and menus must be themed too.
    expect(CSS).toContain(':root[data-app="chat"]');
  });

  it("never redeclares a personal accessibility token", () => {
    // The tokens the personal keys resolve to. Derived from the resolver rather
    // than hand-listed, so a NEW personal setting is protected the day it is
    // added instead of the day somebody remembers this test.
    const defaults = resolveTokens(DEFAULT_APPEARANCE);
    const personalTokens = new Set<string>();
    for (const key of PERSONAL_KEYS) {
      const shifted = resolveTokens({
        ...DEFAULT_APPEARANCE,
        ...perturb(key),
      });
      for (const [token, value] of Object.entries(shifted)) {
        if (defaults[token] !== value) personalTokens.add(token);
      }
    }
    // Sanity: the perturbations must actually move something, or this test
    // passes by measuring nothing.
    expect(personalTokens.size).toBeGreaterThan(0);

    for (const block of chatBlocks()) {
      for (const declared of declaredVars(block)) {
        expect(
          personalTokens.has(declared),
          `globals.css's Chat block declares ${declared}, which is a personal ` +
            `accessibility token. A room must not overrule how a person reads.`,
        ).toBe(false);
      }
    }
  });

  it("does change something, so the scoping mechanism is real", () => {
    const declared = chatBlocks().flatMap(declaredVars);
    expect(declared.length).toBeGreaterThan(0);
  });
});

/** A value different from the default for one personal key. */
function perturb(key: (typeof PERSONAL_KEYS)[number]): Record<string, unknown> {
  switch (key) {
    case "fontScale":
      return { fontScale: 1.3 };
    case "motionScale":
      return { motionScale: 0 };
    case "density":
      return { density: "compact" };
    case "sidebarWidth":
      return { sidebarWidth: 320 };
    case "sidebarPosition":
      return { sidebarPosition: "right" };
    case "headingWeight":
      return { headingWeight: 800 };
    case "fontFamily":
      return { fontFamily: "system" };
    case "contrast":
      return { contrast: "high" };
    default: {
      // A new personal key with no perturbation here would silently contribute
      // nothing, so fail loudly instead.
      const exhaustive: never = key;
      throw new Error(`add a perturbation for the personal key ${exhaustive}`);
    }
  }
}
