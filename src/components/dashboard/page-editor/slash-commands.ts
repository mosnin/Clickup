"use client";

import { Extension } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import type { Editor, Range } from "@tiptap/core";
import type { LucideIcon } from "lucide-react";
import {
  CheckSquare,
  Code2,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Link2,
  List,
  ListOrdered,
  Minus,
  Quote,
  Table as TableIcon,
  Type,
} from "lucide-react";

// The `/` menu.
//
// Grouped rather than a flat list, because a flat list of twenty blocks is a
// wall: someone typing `/` is either reaching for a heading (top group,
// every time) or hunting for something specific (which is what the filter is
// for). The groups mirror how the blocks differ in kind — text structure,
// lists, then the heavier inserts.

export type SlashItem = {
  title: string;
  group: string;
  /** Extra words the filter should match, so "bullet" finds "Bulleted list". */
  keywords: string;
  icon: LucideIcon;
  /** Shown right-aligned: the markdown you could have typed instead. */
  hint?: string;
  run: (editor: Editor, range: Range) => void;
};

/**
 * Opens the OS file picker and hands the chosen image to the editor.
 *
 * The alternative — inserting `![alt](https://)` for someone to fill in — is
 * what this block used to do, and it produced markdown for an image that
 * doesn't exist. Picking a file is the only version of this that works.
 */
function pickImage(editor: Editor, range: Range): void {
  editor.chain().focus().deleteRange(range).run();
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = true;
  input.addEventListener("change", () => {
    const files = Array.from(input.files ?? []);
    if (files.length === 0) return;
    // The upload path lives on the ImageDrop plugin, so the slash command,
    // a paste and a drop all go through exactly one uploader.
    const upload = editor.extensionManager.extensions.find(
      (e) => e.name === "pageImageDrop",
    )?.options?.upload as ((file: File) => Promise<string | null>) | undefined;
    if (!upload) return;
    void (async () => {
      for (const file of files) {
        const url = await upload(file);
        if (url) editor.chain().focus().setImage({ src: url, alt: file.name }).run();
      }
    })();
  });
  input.click();
}

export const SLASH_ITEMS: SlashItem[] = [
  {
    title: "Text",
    group: "Basic blocks",
    keywords: "paragraph plain body",
    icon: Type,
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  {
    title: "Heading 1",
    group: "Basic blocks",
    keywords: "title h1 big",
    icon: Heading1,
    hint: "#",
    run: (editor, range) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .setNode("heading", { level: 1 })
        .run(),
  },
  {
    title: "Heading 2",
    group: "Basic blocks",
    keywords: "subtitle h2 section",
    icon: Heading2,
    hint: "##",
    run: (editor, range) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .setNode("heading", { level: 2 })
        .run(),
  },
  {
    title: "Heading 3",
    group: "Basic blocks",
    keywords: "h3 subsection",
    icon: Heading3,
    hint: "###",
    run: (editor, range) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .setNode("heading", { level: 3 })
        .run(),
  },
  {
    title: "Quote",
    group: "Basic blocks",
    keywords: "blockquote callout cite",
    icon: Quote,
    hint: ">",
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    title: "Divider",
    group: "Basic blocks",
    keywords: "hr rule separator line",
    icon: Minus,
    hint: "---",
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },

  {
    title: "Bulleted list",
    group: "Lists",
    keywords: "unordered ul bullet point",
    icon: List,
    hint: "-",
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    title: "Numbered list",
    group: "Lists",
    keywords: "ordered ol steps",
    icon: ListOrdered,
    hint: "1.",
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    title: "To-do list",
    group: "Lists",
    keywords: "checkbox task check tick",
    icon: CheckSquare,
    hint: "[ ]",
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },

  {
    title: "Table",
    group: "Insert",
    keywords: "grid rows columns spreadsheet",
    icon: TableIcon,
    run: (editor, range) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
  {
    title: "Code",
    group: "Insert",
    keywords: "snippet monospace pre",
    icon: Code2,
    hint: "```",
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    title: "Link to page",
    group: "Insert",
    keywords: "wikilink reference doc internal",
    icon: FileText,
    // Leaves the cursor between the brackets so the next keystroke starts
    // naming the page — the same shape as typing [[ by hand.
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).insertContent("[[").run(),
  },
  {
    // No modal asking for a URL: this is a markdown editor, so it inserts
    // the syntax and leaves the caret where the URL goes. Same reason the
    // rest of the app never calls window.prompt.
    title: "Link",
    group: "Insert",
    keywords: "url href external",
    icon: Link2,
    run: (editor, range) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent("[text](https://)")
        .run(),
  },
  {
    title: "Image",
    group: "Insert",
    keywords: "picture photo embed media upload screenshot",
    icon: ImageIcon,
    run: pickImage,
  },
];

export function filterSlashItems(query: string): SlashItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return SLASH_ITEMS;
  return SLASH_ITEMS.filter((item) =>
    `${item.title} ${item.keywords}`.toLowerCase().includes(needle),
  );
}

/** Groups in first-appearance order, so the menu's shape is stable. */
export function groupSlashItems(
  items: SlashItem[],
): { group: string; items: SlashItem[] }[] {
  const out: { group: string; items: SlashItem[] }[] = [];
  for (const item of items) {
    let bucket = out.find((g) => g.group === item.group);
    if (!bucket) {
      bucket = { group: item.group, items: [] };
      out.push(bucket);
    }
    bucket.items.push(item);
  }
  return out;
}

// Every Suggestion plugin needs its own key. They all default to
// `PluginKey("suggestion")`, and ProseMirror refuses two different instances
// under one key — the editor throws on construction rather than degrading.
export const SlashCommandsPluginKey = new PluginKey("slashCommands");

export const SlashCommands = Extension.create({
  name: "slashCommands",
  addOptions() {
    return {
      suggestion: {
        pluginKey: SlashCommandsPluginKey,
        char: "/",
        // Only at the start of a line: mid-sentence "and/or" should not
        // open a block menu.
        startOfLine: true,
        command: ({
          editor,
          range,
          props,
        }: {
          editor: Editor;
          range: Range;
          props: SlashItem;
        }) => props.run(editor, range),
      },
    };
  },
  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
