import { describe, expect, it } from "vitest";
import {
  DEFAULT_NAV_ORDER,
  NAV_ITEMS,
  navLayoutFor,
  navPrefFrom,
  resolveNav,
  type NavItemId,
} from "../src/lib/nav-items";

const ids = (items: ReturnType<typeof resolveNav>) => items.map((i) => i.id);

describe("the shipped default", () => {
  it("shows everything, so nothing is invisible before anyone curates", () => {
    expect(ids(resolveNav(null, null))).toEqual(
      DEFAULT_NAV_ORDER.filter((id) => !NAV_ITEMS.find((i) => i.id === id)?.dockOnly),
    );
  });

  it("keeps the dock's own destinations out of the sidebar", () => {
    // Search is a row the sidebar already has its own version of.
    expect(ids(resolveNav(null, null))).not.toContain("search");
    expect(ids(resolveNav(null, null, { surface: "dock" }))).toContain("search");
  });
});

describe("a person's own arrangement", () => {
  it("wins over the workspace's", () => {
    const workspace = { order: ["home", "chat"] as NavItemId[], hidden: [] };
    const personal = { order: ["home", "agents"] as NavItemId[], hidden: [] };
    expect(ids(resolveNav(personal, workspace)).slice(0, 2)).toEqual([
      "home",
      "agents",
    ]);
  });

  it("hides what they put away", () => {
    const personal = {
      order: DEFAULT_NAV_ORDER,
      hidden: ["templates", "pages"] as NavItemId[],
    };
    const out = ids(resolveNav(personal, null));
    expect(out).not.toContain("templates");
    expect(out).not.toContain("pages");
    expect(out).toContain("agents");
  });

  it("orders by their arrangement, not the shipped one", () => {
    const personal = {
      order: ["agents", "home", "inbox"] as NavItemId[],
      hidden: [],
    };
    expect(ids(resolveNav(personal, null)).slice(0, 3)).toEqual([
      "agents",
      "home",
      "inbox",
    ]);
  });
});

describe("a workspace default", () => {
  it("curates what somebody starts with", () => {
    const workspace = {
      order: ["home", "my-work", "chat"] as NavItemId[],
      hidden: ["templates", "pages", "spaces"] as NavItemId[],
    };
    const out = ids(resolveNav(null, workspace));
    expect(out.slice(0, 3)).toEqual(["home", "my-work", "chat"]);
    expect(out).not.toContain("templates");
  });

  it("is a starting point, not a prohibition", () => {
    // An admin omitting something means "most of us don't need this", not
    // "you may not have it". Governance lives in the Convex functions, never
    // in whether a link is drawn.
    const workspace = { order: ["home", "chat"] as NavItemId[], hidden: [] };
    expect(ids(resolveNav(null, workspace))).toContain("agents");
  });
});

describe("the two properties that stop this becoming a trap", () => {
  it("never loses a required destination, however hostile the input", () => {
    for (const pref of [
      { order: [] as NavItemId[], hidden: [] as NavItemId[] },
      { order: ["agents"] as NavItemId[], hidden: ["home"] as NavItemId[] },
      { order: ["home"] as NavItemId[], hidden: DEFAULT_NAV_ORDER },
    ]) {
      // A nav you cannot navigate out of is a trap. Required items come back
      // rather than the whole arrangement being rejected — throwing away
      // somebody's deliberate ordering over one mistake is the worse failure.
      expect(ids(resolveNav(pref, null))).toContain("home");
    }
  });

  it("surfaces a destination nobody has ruled on", () => {
    // Somebody who arranged their nav before Agents shipped must still get
    // Agents. Hiding is a decision, never a side effect of having customised
    // early.
    const personal = { order: ["home", "inbox"] as NavItemId[], hidden: [] };
    expect(ids(resolveNav(personal, null))).toContain("agents");
  });

  it("does not resurrect something they explicitly put away", () => {
    const personal = {
      order: ["home", "inbox"] as NavItemId[],
      hidden: ["agents"] as NavItemId[],
    };
    expect(ids(resolveNav(personal, null))).not.toContain("agents");
  });
});

describe("reading a stored row", () => {
  it("survives every shape a layout row can hold", () => {
    expect(navPrefFrom(null)).toBeNull();
    expect(navPrefFrom({})).toBeNull();
    expect(navPrefFrom({ widgets: [] })).toBeNull();
    // Ids this build renamed away must fall through to the layer beneath
    // rather than produce an empty nav.
    expect(navPrefFrom({ widgets: [{ id: "gone" }, { id: "also-gone" }] })).toBeNull();
    expect(navPrefFrom({ widgets: [{ id: "home" }, { id: "nope" }] })).toEqual({
      order: ["home"],
      hidden: [],
    });
    // A bare array, and duplicates collapsed.
    expect(navPrefFrom(["home", "home", "chat"])).toEqual({
      order: ["home", "chat"],
      hidden: [],
    });
    expect(
      navPrefFrom({ widgets: [{ id: "home" }], hidden: ["pages", "bogus"] }),
    ).toEqual({ order: ["home"], hidden: ["pages"] });
  });

  it("round-trips through the stored shape", () => {
    const pref = {
      order: ["agents", "home"] as NavItemId[],
      hidden: ["templates"] as NavItemId[],
    };
    expect(navPrefFrom(navLayoutFor(pref))).toEqual(pref);
  });
});

describe("the registry", () => {
  it("has unique ids and a route for each", () => {
    expect(new Set(DEFAULT_NAV_ORDER).size).toBe(NAV_ITEMS.length);
    for (const item of NAV_ITEMS) {
      expect(item.href.startsWith("/dashboard")).toBe(true);
      expect(item.label.length).toBeGreaterThan(0);
    }
  });

  it("marks exactly one destination required", () => {
    // More than one and "you can always get back" stops being a single,
    // checkable promise.
    expect(NAV_ITEMS.filter((i) => i.required).map((i) => i.id)).toEqual(["home"]);
  });
});
