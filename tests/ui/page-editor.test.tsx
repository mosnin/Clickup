import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { resetHarness } from "./harness";

// The editor's load-bearing claim is that markdown stays the stored format.
// If a Tiptap edit silently rewrites an agent's `## Heading` into something
// else, the whole design falls over — so these tests are about round-trip
// fidelity first and chrome second.

const { PageBodyEditor } = await import("@/components/dashboard/page-editor");

const MENTIONABLES = [
  { id: "u1", name: "Ada Lovelace", kind: "user" as const },
  { id: "ag1", name: "Scout", kind: "agent" as const },
];

function renderEditor(markdown: string, onChange = vi.fn()) {
  const result = render(
    <PageBodyEditor
      markdown={markdown}
      mentionables={MENTIONABLES}
      pageTitles={[{ pageId: "pg2", title: "Billing migration" }]}
      onChange={onChange}
    />,
  );
  return { ...result, onChange };
}

beforeEach(() => resetHarness());

describe("PageBodyEditor", () => {
  it("renders markdown as real structure, not as literal syntax", async () => {
    const { container } = renderEditor(
      "# Architecture\n\nWe use **Convex**.\n\n- one\n- two",
    );
    await waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Architecture");
    });
    expect(container.querySelector("strong")?.textContent).toBe("Convex");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.textContent).not.toContain("**");
  });

  it("round-trips headings, lists, quotes and code without rewriting them", async () => {
    // The full set of block types the slash menu can produce. Whatever the
    // editor gives back has to still be markdown an agent can read.
    const source = [
      "# H1",
      "",
      "## H2",
      "",
      "Body with **bold** and `code`.",
      "",
      "- bullet",
      "",
      "1. numbered",
      "",
      "> quote",
      "",
      "```",
      "const x = 1;",
      "```",
    ].join("\n");

    const onChange = vi.fn();
    const { container } = renderEditor(source, onChange);
    await waitFor(() => expect(container.querySelector("h1")).toBeTruthy());

    // Typing anything makes the editor emit its own serialization.
    const surface = container.querySelector(".page-editor-surface")!;
    fireEvent.keyDown(surface, { key: "a" });
    fireEvent.input(surface);

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const out = onChange.mock.calls.at(-1)![0] as string;

    expect(out).toContain("# H1");
    expect(out).toContain("## H2");
    expect(out).toContain("**bold**");
    expect(out).toContain("`code`");
    expect(out).toContain("- bullet");
    expect(out).toContain("1. numbered");
    expect(out).toContain("> quote");
    expect(out).toContain("const x = 1;");
  });

  it("keeps a GFM table as a table", async () => {
    const source = ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");
    const onChange = vi.fn();
    const { container } = renderEditor(source, onChange);

    await waitFor(() => expect(container.querySelector("table")).toBeTruthy());
    expect(container.querySelectorAll("th")).toHaveLength(2);

    const surface = container.querySelector(".page-editor-surface")!;
    fireEvent.input(surface);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const out = onChange.mock.calls.at(-1)![0] as string;
    // Still pipe-table markdown, not HTML.
    expect(out).toContain("|");
    expect(out).not.toContain("<table");
  });

  it("keeps the app's mention token rather than inventing HTML", async () => {
    const onChange = vi.fn();
    const { container } = renderEditor(
      "Ping @[Ada Lovelace](u1) about this.",
      onChange,
    );
    await waitFor(() =>
      expect(container.querySelector(".page-mention")).toBeTruthy(),
    );

    const surface = container.querySelector(".page-editor-surface")!;
    fireEvent.input(surface);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const out = onChange.mock.calls.at(-1)![0] as string;
    // The exact token the comment composer uses — one mention format for
    // the whole product.
    expect(out).toContain("@[Ada Lovelace](u1)");
  });

  it("preserves [[page links]] verbatim", async () => {
    const onChange = vi.fn();
    const { container } = renderEditor("See [[Billing migration]].", onChange);
    await waitFor(() =>
      expect(container.querySelector(".page-editor-surface")).toBeTruthy(),
    );
    const surface = container.querySelector(".page-editor-surface")!;
    fireEvent.input(surface);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.at(-1)![0]).toContain("[[Billing migration]]");
  });

  it("renders task list checkboxes from GFM syntax", async () => {
    const { container } = renderEditor("- [ ] todo\n- [x] done");
    await waitFor(() =>
      expect(
        container.querySelectorAll('input[type="checkbox"]').length,
      ).toBeGreaterThan(0),
    );
  });

  it("does not let raw HTML in the source become live markup", async () => {
    const { container } = renderEditor(
      "<script>alert(1)</script>\n\nafter",
    );
    await waitFor(() =>
      expect(container.querySelector(".page-editor-surface")).toBeTruthy(),
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("after");
  });

  it("adopts an outside edit only while the reader isn't typing", async () => {
    const { container, rerender } = renderEditor("first");
    await waitFor(() =>
      expect(container.textContent).toContain("first"),
    );

    // An agent rewrites the page underneath an idle reader.
    rerender(
      <PageBodyEditor
        markdown="second"
        mentionables={MENTIONABLES}
        pageTitles={[]}
        onChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(container.textContent).toContain("second"));
  });
});
