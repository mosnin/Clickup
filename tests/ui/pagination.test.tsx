// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  Pagination,
  pageRange,
  type PageSlot,
} from "@/components/interior/pagination";

// `pageRange` is where every pager goes wrong, so it gets tested as the pure
// function it is. The component tests below only cover what rendering adds.

const width = (slots: PageSlot[]) => slots.length;

describe("pageRange", () => {
  it("shows every page when they all fit", () => {
    expect(pageRange(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageRange(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps the first and last page reachable from anywhere", () => {
    for (const page of [1, 2, 10, 19, 20]) {
      const slots = pageRange(page, 20);
      expect(slots[0]).toBe(1);
      expect(slots[slots.length - 1]).toBe(20);
    }
  });

  it("never changes width as you walk it", () => {
    // The property that matters and the one that is always broken: if the
    // strip grows by a slot between page 1 and page 2, every button shifts
    // sideways under the pointer that just clicked one.
    const widths = new Set<number>();
    for (let page = 1; page <= 20; page++) {
      widths.add(width(pageRange(page, 20)));
    }
    expect(widths.size).toBe(1);
  });

  it("only spends a gap where it hides more than one page", () => {
    // "1 … 3" is wider than "1 2 3" and says less, so at the ends the run is
    // drawn out rather than elided.
    expect(pageRange(1, 20)).toEqual([1, 2, 3, 4, 5, "gap", 20]);
    expect(pageRange(20, 20)).toEqual([1, "gap", 16, 17, 18, 19, 20]);
    expect(pageRange(10, 20)).toEqual([1, "gap", 9, 10, 11, "gap", 20]);
  });

  it("always contains the current page", () => {
    for (let page = 1; page <= 40; page++) {
      expect(pageRange(page, 40)).toContain(page);
    }
  });

  it("survives nonsense rather than rendering nonsense", () => {
    expect(pageRange(0, 0)).toEqual([]);
    expect(pageRange(-5, 0)).toEqual([]);
    // Out-of-range pages clamp instead of producing negative page numbers,
    // because ?page=999 in a shared URL is a normal thing to receive.
    expect(pageRange(999, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageRange(-3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageRange(2.7, 5)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("Pagination", () => {
  it("is absent when there is nothing to page", () => {
    const { container } = render(
      <Pagination count={1} page={1} label="Projects" onPageChange={() => {}} />,
    );
    // A disabled pager under every short list is furniture that claims there
    // could be more when there could not.
    expect(container.firstChild).toBeNull();
  });

  it("marks the current page and moves on click", () => {
    const onPageChange = vi.fn();
    render(
      <Pagination
        count={10}
        page={3}
        label="Projects"
        onPageChange={onPageChange}
      />,
    );
    expect(
      screen.getByRole("button", { current: "page" }).textContent,
    ).toBe("3");

    fireEvent.click(screen.getByLabelText("Page 4"));
    expect(onPageChange).toHaveBeenCalledWith(4);
  });

  it("does not fire for the page you are already on", () => {
    const onPageChange = vi.fn();
    render(
      <Pagination
        count={10}
        page={3}
        label="Projects"
        onPageChange={onPageChange}
      />,
    );
    fireEvent.click(screen.getByLabelText("Page 3"));
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it("cannot step past either end", () => {
    const onPageChange = vi.fn();
    const { rerender } = render(
      <Pagination
        count={4}
        page={1}
        label="Projects"
        onPageChange={onPageChange}
      />,
    );
    const prev = screen.getByLabelText("Previous page") as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    fireEvent.click(prev);
    expect(onPageChange).not.toHaveBeenCalled();

    rerender(
      <Pagination
        count={4}
        page={4}
        label="Projects"
        onPageChange={onPageChange}
      />,
    );
    const next = screen.getByLabelText("Next page") as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    fireEvent.click(next);
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it("clamps a page number that arrived from a URL", () => {
    const onPageChange = vi.fn();
    // ?page=999 on a 4-page list is an ordinary thing to be sent.
    render(
      <Pagination
        count={4}
        page={999}
        label="Projects"
        onPageChange={onPageChange}
      />,
    );
    expect(screen.getByRole("button", { current: "page" }).textContent).toBe("4");
    expect((screen.getByLabelText("Next page") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("does not make the ellipsis a thing to read or press", () => {
    render(
      <Pagination count={20} page={10} label="Projects" onPageChange={() => {}} />,
    );
    // Buttons: prev, next, and only the real page numbers.
    const numbered = screen
      .getAllByRole("button")
      .filter((b) => /^\d+$/.test(b.textContent ?? ""));
    expect(numbered).toHaveLength(5);
  });
});
