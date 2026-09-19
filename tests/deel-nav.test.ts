import { describe, expect, it } from "vitest";
import {
  activeSubNavHref,
  activeTopNavId,
  isHomePath,
  showsWorkSubNav,
  WORK_SUB_NAV,
} from "../src/lib/deel-nav";

describe("activeTopNavId", () => {
  it("treats the dashboard root as Home", () => {
    expect(activeTopNavId("/dashboard")).toBe("home");
    expect(activeTopNavId("/dashboard/")).toBe("home");
  });

  it("pins nested work URLs to Work, not Home", () => {
    expect(activeTopNavId("/dashboard/spaces")).toBe("work");
    expect(activeTopNavId("/dashboard/l/list1")).toBe("work");
    expect(activeTopNavId("/dashboard/l/list1/t/task1")).toBe("work");
    expect(activeTopNavId("/dashboard/p/proj1")).toBe("work");
    expect(activeTopNavId("/dashboard/s/space1")).toBe("work");
    expect(activeTopNavId("/dashboard/w/ws1")).toBe("work");
    expect(activeTopNavId("/dashboard/pages/page1")).toBe("work");
  });

  it("keeps Inbox and Agents as their own pills", () => {
    expect(activeTopNavId("/dashboard/inbox")).toBe("inbox");
    expect(activeTopNavId("/dashboard/inbox/x")).toBe("inbox");
    expect(activeTopNavId("/dashboard/agents")).toBe("agents");
    expect(activeTopNavId("/dashboard/agents/a1")).toBe("agents");
  });

  it("is segment-exact for Chat", () => {
    expect(activeTopNavId("/chat")).toBe("chat");
    expect(activeTopNavId("/chat/c/room")).toBe("chat");
    expect(activeTopNavId("/chatter")).toBeNull();
  });

  it("puts appearance, search and admin under More", () => {
    expect(activeTopNavId("/dashboard/appearance")).toBe("more");
    expect(activeTopNavId("/dashboard/search")).toBe("more");
    expect(activeTopNavId("/dashboard/admin")).toBe("more");
  });
});

describe("home vs work chrome", () => {
  it("Home is the only path with no left rail and no subnav", () => {
    expect(isHomePath("/dashboard")).toBe(true);
    expect(isHomePath("/dashboard/spaces")).toBe(false);
    expect(showsWorkSubNav("/dashboard")).toBe(false);
    expect(showsWorkSubNav("/dashboard/spaces")).toBe(true);
    expect(showsWorkSubNav("/dashboard/l/x")).toBe(true);
  });

  it("highlights the matching work sub-item", () => {
    expect(activeSubNavHref("/dashboard/spaces", WORK_SUB_NAV)).toBe(
      "/dashboard/spaces",
    );
    expect(activeSubNavHref("/dashboard/pages/abc", WORK_SUB_NAV)).toBe(
      "/dashboard/pages",
    );
    expect(activeSubNavHref("/dashboard/l/x", WORK_SUB_NAV)).toBeNull();
  });
});
