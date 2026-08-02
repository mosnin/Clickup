import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { navState } from "./harness";
import { ModeSwitcher } from "@/components/chat/mode-switcher";

// The switch between the two dashboards. Small, but it is the only way in and
// out of Chat, so "does it point at the right place, and does it know where you
// are" is worth asserting rather than eyeballing once.

describe("the Work ⇄ Chat switcher", () => {
  beforeEach(() => {
    navState.pathname = "/dashboard";
  });

  it("offers both dashboards as links, so back/middle-click/new-tab work", () => {
    // Deliberately links rather than buttons calling router.push(): a button
    // silently breaks the browser's own navigation affordances.
    render(<ModeSwitcher />);
    expect(
      screen.getByRole("link", { name: /work/i }).getAttribute("href"),
    ).toBe("/dashboard");
    expect(
      screen.getByRole("link", { name: /chat/i }).getAttribute("href"),
    ).toBe("/chat");
  });

  it("marks Work current when you are anywhere in the Work dashboard", () => {
    navState.pathname = "/dashboard/l/abc123";
    render(<ModeSwitcher />);
    expect(
      screen.getByRole("link", { name: /work/i }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen.getByRole("link", { name: /chat/i }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("marks Chat current when you are anywhere in the Chat dashboard", () => {
    navState.pathname = "/chat/c/general";
    render(<ModeSwitcher />);
    expect(
      screen.getByRole("link", { name: /^chat$/i }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it("does not mistake the Work dashboard's own chat page for Chat mode", () => {
    // /dashboard/chat is a Work surface that happens to be about messages.
    // A `pathname.includes("chat")` test would put the switcher in the wrong
    // mode there, which is exactly the kind of thing nobody notices until the
    // sidebar starts lying about which application you are in.
    navState.pathname = "/dashboard/chat";
    render(<ModeSwitcher />);
    expect(
      screen.getByRole("link", { name: /work/i }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it("collapses to a single link naming where it goes", () => {
    // In the icon rail there is no room for two labelled halves, so the
    // control becomes "switch to the other one" — and it still says which one,
    // because an unlabelled glyph that changes your whole application is a
    // guess.
    navState.pathname = "/dashboard";
    render(<ModeSwitcher collapsible />);
    const rail = screen.getByRole("link", { name: "Switch to Chat" });
    expect(rail.getAttribute("href")).toBe("/chat");
  });

  it("points the collapsed link back at Work from inside Chat", () => {
    navState.pathname = "/chat";
    render(<ModeSwitcher collapsible />);
    expect(
      screen.getByRole("link", { name: "Switch to Work" }).getAttribute("href"),
    ).toBe("/dashboard");
  });
});
