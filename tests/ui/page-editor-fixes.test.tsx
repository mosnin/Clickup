import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { resetHarness } from "./harness";

// The audit findings, each pinned by the behaviour it was missing. Four of
// these were defects rather than gaps — an image that deleted itself, a link
// you could write but not follow, a menu Escape couldn't close — so they
// stay covered rather than covered once.

const { PageBodyEditor } = await import("@/components/dashboard/page-editor");

const TITLES = [
  { pageId: "pg2", title: "Billing migration" },
  { pageId: "pg3", title: "Runbook" },
];

async function mount(
  markdown: string,
  props: Partial<{
    onOpenPageLink: (title: string, pageId: string | null) => void;
    uploadImage: (file: File) => Promise<string | null>;
  }> = {},
) {
  let editor: Editor | null = null;
  const onChange = vi.fn();
  const { container } = render(
    <PageBodyEditor
      markdown={markdown}
      mentionables={[]}
      pageTitles={TITLES}
      onChange={onChange}
      onReady={(e) => {
        editor = e;
      }}
      {...props}
    />,
  );
  await waitFor(() => expect(editor).toBeTruthy());
  return { container, onChange, editor: editor! as Editor };
}

const menuText = () =>
  Array.from(document.querySelectorAll("[data-suggestion-menu]"))
    .map((n) => n.textContent ?? "")
    .join("");

beforeEach(() => {
  resetHarness();
  document.body.innerHTML = "";
});

describe("images", () => {
  it("keeps an image instead of silently dropping it", async () => {
    // Before the fix this parsed to an empty paragraph: the schema had no
    // image node, so an agent's screenshot was deleted the first time a
    // person opened the page.
    const { container, onChange } = await mount(
      "before\n\n![a chart](https://example.com/chart.png)\n\nafter",
    );
    await waitFor(() =>
      expect(container.querySelector("img")).toBeTruthy(),
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.com/chart.png",
    );

    const surface = container.querySelector(".page-editor-surface")!;
    surface.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    // And it round-trips as markdown, not as HTML.
    const out = onChange.mock.calls.at(-1)![0] as string;
    expect(out).toContain("![a chart](https://example.com/chart.png)");
    expect(out).not.toContain("<img");
  });

  it("uploads a pasted image and writes its URL into the markdown", async () => {
    const uploadImage = vi
      .fn()
      .mockResolvedValue("https://storage.example/abc.png");
    const { container, editor, onChange } = await mount("", { uploadImage });

    const file = new File(["x"], "screenshot.png", { type: "image/png" });
    await act(async () => {
      editor.commands.focus();
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: { files: [file], getData: () => "", types: [] },
      });
      container
        .querySelector(".page-editor-surface")!
        .dispatchEvent(event);
    });

    await waitFor(() => expect(uploadImage).toHaveBeenCalledWith(file));
    await waitFor(() =>
      expect(onChange.mock.calls.at(-1)?.[0]).toContain(
        "https://storage.example/abc.png",
      ),
    );
  });
});

describe("page links", () => {
  it("follows a link to a page that exists", async () => {
    const onOpenPageLink = vi.fn();
    const { container } = await mount("See [[Runbook]].", { onOpenPageLink });
    await waitFor(() =>
      expect(container.querySelector(".page-wikilink")).toBeTruthy(),
    );
    const link = container.querySelector(".page-wikilink")!;
    await act(async () => {
      link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onOpenPageLink).toHaveBeenCalledWith("Runbook", "pg3");
  });

  it("marks a link to a page that doesn't exist, and offers to create it", async () => {
    const onOpenPageLink = vi.fn();
    const { container } = await mount("See [[Not written yet]].", {
      onOpenPageLink,
    });
    await waitFor(() =>
      expect(container.querySelector(".page-wikilink")).toBeTruthy(),
    );
    const link = container.querySelector(".page-wikilink")!;
    // Visibly unfinished rather than identical to a working link.
    expect(link.className).toContain("page-wikilink-missing");

    await act(async () => {
      link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    // null page id is the signal to create it.
    expect(onOpenPageLink).toHaveBeenCalledWith("Not written yet", null);
  });

  it("still stores a plain [[link]] either way", async () => {
    const { container, onChange } = await mount("See [[Not written yet]].");
    await waitFor(() =>
      expect(container.querySelector(".page-wikilink")).toBeTruthy(),
    );
    container
      .querySelector(".page-editor-surface")!
      .dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.at(-1)![0]).toContain("[[Not written yet]]");
  });
});

describe("escape", () => {
  it("closes the block menu and gives the keys back", async () => {
    const { editor } = await mount("");
    await act(async () => {
      editor.commands.focus();
      editor.commands.insertContent("/");
    });
    await waitFor(() => expect(menuText()).toContain("Heading 1"));

    await act(async () => {
      editor.view.dom.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await waitFor(() => expect(menuText()).not.toContain("Heading 1"));
  });

  it("closes the mention menu too", async () => {
    let editor: Editor | null = null;
    render(
      <PageBodyEditor
        markdown=""
        mentionables={[{ id: "u1", name: "Ada Lovelace", kind: "user" }]}
        pageTitles={[]}
        onChange={vi.fn()}
        onReady={(e) => {
          editor = e;
        }}
      />,
    );
    await waitFor(() => expect(editor).toBeTruthy());
    const ed = editor! as Editor;
    await act(async () => {
      ed.commands.focus();
      ed.commands.insertContent("@");
    });
    await waitFor(() => expect(menuText()).toContain("Ada Lovelace"));
    await act(async () => {
      ed.view.dom.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await waitFor(() => expect(menuText()).not.toContain("Ada Lovelace"));
  });
});
