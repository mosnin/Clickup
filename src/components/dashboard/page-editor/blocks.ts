"use client";

import { Node, mergeAttributes } from "@tiptap/core";

// Toggles and callouts.
//
// Both are Notion staples and neither exists in CommonMark, so the question
// that decides their design is the same one every block here answers: what
// does this look like in the stored markdown, and does it survive a round
// trip? A block that can't answer that deletes data — the Image item shipped
// without an answer and silently ate every image.
//
// Toggle → GFM `<details>`, which is what GitHub, Obsidian and every static
// site generator already render:
//
//     <details><summary>Why we moved off the legacy provider</summary>
//
//     The contract renewed in March.
//
//     </details>
//
// Callout → a blockquote whose first line is a bracketed kind, which is
// GitHub's own alert syntax:
//
//     > [!NOTE]
//     > The migration runs Thursday.
//
// Both degrade honestly: an agent that has never heard of either sees a
// details block and a blockquote, which is exactly what they mean.

type SerializeState = {
  write: (text: string) => void;
  renderContent: (node: unknown) => void;
  closeBlock: (node: unknown) => void;
  wrapBlock: (
    delimiter: string,
    firstDelimiter: string | null,
    node: unknown,
    fn: () => void,
  ) => void;
  ensureNewLine: () => void;
};

export const CALLOUT_KINDS = ["note", "tip", "important", "warning", "caution"] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

/**
 * A collapsible section.
 *
 * The summary is a child node rather than an attribute so it can hold
 * formatting and mentions — a toggle whose title can't contain a link is a
 * toggle people stop using.
 */
export const ToggleBlock = Node.create({
  name: "toggleBlock",
  group: "block",
  content: "toggleSummary block+",
  defining: true,

  parseHTML() {
    return [{ tag: "details" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "details",
      mergeAttributes(HTMLAttributes, { class: "page-toggle", open: "" }),
      0,
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: SerializeState, node: unknown) {
          const typed = node as {
            firstChild: { textContent: string } | null;
            childCount: number;
            child: (i: number) => unknown;
            forEach: (
              fn: (child: unknown, offset: number, index: number) => void,
            ) => void;
          };
          const summary = typed.firstChild?.textContent ?? "";
          state.write(`<details><summary>${summary}</summary>\n\n`);
          // Everything after the summary is ordinary block content, which is
          // why the body survives even in a renderer that ignores <details>.
          typed.forEach((child, _offset, index) => {
            if (index === 0) return;
            state.renderContent(child);
          });
          state.ensureNewLine();
          state.write("</details>");
          state.closeBlock(node);
        },
      },
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-Alt-t": () =>
        this.editor.commands.insertContent({
          type: this.name,
          content: [
            { type: "toggleSummary", content: [{ type: "text", text: "Toggle" }] },
            { type: "paragraph" },
          ],
        }),
    };
  },
});

/** The clickable title line of a toggle. */
export const ToggleSummary = Node.create({
  name: "toggleSummary",
  content: "inline*",
  parseHTML() {
    return [{ tag: "summary" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "summary",
      mergeAttributes(HTMLAttributes, { class: "page-toggle-summary" }),
      0,
    ];
  },
  addStorage() {
    // Serialized by the parent, which needs it inline in the <summary> tag.
    return { markdown: { serialize: () => {} } };
  },
});

/**
 * A callout: an aside that says how to read it.
 *
 * Stored as a GitHub alert blockquote, so the kind is part of the text rather
 * than metadata a plain-markdown reader would lose.
 */
export const Callout = Node.create<{ HTMLAttributes: Record<string, unknown> }>({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: "note" as CalloutKind,
        parseHTML: (element) => element.getAttribute("data-callout") ?? "note",
        renderHTML: (attributes) => ({
          "data-callout": attributes.kind as string,
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        class: `page-callout page-callout-${node.attrs.kind as string}`,
      }),
      0,
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: SerializeState, node: unknown) {
          const typed = node as { attrs: { kind?: string } };
          const kind = (typed.attrs.kind ?? "note").toUpperCase();
          // First line carries the kind, the rest is quoted body — GitHub's
          // alert shape exactly.
          state.wrapBlock("> ", null, node, () => {
            state.write(`[!${kind}]`);
            state.ensureNewLine();
            state.renderContent(node);
          });
        },
      },
    };
  },
});
