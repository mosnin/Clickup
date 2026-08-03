// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Tabs, type TabItem } from "@/components/interior/tabs";

// The keyboard contract is the whole reason this component exists — the
// buttons it replaces already looked right and already changed the filter on
// click. Everything below is a behaviour those buttons did not have.
//
// No jest-dom and no user-event in this project, so: plain attribute reads and
// fireEvent. The events are dispatched at the focused tab and bubble to the
// tablist, which is where the handler lives, so this exercises the real path
// rather than calling the handler directly.

const ITEMS: TabItem[] = [
  { value: "all", label: "All" },
  { value: "on_track", label: "On track" },
  { value: "at_risk", label: "At risk" },
  { value: "paused", label: "Paused" },
];

function press(key: string) {
  fireEvent.keyDown(document.activeElement as Element, { key });
}

function Harness({
  activation = "manual",
  items = ITEMS,
  onChange,
}: {
  activation?: "manual" | "automatic";
  items?: TabItem[];
  onChange?: (v: string) => void;
}) {
  const [value, setValue] = useState("all");
  return (
    <Tabs
      items={items}
      value={value}
      onValueChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
      activation={activation}
      label="Filter projects by health"
      renderPanel={(v) => <div>panel:{v}</div>}
    />
  );
}

describe("Tabs", () => {
  it("is one tab stop, not one per tab", () => {
    render(<Harness />);
    const tabs = screen.getAllByRole("tab");
    // The roving tabindex. Four tabs, one reachable — the difference between
    // tabbing past a filter strip in one press and in four.
    expect(tabs.filter((t) => t.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(tabs[0].getAttribute("tabindex")).toBe("0");
    expect(tabs[1].getAttribute("tabindex")).toBe("-1");
  });

  it("moves with the arrows and wraps at both ends", () => {
    render(<Harness />);
    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();

    press("ArrowRight");
    expect(document.activeElement).toBe(tabs[1]);
    press("End");
    expect(document.activeElement).toBe(tabs[3]);
    // Wrapping matters more than it sounds: without it the last tab is a dead
    // end and the only way back is to reverse over everything.
    press("ArrowRight");
    expect(document.activeElement).toBe(tabs[0]);
    press("ArrowLeft");
    expect(document.activeElement).toBe(tabs[3]);
    press("Home");
    expect(document.activeElement).toBe(tabs[0]);
  });

  it("manual activation moves focus without selecting, until Enter", () => {
    const onChange = vi.fn();
    render(<Harness activation="manual" onChange={onChange} />);
    screen.getAllByRole("tab")[0].focus();

    // Three tabs' worth of arrowing on a strip whose every change is a
    // refetch. Not one query fired.
    press("ArrowRight");
    press("ArrowRight");
    press("ArrowRight");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { selected: true }).textContent).toContain("All");

    press("Enter");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("paused");
    expect(screen.getByRole("tab", { selected: true }).textContent).toContain(
      "Paused",
    );
  });

  it("automatic activation selects as focus lands", () => {
    const onChange = vi.fn();
    render(<Harness activation="automatic" onChange={onChange} />);
    screen.getAllByRole("tab")[0].focus();

    press("ArrowRight");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("on_track");
    expect(screen.getByRole("tab", { selected: true }).textContent).toContain(
      "On track",
    );
  });

  it("skips disabled tabs rather than focusing and refusing them", () => {
    render(
      <Harness
        items={[
          { value: "all", label: "All" },
          { value: "on_track", label: "On track", disabled: true },
          { value: "at_risk", label: "At risk" },
        ]}
      />,
    );
    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();
    press("ArrowRight");
    // Straight past the disabled one. Landing on it and doing nothing reads
    // as a broken strip.
    expect(document.activeElement).toBe(tabs[2]);
  });

  it("wires the panel to the tab both ways", () => {
    render(<Harness />);
    const selected = screen.getByRole("tab", { selected: true });
    const panel = screen.getByRole("tabpanel");
    expect(selected.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(selected.id);
    expect(panel.id).toBeTruthy();
  });

  it("never claims to control a panel that does not exist", () => {
    // The page-level case: the results render far down the page, so the strip
    // is given no panel at all. A dangling aria-controls is worse than none —
    // it sends a screen reader to an element that isn't there.
    render(
      <Tabs items={ITEMS} value="all" onValueChange={() => {}} label="Health" />,
    );
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.hasAttribute("aria-controls")).toBe(false);
    }
  });
});
