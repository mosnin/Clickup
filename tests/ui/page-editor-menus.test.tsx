import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { resetHarness } from "./harness";

// The three suggestion menus. They are the reason this editor feels like an
// editor rather than a textarea, and they are also the fragile part: all
// three are ProseMirror plugins sharing one keyboard and one popup, and the
// first version of this file caught them colliding on a plugin key — which
// threw before the editor could mount at all. So: open each one for real.

const { PageBodyEditor } = await import("@/components/dashboard/page-editor");

const MENTIONABLES = [
  { id: "u1", name: "Ada Lovelace", kind: "user" as const },
  { id: "ag1", name: "Scout", kind: "agent" as const },
];

let liveEditor: Editor | null = null;

afterEach(() => {
  if (liveEditor && !liveEditor.isDestroyed) liveEditor.destroy();
  liveEditor = null;
});

/** Renders the editor and hands back its Tiptap instance once it exists. */
async function mount(markdown = "") {
  let editor: Editor | null = null;
  const onChange = vi.fn();
  const { container } = render(
    <PageBodyEditor
      markdown={markdown}
      mentionables={MENTIONABLES}
      pageTitles={[
        { pageId: "pg2", title: "Billing migration" },
        { pageId: "pg3", title: "Runbook" },
      ]}
      onChange={onChange}
      onReady={(e) => {
        editor = e;
        liveEditor = e;
      }}
    />,
  );
  await waitFor(() => expect(editor).toBeTruthy());
  return { container, onChange, editor: editor! as Editor };
}

/** What the caret sees: menus mount into document.body, not the editor. */
function menuText(): string {
  return Array.from(document.querySelectorAll("[data-suggestion-menu]"))
    .map((n) => n.textContent ?? "")
    .join("\n");
}

async function type(editor: Editor, text: string) {
  await act(async () => {
    editor.commands.focus();
    editor.commands.insertContent(text);
  });
}

beforeEach(() => {
  resetHarness();
  // Menus mount outside the render container and unmount on a later tick, so
  // without this a menu from the previous test can still be in the document
  // and quietly satisfy the next test's assertion.
  document.body.innerHTML = "";
});

describe("editor menus", () => {
  it("opens the block menu on / and groups the blocks", async () => {
    const { editor } = await mount();
    await type(editor, "/");
    await waitFor(() => expect(menuText()).toContain("Heading 1"));

    const text = menuText();
    // Grouped, not a flat wall of twenty blocks.
    expect(text).toContain("Basic blocks");
    expect(text).toContain("Lists");
    expect(text).toContain("Insert");
    // The markdown you could have typed instead, shown as a hint.
    expect(text).toContain("##");
  });

  it("filters the block menu by keyword, not just by title", async () => {
    const { editor } = await mount();
    // "checkbox" appears nowhere in the title "To-do list" — reaching it at
    // all proves the filter reads the keywords, which is the difference
    // between a menu you can search and one you have to already know.
    await type(editor, "/checkbox");
    await waitFor(() => expect(menuText()).toContain("To-do list"));
    expect(menuText()).not.toContain("Heading 1");
  });

  it("offers people and agents separately on @", async () => {
    const { editor } = await mount();
    await type(editor, "@");
    await waitFor(() => expect(menuText()).toContain("Ada Lovelace"));
    const text = menuText();
    expect(text).toContain("People");
    expect(text).toContain("Agents");
    expect(text).toContain("Scout");
  });

  it("narrows mentions as you keep typing", async () => {
    const { editor } = await mount();
    await type(editor, "@Sco");
    await waitFor(() => expect(menuText()).toContain("Scout"));
    expect(menuText()).not.toContain("Ada Lovelace");
  });

  it("offers existing pages on [[ and inserts a link that survives saving", async () => {
    const { editor, onChange } = await mount();
    await type(editor, "[[");
    await waitFor(() => expect(menuText()).toContain("Billing migration"));

    // Pick the first row the way a click would.
    const row = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        "[data-suggestion-menu] button",
      ),
    ).find((b) => b.textContent?.includes("Billing migration"))!;
    expect(row).toBeTruthy();
    await act(async () => {
      row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    await waitFor(() =>
      expect(onChange.mock.calls.at(-1)?.[0]).toContain(
        "[[Billing migration]]",
      ),
    );
  });

  it("leaves / alone in the middle of a sentence", async () => {
    const { editor } = await mount();
    // Stopping right after the slash means an empty query — so if the menu
    // were going to open here it would open showing everything. "and/or" is
    // prose, not a request for a block menu.
    await type(editor, "ship it and/");
    expect(menuText()).not.toContain("Heading 1");

    // And the same slash at the start of a line still does open it, so this
    // is a position rule rather than the menu being broken.
    await act(async () => {
      editor.commands.splitBlock();
    });
    await type(editor, "/");
    await waitFor(() => expect(menuText()).toContain("Heading 1"));
  });
});
