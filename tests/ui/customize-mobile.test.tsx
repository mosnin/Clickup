// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  CustomizeProvider,
  useCustomize,
} from "@/components/appearance/customize-provider";

// Customise mode on a phone.
//
// Reported as three symptoms with two causes: entering the mode from the nav
// left you staring at the nav (the drawer is full-screen, and the mode's whole
// premise is editing the canvas in place), and dismissing that drawer dropped
// the mode, because the scrim under your finger is not a dialog and the
// background handler could not tell it from the canvas.

function Probe() {
  const { active, setActive } = useCustomize();
  return (
    <div>
      <button type="button" onClick={() => setActive(true)}>
        enter
      </button>
      <span data-testid="state">{active ? "on" : "off"}</span>
      <div data-testid="canvas">canvas</div>
      {/* Radix renders the scrim as a sibling of the sheet, not inside it —
          which is exactly why `[role=dialog]` never covered this case. */}
      <div data-slot="sheet-overlay" data-testid="scrim" />
      <div data-slot="sheet-content" role="dialog" data-testid="drawer">
        <button type="button">a nav link</button>
      </div>
    </div>
  );
}

function setup() {
  render(
    <CustomizeProvider>
      <Probe />
    </CustomizeProvider>,
  );
  fireEvent.click(screen.getByText("enter"));
  expect(screen.getByTestId("state").textContent).toBe("on");
}

const down = (el: Element) =>
  fireEvent(el, new MouseEvent("pointerdown", { bubbles: true }));

describe("customise mode and the mobile drawer", () => {
  it("survives dismissing the nav drawer by its scrim", () => {
    setup();
    down(screen.getByTestId("scrim"));
    // The drawer closing is one action. The mode ending is another, and it was
    // not asked for.
    expect(screen.getByTestId("state").textContent).toBe("on");
  });

  it("survives a tap inside the drawer itself", () => {
    setup();
    down(screen.getByText("a nav link"));
    expect(screen.getByTestId("state").textContent).toBe("on");
  });

  it("still leaves when the canvas itself is tapped", () => {
    setup();
    // The behaviour the scrim fix must not cost: tapping your own work with
    // nothing selected is still the way out, which is the only general exit a
    // phone has (there is no Escape).
    down(screen.getByTestId("canvas"));
    expect(screen.getByTestId("state").textContent).toBe("off");
  });
});

describe("entering the mode from the mobile nav", () => {
  // The drawer close cannot be exercised here without mounting the whole
  // dashboard sidebar (Convex, Clerk, router). What CAN be checked, and what
  // the bug actually was, is that the handler asks about `isMobile` and closes
  // the drawer at all — the previous version simply did not mention it.
  // A plain path, not `new URL(..., import.meta.url)`: under the jsdom
  // environment import.meta.url is an http URL and readFileSync refuses it.
  const source = readFileSync("src/components/dashboard/sidebar.tsx", "utf8");
  const handler = source.slice(
    source.indexOf("function AppearanceMenuItem"),
    source.indexOf("function AdminMenuItem"),
  );

  it("closes the drawer so the canvas it edits is visible", () => {
    expect(handler).toContain("setOpenMobile(false)");
    expect(handler).toContain("isMobile");
  });

  it("closes it on the way in, not on the way out", () => {
    // Leaving the mode from inside the drawer is an ordinary menu action;
    // closing the nav under somebody still using it would be its own bug.
    expect(handler).toMatch(/if \(next && isMobile\) setOpenMobile\(false\)/);
  });
});
